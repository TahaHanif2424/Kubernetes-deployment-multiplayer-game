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
 *
 * Everything else (card logic, game state, WebSocket protocol) is unchanged.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const WebSocket = require('ws');
const http      = require('http');
const https     = require('https');
const fs        = require('fs');
const path      = require('path');

const PORT             = parseInt(process.env.PORT             || '3000');
const K8S_ENABLED      = process.env.KUBERNETES_ENABLED        === 'true';
const K8S_NAMESPACE    = process.env.K8S_NAMESPACE             || 'card-battle';
const K8S_PLAYER_IMAGE = process.env.K8S_PLAYER_IMAGE          || 'card-battle-player:latest';
const GAME_SERVER_SVC  = process.env.GAME_SERVER_SVC           || 'game-server-service';

// ─── Kubernetes API helpers ───────────────────────────────────────────────────
// Inside a k8s pod the service-account token is auto-mounted at this path.
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
    const req  = https.request(
      {
        method,
        hostname: 'kubernetes.default.svc',
        path:     urlPath,
        headers:  {
          'Authorization': `Bearer ${K8S_TOKEN}`,
          'Content-Type':  'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
        },
        rejectUnauthorized: false
      },
      res => {
        let raw = '';
        res.on('data', c  => raw += c);
        res.on('end',  () => {
          try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// CHANGE 1 — spawn a lightweight pod for each player that joins
async function spawnPlayerPod(playerId, roomCode) {
  const podName = `player-${playerId}`;

  const manifest = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name:      podName,
      namespace: K8S_NAMESPACE,
      labels: { app: 'card-battle-player', playerId, roomCode }
    },
    spec: {
      restartPolicy: 'Never',
      containers: [{
        name:  'player-session',
        image: K8S_PLAYER_IMAGE,
        imagePullPolicy: 'Never',
        ports: [{ containerPort: 8080 }],
        env: [
          { name: 'PLAYER_ID',       value: playerId },
          { name: 'ROOM_CODE',       value: roomCode },
          { name: 'GAME_SERVER_URL', value: `ws://${GAME_SERVER_SVC}:${PORT}` }
        ],
        resources: {
          requests: { cpu: '50m',  memory: '64Mi'  },
          limits:   { cpu: '200m', memory: '128Mi' }
        }
      }]
    }
  };

  try {
    const res = await k8sRequest('POST', `/api/v1/namespaces/${K8S_NAMESPACE}/pods`, manifest);
    if (res.skipped) return;
    if (res.metadata) console.log(`[k8s] Pod created : ${podName}`);
    else              console.warn(`[k8s] Pod warning : ${res.message}`);
  } catch (err) {
    console.error(`[k8s] Pod create failed for ${playerId}:`, err.message);
  }
}

// CHANGE 2 — delete the pod when the player disconnects
async function deletePlayerPod(playerId) {
  const podName = `player-${playerId}`;
  try {
    await k8sRequest('DELETE', `/api/v1/namespaces/${K8S_NAMESPACE}/pods/${podName}`);
    if (K8S_ENABLED) console.log(`[k8s] Pod deleted : ${podName}`);
  } catch (err) {
    console.error(`[k8s] Pod delete failed for ${playerId}:`, err.message);
  }
}

// ─── HTTP server ──────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {

  // CHANGE 3 — health probe (Kubernetes livenessProbe / readinessProbe)
  if (req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: Object.keys(rooms).length }));
    return;
  }

  // CHANGE 4 — room listing (monitoring / demo dashboard)
  if (req.url === '/api/rooms') {
    const summary = Object.values(rooms).map(r => ({
      code:    r.code,
      started: r.started,
      players: r.players.map(p => ({ id: p.id, name: p.name, pod: `player-${p.id}` }))
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(summary));
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
const rooms = {};

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms[code] ? generateRoomCode() : code;
}

// ─── Card logic (UNCHANGED) ───────────────────────────────────────────────────
const SUITS        = ['S', 'H', 'D', 'C'];
const SUIT_SYMBOLS = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SPECIALS     = ['Skip', 'Rev', '+2'];

function makeDeck() {
  const d = [];
  SUITS.forEach(s => {
    ['2','3','4','5','6','7','8','9','10','J','Q','K','A'].forEach(v => d.push({ s, v }));
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
  if (gs.winner)                     return { error: 'Game already over.' };
  if (gs.current !== playerId)       return { error: 'Not your turn.' };
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
  const top  = gs.discard[gs.discard.length - 1];
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
  if (gs.drewThisTurn)         return { error: 'Already drew this turn.' };
  if (gs.pendingWild)          return { error: 'Choose a suit first.' };
  reshuffleIfNeeded(gs);
  if (gs.deck.length === 0)    return { error: 'No cards left!' };
  const card = gs.deck.splice(0, 1)[0];
  gs.hands[playerId].push(card);
  gs.drewThisTurn = true;
  gs.message = `Drew a card.${canPlay(card, gs.discard[gs.discard.length-1]) ? ' You can play it!' : ' No match — end your turn.'}`;
  return {};
}

function endTurn(gs, playerId) {
  if (gs.current !== playerId) return { error: 'Not your turn.' };
  if (!gs.drewThisTurn)        return { error: 'Draw a card first.' };
  nextPlayer(gs);
  gs.message = `${gs.current}'s turn.`;
  return {};
}

// CHANGE 5 — stateFor now includes podName for each player
function stateFor(room, playerId) {
  const gs = room.gameState;
  if (!gs) return null;
  return {
    type: 'state',
    hand:         gs.hands[playerId] || [],
    discard:      gs.discard[gs.discard.length - 1],
    deckCount:    gs.deck.length,
    current:      gs.current,
    direction:    gs.direction,
    pendingWild:  gs.pendingWild && gs.current === playerId,
    drewThisTurn: gs.drewThisTurn,
    winner:       gs.winner,
    message:      gs.message,
    players: room.players.map(p => ({
      id:        p.id,
      name:      p.name,
      cardCount: gs.hands[p.id]?.length ?? 0,
      isYou:     p.id === playerId,
      podName:   `player-${p.id}`        // visible in UI — proves isolation
    }))
  };
}

function broadcastState(room) {
  room.players.forEach(p => {
    if (p.ws.readyState === WebSocket.OPEN)
      p.ws.send(JSON.stringify(stateFor(room, p.id)));
  });
}

// CHANGE 6 — broadcastLobby now includes podName
function broadcastLobby(room) {
  const msg = JSON.stringify({
    type:     'lobby',
    roomCode: room.code,
    hostId:   room.players[0]?.id,
    players:  room.players.map(p => ({
      id:      p.id,
      name:    p.name,
      podName: `player-${p.id}`
    }))
  });
  room.players.forEach(p => {
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
  });
}

function sendError(ws, msg) {
  ws.send(JSON.stringify({ type: 'error', message: msg }));
}

// ─── WebSocket handler ────────────────────────────────────────────────────────
wss.on('connection', ws => {
  let playerRoomCode = null;
  let playerId       = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { action } = msg;

    // Create room
    if (action === 'createRoom') {
      const code = generateRoomCode();
      playerId       = 'p' + Math.random().toString(36).slice(2, 9);
      playerRoomCode = code;
      rooms[code]    = {
        code, started: false, gameState: null,
        players: [{ id: playerId, name: msg.name || 'Host', ws }]
      };
      ws.send(JSON.stringify({ type: 'created', roomCode: code, playerId }));
      broadcastLobby(rooms[code]);
      spawnPlayerPod(playerId, code);   // CHANGE 7 — spawn pod for host
      return;
    }

    // Join room
    if (action === 'joinRoom') {
      const code = msg.roomCode?.toUpperCase();
      const room  = rooms[code];
      if (!room)                    return sendError(ws, 'Room not found.');
      if (room.started)             return sendError(ws, 'Game already started.');
      if (room.players.length >= 6) return sendError(ws, 'Room is full (max 6).');
      playerId       = 'p' + Math.random().toString(36).slice(2, 9);
      playerRoomCode = code;
      room.players.push({ id: playerId, name: msg.name || `Player ${room.players.length + 1}`, ws });
      ws.send(JSON.stringify({ type: 'joined', roomCode: code, playerId }));
      broadcastLobby(room);
      spawnPlayerPod(playerId, code);   // CHANGE 8 — spawn pod for joiner
      return;
    }

    const room = rooms[playerRoomCode];
    if (!room) return sendError(ws, 'Not in a room.');

    if (action === 'startGame') {
      if (room.players[0].id !== playerId) return sendError(ws, 'Only the host can start.');
      if (room.players.length < 2)         return sendError(ws, 'Need at least 2 players.');
      room.gameState = createGame(room.players);
      room.started   = true;
      broadcastState(room);
      return;
    }

    if (action === 'playCard') {
      const r = applyCard(room.gameState, playerId, msg.cardIndex, msg.chosenSuit);
      if (r.error) return sendError(ws, r.error);
      broadcastState(room);
      return;
    }

    if (action === 'drawCard') {
      const r = drawCard(room.gameState, playerId);
      if (r.error) return sendError(ws, r.error);
      broadcastState(room);
      return;
    }

    if (action === 'endTurn') {
      const r = endTurn(room.gameState, playerId);
      if (r.error) return sendError(ws, r.error);
      broadcastState(room);
      return;
    }

    if (action === 'restartGame') {
      if (room.players[0].id !== playerId) return sendError(ws, 'Only the host can restart.');
      room.gameState = createGame(room.players);
      broadcastState(room);
      return;
    }
  });

  ws.on('close', () => {
    const room = rooms[playerRoomCode];
    if (!room) return;
    const name = room.players.find(p => p.id === playerId)?.name || 'A player';
    room.players = room.players.filter(p => p.id !== playerId);

    if (playerId) deletePlayerPod(playerId);   // CHANGE 9 — clean up pod

    if (room.players.length === 0) { delete rooms[playerRoomCode]; return; }

    if (room.started && room.gameState) {
      delete room.gameState.hands[playerId];
      room.gameState.playerOrder = room.gameState.playerOrder.filter(id => id !== playerId);
      if (room.gameState.current === playerId && room.gameState.playerOrder.length > 0)
        room.gameState.current = room.gameState.playerOrder[0];
      room.gameState.message = `${name} disconnected.`;
      broadcastState(room);
    } else {
      broadcastLobby(room);
    }
  });
});

httpServer.listen(PORT, () => {
  console.log('\n✅  Card Battle — Game Server');
  console.log(`    http://localhost:${PORT}`);
  console.log(`    Kubernetes: ${K8S_ENABLED ? `ENABLED  (ns: ${K8S_NAMESPACE}, image: ${K8S_PLAYER_IMAGE})` : 'DISABLED (local dev mode — pods will be simulated)'}`);
  console.log();
});
