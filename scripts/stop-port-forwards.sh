#!/bin/bash
# Arrête tous les port-forwards lancés par start-port-forwards.sh

PID_FILE="$HOME/.port-forwards.pids"

if [ ! -f "$PID_FILE" ]; then
    echo "Aucun fichier de PIDs trouvé ($PID_FILE) — rien à arrêter."
    exit 0
fi

echo "Arrêt des port-forwards..."
while read -r pid; do
    if kill "$pid" 2>/dev/null; then
        echo "  PID $pid arrêté"
    else
        echo "  PID $pid déjà arrêté ou introuvable"
    fi
done < "$PID_FILE"

rm -f "$PID_FILE"
echo "Terminé."
