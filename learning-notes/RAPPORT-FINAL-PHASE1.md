# Rapport Final — Phase 1 Observability
### iTransform365 / AIZO Suite — De zéro à une stack complète et validée

---

## 1. Résumé exécutif

Ce rapport couvre l'intégralité de la Phase 1 du projet d'observabilité : mise en place des 4 piliers (metrics, logs, traces, profiling), déploiement d'une application démo multi-services instrumentée, et validation d'un cycle SLI/SLO/alerting complet — le tout sur un cluster Kubernetes local (k3d), reproductible à l'identique sur OVH.

**État final :**
- ✅ 4 piliers d'observabilité déployés et validés avec de vraies données
- ✅ Application démo à 2 services (`demo-frontend` → `demo-api`), containerisée, tournant dans le cluster
- ✅ Traces distribuées multi-services avec propagation de contexte W3C
- ✅ Pipeline OpenTelemetry Collector centralisant metrics/logs/traces
- ✅ SLO d'erreur avec règle d'alerte Prometheus validée en conditions réelles (Pending → Firing)
- ✅ Profiling continu (Pyroscope) avec flamegraph du vrai code applicatif

---

## 2. Chronologie du projet

### Phase 0 — Setup de l'environnement local
- Installation des outils : Docker, k3d, kubectl, Helm
- Création du cluster k3d `observability-lab` (1 server + 2 agents)
- Résolution d'un bug système critique : limite `inotify` par défaut (128) trop basse pour faire tourner plusieurs nœuds k3d simultanément — corrigée en portant la limite à 512/524288 via `sysctl`
- Configuration Git + SSH pour versionner tout le travail

### Phase 1.1 — Déploiement des 4 piliers
- **Metrics** : kube-prometheus-stack (Prometheus + Grafana + Alertmanager + node-exporter + kube-state-metrics)
- **Logs** : Loki (chart `grafana/loki`, pas le `loki-stack` déprécié) + Grafana Alloy (DaemonSet) pour la collecte
- **Traces** : Tempo (StatefulSet, stockage local)
- **Profiling** : Pyroscope (StatefulSet)
- **Pipeline central** : OpenTelemetry Collector (Deployment), routant OTLP vers les 3 premiers backends

### Phase 1.2 — Application démo
- `demo-api` (Flask, Python), instrumentée avec auto-instrumentation OpenTelemetry
- `demo-frontend` (Flask, Python), appelant `demo-api`, démontrant la propagation de trace multi-services
- Containerisation des deux services (Dockerfile + manifestes Kubernetes), déploiement dans le cluster
- Ajout du SDK Pyroscope (modèle push) pour le profiling CPU

### Phase 1.3 — Validation opérationnelle
- Vérification systématique des 4 signaux (metrics, logs, traces, profils) avec de vraies données de bout en bout
- Définition d'un SLI (taux d'erreur), d'un SLO (>5% pendant 2 min), et d'une règle d'alerte Prometheus
- Test en conditions réelles : génération de trafic continu, observation du cycle complet Pending → Firing

---

## 3. Incidents rencontrés et résolus (par ordre chronologique)

| # | Incident | Cause racine | Résolution |
|---|---|---|---|
| 1 | Conflit de port 8080 au lancement du cluster | Un autre conteneur (`web_nginx`) occupait déjà le port | Cluster recréé avec ports 8090/8453 |
| 2 | Suppression de cluster incomplète | Suppression Docker asynchrone, résidus (conteneurs/volumes/réseaux) | Nettoyage manuel forcé avant recréation |
| 3 | Agents k3d bloqués indéfiniment au démarrage | Limite système `fs.inotify.max_user_instances` (128) insuffisante pour plusieurs nœuds | `sysctl` porté à 512/524288, rendu permanent |
| 4 | Cluster disparu sans explication | Cause jamais identifiée avec certitude (probable suppression manuelle accidentelle pendant les tests) | Nettoyage du kubeconfig fantôme, recréation |
| 5 | Grafana ne peut pas se connecter à Loki | Chart `grafana/loki-stack` déprécié, déployait Loki 2.6.1 (2022), incompatible avec Grafana récent | Migration vers le chart maintenu `grafana/loki`, mode SingleBinary |
| 6 | Pod Loki principal absent après migration | `deploymentMode` non défini explicitement malgré `singleBinary.replicas` réglé | Ajout explicite de `deploymentMode: SingleBinary` |
| 7 | 404 "no org id" sur les requêtes Loki | Multi-tenancy activée par défaut sur le nouveau chart | Header `X-Scope-OrgID` ajouté dans la config Grafana et Alloy |
| 8 | Alloy en `ErrImagePull` | Coupure réseau transitoire pendant le pull Docker Hub | Résolu automatiquement par les retries Kubernetes |
| 9 | `otel-collector` en `CrashLoopBackOff` | Exporter `loki` inexistant dans le Collector Contrib récent | Remplacé par `otlphttp` pointé vers `/otlp` |
| 10 | Erreur "must specify at least one protocol" | Blocs `grpc:`/`http:` vides non reconnus par le parseur | Ajout de `endpoint: 0.0.0.0:PORT` explicite |
| 11 | `connection refused` sur le port-forward 4317 | Le Collector se liait à l'IP interne du Pod, pas à `0.0.0.0` | Fix identique au #10 — endpoints explicites |
| 12 | Endpoint metrics (8889) inaccessible | Port non exposé sur le Service Kubernetes par le chart | Ajout du bloc `ports.metrics` dans les values Helm |
| 13 | "No data" sur les métriques `demo-api` dans Grafana | Aucun `ServiceMonitor` ne disait à Prometheus de scraper cet endpoint | Création d'un `ServiceMonitor` avec le bon label `release` |
| 14 | Erreur `pkg_resources` au build Docker | Version récente de `setuptools` a retiré `pkg_resources` par défaut | Épinglage explicite de `setuptools==75.1.0` |
| 15 | Aucune donnée dans Pyroscope malgré le SDK installé | Confusion entre modèle *pull* (annotations `profiles.grafana.com/...`, pensées pour Go) et modèle *push* (SDK Python) | Annotations retirées ; diagnostic isolé via test réseau direct puis test du SDK à la main dans le Pod ; le vrai souci était un filtre `service_name` manquant côté UI Grafana, pas le SDK lui-même |

**Leçon transversale** : dans la quasi-totalité de ces incidents, la résolution est passée par la même méthode — lire les vrais logs/events du composant concerné plutôt que deviner, et éliminer les causes dans l'ordre (ressources → réseau/port → version/compatibilité → config applicative précise).

---

## 4. Architecture finale

```
demo-frontend (Pod) ──HTTP──> demo-api (Pod)
      │                             │
      │  OTLP (traces+metrics)      │  OTLP (traces+metrics)
      │  stdout (logs, via Alloy)   │  stdout (logs, via Alloy)
      │  push direct                │  push direct
      ▼                             ▼
OpenTelemetry Collector      Pyroscope (StatefulSet)
      │
      ├──► Prometheus (scrape via ServiceMonitor)
      ├──► Loki (via otlphttp)
      └──► Tempo (via OTLP grpc)

Grafana ──► interroge Prometheus, Loki, Tempo, Pyroscope — un seul endroit pour tout observer
Alertmanager ──► reçoit les alertes déclenchées par les PrometheusRule
```

---

## 5. Livrables produits

- Cluster k3d fonctionnel et documenté (`observability-lab`)
- Stack Helm complète versionnée (`clusters/local/*.yaml`)
- Application démo à 2 services, containerisée (`demo-app/`)
- Manifestes Kubernetes (Deployments, Services, ServiceMonitor, PrometheusRule)
- Règle d'alerte SLO validée en conditions réelles
- Documentation complète : runbook de commandes, guide théorique, ce rapport

---

## 6. Ce qui reste pour les phases suivantes

D'après le cahier des charges officiel (iTransform365) :

**Phase 2 — AI Model Observability** (non commencée)
- Ajout d'un composant LLM/IA à l'application démo
- KPI split infra vs application pour l'IA (GPU/CPU vs latence/coût/tokens)
- Monitoring qualité (hallucination, guardrails, eval scores)
- Logging structuré des prompts/completions
- Drift detection

**Phase 3 — RCA Agent** (non commencée)
- Agent avec accès outillé à Prometheus/Loki/Tempo/Pyroscope
- Corrélation automatique des signaux lors d'un incident
- Production d'hypothèses de root cause

**Phase 4 — Intégration end-to-end** (non commencée)
- Pipeline alerte → investigation agent → rapport structuré
- Validation par chaos testing / injection de pannes
- Documentation finale, runbooks, démo

**Éléments mineurs restants dans la Phase 1**
- Migration du cluster local vers OVH (remplacement des values `local` par des values `ovh` : stockage S3, ingress, dimensionnement)
- Exemplars (lien direct metrics↔traces dans les dashboards Grafana)
- Service Graph de Tempo (nécessite un metrics-generator supplémentaire)
