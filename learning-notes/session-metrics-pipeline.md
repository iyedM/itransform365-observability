# Session — Vérification du pipeline Metrics + décision sur les Logs applicatifs

Suite du RUNBOOK-v2.md — reprend là où on s'était arrêté (traces validées), couvre la vérification des métriques de `demo-api` de bout en bout jusqu'à Prometheus.

---

## 1. Exposer le port metrics du Collector

Le chart Helm ne crée par défaut un port sur le Service que pour ce qu'il connaît (OTLP grpc/http, Jaeger...). L'exporter Prometheus qu'on avait ajouté nous-mêmes (`0.0.0.0:8889`) n'était pas exposé sur le Service tant qu'on ne le déclare pas explicitement.

Vérifier la structure exacte attendue par le chart (au lieu de deviner) :
```bash
helm show values open-telemetry/opentelemetry-collector | grep -A 15 "^ports:"
```

Fichier de values corrigé (ajout du bloc `ports:`) :
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

# TOUJOURS vérifier le contenu avant d'appliquer (heredoc a parfois échoué silencieusement dans cette session)
cat ~/iTransform365/clusters/local/otel-collector-values.yaml

helm upgrade otel-collector open-telemetry/opentelemetry-collector \
  -n observability -f ~/iTransform365/clusters/local/otel-collector-values.yaml
```

Vérifier que le port apparaît sur le Service :
```bash
kubectl get svc otel-collector-opentelemetry-collector -n observability
```

---

## 2. Tester manuellement l'endpoint metrics

Nécessite **deux port-forwards actifs en même temps, dans des terminaux séparés** (un port-forward par processus/terminal, ne pas réutiliser le même terminal pour deux tunnels) :

**Terminal A** (dédié) :
```bash
kubectl port-forward -n observability svc/otel-collector-opentelemetry-collector 4317:4317
```

**Terminal B** (dédié) :
```bash
kubectl port-forward -n observability svc/otel-collector-opentelemetry-collector 8889:8889
```

**Terminal C** — l'app :
```bash
cd ~/iTransform365/demo-app/api
source venv/bin/activate
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
export OTEL_SERVICE_NAME=demo-api
export OTEL_EXPORTER_OTLP_PROTOCOL=grpc
opentelemetry-instrument python app.py
```

**Terminal D** — trafic + vérification :
```bash
for i in {1..10}; do curl -s http://localhost:8081/work; echo; done
sleep 20
curl -s http://localhost:8889/metrics | grep -i "flask\|http_server\|duration"
```

> Résultat attendu : des lignes `http_server_duration_milliseconds_bucket` / `_sum` / `_count`, groupées par `http_status_code="200"` et `http_status_code="500"` — un histogramme Prometheus natif, prêt pour calculer des percentiles de latence plus tard.

---

## 3. Faire scraper l'endpoint par Prometheus — ServiceMonitor

Prometheus (via kube-prometheus-stack / Prometheus Operator) fonctionne en modèle **pull** : il ne reçoit jamais rien passivement, il faut lui dire explicitement quoi scraper, via un CRD `ServiceMonitor`.

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

> Point critique : le label `release: kube-prom` doit correspondre à ce que le Prometheus Operator surveille (`serviceMonitorSelector`) — sans ce label, le ServiceMonitor est ignoré silencieusement, sans erreur visible.

Vérifier que Prometheus a bien pris en compte la cible :
```bash
kubectl get servicemonitor -n observability
kubectl port-forward -n observability svc/kube-prom-kube-prometheus-prometheus 9090:9090
# puis ouvrir http://localhost:9090/targets et chercher "otel-collector-metrics" -> doit être "1/1 up"
```

---

## 4. Interroger les métriques dans Grafana

Explore → Prometheus → requête :
```
http_server_duration_milliseconds_count{http_target="/work"}
```

> Résultat obtenu : deux séries constantes (9 requêtes `http_status_code="200"`, 1 requête `http_status_code="500"`), avec le label `exported_job="demo-api"` (pas `job`, qui lui identifie le scrape Prometheus lui-même, `otel-collector-opentelemetry-collector`).

---

## 5. Décision sur les logs applicatifs de `demo-api` — reportée à la containerisation

**Constat** : `demo-api` n'envoie actuellement aucun log via OTLP — Flask logue juste sur `stdout`. L'auto-instrumentation OpenTelemetry ne capture pas automatiquement les logs Python sans configuration supplémentaire (contrairement aux traces/metrics, branchées automatiquement).

**Deux options considérées :**
1. Ajouter l'instrumentation logging OpenTelemetry (quelques lignes de code) pour router les logs vers OTLP → Collector → Loki, dès maintenant
2. Attendre la containerisation de l'app (prochaine étape du plan) — une fois en Pod, Alloy capte automatiquement le `stdout` du conteneur, comme il le fait déjà pour tous les autres composants de la stack

**Décision : option 2.**

**Justification** :
- Une fois containerisée, la collecte de logs est un effet de bord gratuit de l'architecture déjà en place (Alloy DaemonSet) — aucun travail supplémentaire
- Faire l'option 1 maintenant créerait un double chemin de collecte (OTLP direct + stdout via Alloy) qui coexisterait inutilement après la containerisation — travail à moitié jeté
- C'est aussi le pattern standard de l'industrie : en Kubernetes, la collecte de logs applicatifs se fait presque toujours via stdout + agent de collecte, pas via export OTLP direct depuis le code de l'app

---

## Sauvegarde Git de cette session

```bash
cd ~/iTransform365
git add clusters/local/otel-collector-values.yaml demo-app/otel-collector-servicemonitor.yaml
git commit -m "fix: expose otel-collector metrics port (8889); add ServiceMonitor so Prometheus scrapes demo-api metrics; validate metrics pipeline end-to-end"
git push
```

---

## État du pipeline OTel Collector — bilan complet

| Signal | Chemin | Statut |
|---|---|---|
| Traces | app → OTLP → Collector → Tempo | ✅ Validé (traces visibles dans Grafana/Tempo) |
| Metrics | app → OTLP → Collector → exporter Prometheus (8889) → scrape ServiceMonitor → Prometheus | ✅ Validé (visible dans Grafana/Prometheus) |
| Logs applicatifs | *(reporté)* — sera : Pod stdout → Alloy (DaemonSet) → Loki, une fois containerisé | ⏳ Prévu à l'étape suivante |

## Prochaine étape du plan

Containeriser `demo-api` (Dockerfile + déploiement Kubernetes), ce qui va aussi résoudre la collecte de logs applicatifs comme effet de bord.
