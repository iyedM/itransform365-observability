# Récapitulatif complet — Phase 1 Observability
### Document de préparation pour le meet avec le mentor
### "Ce que j'ai fait, ce que j'ai choisi, et pourquoi" — de zéro jusqu'à maintenant

---

## 1. Point de départ

Le mentor a défini le projet : construire une plateforme d'observabilité complète pour AIZO Suite, en 4 phases progressives (Foundations → AI Observability → RCA Agent → Intégration finale). J'ai commencé par la **Phase 1**, qui couvre les 4 piliers (metrics, logs, traces, profiling) sur l'infrastructure et l'application.

**Choix n°1 — Environnement de développement** : plutôt que de travailler directement sur le cluster OVH partagé, j'ai choisi de tout construire d'abord **en local** (cluster Kubernetes k3d sur ma machine). Raison : itérer librement sans risquer de bloquer le travail d'autres personnes sur le cluster partagé, et pouvoir casser/reconstruire autant de fois que nécessaire pendant l'apprentissage.

---

## 2. Apprentissage des fondations (avant de toucher à l'observabilité elle-même)

Avant de déployer le moindre outil, j'ai pris le temps de comprendre les briques de base, plutôt que de copier des commandes sans les comprendre :

- **Docker** : conteneurs, images, couches et cache de build, ports internes vs externes
- **Kubernetes** : Pods, Deployments/ReplicaSets (boucle de réconciliation), Services (labels/selectors), et surtout la différence entre **DaemonSet** (1 par nœud, pour lire du local), **StatefulSet** (identité stable + stockage persistant), et **Deployment** (sans état, pour du trafic réseau)
- **Helm** : charts et releases, pourquoi ça remplace des dizaines de fichiers YAML gérés à la main

**Choix n°2 — Comprendre avant d'exécuter** : à chaque étape, j'ai demandé "pourquoi ce type d'objet Kubernetes plutôt qu'un autre" avant de l'utiliser — ça m'a permis de diagnostiquer moi-même la majorité des bugs rencontrés plus tard, en sachant où chercher.

---

## 3. Setup du cluster local — premier vrai obstacle

**Ce qui s'est passé** : la création du cluster k3d plantait de façon reproductible dès qu'il y avait plus d'un nœud "agent".

**Ma démarche de diagnostic** : élimination méthodique dans l'ordre — espace disque (écarté), CPU/RAM (écarté), isolé la variable en testant sans agents (fonctionnait), avec 1 agent (plantait) → j'ai fini par trouver que la limite système `fs.inotify.max_user_instances` (128 par défaut) était insuffisante pour plusieurs nœuds Kubernetes simultanés sur la même machine.

**Résolution** : ajustée à 512 via `sysctl`, rendue permanente.

**Ce que ça montre** : une méthode de debug reproductible (ressources → réseau → version → config), pas du tâtonnement au hasard.

---

## 4. Déploiement des 4 piliers — choix d'outils et justifications

| Pilier | Outil choisi | Pourquoi |
|---|---|---|
| Metrics | Prometheus (via kube-prometheus-stack) | Standard de l'industrie, explicitement cité dans le cahier des charges |
| Logs | Loki + Grafana Alloy | Indexe seulement les labels (pas le texte complet comme Elasticsearch) — beaucoup moins cher, adapté au flux "how → why" où on sait déjà quel service regarder |
| Traces | Tempo | Cité dans le cahier des charges, intégration native avec Grafana |
| Profiling | Pyroscope | Cité dans le cahier des charges, flamegraphs pour identifier les hotspots CPU/mémoire au niveau code |
| Pipeline central | OpenTelemetry Collector | Standard vendor-neutral — l'app parle un seul protocole (OTLP), le Collector route vers les 3 backends. Évite le lock-in |

**Choix n°3 — Stack modulaire (Grafana/Prometheus/Loki/Tempo) plutôt qu'un tout-en-un (SigNoz/OpenObserve)** : chaque brique est indépendante et remplaçable, standard largement adopté en entreprise (donc transférable comme compétence et facile à faire reprendre par quelqu'un d'autre), et 100% aligné avec ce que le cahier des charges suggère explicitement. Le compromis assumé : plus de pièces à faire cohabiter = plus de surface pour des bugs d'intégration — ce qu'on a effectivement rencontré, mais dont chaque occurrence a renforcé ma compréhension du système plutôt que d'être du temps perdu.

**Incidents rencontrés à cette étape** (résolus un par un, méthodiquement) :
- Chart `loki-stack` déprécié → migration vers le chart `loki` maintenu
- Exporter Prometheus du Collector inexistant dans une version → remplacé par l'exporter générique OTLP-HTTP
- Endpoints du Collector qui se liaient à l'IP du Pod au lieu de `0.0.0.0` → corrigé, sinon aucun accès externe possible
- Metrics de l'app invisibles dans Prometheus → il manquait un `ServiceMonitor` explicite (Prometheus fonctionne en modèle *pull*, il ne reçoit jamais rien passivement)

---

## 5. Application démo — pour avoir de vraies données, pas des outils vides

**Choix n°4 — Construire une vraie app plutôt que de tester avec des données de test artificielles** : `demo-api` (Flask/Python) simule un taux d'erreur ~10% et une latence variable — pour avoir un comportement réaliste à observer (succès, erreurs, latence) plutôt que des métriques vides.

**Choix n°5 — Deux services, pas un seul** : ajout de `demo-frontend` qui appelle `demo-api`, spécifiquement pour démontrer le **tracing distribué** (une requête qui traverse 2 services doit apparaître comme **une seule trace** avec des spans imbriqués, pas deux traces séparées). Validé avec succès — propagation de contexte W3C automatique via l'auto-instrumentation OpenTelemetry, sans une ligne de code custom pour ça.

**Choix n°6 — Containerisation complète** : les deux services tournent en tant que vrais Pods dans le cluster (Dockerfile + Deployment/Service Kubernetes), pas juste sur ma machine locale — plus réaliste, et ça a permis de valider que la collecte de logs (stdout → Alloy) fonctionne automatiquement sans configuration supplémentaire.

---

## 6. Validation de bout en bout — pas juste "l'outil tourne"

Pour chaque pilier, j'ai vérifié qu'il recevait et affichait de **vraies données**, pas seulement que le Pod était `Running` :
- Metrics : histogramme de latence avec labels de statut HTTP, visible dans Prometheus
- Logs : lignes visibles dans Loki, provenant réellement de l'app
- Traces : trace multi-services confirmée (`demo-frontend` → `demo-api`, 2 services, 3 spans)
- Profiling : flamegraph montrant les vraies fonctions Python de l'app (pas le runtime interne de Pyroscope, erreur qu'on a d'abord faite puis corrigée en isolant le bon filtre)

---

## 7. SLI / SLO / Alerting — testé en conditions réelles, pas juste configuré

**Choix n°7** : définition d'un SLI (taux d'erreur HTTP) et d'un SLO (>5% pendant 2 minutes) volontairement strict pour qu'il se déclenche avec le taux d'erreur simulé (~10%) — pour pouvoir **observer le cycle complet**, pas juste écrire une règle et supposer qu'elle marche.

**Validation** : génération de trafic continu, observation du cycle réel **Inactive → Pending → Firing** dans Prometheus, avec la vraie valeur mesurée cohérente avec le taux simulé.

---

## 8. Finitions demandées explicitement par le cahier des charges

Après une relecture du cahier des charges pour vérifier la conformité complète, j'ai identifié 3 manques et je les ai comblés :

1. **Logs structurés + trace_id** : passage des logs de texte brut à du JSON structuré, avec le `trace_id` de la requête active injecté automatiquement (via l'API de contexte OpenTelemetry). Ça permet un vrai pivot "je vois un log, je clique, je trouve la trace exacte" dans Tempo — exactement le "metric-based logs" demandé.

2. **Exemplars (lien metrics→traces)** : configuration complète côté infrastructure (Prometheus + Collector), mais **limite technique identifiée et documentée honnêtement** : l'auto-instrumentation Python d'OpenTelemetry ne génère pas encore d'exemplars automatiquement — limite connue de l'écosystème, moins mature côté Python que Go/Java. Contournement actuel : pivot manuel par service+fenêtre de temps plutôt que par clic direct. Solution de long terme identifiée (instrumentation manuelle) mais jugée disproportionnée pour l'instant par rapport au bénéfice.

3. **Dashboard unifié corrélant les 4 piliers** : construit et provisionné comme code (pas cliqué à la main dans l'UI), réunissant sur un seul écran : taux de requêtes, jauge SLO, latence p50/p95/p99, état de l'alerte dans le temps, logs structurés filtrables, traces des deux services.

**Incident majeur rencontré ici, et leçon apprise** : le dashboard "perdait" ses données après chaque redémarrage de Grafana. Cause réelle, découverte en deux temps :
- Les data sources Loki/Tempo/Pyroscope, ajoutées à la main via l'UI, n'étaient pas persistantes → **corrigé en les provisionnant via le code Helm** (`additionalDataSources`), donc elles survivent maintenant à n'importe quel redémarrage.
- Le format JSON du dashboard était passé en "v2" (nouveau format interne de Grafana) suite à une édition via "Edit as code" dans l'UI, incompatible avec le provisioning par fichier → **corrigé en reconstruisant le dashboard en format v1 classique**, avec les identifiants de data source directement écrits en dur dans le fichier source.

**Ce que ça illustre** : la vraie bonne pratique qui ressort de toute cette session — **tout traiter comme du code versionné (Git), rien laissé dans l'état éphémère de l'UI**. C'est exactement le principe que je vais présenter en réponse à la remarque du mentor sur la complexité potentielle de debug de l'outillage Grafana.

---

## 9. Outillage de confort — automatiser ce qui est répétitif

Pour ne plus retaper manuellement 8 commandes de `port-forward` à chaque session de travail, j'ai écrit un script qui les lance toutes automatiquement dans une session `tmux` organisée en panneaux — gain de temps et moins d'erreurs de copier-coller.

---

## 10. Bilan — conformité au cahier des charges (Phase 1)

| Exigence | Statut |
|---|---|
| Metrics infra + application | ✅ |
| SLIs/SLOs définis et instrumentés | ✅ testé en conditions réelles |
| Logs centralisés et structurés (pivot metric→log) | ✅ |
| Traces distribuées (multi-services) | ✅ |
| Exemplars (lien metrics→traces) | ⚠️ limite technique documentée, contournement en place |
| Profiling continu | ✅ |
| Dashboards unifiés | ✅ |
| Alerting sur seuils | ✅ testé en conditions réelles |
| Flux d'investigation "how → why" | ✅ pratiqué et documenté |

---

## 11. Points à aborder/discuter avec le mentor demain

- Confirmer si la limite des exemplars vaut la peine d'être creusée davantage (instrumentation manuelle) ou si on avance sur la Phase 2 tel quel
- Discuter du choix d'outillage (Grafana stack vs SigNoz/OpenObserve) — argumentaire déjà préparé, ouvert à ajuster selon sa préférence
- Valider le passage à la migration OVH et/ou à la Phase 2 (observabilité IA)
- Partager les leçons de debug les plus utiles (la méthode d'élimination systématique, le principe "tout en code")
