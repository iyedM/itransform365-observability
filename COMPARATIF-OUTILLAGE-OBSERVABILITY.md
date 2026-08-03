# Comparatif des plateformes d'observabilité
### Document de décision — à discuter avec le mentor

---

## Contexte

Ce document compare les principales options d'outillage d'observabilité disponibles, pour décider ensemble laquelle utiliser pour AIZO Suite. La stack actuellement déployée (Phase 1) est basée sur **Grafana + Prometheus + Loki + Tempo + Pyroscope**, choisie initialement parce que le cahier des charges la cite explicitement en exemple.

---

## Catégorie 1 — Stack modulaire open source

### Grafana + Prometheus + Loki + Tempo + Pyroscope *(stack actuellement déployée)*

| Avantages | Inconvénients |
|---|---|
| Standard de facto de l'industrie — très largement adopté en production | Plus de composants séparés à faire cohabiter → plus de surface pour des bugs d'intégration |
| Composants indépendants et remplaçables individuellement | Courbe d'apprentissage plus longue au départ |
| OpenTelemetry-natif, aucun vendor lock-in | Setup initial plus long qu'un tout-en-un |
| Communauté et documentation immenses | |
| Compétence directement transférable (très demandée sur le marché) | |

---

## Catégorie 2 — Plateformes tout-en-un open source

### SigNoz

| Avantages | Inconvénients |
|---|---|
| Backend unifié (ClickHouse), UI pensée nativement pour metrics+logs+traces ensemble | Moins mature, communauté plus petite que Grafana |
| OpenTelemetry-natif — même standard d'instrumentation, migration peu coûteuse | Moins modulaire — plus difficile de remplacer un composant isolément |
| Setup plus rapide, moins de "plomberie" à assembler soi-même | Moins de battle-testing en production à grande échelle |

### OpenObserve

| Avantages | Inconvénients |
|---|---|
| Single-binary, très simple à opérer | Écosystème encore jeune |
| Empreinte ressources faible — bon pour petites équipes | Moins d'intégrations tierces disponibles |
| License généreuse (AGPL) | Adoption enterprise encore limitée |

### Uptrace

| Avantages | Inconvénients |
|---|---|
| Léger, OpenTelemetry-natif, backend ClickHouse | Communauté encore plus restreinte que SigNoz |
| UI plus simple que SigNoz | Moins connu, moins de retours d'expérience disponibles |

### Coroot

| Avantages | Inconvénients |
|---|---|
| Utilise eBPF — corrélation automatique metrics/traces/logs **sans instrumentation manuelle** | Pensé spécifiquement Kubernetes, moins généraliste |
| Approche très innovante, réduit fortement le travail d'instrumentation | Encore jeune, écosystème et communauté limités |

---

## Catégorie 3 — Stack "logs-first" historique

### ELK / Elastic Stack (Elasticsearch + Logstash/Fluentd + Kibana)

| Avantages | Inconvénients |
|---|---|
| Très mature, utilisé depuis longtemps en entreprise | Indexe le texte complet des logs → lourd en ressources (CPU/disque) à grande échelle |
| Recherche full-text extrêmement puissante (contrairement à Loki) | Coûteux à scaler |
| | License changée vers SSPL — plus totalement open source au sens strict |

---

## Catégorie 4 — SaaS commercial (à titre de comparaison, non open source)

| Plateforme | Positionnement |
|---|---|
| **Datadog** | Leader du marché, tout-en-un très complet, mais coûteux à grande échelle |
| **New Relic** | Concurrent direct de Datadog, tarification par utilisateur |
| **Honeycomb** | Pionnier de l'observabilité "événementielle" (pas de métriques pré-agrégées), excellent pour du debugging fin sur des comportements rares |
| **Grafana Cloud** | Version hébergée/managée de la stack Grafana — mêmes composants, sans devoir les opérer soi-même |
| **Dynatrace** | Très orienté auto-détection pilotée par IA, positionnement haut de gamme entreprise |

---

## Tableau de décision rapide

| Priorité recherchée | Meilleur choix |
|---|---|
| Standard industrie, modulaire, transférable comme compétence | Grafana stack *(actuel)* |
| Setup rapide, moins de composants à gérer | SigNoz ou OpenObserve |
| Recherche full-text puissante sur les logs | ELK / Elastic |
| Zéro instrumentation manuelle, tout automatique (K8s) | Coroot |
| Budget disponible, solution clé-en-main gérée | Datadog / Grafana Cloud |
| Investigation de comportements complexes/rares | Honeycomb |

---

## Recommandation actuelle

La stack Grafana reste le choix recommandé pour la suite du projet :
- Explicitement suggérée par le cahier des charges de la Phase 1
- Déjà déployée, validée de bout en bout (4 piliers + app démo + SLO/alerting + dashboard unifié)
- Compétence la plus transférable et la plus demandée sur le marché du travail
- Le principal risque identifié (complexité de debug de l'outillage) a été rencontré concrètement et résolu en appliquant une règle simple : tout traiter comme du code versionné (data sources, dashboards, alertes) plutôt que de configurer à la main dans l'UI

**Alternative à considérer si une réévaluation est souhaitée** : SigNoz — étant OpenTelemetry-natif, la migration serait relativement peu coûteuse depuis la stack actuelle, avec un setup plus rapide pour la suite du projet si la priorité bascule vers la vitesse plutôt que la modularité.

---

## Points à trancher ensemble

1. Garder la stack Grafana actuelle pour la suite (Phase 2, 3, 4) ?
2. Si réévaluation souhaitée, tester SigNoz en parallèle sur un périmètre limité avant de décider ?
3. Prioriser la migration OVH avec la stack actuelle, ou attendre une décision d'outillage avant de migrer ?
