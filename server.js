/**
 * Card Battle — Game Server (Kubernetes-ready)
 *
 * CHANGES FROM ORIGINAL server.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. spawnPlayerPod()   — calls Kubernetes API to create a thin pod whenever
 *                         a player creates or joins a room
 * 2. deletePlayerPod()  — deletes the pod when the player disconnects
 * 3. GET /api/health    — liveness/readiness probe for Kubernetes
 * 4. GET /api/rooms     — room summary endpoint for monitoring
 * 5. podName included   — in lobby + state messages so the UI can show it
 * 6. KUBERNETES_ENABLED — env flag: "true" inside cluster, unset for local dev
 * 7. REDIS MIGRATION    — state moved to Redis for multi-pod scaling and fault tolerance
 *
 * Everything else (card logic, game state, WebSocket protocol) is unchanged.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { createClient } = require('redis');

const PORT = parseInt(process.env.PORT || '3000');
const K8S_ENABLED = process.env.KUBERNETES_ENABLED === 'true';
const K8S_NAMESPACE = process.env.K8S_NAMESPACE || 'card-battle';
const K8S_PLAYER_IMAGE = process.env.K8S_PLAYER_IMAGE || 'card-battle-player:latest';
const GAME_SERVER_SVC = process.env.GAME_SERVER_SVC || 'game-server-service';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// ─── Kubernetes API helpers ───────────────────────────────────────────────────
const K8S_TOKEN = K8S_ENABLED
  ? fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8').trim()
  : 'local-dev';

function k8sRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    if (!K8S_ENABLED) {
      console.log(`[k8s SKIP] ${method} ${urlPath}`);
      return resolve({ skipped: true });
    }

    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        method,
        hostname: 'kubernetes.default.svc',
        path: urlPath,
        headers: {
          'Authorization': `Bearer ${K8S_TOKEN}`,
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
        },
        rejectUnauthorized: false
      },
      res => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function spawnPlayerPod(playerId, roomCode) {
  const podName = `player-${playerId}`;

  const manifest = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: podName,
      namespace: K8S_NAMESPACE,
      labels: { app: 'card-battle-player', playerId, roomCode }
    },
    spec: {
      restartPolicy: 'Never',
      containers: [{
        name: 'player-session',
        image: K8S_PLAYER_IMAGE,
        imagePullPolicy: 'Never',
        ports: [{ containerPort: 8080 }],
        env: [
          { name: 'PLAYER_ID', value: playerId },
          { name: 'ROOM_CODE', value: roomCode },
          { name: 'GAME_SERVER_URL', value: `ws://${GAME_SERVER_SVC}:${PORT}` }
        ],
        resources: {
          requests: { cpu: '50m', memory: '64Mi' },
          limits: { cpu: '200m', memory: '128Mi' }
        }
      }]
    }
  };

  try {
    const res = await k8sRequest('POST', `/api/v1/namespaces/${K8S_NAMESPACE}/pods`, manifest);
    if (res.skipped) return;
    if (res.metadata) console.log(`[k8s] Pod created : ${podName}`);
    else console.warn(`[k8s] Pod warning : ${res.message}`);
  } catch (err) {
    console.error(`[k8s] Pod create failed for ${playerId}:`, err.message);
  }
}

async function deletePlayerPod(playerId) {
  const podName = `player-${playerId}`;
  try {
    const res = await k8sRequest('DELETE', `/api/v1/namespaces/${K8S_NAMESPACE}/pods/${podName}`);
    if (K8S_ENABLED) console.log(`[k8s] Pod deleted : ${podName}`, res);
  } catch (err) {
    console.error(`[k8s] Pod delete failed for ${playerId}:`, err.message);
  }
}

// ─── Redis Setup ──────────────────────────────────────────────────────────────
const redisClient = createClient({ url: REDIS_URL });
const subscriber = redisClient.duplicate();

redisClient.on('error', err => console.error('Redis Client Error', err));
subscriber.on('error', err => console.error('Redis Subscriber Error', err));

Promise.all([redisClient.connect(), subscriber.connect()]).then(() => {
  console.log(`[Redis] Connected to ${REDIS_URL}`);

  subscriber.subscribe('room_updates', (message) => {
    const { room, updateType } = JSON.parse(message);
    room.players.forEach(p => {
      const conn = localConnections[p.id];
      if (conn && conn.readyState === WebSocket.OPEN) {
        if (updateType === 'state') {
          conn.send(JSON.stringify(stateFor(room, p.id)));
        } else if (updateType === 'lobby') {
          const msg = JSON.stringify({
            type: 'lobby',
            roomCode: room.code,
            hostId: room.players[0]?.id,
            players: room.players.map(p2 => ({
              id: p2.id,
              name: p2.name,
              podName: `player-${p2.id}`
            }))
          });
          conn.send(msg);
        }
      }
    });
  });
}).catch(err => {
  console.error('[Redis] Connection failed', err);
});

// ─── HTTP server ──────────────────────────────────────────────────────────────
const httpServer = http.createServer(async (req, res) => {

  if (req.url === '/api/health') {
    try {
      const keys = await redisClient.keys('room:*');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', rooms: keys.length }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error' }));
    }
    return;
  }

  if (req.url === '/api/rooms') {
    try {
      const keys = await redisClient.keys('room:*');
      const summary = [];
      for (const key of keys) {
        const roomRaw = await redisClient.get(key);
        if (roomRaw) {
          const r = JSON.parse(roomRaw);
          summary.push({
            code: r.code,
            started: r.started,
            players: r.players.map(p => ({ id: p.id, name: p.name, pod: `player-${p.id}` }))
          });
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(summary));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Serve client HTML
  if (req.url === '/' || req.url === '/index.html') {
    const file = fs.readFileSync(path.join(__dirname, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(file);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ─── WebSocket server ─────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server: httpServer });
const localConnections = {}; // playerId -> ws

async function generateRoomCodeRedis() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  const exists = await redisClient.exists(`room:${code}`);
  return exists ? await generateRoomCodeRedis() : code;
}

async function saveAndBroadcast(room, updateType) {
  await redisClient.set(`room:${room.code}`, JSON.stringify(room));
  await redisClient.publish('room_updates', JSON.stringify({ room, updateType }));
}

// ─── Card logic (UNCHANGED) ───────────────────────────────────────────────────
const SUITS = ['S', 'H', 'D', 'C'];
const SUIT_SYMBOLS = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SPECIALS = ['Skip', 'Rev', '+2'];

function makeDeck() {
  const d = [];
  SUITS.forEach(s => {
    ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'].forEach(v => d.push({ s, v }));
    SPECIALS.forEach(v => d.push({ s, v }));
  });
  for (let i = 0; i < 4; i++) d.push({ s: 'W', v: 'Wild' });
  return d;
}

function shuffle(a) {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

function canPlay(card, top) {
  if (card.v === 'Wild') return true;
  return card.s === top.s || card.v === top.v;
}

function createGame(players) {
  let deck = shuffle(makeDeck());
  const hands = {};
  players.forEach(p => { hands[p.id] = deck.splice(0, 7); });
  let first;
  do { first = deck.splice(0, 1)[0]; }
  while ([...SPECIALS, 'Wild'].includes(first.v));
  return {
    deck, discard: [first], hands,
    current: players[0].id, direction: 1,
    playerOrder: players.map(p => p.id),
    pendingWild: false, drewThisTurn: false, winner: null,
    message: `Game started! ${players[0].name}'s turn.`
  };
}

function reshuffleIfNeeded(gs) {
  if (gs.deck.length < 2) {
    const top = gs.discard.pop();
    gs.deck = shuffle(gs.discard);
    gs.discard = [top];
  }
}

function nextPlayer(gs, skip = false) {
  const order = gs.playerOrder;
  let idx = order.indexOf(gs.current);
  idx = (idx + gs.direction + order.length) % order.length;
  if (skip) idx = (idx + gs.direction + order.length) % order.length;
  gs.current = order[idx];
  gs.drewThisTurn = false;
}

function applyCard(gs, playerId, cardIndex, chosenSuit) {
  if (gs.winner) return { error: 'Game already over.' };
  if (gs.current !== playerId) return { error: 'Not your turn.' };
  if (gs.pendingWild && !chosenSuit) return { error: 'Choose a suit for Wild.' };

  if (gs.pendingWild && chosenSuit) {
    gs.discard[gs.discard.length - 1].s = chosenSuit;
    gs.pendingWild = false;
    nextPlayer(gs);
    gs.message = `Wild → ${SUIT_SYMBOLS[chosenSuit]}. ${gs.current}'s turn.`;
    return {};
  }

  const hand = gs.hands[playerId];
  if (cardIndex < 0 || cardIndex >= hand.length) return { error: 'Invalid card.' };
  const card = hand[cardIndex];
  const top = gs.discard[gs.discard.length - 1];
  if (!canPlay(card, top)) return { error: 'That card cannot be played.' };

  hand.splice(cardIndex, 1);
  gs.discard.push(card);
  gs.drewThisTurn = false;

  if (hand.length === 0) { gs.winner = playerId; gs.message = `${playerId} wins!`; return {}; }

  if (card.v === 'Wild') {
    gs.pendingWild = true; gs.message = 'Wild played! Choose a suit.'; return {};
  }
  if (card.v === 'Skip') {
    const si = (gs.playerOrder.indexOf(gs.current) + gs.direction + gs.playerOrder.length) % gs.playerOrder.length;
    const skipped = gs.playerOrder[si];
    nextPlayer(gs, true);
    gs.message = `${skipped} was skipped!`;
  } else if (card.v === 'Rev') {
    gs.direction *= -1; nextPlayer(gs); gs.message = 'Turn order reversed!';
  } else if (card.v === '+2') {
    const ti = (gs.playerOrder.indexOf(gs.current) + gs.direction + gs.playerOrder.length) % gs.playerOrder.length;
    const target = gs.playerOrder[ti];
    reshuffleIfNeeded(gs);
    gs.hands[target].push(...gs.deck.splice(0, 2));
    nextPlayer(gs);
    gs.message = `${target} drew 2 cards!`;
  } else {
    nextPlayer(gs); gs.message = `${gs.current}'s turn.`;
  }
  return {};
}

function drawCard(gs, playerId) {
  if (gs.current !== playerId) return { error: 'Not your turn.' };
  if (gs.drewThisTurn) return { error: 'Already drew this turn.' };
  if (gs.pendingWild) return { error: 'Choose a suit first.' };
  reshuffleIfNeeded(gs);
  if (gs.deck.length === 0) return { error: 'No cards left!' };
  const card = gs.deck.splice(0, 1)[0];
  gs.hands[playerId].push(card);
  gs.drewThisTurn = true;
  gs.message = `Drew a card.${canPlay(card, gs.discard[gs.discard.length - 1]) ? ' You can play it!' : ' No match — end your turn.'}`;
  return {};
}

function endTurn(gs, playerId) {
  if (gs.current !== playerId) return { error: 'Not your turn.' };
  if (!gs.drewThisTurn) return { error: 'Draw a card first.' };
  nextPlayer(gs);
  gs.message = `${gs.current}'s turn.`;
  return {};
}

function stateFor(room, playerId) {
  const gs = room.gameState;
  if (!gs) return null;
  return {
    type: 'state',
    hand: gs.hands[playerId] || [],
    discard: gs.discard[gs.discard.length - 1],
    deckCount: gs.deck.length,
    current: gs.current,
    direction: gs.direction,
    pendingWild: gs.pendingWild && gs.current === playerId,
    drewThisTurn: gs.drewThisTurn,
    winner: gs.winner,
    message: gs.message,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      cardCount: gs.hands[p.id]?.length ?? 0,
      isYou: p.id === playerId,
      podName: `player-${p.id}`
    }))
  };
}

function sendError(ws, msg) {
  ws.send(JSON.stringify({ type: 'error', message: msg }));
}

// ─── WebSocket handler ────────────────────────────────────────────────────────
wss.on('connection', ws => {
  let playerRoomCode = null;
  let playerId = null;

  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { action } = msg;

    if (action === 'createRoom') {
      const code = await generateRoomCodeRedis();
      playerId = 'p' + Math.random().toString(36).slice(2, 9);
      playerRoomCode = code;
      localConnections[playerId] = ws;

      const room = {
        code, started: false, gameState: null,
        players: [{ id: playerId, name: msg.name || 'Host' }]
      };
      await saveAndBroadcast(room, 'lobby');

      ws.send(JSON.stringify({ type: 'created', roomCode: code, playerId }));
      spawnPlayerPod(playerId, code);
      return;
    }

    if (action === 'joinRoom') {
      const code = msg.roomCode?.toUpperCase();
      const roomRaw = await redisClient.get(`room:${code}`);
      if (!roomRaw) return sendError(ws, 'Room not found.');
      const room = JSON.parse(roomRaw);

      if (room.started) return sendError(ws, 'Game already started.');
      if (room.players.length >= 6) return sendError(ws, 'Room is full (max 6).');

      playerId = 'p' + Math.random().toString(36).slice(2, 9);
      playerRoomCode = code;
      localConnections[playerId] = ws;

      room.players.push({ id: playerId, name: msg.name || `Player ${room.players.length + 1}` });
      await saveAndBroadcast(room, 'lobby');

      ws.send(JSON.stringify({ type: 'joined', roomCode: code, playerId }));
      spawnPlayerPod(playerId, code);
      return;
    }

    if (!playerRoomCode) return sendError(ws, 'Not in a room.');

    const roomRaw = await redisClient.get(`room:${playerRoomCode}`);
    if (!roomRaw) return sendError(ws, 'Room not found.');
    const room = JSON.parse(roomRaw);

    if (action === 'startGame') {
      if (room.players[0].id !== playerId) return sendError(ws, 'Only the host can start.');
      if (room.players.length < 2) return sendError(ws, 'Need at least 2 players.');
      room.gameState = createGame(room.players);
      room.started = true;
      await saveAndBroadcast(room, 'state');
      return;
    }

    if (action === 'playCard') {
      const r = applyCard(room.gameState, playerId, msg.cardIndex, msg.chosenSuit);
      if (r.error) return sendError(ws, r.error);
      await saveAndBroadcast(room, 'state');
      return;
    }

    if (action === 'drawCard') {
      const r = drawCard(room.gameState, playerId);
      if (r.error) return sendError(ws, r.error);
      await saveAndBroadcast(room, 'state');
      return;
    }

    if (action === 'endTurn') {
      const r = endTurn(room.gameState, playerId);
      if (r.error) return sendError(ws, r.error);
      await saveAndBroadcast(room, 'state');
      return;
    }

    if (action === 'restartGame') {
      if (room.players[0].id !== playerId) return sendError(ws, 'Only the host can restart.');
      room.gameState = createGame(room.players);
      await saveAndBroadcast(room, 'state');
      return;
    }
  });

  ws.on('close', async () => {
    if (playerId) {
      delete localConnections[playerId];
      deletePlayerPod(playerId);

      if (playerRoomCode) {
        const roomRaw = await redisClient.get(`room:${playerRoomCode}`);
        if (roomRaw) {
          const room = JSON.parse(roomRaw);
          const name = room.players.find(p => p.id === playerId)?.name || 'A player';
          room.players = room.players.filter(p => p.id !== playerId);

          if (room.players.length === 0) {
            await redisClient.del(`room:${playerRoomCode}`);
          } else {
            if (room.started && room.gameState) {
              if (room.gameState.hands && room.gameState.hands[playerId]) {
                delete room.gameState.hands[playerId];
              }
              room.gameState.playerOrder = room.gameState.playerOrder.filter(id => id !== playerId);
              if (room.gameState.current === playerId && room.gameState.playerOrder.length > 0)
                room.gameState.current = room.gameState.playerOrder[0];
              room.gameState.message = `${name} disconnected.`;
              await saveAndBroadcast(room, 'state');
            } else {
              await saveAndBroadcast(room, 'lobby');
            }
          }
        }
      }
    }
  });
});

httpServer.listen(PORT, () => {
  console.log('\n✅  Card Battle — Game Server');
  console.log(`    http://localhost:${PORT}`);
  console.log(`    Kubernetes: ${K8S_ENABLED ? `ENABLED  (ns: ${K8S_NAMESPACE}, image: ${K8S_PLAYER_IMAGE})` : 'DISABLED (local dev mode — pods will be simulated)'}`);
  console.log();
});