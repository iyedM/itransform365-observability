# Runbook Final — Reconstruction complète de la stack (Phase 0 → Phase 1 terminée)

---

## 0. Prérequis système (une seule fois par machine)

```bash
sudo sysctl fs.inotify.max_user_instances=512
sudo sysctl fs.inotify.max_user_watches=524288
echo "fs.inotify.max_user_instances=512" | sudo tee -a /etc/sysctl.conf
echo "fs.inotify.max_user_watches=524288" | sudo tee -a /etc/sysctl.conf
sudo sysctl -p

curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash
curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
# kubectl et docker : voir doc officielle si absents
```

## 1. Cluster + namespace

```bash
k3d cluster create observability-lab \
  --agents 2 \
  --port "8090:80@loadbalancer" \
  --port "8453:443@loadbalancer" \
  --k3s-arg "--disable=traefik@server:0"

kubectl create namespace observability
```

## 2. Repos Helm

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo add grafana https://grafana.github.io/helm-charts
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts
helm repo update
```

## 3. Metrics — kube-prometheus-stack

```bash
mkdir -p ~/iTransform365/clusters/local
cat > ~/iTransform365/clusters/local/kube-prometheus-values.yaml << 'EOF'
grafana:
  adminPassword: admin
  service:
    type: ClusterIP
prometheus:
  prometheusSpec:
    retention: 3d
    resources:
      requests:
        cpu: 200m
        memory: 512Mi
alertmanager:
  alertmanagerSpec:
    resources:
      requests:
        cpu: 50m
        memory: 128Mi
EOF

helm install kube-prom prometheus-community/kube-prometheus-stack \
  -n observability -f ~/iTransform365/clusters/local/kube-prometheus-values.yaml
```

## 4. Logs — Loki (chart maintenu, PAS loki-stack)

```bash
cat > ~/iTransform365/clusters/local/loki-values.yaml << 'EOF'
deploymentMode: SingleBinary
loki:
  commonConfig:
    replication_factor: 1
  storage:
    type: filesystem
  useTestSchema: true
singleBinary:
  replicas: 1
backend:
  replicas: 0
read:
  replicas: 0
write:
  replicas: 0
EOF

helm install loki grafana/loki -n observability -f ~/iTransform365/clusters/local/loki-values.yaml
```

## 5. Collecte de logs — Grafana Alloy (DaemonSet)

```bash
cat > ~/iTransform365/clusters/local/alloy-values.yaml << 'EOF'
alloy:
  configMap:
    content: |
      discovery.kubernetes "pods" {
        role = "pod"
      }
      discovery.relabel "pods" {
        targets = discovery.kubernetes.pods.targets
        rule {
          source_labels = ["__meta_kubernetes_namespace"]
          target_label  = "namespace"
        }
        rule {
          source_labels = ["__meta_kubernetes_pod_name"]
          target_label  = "pod"
        }
        rule {
          source_labels = ["__meta_kubernetes_pod_container_name"]
          target_label  = "container"
        }
      }
      loki.source.kubernetes "pods" {
        targets    = discovery.relabel.pods.output
        forward_to = [loki.write.default.receiver]
      }
      loki.write "default" {
        endpoint {
          url = "http://loki-gateway.observability.svc.cluster.local/loki/api/v1/push"
          headers = {
            "X-Scope-OrgID" = "foo",
          }
        }
      }
controller:
  type: daemonset
EOF

helm install alloy grafana/alloy -n observability -f ~/iTransform365/clusters/local/alloy-values.yaml
```

## 6. Traces — Tempo

```bash
helm install tempo grafana/tempo -n observability \
  --set tempo.storage.trace.backend=local
```

## 7. Pipeline central — OpenTelemetry Collector

```bash
cat > ~/iTransform365/clusters/local/otel-collector-values.yaml << 'EOF'
mode: deployment
image:
  repository: "otel/opentelemetry-collector-contrib"
ports:
  metrics:
    enabled: true
    containerPort: 8889
    servicePort: 8889
    protocol: TCP
config:
  receivers:
    otlp:
      protocols:
        grpc:
          endpoint: 0.0.0.0:4317
        http:
          endpoint: 0.0.0.0:4318
  exporters:
    prometheus:
      endpoint: "0.0.0.0:8889"
    otlphttp/loki:
      endpoint: "http://loki-gateway.observability.svc.cluster.local/otlp"
      headers:
        X-Scope-OrgID: foo
    otlp/tempo:
      endpoint: "tempo:4317"
      tls:
        insecure: true
  service:
    pipelines:
      metrics:
        receivers: [otlp]
        exporters: [prometheus]
      logs:
        receivers: [otlp]
        exporters: [otlphttp/loki]
      traces:
        receivers: [otlp]
        exporters: [otlp/tempo]
EOF

helm install otel-collector open-telemetry/opentelemetry-collector \
  -n observability -f ~/iTransform365/clusters/local/otel-collector-values.yaml
```

## 8. Profiling — Pyroscope

```bash
helm install pyroscope grafana/pyroscope -n observability
```

## 9. ServiceMonitor pour scraper les metrics du Collector

```bash
mkdir -p ~/iTransform365/demo-app
cat > ~/iTransform365/demo-app/otel-collector-servicemonitor.yaml << 'EOF'
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: otel-collector-metrics
  namespace: observability
  labels:
    release: kube-prom
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: opentelemetry-collector
  endpoints:
    - port: metrics
      interval: 15s
EOF

kubectl apply -f ~/iTransform365/demo-app/otel-collector-servicemonitor.yaml
```

## 10. App démo — demo-api

```bash
mkdir -p ~/iTransform365/demo-app/api
cd ~/iTransform365/demo-app/api

cat > app.py << 'EOF'
import time
import random
import pyroscope
from flask import Flask, jsonify

pyroscope.configure(
    application_name="demo-api",
    server_address="http://pyroscope.observability.svc.cluster.local:4040",
)

app = Flask(__name__)

@app.route("/work")
def work():
    with pyroscope.tag_wrapper({"endpoint": "work"}):
        duration = random.uniform(0.05, 0.4)
        time.sleep(duration)
        if random.random() < 0.1:
            return jsonify({"error": "something went wrong"}), 500
        return jsonify({"status": "ok", "duration_ms": round(duration * 1000)})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8081)
EOF

cat > requirements.txt << 'EOF'
flask==3.0.3
opentelemetry-distro==0.48b0
opentelemetry-exporter-otlp==1.27.0
pyroscope-io==0.8.11
EOF

cat > Dockerfile << 'EOF'
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir setuptools==75.1.0 && \
    pip install --no-cache-dir -r requirements.txt && \
    opentelemetry-bootstrap -a install
COPY app.py .
EXPOSE 8081
CMD ["opentelemetry-instrument", "python", "app.py"]
EOF

docker build -t demo-api:v2 .
k3d image import demo-api:v2 -c observability-lab
```

Manifeste Kubernetes :
```bash
mkdir -p ~/iTransform365/demo-app/k8s
cat > ~/iTransform365/demo-app/k8s/demo-api-deployment.yaml << 'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: demo-api
  namespace: observability
  labels:
    app: demo-api
spec:
  replicas: 1
  selector:
    matchLabels:
      app: demo-api
  template:
    metadata:
      labels:
        app: demo-api
    spec:
      containers:
        - name: demo-api
          image: demo-api:v2
          imagePullPolicy: Never
          ports:
            - containerPort: 8081
          env:
            - name: OTEL_EXPORTER_OTLP_ENDPOINT
              value: "http://otel-collector-opentelemetry-collector.observability.svc.cluster.local:4317"
            - name: OTEL_SERVICE_NAME
              value: "demo-api"
            - name: OTEL_EXPORTER_OTLP_PROTOCOL
              value: "grpc"
---
apiVersion: v1
kind: Service
metadata:
  name: demo-api
  namespace: observability
spec:
  selector:
    app: demo-api
  ports:
    - port: 8081
      targetPort: 8081
EOF

kubectl apply -f ~/iTransform365/demo-app/k8s/demo-api-deployment.yaml
```

## 11. App démo — demo-frontend

```bash
mkdir -p ~/iTransform365/demo-app/frontend
cd ~/iTransform365/demo-app/frontend

cat > app.py << 'EOF'
import requests
from flask import Flask, jsonify

app = Flask(__name__)
API_URL = "http://demo-api.observability.svc.cluster.local:8081/work"

@app.route("/")
def index():
    try:
        response = requests.get(API_URL, timeout=5)
        return jsonify({
            "frontend_status": "ok",
            "api_response": response.json(),
            "api_status_code": response.status_code
        })
    except requests.exceptions.RequestException as e:
        return jsonify({"frontend_status": "error", "detail": str(e)}), 502

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8082)
EOF

cat > requirements.txt << 'EOF'
flask==3.0.3
requests==2.32.3
opentelemetry-distro==0.48b0
opentelemetry-exporter-otlp==1.27.0
EOF

cat > Dockerfile << 'EOF'
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir setuptools==75.1.0 && \
    pip install --no-cache-dir -r requirements.txt && \
    opentelemetry-bootstrap -a install
COPY app.py .
EXPOSE 8082
CMD ["opentelemetry-instrument", "python", "app.py"]
EOF

docker build -t demo-frontend:v1 .
k3d image import demo-frontend:v1 -c observability-lab
```

```bash
cat > ~/iTransform365/demo-app/k8s/demo-frontend-deployment.yaml << 'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: demo-frontend
  namespace: observability
  labels:
    app: demo-frontend
spec:
  replicas: 1
  selector:
    matchLabels:
      app: demo-frontend
  template:
    metadata:
      labels:
        app: demo-frontend
    spec:
      containers:
        - name: demo-frontend
          image: demo-frontend:v1
          imagePullPolicy: Never
          ports:
            - containerPort: 8082
          env:
            - name: OTEL_EXPORTER_OTLP_ENDPOINT
              value: "http://otel-collector-opentelemetry-collector.observability.svc.cluster.local:4317"
            - name: OTEL_SERVICE_NAME
              value: "demo-frontend"
            - name: OTEL_EXPORTER_OTLP_PROTOCOL
              value: "grpc"
---
apiVersion: v1
kind: Service
metadata:
  name: demo-frontend
  namespace: observability
spec:
  selector:
    app: demo-frontend
  ports:
    - port: 8082
      targetPort: 8082
EOF

kubectl apply -f ~/iTransform365/demo-app/k8s/demo-frontend-deployment.yaml
```

## 12. SLO + Alerte

```bash
cat > ~/iTransform365/demo-app/k8s/demo-api-alerts.yaml << 'EOF'
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: demo-api-slo
  namespace: observability
  labels:
    release: kube-prom
spec:
  groups:
    - name: demo-api-slo
      rules:
        - alert: DemoAPIHighErrorRate
          expr: |
            sum(rate(http_server_duration_milliseconds_count{exported_job="demo-api", http_status_code="500"}[5m]))
            /
            sum(rate(http_server_duration_milliseconds_count{exported_job="demo-api"}[5m]))
            > 0.05
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "Taux d'erreur élevé sur demo-api"
            description: "Le taux d'erreur de demo-api dépasse 5% depuis plus de 2 minutes (valeur actuelle : {{ $value | humanizePercentage }})"
EOF

kubectl apply -f ~/iTransform365/demo-app/k8s/demo-api-alerts.yaml
```

## 13. Accès et vérifications

```bash
# Grafana
kubectl port-forward -n observability svc/kube-prom-grafana 3000:80
# http://localhost:3000 -- admin/admin

# Frontend de test
kubectl port-forward -n observability svc/demo-frontend 8082:8082

# Trafic de test
for i in {1..30}; do curl -s http://localhost:8082/ > /dev/null; done

# Prometheus UI directe
kubectl port-forward -n observability svc/kube-prom-kube-prometheus-prometheus 9090:9090
# http://localhost:9090/targets  et  /alerts

# Alertmanager UI directe
kubectl port-forward -n observability svc/kube-prom-kube-prometheus-alertmanager 9093:9093
# http://localhost:9093
```

### Data sources Grafana

| Data source | URL | Note |
|---|---|---|
| Prometheus | `http://kube-prom-kube-prometheus-prometheus:9090` | |
| Loki | `http://loki-gateway` | Header `X-Scope-OrgID: foo` requis |
| Tempo | `http://tempo:3200` | Port 3200, pas 3100 |
| Pyroscope | `http://pyroscope.observability.svc.cluster.local:4040` | |

### Requêtes de vérification

```
# Prometheus
up
http_server_duration_milliseconds_count{exported_job="demo-api"}

# Loki
{namespace="observability", pod=~"demo-api.*"}

# Tempo (onglet Search)
Service Name = demo-api  (ou demo-frontend pour voir les traces multi-services)

# Pyroscope
{service_name="demo-api"}
```

## 14. Nettoyage complet

```bash
helm uninstall pyroscope otel-collector tempo alloy loki kube-prom -n observability
kubectl delete -f ~/iTransform365/demo-app/k8s/
kubectl delete namespace observability
k3d cluster delete observability-lab
```

## 15. Cycle Git de routine

```bash
cd ~/iTransform365
git add .
git commit -m "message"
git push
```
