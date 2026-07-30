#!/bin/bash
# Arrête tous les port-forwards en tuant la session tmux entière.

SESSION="observability"

if tmux has-session -t "$SESSION" 2>/dev/null; then
    tmux kill-session -t "$SESSION"
    echo "Session tmux '$SESSION' arrêtée — tous les port-forwards sont coupés."
else
    echo "Aucune session tmux '$SESSION' active."
fi
