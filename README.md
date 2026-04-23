# Kubernetes-deployment-multiplayer-game
Created a multiplayer Uno game that is deployed on kubernetes and it demonstrates the concept of  Parallel and distributed computing. It contain a single server and it will spin up a pod if a new player joins so that the overall load on the server remain the same.


# 1. Build the Game Server image
docker build -t card-battle-server:latest -f Dockerfile .
# 2. Build the Player Pod image
docker build -t card-battle-player:latest -f player.Dockerfile .

kind load docker-image card-battle-server:latest --name card-battle
kind load docker-image card-battle-player:latest --name card-battle

<!-- To check the pods: -->
kubectl get pods -n card-battle

<!-- To forward the port: -->
kubectl port-forward svc/game-server-service 3000:3000 -n card-battle --address 0.0.0.0
