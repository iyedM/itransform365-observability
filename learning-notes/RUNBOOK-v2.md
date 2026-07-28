# Runbook complet v2 — Setup Observability Stack + App Démo
### Toutes les commandes, dans l'ordre, du cluster vide jusqu'à une app instrumentée envoyant des traces

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
# kubectl : déjà présent sur la plupart des setups modernes, sinon voir doc officielle
```

---

## 1. Cluster local

```bash
k3d cluster create observability-lab \
  --agents 2 \
  --port "8090:80@loadbalancer" \
  --port "8453:443@loadbalancer" \
  --k3s-arg "--disable=traefik@server:0"

kubectl create namespace observability
```

---

## 2. Repos Helm

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo add grafana https://grafana.github.io/helm-charts
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts
helm repo update
```

---

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

---

## 4. Logs — Loki (chart maintenu `grafana/loki`, PAS `loki-stack`)

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

---

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

---

## 6. Traces — Tempo (StatefulSet)

```bash
helm install tempo grafana/tempo -n observability \
  --set tempo.storage.trace.backend=local
```

> Port API de requête : **3200** (pas 3100, réservé à Loki). Port OTLP entrant : 4317 (grpc) / 4318 (http).

---

## 7. Pipeline central — OpenTelemetry Collector

```bash
cat > ~/iTransform365/clusters/local/otel-collector-values.yaml << 'EOF'
mode: deployment
image:
  repository: "otel/opentelemetry-collector-contrib"
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

> Points critiques (sinon `connection refused` en port-forward et échec d'envoi des données) :
> - `image.repository` doit être défini explicitement (versions récentes du chart l'exigent)
> - L'exporter `loki` n'existe pas dans le Collector Contrib récent → utiliser `otlphttp` pointé vers `/otlp`
> - `grpc:`/`http:` doivent avoir un `endpoint: 0.0.0.0:PORT` **explicite** — sans ça, le Collector se lie à l'IP interne du Pod au lieu de toutes les interfaces, et `kubectl port-forward` échoue avec "connection refused"

---

## 8. Profiling — Pyroscope (StatefulSet)

```bash
helm install pyroscope grafana/pyroscope -n observability
```

---

## 9. Accès Grafana + Data sources

```bash
kubectl port-forward -n observability svc/kube-prom-grafana 3000:80
```
`http://localhost:3000` — admin/admin

| Data source | URL | Notes |
|---|---|---|
| Prometheus | `http://kube-prom-kube-prometheus-prometheus:9090` | |
| Loki | `http://loki-gateway` | Header HTTP requis : `X-Scope-OrgID: foo` |
| Tempo | `http://tempo:3200` | |
| Pyroscope | `http://pyroscope.observability.svc.cluster.local.:4040` | |

---

## 10. App démo — service `demo-api` (Python/Flask, instrumenté OpenTelemetry)

### Structure et code

```bash
mkdir -p ~/iTransform365/demo-app/api
cd ~/iTransform365/demo-app/api

cat > app.py << 'EOF'
import time
import random
from flask import Flask, jsonify

app = Flask(__name__)

@app.route("/work")
def work():
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
EOF
```

> Port 8081 utilisé plutôt que 8080 — 8080 est déjà pris par un autre conteneur sur cette machine.

### Environnement Python isolé

```bash
sudo apt install python3.12-venv   # si le module venv n'est pas déjà présent
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
opentelemetry-bootstrap -a install
```

> Si `opentelemetry-bootstrap` échoue avec `ModuleNotFoundError: No module named 'pkg_resources'` : `pip install setuptools==75.1.0` puis retenter.

### Lancer l'app avec auto-instrumentation

**Terminal A** — port-forward vers le Collector (rester ouvert) :
```bash
kubectl port-forward -n observability svc/otel-collector-opentelemetry-collector 4317:4317
```

**Terminal B** — l'app elle-même :
```bash
cd ~/iTransform365/demo-app/api
source venv/bin/activate
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
export OTEL_SERVICE_NAME=demo-api
export OTEL_EXPORTER_OTLP_PROTOCOL=grpc
opentelemetry-instrument python app.py
```

**Terminal C** — générer du trafic :
```bash
for i in {1..10}; do curl -s http://localhost:8081/work; echo; done
```

### Vérifier les traces dans Grafana

Explore → tempo → onglet **Search** → Service Name = `demo-api` → Run query

---

## 11. Vérifications rapides (santé globale)

```bash
kubectl get pods -n observability
```

Test manuel Loki (sans passer par Alloy) :
```bash
kubectl port-forward -n observability svc/loki-gateway 3100:80 &
curl -H "Content-Type: application/json" -XPOST -s "http://127.0.0.1:3100/loki/api/v1/push" \
  --data-raw "{\"streams\": [{\"stream\": {\"job\": \"test\"}, \"values\": [[\"$(date +%s)000000000\", \"fizzbuzz\"]]}]}" \
  -H X-Scope-OrgId:foo

curl "http://127.0.0.1:3100/loki/api/v1/query_range" --data-urlencode 'query={job="test"}' -H X-Scope-OrgId:foo
```

Requêtes utiles dans Grafana Explore :
- Prometheus : `up`
- Loki : `{namespace="observability"}`
- Tempo : Search → Service Name = `demo-api`

---

## 12. Nettoyage complet

```bash
helm uninstall pyroscope otel-collector tempo alloy loki kube-prom -n observability
kubectl delete namespace observability
k3d cluster delete observability-lab
```

---

## 13. Cycle Git de routine

```bash
cd ~/iTransform365
git add .
git commit -m "message décrivant ce qui a changé"
git push
```

---

## État de la stack à ce stade

- ✅ Cluster k3d (3 nœuds)
- ✅ Metrics — Prometheus + Grafana + Alertmanager
- ✅ Logs — Loki (SingleBinary) + Alloy (DaemonSet)
- ✅ Traces — Tempo (StatefulSet), **validé avec de vraies traces de `demo-api`**
- ✅ Profiling — Pyroscope (StatefulSet), pas encore branché à une app
- ✅ Pipeline central — OTel Collector (Deployment), **validé pour les traces**, metrics/logs de l'app pas encore vérifiés
- ✅ App démo — `demo-api` (Flask + auto-instrumentation OpenTelemetry), tourne en local sur la machine (pas encore dans le cluster)
- ❌ Service frontend (2ème service de l'app démo)
- ❌ SLIs/SLOs + règles d'alerte
- ❌ Exemplars
