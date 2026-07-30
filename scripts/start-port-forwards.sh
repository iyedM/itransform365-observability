#!/bin/bash
# Lance tous les port-forwards nécessaires en arrière-plan.
# Usage : ./start-port-forwards.sh

set -e

NAMESPACE="observability"
PID_FILE="$HOME/.port-forwards.pids"

# Nettoyage des anciens port-forwards s'ils tournent encore
if [ -f "$PID_FILE" ]; then
    echo "Arrêt des anciens port-forwards..."
    while read -r pid; do
        kill "$pid" 2>/dev/null || true
    done < "$PID_FILE"
    rm -f "$PID_FILE"
fi

> "$PID_FILE"

start_forward() {
    local service=$1
    local ports=$2
    local label=$3

    kubectl port-forward -n "$NAMESPACE" "svc/$service" "$ports" \
        > "/tmp/pf-${label}.log" 2>&1 &

    local pid=$!
    echo "$pid" >> "$PID_FILE"
    echo "  [$label] svc/$service $ports -> PID $pid (log: /tmp/pf-${label}.log)"
}

echo "Démarrage des port-forwards..."

start_forward "kube-prom-grafana" "3000:80" "grafana"
start_forward "otel-collector-opentelemetry-collector" "4317:4317" "otel-grpc"
start_forward "otel-collector-opentelemetry-collector" "8889:8889" "otel-metrics"
start_forward "demo-frontend" "8082:8082" "frontend"
start_forward "demo-api" "8081:8081" "api"
start_forward "kube-prom-kube-prometheus-prometheus" "9090:9090" "prometheus"
start_forward "kube-prom-kube-prometheus-alertmanager" "9093:9093" "alertmanager"
start_forward "loki-gateway" "3100:80" "loki"

sleep 2
echo ""
echo "Tous les port-forwards sont lancés. PIDs sauvegardés dans $PID_FILE"
echo ""
echo "Accès :"
echo "  Grafana       -> http://localhost:3000"
echo "  Prometheus    -> http://localhost:9090"
echo "  Alertmanager  -> http://localhost:9093"
echo "  demo-frontend -> http://localhost:8082"
echo "  demo-api      -> http://localhost:8081"
echo ""
echo "Pour tout arrêter : ./stop-port-forwards.sh"
