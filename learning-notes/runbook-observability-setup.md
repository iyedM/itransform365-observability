# Runbook complet — Setup Observability Stack (Phase 0-1)
### Toutes les commandes, dans l'ordre, pour reconstruire l'environnement de zéro

---

## 0. Prérequis système (une seule fois par machine)

Corrige la limite `inotify` — sans ça, les nœuds "agent" du cluster restent bloqués indéfiniment au démarrage dès qu'il y en a plus d'un :

```bash
sudo sysctl fs.inotify.max_user_instances=512
sudo sysctl fs.inotify.max_user_watches=524288
echo "fs.inotify.max_user_instances=512" | sudo tee -a /etc/sysctl.conf
echo "fs.inotify.max_user_watches=524288" | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

Installe les outils nécessaires :

```bash
# k3d
curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash
k3d version

# kubectl (si pas déjà installé)
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
chmod +x kubectl && sudo mv kubectl /usr/local/bin/
kubectl version --client

# Helm
curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
helm version
```

---

## 1. Créer le cluster local

```bash
k3d cluster create observability-lab \
  --agents 2 \
  --port "8090:80@loadbalancer" \
  --port "8453:443@loadbalancer" \
  --k3s-arg "--disable=traefik@server:0"
```

> Note : port 8080 était déjà pris par un autre conteneur sur cette machine, d'où l'usage de 8090/8453.

Vérifie :
```bash
docker ps -a --filter "name=k3d-observability-lab"
kubectl get nodes
```

Les 4 conteneurs (server-0, agent-0, agent-1, serverlb) doivent être "Up", et les 3 nœuds "Ready".

---

## 2. Créer le namespace dédié

```bash
kubectl create namespace observability
```

---

## 3. Ajouter les repos Helm nécessaires

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo add grafana https://grafana.github.io/helm-charts
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts
helm repo update
```

---

## 4. Déployer les métriques — kube-prometheus-stack

Crée le fichier de values :

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
```

Installe :
```bash
helm install kube-prom prometheus-community/kube-prometheus-stack \
  -n observability -f ~/iTransform365/clusters/local/kube-prometheus-values.yaml
```

Vérifie :
```bash
kubectl get pods -n observability
```

---

## 5. Déployer les logs — Loki

> Important : utiliser le chart `grafana/loki` (maintenu), PAS `grafana/loki-stack` (déprécié, version de Loki trop ancienne, incompatible avec Grafana récent).

Crée le fichier de values :

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
```

Installe :
```bash
helm install loki grafana/loki -n observability -f ~/iTransform365/clusters/local/loki-values.yaml
```

Vérifie :
```bash
kubectl get pods -n observability | grep loki
```

---

## 6. Déployer la collecte de logs — Grafana Alloy (DaemonSet)

Crée le fichier de values :

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
```

Installe :
```bash
helm install alloy grafana/alloy -n observability -f ~/iTransform365/clusters/local/alloy-values.yaml
```

Vérifie (doit montrer 3 Pods, un par nœud) :
```bash
kubectl get pods -n observability | grep alloy
```

---

## 7. Déployer les traces — Tempo

```bash
helm install tempo grafana/tempo -n observability \
  --set tempo.storage.trace.backend=local
```

Vérifie (StatefulSet, doit montrer `tempo-0`) :
```bash
kubectl get pods -n observability | grep tempo
kubectl get svc -n observability | grep tempo
```

> Port API de requête : 3200 (pas 3100, qui est celui de Loki). Port OTLP pour recevoir des traces : 4317 (grpc) / 4318 (http).

---

## 8. Déployer le pipeline central — OpenTelemetry Collector

Crée le fichier de values :

```bash
cat > ~/iTransform365/clusters/local/otel-collector-values.yaml << 'EOF'
mode: deployment
image:
  repository: "otel/opentelemetry-collector-contrib"
config:
  receivers:
    otlp:
      protocols:
        grpc: {}
        http: {}
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
```

Installe :
```bash
helm install otel-collector open-telemetry/opentelemetry-collector \
  -n observability -f ~/iTransform365/clusters/local/otel-collector-values.yaml
```

Vérifie (Deployment) :
```bash
kubectl get pods -n observability | grep otel
```

> Points d'attention rencontrés : `image.repository` doit être défini explicitement dans les versions récentes du chart ; l'exporter `loki` n'existe pas dans le Collector Contrib récent, utiliser `otlphttp` à la place ; les protocoles `grpc`/`http` doivent avoir `{}` explicite, pas juste vide.

---

## 9. Déployer le profiling — Pyroscope

```bash
helm install pyroscope grafana/pyroscope -n observability
```

Vérifie (StatefulSet, doit montrer `pyroscope-0` et `pyroscope-alloy-0`) :
```bash
kubectl get pods -n observability | grep pyroscope
```

---

## 10. Accéder à Grafana

```bash
kubectl port-forward -n observability svc/kube-prom-grafana 3000:80
```

Ouvrir `http://localhost:3000` — identifiant `admin`, mot de passe `admin`.

### Ajouter les data sources dans Grafana (Connections → Data sources → Add data source)

| Data source | URL |
|---|---|
| Prometheus | `http://kube-prom-kube-prometheus-prometheus:9090` |
| Loki | `http://loki-gateway` (+ header HTTP `X-Scope-OrgID: foo`) |
| Tempo | `http://tempo:3200` |
| Pyroscope | `http://pyroscope.observability.svc.cluster.local.:4040` |

---

## 11. Vérifications rapides (santé de la stack)

```bash
# Tous les Pods de la stack
kubectl get pods -n observability

# Test rapide Prometheus (dans Grafana → Explore → Prometheus)
# requête : up

# Test rapide Loki (dans Grafana → Explore → Loki)
# requête : {namespace="observability"}

# Test manuel d'envoi de logs vers Loki (sans passer par Alloy)
kubectl port-forward -n observability svc/loki-gateway 3100:80 &
curl -H "Content-Type: application/json" -XPOST -s "http://127.0.0.1:3100/loki/api/v1/push" \
  --data-raw "{\"streams\": [{\"stream\": {\"job\": \"test\"}, \"values\": [[\"$(date +%s)000000000\", \"fizzbuzz\"]]}]}" \
  -H X-Scope-OrgId:foo

curl "http://127.0.0.1:3100/loki/api/v1/query_range" --data-urlencode 'query={job="test"}' -H X-Scope-OrgId:foo
```

---

## 12. Nettoyage / suppression complète (si besoin de repartir de zéro)

```bash
helm uninstall pyroscope -n observability
helm uninstall otel-collector -n observability
helm uninstall tempo -n observability
helm uninstall alloy -n observability
helm uninstall loki -n observability
helm uninstall kube-prom -n observability
kubectl delete namespace observability

# Supprimer le cluster complet
k3d cluster delete observability-lab
```

---

## 13. Cycle Git de routine (à chaque étape terminée)

```bash
cd ~/iTransform365
git add .
git commit -m "message décrivant ce qui a changé"
git push
```

(SSH déjà configuré, pas besoin de retaper d'identifiants)

---

## État actuel de la stack (au moment de la rédaction de ce fichier)

- ✅ Cluster k3d (observability-lab, 3 nœuds)
- ✅ Metrics — Prometheus + Grafana + Alertmanager
- ✅ Logs — Loki (SingleBinary) + Grafana Alloy (DaemonSet)
- ✅ Traces — Tempo (StatefulSet)
- ✅ Profiling — Pyroscope (StatefulSet) + Alloy dédié (StatefulSet)
- ✅ Pipeline central — OpenTelemetry Collector (Deployment)
- ❌ Application démo instrumentée — pas encore construite (prochaine étape)
- ❌ SLIs/SLOs + règles d'alerte concrètes
- ❌ Exemplars (lien metrics↔traces)
