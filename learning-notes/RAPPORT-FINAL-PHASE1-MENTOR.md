# Rapport Final — Phase 1 : Observability Foundations
### iTransform365 / AIZO Suite — Observability Engineering Internship

**Auteur :** Iyed
**Période couverte :** Setup initial → validation complète des 4 piliers + dashboard unifié
**Environnement :** Kubernetes local (k3d), reproductible sur OVH

---

## 1. Résumé exécutif

Cette phase couvre l'intégralité des fondations d'observabilité demandées par le cahier des charges : les 4 piliers (metrics, logs, traces, profiling), une application démo multi-services entièrement instrumentée, un pipeline centralisé OpenTelemetry, un cycle SLI/SLO/alerting validé en conditions réelles, et un dashboard Grafana unifié corrélant l'ensemble.

**État final — tous les livrables du cahier des charges pour la Phase 1 :**

| Exigence | Statut |
|---|---|
| Metrics — KPIs infra + application | ✅ Fait |
| SLIs/SLOs définis et instrumentés | ✅ Fait, validé en conditions réelles |
| Logs — collecte centralisée | ✅ Fait |
| Logs structurés/corrélés (trace_id) pour pivot metric→log | ✅ Fait |
| Traces — instrumentation distribuée | ✅ Fait, multi-services |
| Exemplars (lien metrics→traces) | ⚠️ Limite technique documentée (voir section 6) |
| Profiling continu | ✅ Fait |
| Dashboards unifiés corrélant les 4 piliers | ✅ Fait |
| Alerting sur seuils critiques | ✅ Fait, testé en conditions réelles |
| Flux d'investigation "how → why" | ✅ Documenté et pratiqué |

---

## 2. Architecture déployée

```
demo-frontend (Pod) ──HTTP──> demo-api (Pod)
      │                             │
      │  OTLP (traces+metrics)      │  OTLP (traces+metrics)
      │  stdout logs (via Alloy)    │  stdout logs (via Alloy)
      ▼                             ▼
OpenTelemetry Collector      Pyroscope (profiling, SDK push)
      │
      ├──► Prometheus (scrape via ServiceMonitor)
      ├──► Loki (via otlphttp)
      └──► Tempo (via OTLP grpc)

Grafana ──► dashboard unifié : metrics + logs + traces + accès profiling
Alertmanager ──► reçoit les alertes SLO déclenchées par Prometheus
```

**Composants déployés (namespace `observability`, cluster k3d 3 nœuds) :**
- kube-prometheus-stack (Prometheus + Grafana + Alertmanager + node-exporter + kube-state-metrics)
- Loki (SingleBinary) + Grafana Alloy (DaemonSet, collecte de logs)
- Tempo (traces)
- Pyroscope (profiling)
- OpenTelemetry Collector (pipeline central)
- `demo-api` + `demo-frontend` — application Python/Flask à 2 services, containerisée, instrumentée

---

## 3. Étapes réalisées (chronologie)

### Étape 1 — Setup de l'environnement
Installation Docker/k3d/kubectl/Helm, création du cluster local, configuration Git/SSH pour versionner tout le travail au fil de l'eau.

### Étape 2 — Déploiement des 4 piliers
Chaque brique déployée via Helm, versionnée en fichiers `values.yaml` dans le repo :
- Prometheus/Grafana/Alertmanager
- Loki + Alloy
- Tempo
- OpenTelemetry Collector
- Pyroscope

### Étape 3 — Application démo instrumentée
- `demo-api` : service Flask simulant un taux d'erreur ~10% et une latence variable, pour avoir de vraies données à observer
- Auto-instrumentation OpenTelemetry (traces + metrics automatiques, sans code custom)
- `demo-frontend` : second service appelant `demo-api`, démontrant la propagation de trace distribuée (W3C traceparent)
- Containerisation des deux services (Dockerfile + Deployment/Service Kubernetes)

### Étape 4 — Validation opérationnelle de bout en bout
Vérification systématique que chaque pilier reçoit et affiche de vraies données (pas seulement que l'outil tourne) :
- Metrics visibles dans Prometheus via un `ServiceMonitor`
- Logs visibles dans Loki via Alloy
- Traces multi-services visibles dans Tempo, avec propagation de contexte confirmée (2 services, spans imbriqués)
- Profils CPU visibles dans Pyroscope (flamegraph du vrai code Python)

### Étape 5 — SLI/SLO/Alerting
- Définition d'un SLI (taux d'erreur HTTP), d'un SLO (>5% pendant 2 minutes), et d'une règle d'alerte Prometheus (`PrometheusRule`)
- Test en conditions réelles avec trafic continu généré : cycle complet observé **Inactive → Pending → Firing**, avec la vraie valeur mesurée (~10%) cohérente avec le taux d'erreur simulé

### Étape 6 — Finitions demandées explicitement par le cahier des charges
- **Logs structurés** : passage des logs Flask en JSON avec `trace_id` injecté automatiquement depuis le contexte OpenTelemetry actif — permet un vrai pivot "clic sur un log → trouve la trace exacte correspondante" dans Tempo
- **Dashboard unifié** : construction d'un dashboard Grafana (provisionné comme code, via ConfigMap) réunissant sur un seul écran : taux de requêtes, jauge SLO, latence p50/p95/p99, état de l'alerte dans le temps, logs structurés filtrables, traces récentes des deux services

---

## 4. Incidents rencontrés et résolus

Au total, une quinzaine d'incidents ont été rencontrés et résolus méthodiquement. Les plus significatifs :

| Incident | Cause racine | Résolution |
|---|---|---|
| Nœuds k3d bloqués indéfiniment au démarrage | Limite système `inotify` par défaut trop basse pour plusieurs nœuds simultanés | `sysctl` ajusté, rendu permanent |
| Grafana incapable de se connecter à Loki | Chart déprécié déployant une version de Loki trop ancienne | Migration vers le chart maintenu, mode SingleBinary |
| Collector en CrashLoopBackOff | Exporter Loki inexistant dans la version récente du Collector | Remplacé par l'exporter OTLP-HTTP générique |
| `connection refused` sur les ports du Collector | Binding implicite sur l'IP du Pod plutôt que sur toutes les interfaces | Endpoints explicites `0.0.0.0:PORT` |
| Aucune métrique `demo-api` visible dans Prometheus | Aucun `ServiceMonitor` ne déclarait l'endpoint à scraper | ServiceMonitor créé avec le bon label |
| Aucune donnée dans Pyroscope malgré le SDK installé | Confusion entre modèle pull (annotations, pensées pour Go) et modèle push (SDK Python) ; le vrai blocage était un filtre `service_name` manquant côté UI | Annotations retirées, requête corrigée |
| Dashboard "No data" sur logs/traces malgré une config JSON correcte | Les data sources Loki/Tempo/Pyroscope, ajoutées manuellement via l'UI, avaient été perdues lors d'un redémarrage du Pod Grafana (stockage non persistant) | Provisionnement des data sources déplacé dans le code (Helm `additionalDataSources`) — ne peut plus jamais se reproduire |

**Méthode appliquée à chaque incident** : lecture systématique des vrais logs/events du composant concerné plutôt que supposition, élimination des causes dans l'ordre (ressources → réseau → version/compatibilité → config applicative), test de connectivité isolé avant de blâmer le réseau.

---

## 5. Preuves de fonctionnement (résumé des validations)

- **Metrics** : `http_server_duration_milliseconds` avec labels de statut HTTP, scrapé et interrogeable dans Grafana
- **Logs** : lignes JSON structurées avec `trace_id`, visibles et filtrables dans Loki
- **Traces** : trace multi-services confirmée — `demo-frontend GET /` (span parent) contenant `demo-api GET /work` (span enfant), durée totale et répartition du temps visibles
- **Profiling** : flamegraph montrant les vraies fonctions Python de `demo-api` (`flask/app.py wsgi_app`, `werkzeug/serving.py handle`...)
- **SLO/Alerting** : alerte `DemoAPIHighErrorRate` observée en état Firing avec valeur mesurée 10.28%, au-dessus du seuil de 5%
- **Dashboard unifié** : les 4 piliers affichés simultanément pour `demo-api`, avec pivot log→trace fonctionnel via `trace_id`

---

## 6. Limite technique identifiée et documentée : Exemplars

Le cahier des charges demande un lien direct metrics→traces via exemplars. La configuration complète a été mise en place côté infrastructure (`exemplar-storage` activé sur Prometheus, format OpenMetrics activé sur le Collector), mais aucun exemplar n'est généré.

**Cause racine identifiée** : l'auto-instrumentation Python d'OpenTelemetry (`opentelemetry-instrumentation-flask`) ne génère pas encore d'exemplars automatiquement sur ses métriques — une limitation connue de l'écosystème OpenTelemetry côté Python, moins mature que les SDK Go/Java sur ce point précis.

**Contournement actuel** : le pivot metrics→traces se fait indirectement (filtrage de Tempo par service + fenêtre de temps correspondant au pic observé dans Prometheus), plutôt que par clic direct. Le pivot **logs→traces**, lui, fonctionne parfaitement.

**Solution pour plus tard, si jugée prioritaire** : instrumentation manuelle des métriques de latence avec attachement explicite du `trace_id` en exemplar — travail identifié mais non entrepris à ce stade, jugé disproportionné par rapport au bénéfice pour l'avancement du projet.

---

## 7. Livrables disponibles

- Cluster reproductible avec runbook complet de commandes
- Stack Helm versionnée (fichiers `values.yaml` pour chaque composant)
- Application démo à 2 services, containerisée, instrumentée
- Règle SLO/alerting fonctionnelle
- Dashboard Grafana unifié, provisionné comme code
- Documentation : ce rapport, un runbook de commandes, un livre de théorie couvrant tous les concepts appris (Docker → Kubernetes → Helm → 4 piliers → OpenTelemetry → SLO/Alerting → méthode de diagnostic)

---

## 8. Prochaines étapes proposées

- Migration de la stack vers OVH (remplacement des values `local` par des values `ovh`)
- Phase 2 du cahier des charges : observabilité des composants IA/LLM d'AIZO Advisor (KPI split infra/app pour l'IA, monitoring qualité, drift detection)
- Reprise de l'instrumentation manuelle des exemplars si jugée prioritaire par l'équipe
