#!/bin/bash
# Lance tous les port-forwards dans une seule session tmux organisée en panneaux.
# Prérequis : sudo apt install tmux
# Usage : ./start-port-forwards-tmux.sh
# Pour revenir dessus plus tard : tmux attach -t observability

NAMESPACE="observability"
SESSION="observability"

# Si la session existe déjà, on s'y attache directement plutôt que d'en recréer une
if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "La session tmux '$SESSION' existe déjà. Connexion..."
    tmux attach -t "$SESSION"
    exit 0
fi

# Crée la session avec la première fenêtre/panneau : Grafana
tmux new-session -d -s "$SESSION" -n "observability" \
    "kubectl port-forward -n $NAMESPACE svc/kube-prom-grafana 3000:80"

# Découpe en panneaux successifs pour les autres services
tmux split-window -h -t "$SESSION" \
    "kubectl port-forward -n $NAMESPACE svc/otel-collector-opentelemetry-collector 4317:4317"

tmux split-window -v -t "$SESSION" \
    "kubectl port-forward -n $NAMESPACE svc/otel-collector-opentelemetry-collector 8889:8889"

tmux select-pane -t "$SESSION":0.0
tmux split-window -v -t "$SESSION" \
    "kubectl port-forward -n $NAMESPACE svc/demo-frontend 8082:8082"

tmux select-pane -t "$SESSION":0.1
tmux split-window -v -t "$SESSION" \
    "kubectl port-forward -n $NAMESPACE svc/demo-api 8081:8081"

tmux select-pane -t "$SESSION":0.2
tmux split-window -h -t "$SESSION" \
    "kubectl port-forward -n $NAMESPACE svc/kube-prom-kube-prometheus-prometheus 9090:9090"

tmux select-pane -t "$SESSION":0.4
tmux split-window -h -t "$SESSION" \
    "kubectl port-forward -n $NAMESPACE svc/kube-prom-kube-prometheus-alertmanager 9093:9093"

tmux split-window -v -t "$SESSION" \
    "kubectl port-forward -n $NAMESPACE svc/loki-gateway 3100:80"

# Réorganise proprement en grille (tiled = répartition égale façon mosaïque)
tmux select-layout -t "$SESSION" tiled

echo "Session tmux '$SESSION' créée avec les 8 port-forwards."
echo ""
echo "Connexion à la session..."
sleep 1
tmux attach -t "$SESSION"
