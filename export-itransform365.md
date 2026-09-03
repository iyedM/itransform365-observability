## ./AGENT-TO-AGENT-RESULTS (1).md
```
# Résultats — Test de communication agent-à-agent

## Contexte

Question posée par Koussay (tutor) : *"Can you test subagent or agent to agent
communication scenario?"* — dans le cadre de la préparation de la Phase 2
(observabilité IA), suite à l'annonce de nouveaux projets IA arrivant en
septembre.

## Objectif du test

Vérifier si le pipeline d'observabilité (OpenTelemetry + OpenInference +
Collector + Tempo) capture correctement une interaction entre **deux agents
distincts** (un Supervisor qui délègue à un Sub-agent spécialisé) comme
**une seule trace continue**, ou si le tracing se fragmente en traces
séparées et déconnectées.

C'est une question importante : dans une architecture réelle type AIZO
Adviser (LangGraph avec plusieurs nœuds spécialisés), perdre la continuité
du tracing entre agents rendrait le debugging quasi impossible — on verrait
des morceaux isolés sans pouvoir reconstituer le parcours complet d'une
requête.

## Scénario construit

**Stack** : Node.js (aligné avec la stack réelle de l'équipe), LangGraph.js,
OpenInference pour l'instrumentation, LiteLLM Gateway (`qwen3.6-35b`) comme
provider LLM.

**Pattern** : Supervisor → Sub-agent → Supervisor (synthèse)

```
Supervisor (routeur)
  │  classe la requête
  ▼
Sub-agent (recherche spécialisée)
  │  répond avec un rôle/prompt distinct du Supervisor
  ▼
Supervisor (synthèse)
  │  reformule la réponse du sous-agent pour l'utilisateur final
  ▼
Réponse finale
```

Le point clé du test : le Sub-agent a son **propre appel LLM indépendant**
(prompt système différent, contexte différent), pas juste un passage de
paramètre — pour simuler une vraie délégation entre deux "agents" distincts,
pas juste deux étapes du même agent.

## Résultat obtenu

**✅ Le tracing reste une seule trace continue.**

Trace ID : `5fa6dd0559fa980354e80ea5752b52f0`, durée totale 3.3s, 14 spans,
1 seul service déclaré (`aizo-poc-agent-to-agent`).

Hiérarchie observée dans Tempo :

```
aizo-poc-agent-to-agent: LangGraph (3.3s)
├─ __start__ (5.74ms)
├─ supervisor_router (3.37ms)
│   └─ Branch<supervisor_router, delegate_to_subagent, supervisor_direct>
├─ delegate_to_subagent (1.75s)          <- Sub-agent
│   └─ ChatOpenAI (1.74s)                <- son appel LLM réel (qwen3.6-35b)
└─ supervisor_synthesize (1.53s)         <- retour au Supervisor
    └─ ChatOpenAI (1.53s)                <- sa synthèse finale
```

Chaque appel LLM (`ChatOpenAI`) est capturé avec ses attributs complets :
modèle utilisé, tokens (prompt/completion/total), messages input/output —
identique à ce qu'on avait déjà validé pour un agent seul, mais cette fois
réparti correctement entre les deux "agents" logiques, sans rien perdre.

## Ce que ça confirme

1. **Le pipeline d'observabilité existant (Phase 1) supporte nativement le
   multi-agent** — aucune modification d'infrastructure nécessaire (même
   Collector, même Tempo, même dashboard potentiel).
2. **OpenInference propage correctement le contexte de trace** à travers
   plusieurs appels LLM séquentiels dans un même process, même avec des
   rôles/prompts différents par étape.
3. La répartition du temps par agent est directement visible (ici : 1.75s
   pour le Sub-agent, 1.53s pour la synthèse du Supervisor) — utile pour
   identifier quel agent est responsable d'une latence excessive dans un
   vrai scénario de production.

## Limite de ce test (à garder en tête)

Ce test valide la continuité du tracing **dans un seul process** (les deux
"agents" sont deux nœuds du même graphe LangGraph, pas deux services
séparés communiquant sur le réseau). Un test plus poussé consisterait à
séparer les deux agents en **deux services distincts** (comme
`demo-frontend`/`demo-api` en Phase 1), pour vérifier que la propagation de
trace W3C fonctionne aussi à travers une frontière réseau — pas encore testé
pour un scénario spécifiquement multi-agent IA (voir section "Prochaines
étapes" en fin de document).

## Test complémentaire — chaîne de 3 agents

Pour vérifier que le résultat tient aussi avec plusieurs sauts successifs
(pas juste un aller-retour), un deuxième test a été construit :
`Supervisor → Research Agent → Validation Agent → Supervisor (synthèse)`.

**Résultat** : confirmé à nouveau — une seule trace continue (18 spans,
1 service, durée totale 3.13s), avec les 3 appels LLM distincts
(`research_agent`, `validation_agent`, `supervisor_synthesize`) tous
imbriqués correctement dans la même trace.

**Conclusion renforcée** : le tracing OpenTelemetry/OpenInference reste
cohérent quelle que soit la profondeur de la chaîne d'agents testée
(1 saut ou 2 sauts), pas seulement pour le cas le plus simple.

Fichier : `demo-app/ai-poc-node/three-agent-chain.js`

## Test complémentaire — agents en parallèle (fan-out / fan-in)

Troisième variante testée : est-ce que le tracing reste cohérent quand
**deux agents s'exécutent simultanément** plutôt que l'un après l'autre ?

**Scénario** : le Supervisor délègue en même temps à un Research Agent et
un Translation Agent, indépendants l'un de l'autre, puis attend que les
deux aient terminé avant de synthétiser une réponse finale.

**Résultat (preuve par le timing)** :
- Research Agent : 2062ms
- Translation Agent : 1557ms
- Temps total mesuré : 2606ms

Si l'exécution avait été séquentielle, le temps total attendu aurait été
proche de la somme des deux (~3619ms). Le temps mesuré (2606ms) est
nettement plus proche du **plus long des deux appels** (2062ms) que de
leur somme — confirmant un vrai parallélisme d'exécution, pas une
exécution séquentielle déguisée.

**Conclusion** : LangGraph exécute correctement les branches parallèles
(fan-out/fan-in natif du framework, sans logique de synchronisation
manuelle nécessaire). Le principe de trace continue observé dans les 2
tests précédents devrait s'appliquer également ici — confirmation visuelle
du chevauchement des spans dans Tempo en cours de vérification.

Fichier : `demo-app/ai-poc-node/parallel-agents.js`

## Prochaines étapes possibles

- Confirmation visuelle dans Tempo du chevauchement temporel des spans
  parallèles (research_agent / translation_agent)
- Séparer deux agents en **deux services réseau distincts** (comme
  `demo-frontend`/`demo-api`) pour valider la propagation de trace W3C
  à travers une frontière réseau, pas seulement dans un même process
- Tester la gestion des erreurs entre agents (un sous-agent qui échoue/
  timeout - la trace reste-t-elle lisible ?)
- Tester avec les 7 types de tâches réels de l'architecture AIZO Adviser
  (routing, chat, retrieval planning, retrieval synthesis, vision, memory,
  Cypher generation), pas seulement les 2-3 simulés jusqu'ici

## Fichiers concernés

- `demo-app/ai-poc-node/agent-to-agent.js` — scénario Supervisor/Sub-agent (test 1)
- `demo-app/ai-poc-node/three-agent-chain.js` — chaîne de 3 agents (test 2)
- `demo-app/ai-poc-node/parallel-agents.js` — agents en parallèle (test 3)
- `demo-app/ai-poc-node/app.js` — le POC single-agent de base (référence)

## Scénario B — Erreur non gérée (crash)

**Fichier** : `error-scenario-b-crash.js`
**Trace ID** : `d2777dfb0f5941a8824f32be07b90315`
**Date** : 30/08/2026

### Setup
Le Sub-agent lève une exception non catchée (contrairement au Scénario A où
l'erreur est catchée avec `recordException` + `setStatus ERROR` explicite).
Aucun try/catch autour de l'appel au sous-agent.

### Résultat
- **8 spans** exportés vers Tempo (contre 13 dans le Scénario A)
- Durée totale de la trace : 21.21ms
- Le crash survient dans le span `subagent_crash` (1.16ms)
- **Aucun span après `subagent_crash`** : pas de retour au Supervisor, pas de
  synthèse finale — le graphe LangGraph s'arrête net à l'exception
- Le statut ERROR se **propage jusqu'au span racine**
  (`aizo-poc-error-unhandled: LangGraph`), contrairement au Scénario A où
  seul le span du sous-agent était marqué en erreur

### Comparaison A vs B

| | Scénario A (géré) | Scénario B (non géré) |
|---|---|---|
| Span(s) en erreur | Sous-agent uniquement | Sous-agent + racine (propagation) |
| Spans totaux | 13 (chaîne complète) | 8 (arrêt net) |
| Suite du graphe | Supervisor répond avec fallback | Rien après le crash |
| Trace exportée | Complète | Partielle, mais fidèle à l'exécution réelle |

### Conclusion
OpenTelemetry/OpenInference n'a pas "perdu" de télémétrie : la trace
partielle reflète exactement ce qui s'est exécuté avant l'exception. Même un
crash non géré au niveau applicatif reste entièrement diagnosticable dans
Tempo — on voit précisément où la chaîne s'est rompue et l'erreur propagée
jusqu'à la racine permet une détection immédiate par une alerte Grafana sur
le statut du span racine.
```

## ./AGENT-TO-AGENT-RESULTS.md
```
# Résultats — Test de communication agent-à-agent

## Contexte

Question posée par Koussay (tutor) : *"Can you test subagent or agent to agent
communication scenario?"* — dans le cadre de la préparation de la Phase 2
(observabilité IA), suite à l'annonce de nouveaux projets IA arrivant en
septembre.

## Objectif du test

Vérifier si le pipeline d'observabilité (OpenTelemetry + OpenInference +
Collector + Tempo) capture correctement une interaction entre **deux agents
distincts** (un Supervisor qui délègue à un Sub-agent spécialisé) comme
**une seule trace continue**, ou si le tracing se fragmente en traces
séparées et déconnectées.

C'est une question importante : dans une architecture réelle type AIZO
Adviser (LangGraph avec plusieurs nœuds spécialisés), perdre la continuité
du tracing entre agents rendrait le debugging quasi impossible — on verrait
des morceaux isolés sans pouvoir reconstituer le parcours complet d'une
requête.

## Scénario construit

**Stack** : Node.js (aligné avec la stack réelle de l'équipe), LangGraph.js,
OpenInference pour l'instrumentation, LiteLLM Gateway (`qwen3.6-35b`) comme
provider LLM.

**Pattern** : Supervisor → Sub-agent → Supervisor (synthèse)

```
Supervisor (routeur)
  │  classe la requête
  ▼
Sub-agent (recherche spécialisée)
  │  répond avec un rôle/prompt distinct du Supervisor
  ▼
Supervisor (synthèse)
  │  reformule la réponse du sous-agent pour l'utilisateur final
  ▼
Réponse finale
```

Le point clé du test : le Sub-agent a son **propre appel LLM indépendant**
(prompt système différent, contexte différent), pas juste un passage de
paramètre — pour simuler une vraie délégation entre deux "agents" distincts,
pas juste deux étapes du même agent.

## Résultat obtenu

**✅ Le tracing reste une seule trace continue.**

Trace ID : `5fa6dd0559fa980354e80ea5752b52f0`, durée totale 3.3s, 14 spans,
1 seul service déclaré (`aizo-poc-agent-to-agent`).

Hiérarchie observée dans Tempo :

```
aizo-poc-agent-to-agent: LangGraph (3.3s)
├─ __start__ (5.74ms)
├─ supervisor_router (3.37ms)
│   └─ Branch<supervisor_router, delegate_to_subagent, supervisor_direct>
├─ delegate_to_subagent (1.75s)          <- Sub-agent
│   └─ ChatOpenAI (1.74s)                <- son appel LLM réel (qwen3.6-35b)
└─ supervisor_synthesize (1.53s)         <- retour au Supervisor
    └─ ChatOpenAI (1.53s)                <- sa synthèse finale
```

Chaque appel LLM (`ChatOpenAI`) est capturé avec ses attributs complets :
modèle utilisé, tokens (prompt/completion/total), messages input/output —
identique à ce qu'on avait déjà validé pour un agent seul, mais cette fois
réparti correctement entre les deux "agents" logiques, sans rien perdre.

## Ce que ça confirme

1. **Le pipeline d'observabilité existant (Phase 1) supporte nativement le
   multi-agent** — aucune modification d'infrastructure nécessaire (même
   Collector, même Tempo, même dashboard potentiel).
2. **OpenInference propage correctement le contexte de trace** à travers
   plusieurs appels LLM séquentiels dans un même process, même avec des
   rôles/prompts différents par étape.
3. La répartition du temps par agent est directement visible (ici : 1.75s
   pour le Sub-agent, 1.53s pour la synthèse du Supervisor) — utile pour
   identifier quel agent est responsable d'une latence excessive dans un
   vrai scénario de production.

## Limite de ce test (à garder en tête)

Ce test valide la continuité du tracing **dans un seul process** (les deux
"agents" sont deux nœuds du même graphe LangGraph, pas deux services
séparés communiquant sur le réseau). Un test plus poussé consisterait à
séparer les deux agents en **deux services distincts** (comme
`demo-frontend`/`demo-api` en Phase 1), pour vérifier que la propagation de
trace W3C fonctionne aussi à travers une frontière réseau — pas encore testé
pour un scénario spécifiquement multi-agent IA.

## Fichiers concernés

- `demo-app/ai-poc-node/agent-to-agent.js` — le scénario Supervisor/Sub-agent testé
- `demo-app/ai-poc-node/app.js` — le POC single-agent de base (référence)

## Test complémentaire — chaîne de 3 agents

Pour vérifier que le résultat tient aussi avec plusieurs sauts successifs
(pas juste un aller-retour), un deuxième test a été construit :
`Supervisor → Research Agent → Validation Agent → Supervisor (synthèse)`.

**Résultat** : confirmé à nouveau — une seule trace continue (18 spans,
1 service, durée totale 3.13s), avec les 3 appels LLM distincts
(`research_agent`, `validation_agent`, `supervisor_synthesize`) tous
imbriqués correctement dans la même trace.

**Conclusion renforcée** : le tracing OpenTelemetry/OpenInference reste
cohérent quelle que soit la profondeur de la chaîne d'agents testée
(1 saut ou 2 sauts), pas seulement pour le cas le plus simple.

Fichier : `demo-app/ai-poc-node/three-agent-chain.js`
```

## ./clusters/local/alloy-values.yaml
```
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
```

## ./clusters/local/kube-prometheus-values.yaml
```
grafana:
  adminPassword: admin
  service:
    type: ClusterIP
  additionalDataSources:
    - name: loki
      type: loki
      access: proxy
      url: http://loki-gateway
      jsonData:
        httpHeaderName1: "X-Scope-OrgID"
      secureJsonData:
        httpHeaderValue1: "foo"
    - name: tempo
      type: tempo
      access: proxy
      url: http://tempo:3200
    - name: pyroscope
      type: grafana-pyroscope-datasource
      access: proxy
      url: http://pyroscope.observability.svc.cluster.local:4040
prometheus:
  prometheusSpec:
    retention: 3d
    enableFeatures:
      - exemplar-storage
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
```

## ./clusters/local/loki-values.yaml
```
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
```

## ./clusters/local/otel-collector-values.yaml
```
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
      enable_open_metrics: true
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
```

## ./clusters/local/pyroscope-notes.md
```
# Pyroscope — installation

Installé avec les valeurs par défaut du chart (pas de values.yaml custom) :

    helm install pyroscope grafana/pyroscope -n observability

Déploie deux composants :
- pyroscope-0 (StatefulSet) — stockage des profils
- pyroscope-alloy-0 (StatefulSet) — scrape les endpoints pprof via annotations sur les Pods
  (contrairement à l'Alloy des logs, celui-ci n'a pas besoin d'être un DaemonSet :
  il ne lit pas de fichiers locaux par nœud, il scrape des endpoints HTTP pprof
  exposés par des Pods spécifiques désignés via annotations, donc un nombre fixe
  d'instances suffit)

Pour instrumenter une app, ajouter ces annotations sur son Pod/Deployment :

    profiles.grafana.com/memory.scrape: "true"
    profiles.grafana.com/memory.port: "8080"
    profiles.grafana.com/cpu.scrape: "true"
    profiles.grafana.com/cpu.port: "8080"

URL Grafana (data source) : http://pyroscope.observability.svc.cluster.local.:4040
```

## ./clusters/local/setup.md
```
# Setup cluster local — observability-lab

## Prérequis système (à faire une seule fois par machine)
Augmenter les limites inotify — sinon les nœuds "agent" restent bloqués indéfiniment
au démarrage dès qu'il y en a plus d'un (containerd ne finit jamais son init) :

    sudo sysctl fs.inotify.max_user_instances=512
    sudo sysctl fs.inotify.max_user_watches=524288
    echo "fs.inotify.max_user_instances=512" | sudo tee -a /etc/sysctl.conf
    echo "fs.inotify.max_user_watches=524288" | sudo tee -a /etc/sysctl.conf
    sudo sysctl -p

## Créer le cluster

    k3d cluster create observability-lab \
      --agents 2 \
      --port "8090:80@loadbalancer" \
      --port "8453:443@loadbalancer" \
      --k3s-arg "--disable=traefik@server:0"

Note : port 8080 est déjà pris par un autre conteneur (web_nginx) sur cette machine,
d'où l'usage de 8090/8453 plutôt que 8080/8443.

## Vérifier que tout va bien

    docker ps -a --filter "name=k3d-observability-lab"
    kubectl get nodes

Les 4 conteneurs (server-0, agent-0, agent-1, serverlb) doivent être "Up",
et les 3 nœuds "Ready".

## Supprimer le cluster proprement

    k3d cluster delete observability-lab
```

## ./COMPARATIF-OUTILLAGE-OBSERVABILITY.md
```
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
```

## ./demo-app/ai-poc/app.py
```
"""
POC — Petit graphe LangGraph instrumenté avec OpenTelemetry.
Simule le pattern Router -> Chatbot -> Tool -> End décrit dans l'architecture AIZO.

Usage :
    export OPENAI_API_KEY="sk-..."   # ou la clé fournie par Haykel
    export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4317"  # via port-forward vers le Collector
    python app.py
"""

import os
from typing import TypedDict, Annotated
from langgraph.graph import StateGraph, END
from langgraph.graph.message import add_messages
from langchain_core.tools import tool
from langchain_core.messages import HumanMessage, AIMessage

# --- Instrumentation OpenTelemetry (via OpenInference) ---
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from openinference.instrumentation.langchain import LangChainInstrumentor

# Mode test : si aucune clé LiteLLM n'est fournie, on simule le LLM plutôt que
# d'appeler un vrai provider - permet de valider tout le pipeline
# (graphe + tracing) avant d'avoir la clé.
MOCK_MODE = not bool(os.environ.get("LITELLM_KEY"))


def get_llm():
    """Retourne un vrai LLM (via le LiteLLM Gateway d'iTransform365) si une clé
    est disponible, sinon un LLM simulé."""
    if MOCK_MODE:
        from langchain_core.language_models.fake_chat_models import FakeListChatModel
        print("[MOCK_MODE actif - aucune clé LITELLM_KEY détectée, réponses simulées]\n")
        return FakeListChatModel(responses=[
            "Voici une réponse simulée pour tester le pipeline de tracing.",
        ])
    else:
        from langchain_openai import ChatOpenAI
        # LiteLLM expose une API compatible OpenAI - on pointe juste
        # base_url vers le gateway au lieu de l'API OpenAI directe
        return ChatOpenAI(
            model="qwen3.6-35b",
            api_key=os.environ["LITELLM_KEY"],
            base_url="https://litellm.itransform365.com",
            temperature=0,
        )

def setup_tracing():
    """Configure OpenTelemetry pour envoyer les traces vers le Collector."""
    otlp_endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317")
    service_name = os.environ.get("OTEL_SERVICE_NAME", "aizo-poc-langgraph")

    resource = Resource.create({"service.name": service_name})
    provider = TracerProvider(resource=resource)
    exporter = OTLPSpanExporter(endpoint=otlp_endpoint, insecure=True)
    provider.add_span_processor(BatchSpanProcessor(exporter))
    trace.set_tracer_provider(provider)

    # Instrumente automatiquement tous les appels LangChain/LangGraph -
    # pas besoin d'ajouter des spans manuellement dans le code du graphe
    LangChainInstrumentor().instrument()


# --- Définition du graphe (Router -> Chatbot -> Tool -> End) ---

class GraphState(TypedDict):
    messages: Annotated[list, add_messages]
    task_type: str  # routing / chat / retrieval / vision / memory / cypher... (voir archi AIZO)


@tool
def search_knowledge_base(query: str) -> str:
    """Simule une recherche dans une base de connaissances (équivalent Tavily/Neo4j dans AIZO)."""
    return f"[résultat simulé pour: {query}] Voici une information pertinente trouvée dans la base."


def router_node(state: GraphState) -> GraphState:
    """Classifie la requête - équivalent du Router dans l'archi AIZO."""
    last_message = state["messages"][-1].content
    # Classification simplifiée pour la démo - dans AIZO, ça détermine
    # laquelle des 7 tâches (routing/chat/vision/retrieval/etc.) s'applique
    task_type = "chat"
    if "cherche" in last_message.lower() or "trouve" in last_message.lower():
        task_type = "retrieval"
    return {"messages": state["messages"], "task_type": task_type}


def chatbot_node(state: GraphState) -> GraphState:
    """Génère une réponse ou demande un outil - équivalent du Chatbot dans l'archi AIZO."""
    llm = get_llm()
    if MOCK_MODE:
        # FakeListChatModel ne supporte pas bind_tools() - on simule
        # directement une réponse finale sans appel d'outil pour ce test
        response = llm.invoke(state["messages"])
    else:
        llm_with_tools = llm.bind_tools([search_knowledge_base])
        response = llm_with_tools.invoke(state["messages"])
    return {"messages": [response], "task_type": state["task_type"]}


def should_use_tool(state: GraphState) -> str:
    """Décide si on passe par le tool node ou si on termine directement."""
    last_message = state["messages"][-1]
    if hasattr(last_message, "tool_calls") and last_message.tool_calls:
        return "tools"
    return END


def tool_node(state: GraphState) -> GraphState:
    """Exécute l'outil demandé et renvoie le résultat au chatbot - équivalent du Tool node AIZO."""
    last_message = state["messages"][-1]
    results = []
    for tool_call in last_message.tool_calls:
        if tool_call["name"] == "search_knowledge_base":
            result = search_knowledge_base.invoke(tool_call["args"])
            results.append({"tool_call_id": tool_call["id"], "content": result})
    from langchain_core.messages import ToolMessage
    tool_messages = [
        ToolMessage(content=r["content"], tool_call_id=r["tool_call_id"])
        for r in results
    ]
    return {"messages": tool_messages, "task_type": state["task_type"]}


def build_graph():
    graph = StateGraph(GraphState)

    graph.add_node("router", router_node)
    graph.add_node("chatbot", chatbot_node)
    graph.add_node("tools", tool_node)

    graph.set_entry_point("router")
    graph.add_edge("router", "chatbot")
    graph.add_conditional_edges("chatbot", should_use_tool, {"tools": "tools", END: END})
    graph.add_edge("tools", "chatbot")

    return graph.compile()


if __name__ == "__main__":
    setup_tracing()
    app = build_graph()

    # Requête de test - chaque exécution produit une trace complète
    # (Router -> Chatbot -> [Tool] -> Chatbot -> End) visible dans Tempo
    result = app.invoke({
        "messages": [HumanMessage(content="Cherche des informations sur l'observabilité Kubernetes")],
        "task_type": "",
    })

    print("\n--- Réponse finale ---")
    print(result["messages"][-1].content)
    print(f"\nTask type détecté: {result['task_type']}")
    print("\nVérifie la trace dans Grafana -> Explore -> Tempo -> service.name = aizo-poc-langgraph")
```

## ./demo-app/ai-poc-node/agent-error-handling.js
```
/**
 * POC — Gestion des erreurs entre agents.
 * Teste 2 scénarios :
 *   A) Erreur GÉRÉE : le Sub-agent échoue, le Supervisor le détecte et
 *      répond avec un message de repli (fallback).
 *   B) Erreur NON GÉRÉE (crash) : le Sub-agent lève une exception non
 *      catchée - on vérifie si la trace partielle arrive quand même
 *      jusqu'à Tempo, avec l'erreur visible sur le span concerné.
 *
 * Usage :
 *   export LITELLM_KEY="..."
 *   export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4317"
 *   node agent-error-handling.js
 */

const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");
const { BatchSpanProcessor } = require("@opentelemetry/sdk-trace-base");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-grpc");
const { Resource } = require("@opentelemetry/resources");
const { SemanticResourceAttributes } = require("@opentelemetry/semantic-conventions");
const { diag, DiagConsoleLogger, DiagLogLevel, trace, SpanStatusCode } = require("@opentelemetry/api");
const { LangChainInstrumentation } = require("@arizeai/openinference-instrumentation-langchain");
const CallbackManagerModule = require("@langchain/core/callbacks/manager");

const { StateGraph, END, Annotation, START } = require("@langchain/langgraph");
const { ChatOpenAI } = require("@langchain/openai");
const { HumanMessage, SystemMessage } = require("@langchain/core/messages");

diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

function setupTracing(serviceName) {
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4317";

  const provider = new NodeTracerProvider({
    resource: new Resource({ [SemanticResourceAttributes.SERVICE_NAME]: serviceName }),
  });

  const exporter = new OTLPTraceExporter({ url: otlpEndpoint });
  provider.addSpanProcessor(new BatchSpanProcessor(exporter));
  provider.register();

  const lcInstrumentation = new LangChainInstrumentation();
  lcInstrumentation.manuallyInstrument(CallbackManagerModule);

  return provider;
}

function getLlm() {
  return new ChatOpenAI({
    modelName: "qwen3.6-35b",
    openAIApiKey: process.env.LITELLM_KEY,
    configuration: { baseURL: "https://litellm.itransform365.com" },
    temperature: 0,
  });
}

// --- Simule un échec de sous-agent : timeout ou service indisponible ---
function simulateSubagentFailure() {
  throw new Error("Sub-agent unavailable: connection timeout after 5000ms (simulated failure)");
}

// =========================================================================
// SCÉNARIO A — Erreur GÉRÉE avec fallback
// =========================================================================

const GraphStateA = Annotation.Root({
  messages: Annotation({ reducer: (existing, update) => existing.concat(update), default: () => [] }),
  subagentFailed: Annotation({ reducer: (_, u) => u, default: () => false }),
});

function supervisorRouterA(state) {
  console.log("[Scénario A - Supervisor] Délégation vers le Sub-agent");
  return {};
}

async function subagentWithFailureHandled(state) {
  try {
    console.log("[Scénario A - Sub-agent] Tentative d'exécution...");
    simulateSubagentFailure();
  } catch (err) {
    console.log(`[Scénario A - Sub-agent] Échec détecté : ${err.message}`);
    // On enregistre explicitement l'erreur sur le span actif, mais on
    // NE relance PAS l'exception - le Supervisor va gérer un fallback
    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
      activeSpan.recordException(err);
      activeSpan.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    }
    return { subagentFailed: true };
  }
}

async function supervisorFallbackA(state) {
  if (state.subagentFailed) {
    console.log("[Scénario A - Supervisor] Sub-agent en échec - réponse de repli");
    return {
      messages: [{ content: "Désolé, le service de recherche est temporairement indisponible. Veuillez réessayer plus tard." }],
    };
  }
  return { messages: [{ content: "Réponse normale (pas d'échec détecté)." }] };
}

function buildGraphA() {
  return new StateGraph(GraphStateA)
    .addNode("supervisor_router", supervisorRouterA)
    .addNode("subagent", subagentWithFailureHandled)
    .addNode("supervisor_fallback", supervisorFallbackA)
    .addEdge(START, "supervisor_router")
    .addEdge("supervisor_router", "subagent")
    .addEdge("subagent", "supervisor_fallback")
    .addEdge("supervisor_fallback", END)
    .compile();
}

// =========================================================================
// SCÉNARIO B — Erreur NON GÉRÉE (crash sans filet de sécurité)
// =========================================================================

const GraphStateB = Annotation.Root({
  messages: Annotation({ reducer: (existing, update) => existing.concat(update), default: () => [] }),
});

function supervisorRouterB(state) {
  console.log("[Scénario B - Supervisor] Délégation vers le Sub-agent");
  return {};
}

async function subagentWithUnhandledCrash(state) {
  console.log("[Scénario B - Sub-agent] Tentative d'exécution...");
  // Aucun try/catch ici - l'exception remonte telle quelle et fait planter le graphe
  simulateSubagentFailure();
  return {};
}

function buildGraphB() {
  return new StateGraph(GraphStateB)
    .addNode("supervisor_router", supervisorRouterB)
    .addNode("subagent_crash", subagentWithUnhandledCrash)
    .addEdge(START, "supervisor_router")
    .addEdge("supervisor_router", "subagent_crash")
    .addEdge("subagent_crash", END)
    .compile();
}

// =========================================================================

async function runScenarioA() {
  console.log("\n========================================");
  console.log("SCÉNARIO A — Erreur GÉRÉE (fallback)");
  console.log("========================================\n");

  const provider = setupTracing("aizo-poc-error-handled");
  const app = buildGraphA();
  const tracer = trace.getTracer("error-test-runner");

  let capturedTraceId;
  await tracer.startActiveSpan("main-invocation", async (span) => {
    capturedTraceId = span.spanContext().traceId;
    console.log(`[Trace ID] ${capturedTraceId}`);

    const result = await app.invoke({
      messages: [new HumanMessage("Cherche des infos sur le tracing distribué")],
      subagentFailed: false,
    });

    console.log("\n--- Résultat final ---");
    console.log(result.messages[result.messages.length - 1].content);
    span.end();
  });

  console.log(`\nCherche dans Tempo (service: aizo-poc-error-handled) : ${capturedTraceId}`);
  console.log("Vérifie : le span 'subagent' doit apparaître en ERREUR (rouge),");
  console.log("mais la trace globale doit être COMPLÈTE (le Supervisor a quand même répondu).");

  await provider.forceFlush();
  await new Promise((r) => setTimeout(r, 2000));
}

async function runScenarioB() {
  console.log("\n========================================");
  console.log("SCÉNARIO B — Erreur NON GÉRÉE (crash)");
  console.log("========================================\n");

  const provider = setupTracing("aizo-poc-error-unhandled");
  const app = buildGraphB();
  const tracer = trace.getTracer("error-test-runner");

  let capturedTraceId;
  try {
    await tracer.startActiveSpan("main-invocation", async (span) => {
      capturedTraceId = span.spanContext().traceId;
      console.log(`[Trace ID] ${capturedTraceId}`);

      await app.invoke({
        messages: [new HumanMessage("Cherche des infos sur le tracing distribué")],
      });

      span.end();
    });
  } catch (err) {
    console.log(`\n[Crash capturé au niveau du programme] ${err.message}`);
  }

  console.log(`\nCherche dans Tempo (service: aizo-poc-error-unhandled) : ${capturedTraceId}`);
  console.log("Vérifie : est-ce que la trace PARTIELLE (jusqu'au point de crash) arrive");
  console.log("quand même dans Tempo, avec le span 'subagent_crash' visible en erreur ?");

  await provider.forceFlush();
  await new Promise((r) => setTimeout(r, 2000));
}

async function main() {
  await runScenarioA();
  await runScenarioB();
  process.exit(0);
}

main().catch((err) => {
  console.error("Erreur inattendue dans le script lui-même:", err);
  process.exit(1);
});
```

## ./demo-app/ai-poc-node/agent-to-agent.js
```
/**
 * POC — Communication agent-à-agent (Supervisor -> Sub-agent) instrumentée avec OpenTelemetry.
 * Teste si le tracing reste UNE SEULE trace continue quand un agent délègue à un autre,
 * ou si ça se casse en traces séparées.
 *
 * Usage :
 *   export LITELLM_KEY="..."
 *   export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4317"
 *   node agent-to-agent.js
 */

const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");
const { BatchSpanProcessor } = require("@opentelemetry/sdk-trace-base");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-grpc");
const { Resource } = require("@opentelemetry/resources");
const { SemanticResourceAttributes } = require("@opentelemetry/semantic-conventions");
const { diag, DiagConsoleLogger, DiagLogLevel } = require("@opentelemetry/api");
const { LangChainInstrumentation } = require("@arizeai/openinference-instrumentation-langchain");
const CallbackManagerModule = require("@langchain/core/callbacks/manager");

// Active les logs internes d'OpenTelemetry - indispensable pour voir les
// vraies erreurs d'export (auth, connexion, sérialisation...), qui restent
// sinon complètement silencieuses avec le SDK Node.js.
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);

const { StateGraph, END, Annotation } = require("@langchain/langgraph");
const { ChatOpenAI } = require("@langchain/openai");
const { HumanMessage, SystemMessage, AIMessage } = require("@langchain/core/messages");

// --- Instrumentation OpenTelemetry ---
function setupTracing() {
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4317";
  const serviceName = process.env.OTEL_SERVICE_NAME || "aizo-poc-agent-to-agent";

  const provider = new NodeTracerProvider({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
    }),
  });

  const exporter = new OTLPTraceExporter({ url: otlpEndpoint });
  provider.addSpanProcessor(new BatchSpanProcessor(exporter));
  provider.register();

  const lcInstrumentation = new LangChainInstrumentation();
  lcInstrumentation.manuallyInstrument(CallbackManagerModule);

  return provider;
}

const MOCK_MODE = !process.env.LITELLM_KEY;

function getLlm(systemRole) {
  if (MOCK_MODE) {
    const { FakeListChatModel } = require("@langchain/core/utils/testing");
    return new FakeListChatModel({
      responses: [`[${systemRole}] Réponse simulée pour tester le pipeline de tracing.`],
    });
  }
  return new ChatOpenAI({
    modelName: "qwen3.6-35b",
    openAIApiKey: process.env.LITELLM_KEY,
    configuration: { baseURL: "https://litellm.itransform365.com" },
    temperature: 0,
  });
}

// --- État partagé entre Supervisor et Sub-agent ---
const GraphState = Annotation.Root({
  messages: Annotation({
    reducer: (existing, update) => existing.concat(update),
    default: () => [],
  }),
  taskType: Annotation({
    reducer: (_, update) => update,
    default: () => "",
  }),
  subagentResult: Annotation({
    reducer: (_, update) => update,
    default: () => null,
  }),
});

// --- Nœud Supervisor : décide de déléguer ou répondre directement ---
function supervisorRouterNode(state) {
  const lastMessage = state.messages[state.messages.length - 1].content;
  const taskType = /cherche|trouve|recherche/i.test(lastMessage) ? "retrieval" : "chat";
  console.log(`[Supervisor] Requête classée: ${taskType}`);
  return { taskType };
}

function shouldDelegate(state) {
  return state.taskType === "retrieval" ? "delegate_to_subagent" : "supervisor_direct_answer";
}

// --- Sub-agent : un agent spécialisé, distinct, avec son propre rôle/prompt ---
// C'est ICI que se joue le vrai test : cet appel LLM doit apparaître comme un
// span imbriqué DANS LA MÊME TRACE que le Supervisor, pas comme une trace séparée.
async function subagentNode(state) {
  console.log("[Sub-agent] Invoqué par le Supervisor pour une tâche de recherche spécialisée");

  const llm = getLlm("ResearchSubAgent");
  const userQuery = state.messages[0].content;

  const subagentMessages = [
    new SystemMessage(
      "Tu es un sous-agent spécialisé dans la recherche d'informations techniques. " +
      "Réponds de façon concise et factuelle, en 2-3 phrases maximum."
    ),
    new HumanMessage(userQuery),
  ];

  const response = await llm.invoke(subagentMessages);

  return {
    subagentResult: response.content,
    messages: [new AIMessage(`[Résultat du sous-agent] ${response.content}`)],
  };
}

// --- Supervisor : synthétise la réponse finale à partir du résultat du sous-agent ---
async function supervisorSynthesizeNode(state) {
  console.log("[Supervisor] Synthèse de la réponse finale à partir du résultat du sous-agent");

  const llm = getLlm("Supervisor");
  const synthesisMessages = [
    new SystemMessage(
      "Tu es le superviseur. Un sous-agent spécialisé a fourni les informations suivantes. " +
      "Reformule-les en une réponse claire et complète pour l'utilisateur."
    ),
    new HumanMessage(`Résultat du sous-agent: ${state.subagentResult}`),
  ];

  const response = await llm.invoke(synthesisMessages);
  return { messages: [response] };
}

// --- Supervisor : répond directement sans déléguer (cas "chat" simple) ---
async function supervisorDirectAnswerNode(state) {
  console.log("[Supervisor] Réponse directe, pas de délégation nécessaire");
  const llm = getLlm("Supervisor");
  const response = await llm.invoke(state.messages);
  return { messages: [response] };
}

function buildGraph() {
  const graph = new StateGraph(GraphState)
    .addNode("supervisor_router", supervisorRouterNode)
    .addNode("delegate_to_subagent", subagentNode)
    .addNode("supervisor_direct_answer", supervisorDirectAnswerNode)
    .addNode("supervisor_synthesize", supervisorSynthesizeNode)
    .setEntryPoint("supervisor_router")
    .addConditionalEdges("supervisor_router", shouldDelegate, {
      delegate_to_subagent: "delegate_to_subagent",
      supervisor_direct_answer: "supervisor_direct_answer",
    })
    .addEdge("delegate_to_subagent", "supervisor_synthesize")
    .addEdge("supervisor_synthesize", END)
    .addEdge("supervisor_direct_answer", END);

  return graph.compile();
}

async function main() {
  const tracerProvider = setupTracing();
  const app = buildGraph();

  console.log("=== Test agent-à-agent : Supervisor -> Sub-agent ===\n");

  const result = await app.invoke({
    messages: [new HumanMessage("Cherche des informations sur l'observabilité Kubernetes")],
    taskType: "",
    subagentResult: null,
  });

  console.log("\n--- Réponse finale (après délégation au sous-agent) ---");
  console.log(result.messages[result.messages.length - 1].content);

  console.log("\n=== Vérification à faire dans Grafana ===");
  console.log("Explore -> Tempo -> service.name = " + (process.env.OTEL_SERVICE_NAME || "aizo-poc-agent-to-agent"));
  console.log("Question clé : est-ce que 'delegate_to_subagent' et 'supervisor_synthesize'");
  console.log("apparaissent comme DEUX SPANS DANS LA MÊME TRACE, ou comme deux traces séparées ?");
  console.log("Si c'est une seule trace continue -> le tracing agent-à-agent fonctionne correctement.");

  // Force l'envoi de tous les spans en attente avant de quitter le process -
  // le BatchSpanProcessor n'exporte pas immédiatement, il faut le forcer.
  console.log("\n[Flush] Envoi forcé des spans en attente vers le Collector...");
  await tracerProvider.forceFlush();
  await new Promise((resolve) => setTimeout(resolve, 3000));
  console.log("[Flush] Terminé.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

## ./demo-app/ai-poc-node/app.js
```
/**
 * POC — Petit graphe LangGraph.js instrumenté avec OpenTelemetry (via OpenInference).
 * Équivalent Node.js du POC Python, pour correspondre à la stack réelle de l'équipe.
 *
 * Usage :
 *   export LITELLM_KEY="..."
 *   export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4317"
 *   node app.js
 */

const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");
const { BatchSpanProcessor } = require("@opentelemetry/sdk-trace-base");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-grpc");
const { Resource } = require("@opentelemetry/resources");
const { SemanticResourceAttributes } = require("@opentelemetry/semantic-conventions");
const { LangChainInstrumentation } = require("@arizeai/openinference-instrumentation-langchain");
const CallbackManagerModule = require("@langchain/core/callbacks/manager");

const { StateGraph, END, Annotation } = require("@langchain/langgraph");
const { ChatOpenAI } = require("@langchain/openai");
const { HumanMessage, ToolMessage } = require("@langchain/core/messages");
const { tool } = require("@langchain/core/tools");
const { z } = require("zod");

// --- Instrumentation OpenTelemetry (via OpenInference) ---
// Contrairement à Python (où l'instrumentation est automatique), LangChain.js
// exige une instrumentation manuelle du module de callbacks - c'est la seule
// vraie différence structurelle par rapport à la version Python.

function setupTracing() {
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4317";
  const serviceName = process.env.OTEL_SERVICE_NAME || "aizo-poc-langgraph-js";

  const provider = new NodeTracerProvider({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
    }),
  });

  const exporter = new OTLPTraceExporter({ url: otlpEndpoint });
  provider.addSpanProcessor(new BatchSpanProcessor(exporter));
  provider.register();

  const lcInstrumentation = new LangChainInstrumentation();
  lcInstrumentation.manuallyInstrument(CallbackManagerModule);
}

// --- Détection du mode mock (pas de clé -> LLM simulé) ---
const MOCK_MODE = !process.env.LITELLM_KEY;

function getLlm() {
  if (MOCK_MODE) {
    console.log("[MOCK_MODE actif - aucune clé LITELLM_KEY détectée, réponses simulées]\n");
    // FakeListChatModel équivalent en JS
    const { FakeListChatModel } = require("@langchain/core/utils/testing");
    return new FakeListChatModel({
      responses: ["Voici une réponse simulée pour tester le pipeline de tracing."],
    });
  } else {
    return new ChatOpenAI({
      modelName: "qwen3.6-35b",
      openAIApiKey: process.env.LITELLM_KEY,
      configuration: { baseURL: "https://litellm.itransform365.com" },
      temperature: 0,
    });
  }
}

// --- Outil simulé (équivalent Tavily/Neo4j dans AIZO) ---
const searchKnowledgeBase = tool(
  async ({ query }) => {
    return `[résultat simulé pour: ${query}] Voici une information pertinente trouvée dans la base.`;
  },
  {
    name: "search_knowledge_base",
    description: "Simule une recherche dans une base de connaissances (équivalent Tavily/Neo4j dans AIZO).",
    schema: z.object({
      query: z.string(),
    }),
  }
);

// --- État du graphe ---
const GraphState = Annotation.Root({
  messages: Annotation({
    reducer: (existing, update) => existing.concat(update),
    default: () => [],
  }),
  taskType: Annotation({
    reducer: (_, update) => update,
    default: () => "",
  }),
});

// --- Nœuds du graphe (Router -> Chatbot -> Tool -> End) ---

function routerNode(state) {
  const lastMessage = state.messages[state.messages.length - 1].content;
  let taskType = "chat";
  if (/cherche|trouve/i.test(lastMessage)) {
    taskType = "retrieval";
  }
  return { taskType };
}

async function chatbotNode(state) {
  const llm = getLlm();
  if (MOCK_MODE) {
    const response = await llm.invoke(state.messages);
    return { messages: [response] };
  } else {
    const llmWithTools = llm.bindTools([searchKnowledgeBase]);
    const response = await llmWithTools.invoke(state.messages);
    return { messages: [response] };
  }
}

function shouldUseTool(state) {
  const lastMessage = state.messages[state.messages.length - 1];
  if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
    return "tools";
  }
  return END;
}

async function toolNode(state) {
  const lastMessage = state.messages[state.messages.length - 1];
  const toolMessages = [];
  for (const toolCall of lastMessage.tool_calls) {
    if (toolCall.name === "search_knowledge_base") {
      const result = await searchKnowledgeBase.invoke(toolCall.args);
      toolMessages.push(new ToolMessage({ content: result, tool_call_id: toolCall.id }));
    }
  }
  return { messages: toolMessages };
}

function buildGraph() {
  const graph = new StateGraph(GraphState)
    .addNode("router", routerNode)
    .addNode("chatbot", chatbotNode)
    .addNode("tools", toolNode)
    .setEntryPoint("router")
    .addEdge("router", "chatbot")
    .addConditionalEdges("chatbot", shouldUseTool, { tools: "tools", [END]: END })
    .addEdge("tools", "chatbot");

  return graph.compile();
}

async function main() {
  setupTracing();
  const app = buildGraph();

  const result = await app.invoke({
    messages: [new HumanMessage("Cherche des informations sur l'observabilité Kubernetes")],
    taskType: "",
  });

  console.log("\n--- Réponse finale ---");
  console.log(result.messages[result.messages.length - 1].content);
  console.log(`\nTask type détecté: ${result.taskType}`);
  console.log("\nVérifie la trace dans Grafana -> Explore -> Tempo -> service.name = aizo-poc-langgraph-js");

  // Laisse le temps au BatchSpanProcessor d'exporter avant de quitter
  await new Promise((resolve) => setTimeout(resolve, 2000));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

## ./demo-app/ai-poc-node/error-scenario-b-crash.js
```
/**
 * POC — Scénario B : Erreur NON GÉRÉE (crash sans filet de sécurité).
 * Script séparé (processus Node.js indépendant) - voir error-scenario-a-handled.js
 * pour l'explication du pourquoi ces 2 scénarios sont dans des fichiers distincts.
 *
 * Usage :
 *   export LITELLM_KEY="..."
 *   export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4317"
 *   node error-scenario-b-crash.js
 */

const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");
const { BatchSpanProcessor } = require("@opentelemetry/sdk-trace-base");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-grpc");
const { Resource } = require("@opentelemetry/resources");
const { SemanticResourceAttributes } = require("@opentelemetry/semantic-conventions");
const { diag, DiagConsoleLogger, DiagLogLevel, trace } = require("@opentelemetry/api");
const { LangChainInstrumentation } = require("@arizeai/openinference-instrumentation-langchain");
const CallbackManagerModule = require("@langchain/core/callbacks/manager");

const { StateGraph, END, Annotation, START } = require("@langchain/langgraph");
const { HumanMessage } = require("@langchain/core/messages");

diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

function setupTracing() {
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4317";
  const provider = new NodeTracerProvider({
    resource: new Resource({ [SemanticResourceAttributes.SERVICE_NAME]: "aizo-poc-error-unhandled" }),
  });
  const exporter = new OTLPTraceExporter({ url: otlpEndpoint });
  provider.addSpanProcessor(new BatchSpanProcessor(exporter));
  provider.register();

  const lcInstrumentation = new LangChainInstrumentation();
  lcInstrumentation.manuallyInstrument(CallbackManagerModule);

  return provider;
}

function simulateSubagentFailure() {
  throw new Error("Sub-agent unavailable: connection timeout after 5000ms (simulated failure)");
}

const GraphState = Annotation.Root({
  messages: Annotation({ reducer: (existing, update) => existing.concat(update), default: () => [] }),
});

function supervisorRouter(state) {
  console.log("[Supervisor] Délégation vers le Sub-agent");
  return {};
}

async function subagentWithUnhandledCrash(state) {
  console.log("[Sub-agent] Tentative d'exécution...");
  // Aucun try/catch - l'exception remonte telle quelle et fait planter le graphe
  simulateSubagentFailure();
  return {};
}

function buildGraph() {
  return new StateGraph(GraphState)
    .addNode("supervisor_router", supervisorRouter)
    .addNode("subagent_crash", subagentWithUnhandledCrash)
    .addEdge(START, "supervisor_router")
    .addEdge("supervisor_router", "subagent_crash")
    .addEdge("subagent_crash", END)
    .compile();
}

async function main() {
  console.log("=== SCÉNARIO B — Erreur NON GÉRÉE (crash) ===\n");

  const provider = setupTracing();
  const app = buildGraph();
  const tracer = trace.getTracer("error-test-runner");

  let capturedTraceId;
  try {
    await tracer.startActiveSpan("main-invocation", async (span) => {
      capturedTraceId = span.spanContext().traceId;
      console.log(`[Trace ID] ${capturedTraceId}`);

      await app.invoke({
        messages: [new HumanMessage("Cherche des infos sur le tracing distribué")],
      });

      span.end();
    });
  } catch (err) {
    console.log(`\n[Crash capturé au niveau du programme] ${err.message}`);
  }

  console.log(`\nCherche dans Tempo : ${capturedTraceId}`);
  console.log("(service.name = aizo-poc-error-unhandled)");
  console.log("Vérifie : est-ce que la trace PARTIELLE (jusqu'au point de crash) arrive");
  console.log("quand même dans Tempo, avec le span 'subagent_crash' visible en erreur ?");

  await provider.forceFlush();
  await new Promise((r) => setTimeout(r, 2000));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

## ./demo-app/ai-poc-node/package.json
```
{
  "name": "aizo-poc-langgraph-js",
  "version": "1.0.0",
  "description": "POC LangGraph.js instrumenté avec OpenTelemetry/OpenInference - equivalent Node.js du POC Python",
  "main": "app.js",
  "scripts": {
    "start": "node app.js"
  },
  "dependencies": {
    "@arizeai/openinference-instrumentation-langchain": "^1.0.0",
    "@langchain/core": "^0.3.0",
    "@langchain/langgraph": "^0.2.0",
    "@langchain/openai": "^0.3.0",
    "@opentelemetry/exporter-trace-otlp-grpc": "^0.54.0",
    "@opentelemetry/instrumentation-http": "^0.221.0",
    "@opentelemetry/resources": "^1.27.0",
    "@opentelemetry/sdk-trace-base": "^1.27.0",
    "@opentelemetry/sdk-trace-node": "^1.27.0",
    "@opentelemetry/semantic-conventions": "^1.27.0",
    "axios": "^1.20.0",
    "express": "^5.2.1",
    "zod": "^3.23.0"
  }
}
```

## ./demo-app/ai-poc-node/package-lock.json
```
{
  "name": "aizo-poc-langgraph-js",
  "version": "1.0.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "aizo-poc-langgraph-js",
      "version": "1.0.0",
      "dependencies": {
        "@arizeai/openinference-instrumentation-langchain": "^1.0.0",
        "@langchain/core": "^0.3.0",
        "@langchain/langgraph": "^0.2.0",
        "@langchain/openai": "^0.3.0",
        "@opentelemetry/exporter-trace-otlp-grpc": "^0.54.0",
        "@opentelemetry/instrumentation-http": "^0.221.0",
        "@opentelemetry/resources": "^1.27.0",
        "@opentelemetry/sdk-trace-base": "^1.27.0",
        "@opentelemetry/sdk-trace-node": "^1.27.0",
        "@opentelemetry/semantic-conventions": "^1.27.0",
        "axios": "^1.20.0",
        "express": "^5.2.1",
        "zod": "^3.23.0"
      }
    },
    "node_modules/@arizeai/openinference-core": {
      "version": "0.3.3",
      "resolved": "https://registry.npmjs.org/@arizeai/openinference-core/-/openinference-core-0.3.3.tgz",
      "integrity": "sha512-QJYCr9kGJ83iRgcEM/elQMiw0g3uoBQDt6QnKKYT9nFcW17pi7dx8+sjE09b1T+yyNK9fSppPZq78OkwBuWYZw==",
      "license": "Apache-2.0",
      "dependencies": {
        "@arizeai/openinference-semantic-conventions": "0.14.0",
        "@opentelemetry/api": "^1.9.0",
        "@opentelemetry/core": "^1.25.1"
      }
    },
    "node_modules/@arizeai/openinference-instrumentation-langchain": {
      "version": "1.1.0",
      "resolved": "https://registry.npmjs.org/@arizeai/openinference-instrumentation-langchain/-/openinference-instrumentation-langchain-1.1.0.tgz",
      "integrity": "sha512-g2J8spuD5dVae7cf18lqMXJYnPmolm9yrojuj7jOIgbLZTZYdmeYq+3UGM1ssUvxxif08gXry2KeJzCIR0PQ0g==",
      "license": "Apache-2.0",
      "dependencies": {
        "@arizeai/openinference-core": "0.3.3",
        "@arizeai/openinference-semantic-conventions": "0.14.0",
        "@opentelemetry/api": "^1.9.0",
        "@opentelemetry/core": "^1.25.1",
        "@opentelemetry/instrumentation": "^0.46.0"
      },
      "peerDependencies": {
        "@langchain/core": "^0.1.0 || ^0.2.0 || ^0.3.0"
      }
    },
    "node_modules/@arizeai/openinference-semantic-conventions": {
      "version": "0.14.0",
      "resolved": "https://registry.npmjs.org/@arizeai/openinference-semantic-conventions/-/openinference-semantic-conventions-0.14.0.tgz",
      "integrity": "sha512-lczLdSuI+vVwoUgR3iDstVsaUtWkY6kwPWb4uuAuzQNLV8Lm04lNW6QFbhWjHbVDeQ6i6I8+/iAa9JeJ0j745g==",
      "license": "Apache-2.0"
    },
    "node_modules/@cfworker/json-schema": {
      "version": "4.1.1",
      "resolved": "https://registry.npmjs.org/@cfworker/json-schema/-/json-schema-4.1.1.tgz",
      "integrity": "sha512-gAmrUZSGtKc3AiBL71iNWxDsyUC5uMaKKGdvzYsBoTW/xi42JQHl7eKV2OYzCUqvc+D2RCcf7EXY2iCyFIk6og==",
      "license": "MIT"
    },
    "node_modules/@grpc/grpc-js": {
      "version": "1.14.4",
      "resolved": "https://registry.npmjs.org/@grpc/grpc-js/-/grpc-js-1.14.4.tgz",
      "integrity": "sha512-k9Dj3DV/itK9D06Y8f190Qgop7/Ui+D0njFV3LHMPwPT75DpXLQohE9Wmz0QElrJnzsjB7KPWiKJbOl7IPDArQ==",
      "license": "Apache-2.0",
      "dependencies": {
        "@grpc/proto-loader": "^0.8.0",
        "@js-sdsl/ordered-map": "^4.4.2"
      },
      "engines": {
        "node": ">=12.10.0"
      }
    },
    "node_modules/@grpc/proto-loader": {
      "version": "0.8.1",
      "resolved": "https://registry.npmjs.org/@grpc/proto-loader/-/proto-loader-0.8.1.tgz",
      "integrity": "sha512-wtF6h+DY6M3YaDBPAmvuuA6jV8Sif9MjtOI5euKFWRgCDl5PeDpPsHR9u2l6St5ceY8AZgoNDww5+HvEsXFsGg==",
      "license": "Apache-2.0",
      "dependencies": {
        "lodash.camelcase": "^4.3.0",
        "long": "^5.0.0",
        "protobufjs": "^7.5.5",
        "yargs": "^17.7.2"
      },
      "bin": {
        "proto-loader-gen-types": "build/bin/proto-loader-gen-types.js"
      },
      "engines": {
        "node": ">=6"
      }
    },
    "node_modules/@js-sdsl/ordered-map": {
      "version": "4.4.2",
      "resolved": "https://registry.npmjs.org/@js-sdsl/ordered-map/-/ordered-map-4.4.2.tgz",
      "integrity": "sha512-iUKgm52T8HOE/makSxjqoWhe95ZJA1/G1sYsGev2JDKUSS14KAgg1LHb+Ba+IPow0xflbnSkOsZcO08C7w1gYw==",
      "license": "MIT",
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/js-sdsl"
      }
    },
    "node_modules/@langchain/core": {
      "version": "0.3.80",
      "resolved": "https://registry.npmjs.org/@langchain/core/-/core-0.3.80.tgz",
      "integrity": "sha512-vcJDV2vk1AlCwSh3aBm/urQ1ZrlXFFBocv11bz/NBUfLWD5/UDNMzwPdaAd2dKvNmTWa9FM2lirLU3+JCf4cRA==",
      "license": "MIT",
      "dependencies": {
        "@cfworker/json-schema": "^4.0.2",
        "ansi-styles": "^5.0.0",
        "camelcase": "6",
        "decamelize": "1.2.0",
        "js-tiktoken": "^1.0.12",
        "langsmith": "^0.3.67",
        "mustache": "^4.2.0",
        "p-queue": "^6.6.2",
        "p-retry": "4",
        "uuid": "^10.0.0",
        "zod": "^3.25.32",
        "zod-to-json-schema": "^3.22.3"
      },
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@langchain/langgraph": {
      "version": "0.2.74",
      "resolved": "https://registry.npmjs.org/@langchain/langgraph/-/langgraph-0.2.74.tgz",
      "integrity": "sha512-oHpEi5sTZTPaeZX1UnzfM2OAJ21QGQrwReTV6+QnX7h8nDCBzhtipAw1cK616S+X8zpcVOjgOtJuaJhXa4mN8w==",
      "license": "MIT",
      "dependencies": {
        "@langchain/langgraph-checkpoint": "~0.0.17",
        "@langchain/langgraph-sdk": "~0.0.32",
        "uuid": "^10.0.0",
        "zod": "^3.23.8"
      },
      "engines": {
        "node": ">=18"
      },
      "peerDependencies": {
        "@langchain/core": ">=0.2.36 <0.3.0 || >=0.3.40 < 0.4.0",
        "zod-to-json-schema": "^3.x"
      },
      "peerDependenciesMeta": {
        "zod-to-json-schema": {
          "optional": true
        }
      }
    },
    "node_modules/@langchain/langgraph-checkpoint": {
      "version": "0.0.18",
      "resolved": "https://registry.npmjs.org/@langchain/langgraph-checkpoint/-/langgraph-checkpoint-0.0.18.tgz",
      "integrity": "sha512-IS7zJj36VgY+4pf8ZjsVuUWef7oTwt1y9ylvwu0aLuOn1d0fg05Om9DLm3v2GZ2Df6bhLV1kfWAM0IAl9O5rQQ==",
      "license": "MIT",
      "dependencies": {
        "uuid": "^10.0.0"
      },
      "engines": {
        "node": ">=18"
      },
      "peerDependencies": {
        "@langchain/core": ">=0.2.31 <0.4.0"
      }
    },
    "node_modules/@langchain/langgraph-sdk": {
      "version": "0.0.112",
      "resolved": "https://registry.npmjs.org/@langchain/langgraph-sdk/-/langgraph-sdk-0.0.112.tgz",
      "integrity": "sha512-/9W5HSWCqYgwma6EoOspL4BGYxGxeJP6lIquPSF4FA0JlKopaUv58ucZC3vAgdJyCgg6sorCIV/qg7SGpEcCLw==",
      "license": "MIT",
      "dependencies": {
        "@types/json-schema": "^7.0.15",
        "p-queue": "^6.6.2",
        "p-retry": "4",
        "uuid": "^9.0.0"
      },
      "peerDependencies": {
        "@langchain/core": ">=0.2.31 <0.4.0",
        "react": "^18 || ^19",
        "react-dom": "^18 || ^19"
      },
      "peerDependenciesMeta": {
        "@langchain/core": {
          "optional": true
        },
        "react": {
          "optional": true
        },
        "react-dom": {
          "optional": true
        }
      }
    },
    "node_modules/@langchain/langgraph-sdk/node_modules/uuid": {
      "version": "9.0.1",
      "resolved": "https://registry.npmjs.org/uuid/-/uuid-9.0.1.tgz",
      "integrity": "sha512-b+1eJOlsR9K8HJpow9Ok3fiWOWSIcIzXodvv0rQjVoOVNpWMpxf1wZNpt4y9h10odCNrqnYp1OBzRktckBe3sA==",
      "deprecated": "uuid@10 and below is no longer supported.  For ESM codebases, update to uuid@latest.  For CommonJS codebases, use uuid@11 (but be aware this version will likely be deprecated in 2028).",
      "funding": [
        "https://github.com/sponsors/broofa",
        "https://github.com/sponsors/ctavan"
      ],
      "license": "MIT",
      "bin": {
        "uuid": "dist/bin/uuid"
      }
    },
    "node_modules/@langchain/openai": {
      "version": "0.3.17",
      "resolved": "https://registry.npmjs.org/@langchain/openai/-/openai-0.3.17.tgz",
      "integrity": "sha512-uw4po32OKptVjq+CYHrumgbfh4NuD7LqyE+ZgqY9I/LrLc6bHLMc+sisHmI17vgek0K/yqtarI0alPJbzrwyag==",
      "license": "MIT",
      "dependencies": {
        "js-tiktoken": "^1.0.12",
        "openai": "^4.77.0",
        "zod": "^3.22.4",
        "zod-to-json-schema": "^3.22.3"
      },
      "engines": {
        "node": ">=18"
      },
      "peerDependencies": {
        "@langchain/core": ">=0.3.29 <0.4.0"
      }
    },
    "node_modules/@opentelemetry/api": {
      "version": "1.9.1",
      "resolved": "https://registry.npmjs.org/@opentelemetry/api/-/api-1.9.1.tgz",
      "integrity": "sha512-gLyJlPHPZYdAk1JENA9LeHejZe1Ti77/pTeFm/nMXmQH/HFZlcS/O2XJB+L8fkbrNSqhdtlvjBVjxwUYanNH5Q==",
      "license": "Apache-2.0",
      "engines": {
        "node": ">=8.0.0"
      }
    },
    "node_modules/@opentelemetry/api-logs": {
      "version": "0.54.2",
      "resolved": "https://registry.npmjs.org/@opentelemetry/api-logs/-/api-logs-0.54.2.tgz",
      "integrity": "sha512-4MTVwwmLgUh5QrJnZpYo6YRO5IBLAggf2h8gWDblwRagDStY13aEvt7gGk3jewrMaPlHiF83fENhIx0HO97/cQ==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/api": "^1.3.0"
      },
      "engines": {
        "node": ">=14"
      }
    },
    "node_modules/@opentelemetry/context-async-hooks": {
      "version": "1.30.1",
      "resolved": "https://registry.npmjs.org/@opentelemetry/context-async-hooks/-/context-async-hooks-1.30.1.tgz",
      "integrity": "sha512-s5vvxXPVdjqS3kTLKMeBMvop9hbWkwzBpu+mUO2M7sZtlkyDJGwFe33wRKnbaYDo8ExRVBIIdwIGrqpxHuKttA==",
      "license": "Apache-2.0",
      "engines": {
        "node": ">=14"
      },
      "peerDependencies": {
        "@opentelemetry/api": ">=1.0.0 <1.10.0"
      }
    },
    "node_modules/@opentelemetry/core": {
      "version": "1.30.1",
      "resolved": "https://registry.npmjs.org/@opentelemetry/core/-/core-1.30.1.tgz",
      "integrity": "sha512-OOCM2C/QIURhJMuKaekP3TRBxBKxG/TWWA0TL2J6nXUtDnuCtccy49LUJF8xPFXMX+0LMcxFpCo8M9cGY1W6rQ==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/semantic-conventions": "1.28.0"
      },
      "engines": {
        "node": ">=14"
      },
      "peerDependencies": {
        "@opentelemetry/api": ">=1.0.0 <1.10.0"
      }
    },
    "node_modules/@opentelemetry/core/node_modules/@opentelemetry/semantic-conventions": {
      "version": "1.28.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/semantic-conventions/-/semantic-conventions-1.28.0.tgz",
      "integrity": "sha512-lp4qAiMTD4sNWW4DbKLBkfiMZ4jbAboJIGOQr5DvciMRI494OapieI9qiODpOt0XBr1LjIDy1xAGAnVs5supTA==",
      "license": "Apache-2.0",
      "engines": {
        "node": ">=14"
      }
    },
    "node_modules/@opentelemetry/exporter-trace-otlp-grpc": {
      "version": "0.54.2",
      "resolved": "https://registry.npmjs.org/@opentelemetry/exporter-trace-otlp-grpc/-/exporter-trace-otlp-grpc-0.54.2.tgz",
      "integrity": "sha512-tmxiCYhQdPrzwlM6O7VQeNP9PBjKhaiOo54wFxQFZQcoVaDiOOES4+6PwHU1eW+43mDsgdQHN5AHSRHVLe9jDA==",
      "license": "Apache-2.0",
      "dependencies": {
        "@grpc/grpc-js": "^1.7.1",
        "@opentelemetry/core": "1.27.0",
        "@opentelemetry/otlp-grpc-exporter-base": "0.54.2",
        "@opentelemetry/otlp-transformer": "0.54.2",
        "@opentelemetry/resources": "1.27.0",
        "@opentelemetry/sdk-trace-base": "1.27.0"
      },
      "engines": {
        "node": ">=14"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/exporter-trace-otlp-grpc/node_modules/@opentelemetry/core": {
      "version": "1.27.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/core/-/core-1.27.0.tgz",
      "integrity": "sha512-yQPKnK5e+76XuiqUH/gKyS8wv/7qITd5ln56QkBTf3uggr0VkXOXfcaAuG330UfdYu83wsyoBwqwxigpIG+Jkg==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/semantic-conventions": "1.27.0"
      },
      "engines": {
        "node": ">=14"
      },
      "peerDependencies": {
        "@opentelemetry/api": ">=1.0.0 <1.10.0"
      }
    },
    "node_modules/@opentelemetry/exporter-trace-otlp-grpc/node_modules/@opentelemetry/resources": {
      "version": "1.27.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/resources/-/resources-1.27.0.tgz",
      "integrity": "sha512-jOwt2VJ/lUD5BLc+PMNymDrUCpm5PKi1E9oSVYAvz01U/VdndGmrtV3DU1pG4AwlYhJRHbHfOUIlpBeXCPw6QQ==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/core": "1.27.0",
        "@opentelemetry/semantic-conventions": "1.27.0"
      },
      "engines": {
        "node": ">=14"
      },
      "peerDependencies": {
        "@opentelemetry/api": ">=1.0.0 <1.10.0"
      }
    },
    "node_modules/@opentelemetry/exporter-trace-otlp-grpc/node_modules/@opentelemetry/sdk-trace-base": {
      "version": "1.27.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/sdk-trace-base/-/sdk-trace-base-1.27.0.tgz",
      "integrity": "sha512-btz6XTQzwsyJjombpeqCX6LhiMQYpzt2pIYNPnw0IPO/3AhT6yjnf8Mnv3ZC2A4eRYOjqrg+bfaXg9XHDRJDWQ==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/core": "1.27.0",
        "@opentelemetry/resources": "1.27.0",
        "@opentelemetry/semantic-conventions": "1.27.0"
      },
      "engines": {
        "node": ">=14"
      },
      "peerDependencies": {
        "@opentelemetry/api": ">=1.0.0 <1.10.0"
      }
    },
    "node_modules/@opentelemetry/exporter-trace-otlp-grpc/node_modules/@opentelemetry/semantic-conventions": {
      "version": "1.27.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/semantic-conventions/-/semantic-conventions-1.27.0.tgz",
      "integrity": "sha512-sAay1RrB+ONOem0OZanAR1ZI/k7yDpnOQSQmTMuGImUQb2y8EbSaCJ94FQluM74xoU03vlb2d2U90hZluL6nQg==",
      "license": "Apache-2.0",
      "engines": {
        "node": ">=14"
      }
    },
    "node_modules/@opentelemetry/instrumentation": {
      "version": "0.46.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/instrumentation/-/instrumentation-0.46.0.tgz",
      "integrity": "sha512-a9TijXZZbk0vI5TGLZl+0kxyFfrXHhX6Svtz7Pp2/VBlCSKrazuULEyoJQrOknJyFWNMEmbbJgOciHCCpQcisw==",
      "license": "Apache-2.0",
      "dependencies": {
        "@types/shimmer": "^1.0.2",
        "import-in-the-middle": "1.7.1",
        "require-in-the-middle": "^7.1.1",
        "semver": "^7.5.2",
        "shimmer": "^1.2.1"
      },
      "engines": {
        "node": ">=14"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/instrumentation-http": {
      "version": "0.221.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/instrumentation-http/-/instrumentation-http-0.221.0.tgz",
      "integrity": "sha512-oIP91CPIANuYr09tGFElPFKAh6JUar+awJf1kBRYlaeo9b0gDwZHEB2zBfFlvdNFHm0wAVutMZODVi5smKT30g==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/core": "2.10.0",
        "@opentelemetry/instrumentation": "0.221.0",
        "@opentelemetry/semantic-conventions": "^1.29.0",
        "forwarded-parse": "2.1.2"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/instrumentation-http/node_modules/@opentelemetry/api-logs": {
      "version": "0.221.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/api-logs/-/api-logs-0.221.0.tgz",
      "integrity": "sha512-OlanaW1vv7ufTqQ3/fPLI4arGt5ZoM+P8abOMki6uEYnpRazepSWDwDnnw+la7kE26SHVC18//SMccrDvLKOXQ==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/api": "^1.3.0"
      },
      "engines": {
        "node": ">=8.0.0"
      }
    },
    "node_modules/@opentelemetry/instrumentation-http/node_modules/@opentelemetry/core": {
      "version": "2.10.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/core/-/core-2.10.0.tgz",
      "integrity": "sha512-/wNZ8twnEQQA4HoHu22+vcsdru6pWPWxW+7w+FlxT6Id7PE/WIbZmVKkte+PF72e0F2dnImFeHD2syyE1Mw6MQ==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/semantic-conventions": "^1.29.0"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": ">=1.0.0 <1.10.0"
      }
    },
    "node_modules/@opentelemetry/instrumentation-http/node_modules/@opentelemetry/instrumentation": {
      "version": "0.221.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/instrumentation/-/instrumentation-0.221.0.tgz",
      "integrity": "sha512-cCk80Z/iRDf/5gfsKMB4f74LqVA5yKETB/9ojPzVW/6/f70iu89nJvGxsFCxx4XfSohaOofkU19kiYm84AiAlw==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/api-logs": "0.221.0",
        "import-in-the-middle": "^3.0.0",
        "require-in-the-middle": "^8.0.0"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/instrumentation-http/node_modules/cjs-module-lexer": {
      "version": "2.2.1",
      "resolved": "https://registry.npmjs.org/cjs-module-lexer/-/cjs-module-lexer-2.2.1.tgz",
      "integrity": "sha512-Ca8swihM+/4yKecYHY52kgJd300hi2lADU/a1RxNTRe+RJ9jvqQlESpbz9DnG9mowez8qwXHB8qYdIUw9e+F5Q==",
      "license": "MIT"
    },
    "node_modules/@opentelemetry/instrumentation-http/node_modules/import-in-the-middle": {
      "version": "3.3.3",
      "resolved": "https://registry.npmjs.org/import-in-the-middle/-/import-in-the-middle-3.3.3.tgz",
      "integrity": "sha512-AiohS3H80sXO6owEltjGX+glb7qXaDhBoJb9XcQVH4UI207xu/bDLUcadVKp7Qe576reg9yr/PXZjV5qx8gfbA==",
      "license": "Apache-2.0",
      "dependencies": {
        "cjs-module-lexer": "^2.2.0",
        "es-module-lexer": "^2.2.0",
        "module-details-from-path": "^1.0.4"
      },
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@opentelemetry/instrumentation-http/node_modules/require-in-the-middle": {
      "version": "8.0.1",
      "resolved": "https://registry.npmjs.org/require-in-the-middle/-/require-in-the-middle-8.0.1.tgz",
      "integrity": "sha512-QT7FVMXfWOYFbeRBF6nu+I6tr2Tf3u0q8RIEjNob/heKY/nh7drD/k7eeMFmSQgnTtCzLDcCu/XEnpW2wk4xCQ==",
      "license": "MIT",
      "dependencies": {
        "debug": "^4.3.5",
        "module-details-from-path": "^1.0.3"
      },
      "engines": {
        "node": ">=9.3.0 || >=8.10.0 <9.0.0"
      }
    },
    "node_modules/@opentelemetry/otlp-exporter-base": {
      "version": "0.54.2",
      "resolved": "https://registry.npmjs.org/@opentelemetry/otlp-exporter-base/-/otlp-exporter-base-0.54.2.tgz",
      "integrity": "sha512-NrNyxu6R/bGAwanhz1HI0aJWKR6xUED4TjCH4iWMlAfyRukGbI9Kt/Akd2sYLwRKNhfS+sKetKGCUQPMDyYYMA==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/core": "1.27.0",
        "@opentelemetry/otlp-transformer": "0.54.2"
      },
      "engines": {
        "node": ">=14"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/otlp-exporter-base/node_modules/@opentelemetry/core": {
      "version": "1.27.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/core/-/core-1.27.0.tgz",
      "integrity": "sha512-yQPKnK5e+76XuiqUH/gKyS8wv/7qITd5ln56QkBTf3uggr0VkXOXfcaAuG330UfdYu83wsyoBwqwxigpIG+Jkg==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/semantic-conventions": "1.27.0"
      },
      "engines": {
        "node": ">=14"
      },
      "peerDependencies": {
        "@opentelemetry/api": ">=1.0.0 <1.10.0"
      }
    },
    "node_modules/@opentelemetry/otlp-exporter-base/node_modules/@opentelemetry/semantic-conventions": {
      "version": "1.27.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/semantic-conventions/-/semantic-conventions-1.27.0.tgz",
      "integrity": "sha512-sAay1RrB+ONOem0OZanAR1ZI/k7yDpnOQSQmTMuGImUQb2y8EbSaCJ94FQluM74xoU03vlb2d2U90hZluL6nQg==",
      "license": "Apache-2.0",
      "engines": {
        "node": ">=14"
      }
    },
    "node_modules/@opentelemetry/otlp-grpc-exporter-base": {
      "version": "0.54.2",
      "resolved": "https://registry.npmjs.org/@opentelemetry/otlp-grpc-exporter-base/-/otlp-grpc-exporter-base-0.54.2.tgz",
      "integrity": "sha512-HZtACQuLhgDcgNa9arGnVVGV28sSGQ+iwRgICWikFKiVxUsoWffqBvTxPa6G3DUTg5R+up97j/zxubEyxSAOHg==",
      "license": "Apache-2.0",
      "dependencies": {
        "@grpc/grpc-js": "^1.7.1",
        "@opentelemetry/core": "1.27.0",
        "@opentelemetry/otlp-exporter-base": "0.54.2",
        "@opentelemetry/otlp-transformer": "0.54.2"
      },
      "engines": {
        "node": ">=14"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/otlp-grpc-exporter-base/node_modules/@opentelemetry/core": {
      "version": "1.27.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/core/-/core-1.27.0.tgz",
      "integrity": "sha512-yQPKnK5e+76XuiqUH/gKyS8wv/7qITd5ln56QkBTf3uggr0VkXOXfcaAuG330UfdYu83wsyoBwqwxigpIG+Jkg==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/semantic-conventions": "1.27.0"
      },
      "engines": {
        "node": ">=14"
      },
      "peerDependencies": {
        "@opentelemetry/api": ">=1.0.0 <1.10.0"
      }
    },
    "node_modules/@opentelemetry/otlp-grpc-exporter-base/node_modules/@opentelemetry/semantic-conventions": {
      "version": "1.27.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/semantic-conventions/-/semantic-conventions-1.27.0.tgz",
      "integrity": "sha512-sAay1RrB+ONOem0OZanAR1ZI/k7yDpnOQSQmTMuGImUQb2y8EbSaCJ94FQluM74xoU03vlb2d2U90hZluL6nQg==",
      "license": "Apache-2.0",
      "engines": {
        "node": ">=14"
      }
    },
    "node_modules/@opentelemetry/otlp-transformer": {
      "version": "0.54.2",
      "resolved": "https://registry.npmjs.org/@opentelemetry/otlp-transformer/-/otlp-transformer-0.54.2.tgz",
      "integrity": "sha512-2tIjahJlMRRUz0A2SeE+qBkeBXBFkSjR0wqJ08kuOqaL8HNGan5iZf+A8cfrfmZzPUuMKCyY9I+okzFuFs6gKQ==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/api-logs": "0.54.2",
        "@opentelemetry/core": "1.27.0",
        "@opentelemetry/resources": "1.27.0",
        "@opentelemetry/sdk-logs": "0.54.2",
        "@opentelemetry/sdk-metrics": "1.27.0",
        "@opentelemetry/sdk-trace-base": "1.27.0",
        "protobufjs": "^7.3.0"
      },
      "engines": {
        "node": ">=14"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/otlp-transformer/node_modules/@opentelemetry/core": {
      "version": "1.27.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/core/-/core-1.27.0.tgz",
      "integrity": "sha512-yQPKnK5e+76XuiqUH/gKyS8wv/7qITd5ln56QkBTf3uggr0VkXOXfcaAuG330UfdYu83wsyoBwqwxigpIG+Jkg==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/semantic-conventions": "1.27.0"
      },
      "engines": {
        "node": ">=14"
      },
      "peerDependencies": {
        "@opentelemetry/api": ">=1.0.0 <1.10.0"
      }
    },
    "node_modules/@opentelemetry/otlp-transformer/node_modules/@opentelemetry/resources": {
      "version": "1.27.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/resources/-/resources-1.27.0.tgz",
      "integrity": "sha512-jOwt2VJ/lUD5BLc+PMNymDrUCpm5PKi1E9oSVYAvz01U/VdndGmrtV3DU1pG4AwlYhJRHbHfOUIlpBeXCPw6QQ==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/core": "1.27.0",
        "@opentelemetry/semantic-conventions": "1.27.0"
      },
      "engines": {
        "node": ">=14"
      },
      "peerDependencies": {
        "@opentelemetry/api": ">=1.0.0 <1.10.0"
      }
    },
    "node_modules/@opentelemetry/otlp-transformer/node_modules/@opentelemetry/sdk-trace-base": {
      "version": "1.27.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/sdk-trace-base/-/sdk-trace-base-1.27.0.tgz",
      "integrity": "sha512-btz6XTQzwsyJjombpeqCX6LhiMQYpzt2pIYNPnw0IPO/3AhT6yjnf8Mnv3ZC2A4eRYOjqrg+bfaXg9XHDRJDWQ==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/core": "1.27.0",
        "@opentelemetry/resources": "1.27.0",
        "@opentelemetry/semantic-conventions": "1.27.0"
      },
      "engines": {
        "node": ">=14"
      },
      "peerDependencies": {
        "@opentelemetry/api": ">=1.0.0 <1.10.0"
      }
    },
    "node_modules/@opentelemetry/otlp-transformer/node_modules/@opentelemetry/semantic-conventions": {
      "version": "1.27.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/semantic-conventions/-/semantic-conventions-1.27.0.tgz",
      "integrity": "sha512-sAay1RrB+ONOem0OZanAR1ZI/k7yDpnOQSQmTMuGImUQb2y8EbSaCJ94FQluM74xoU03vlb2d2U90hZluL6nQg==",
      "license": "Apache-2.0",
      "engines": {
        "node": ">=14"
      }
    },
    "node_modules/@opentelemetry/propagator-b3": {
      "version": "1.30.1",
      "resolved": "https://registry.npmjs.org/@opentelemetry/propagator-b3/-/propagator-b3-1.30.1.tgz",
      "integrity": "sha512-oATwWWDIJzybAZ4pO76ATN5N6FFbOA1otibAVlS8v90B4S1wClnhRUk7K+2CHAwN1JKYuj4jh/lpCEG5BAqFuQ==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/core": "1.30.1"
      },
      "engines": {
        "node": ">=14"
      },
      "peerDependencies": {
        "@opentelemetry/api": ">=1.0.0 <1.10.0"
      }
    },
    "node_modules/@opentelemetry/propagator-jaeger": {
      "version": "1.30.1",
      "resolved": "https://registry.npmjs.org/@opentelemetry/propagator-jaeger/-/propagator-jaeger-1.30.1.tgz",
      "integrity": "sha512-Pj/BfnYEKIOImirH76M4hDaBSx6HyZ2CXUqk+Kj02m6BB80c/yo4BdWkn/1gDFfU+YPY+bPR2U0DKBfdxCKwmg==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/core": "1.30.1"
      },
      "engines": {
        "node": ">=14"
      },
      "peerDependencies": {
        "@opentelemetry/api": ">=1.0.0 <1.10.0"
      }
    },
    "node_modules/@opentelemetry/resources": {
      "version": "1.30.1",
      "resolved": "https://registry.npmjs.org/@opentelemetry/resources/-/resources-1.30.1.tgz",
      "integrity": "sha512-5UxZqiAgLYGFjS4s9qm5mBVo433u+dSPUFWVWXmLAD4wB65oMCoXaJP1KJa9DIYYMeHu3z4BZcStG3LC593cWA==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/core": "1.30.1",
        "@opentelemetry/semantic-conventions": "1.28.0"
      },
      "engines": {
        "node": ">=14"
      },
      "peerDependencies": {
        "@opentelemetry/api": ">=1.0.0 <1.10.0"
      }
    },
    "node_modules/@opentelemetry/resources/node_modules/@opentelemetry/semantic-conventions": {
      "version": "1.28.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/semantic-conventions/-/semantic-conventions-1.28.0.tgz",
      "integrity": "sha512-lp4qAiMTD4sNWW4DbKLBkfiMZ4jbAboJIGOQr5DvciMRI494OapieI9qiODpOt0XBr1LjIDy1xAGAnVs5supTA==",
      "license": "Apache-2.0",
      "engines": {
        "node": ">=14"
      }
    },
    "node_modules/@opentelemetry/sdk-logs": {
      "version": "0.54.2",
      "resolved": "https://registry.npmjs.org/@opentelemetry/sdk-logs/-/sdk-logs-0.54.2.tgz",
      "integrity": "sha512-yIbYqDLS/AtBbPjCjh6eSToGNRMqW2VR8RrKEy+G+J7dFG7pKoptTH5T+XlKPleP9NY8JZYIpgJBlI+Osi0rFw==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/api-logs": "0.54.2",
        "@opentelemetry/core": "1.27.0",
        "@opentelemetry/resources": "1.27.0"
      },
      "engines": {
        "node": ">=14"
      },
      "peerDependencies": {
        "@opentelemetry/api": ">=1.4.0 <1.10.0"
      }
    },
    "node_modules/@opentelemetry/sdk-logs/node_modules/@opentelemetry/core": {
      "version": "1.27.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/core/-/core-1.27.0.tgz",
      "integrity": "sha512-yQPKnK5e+76XuiqUH/gKyS8wv/7qITd5ln56QkBTf3uggr0VkXOXfcaAuG330UfdYu83wsyoBwqwxigpIG+Jkg==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/semantic-conventions": "1.27.0"
      },
      "engines": {
        "node": ">=14"
      },
      "peerDependencies": {
        "@opentelemetry/api": ">=1.0.0 <1.10.0"
      }
    },
    "node_modules/@opentelemetry/sdk-logs/node_modules/@opentelemetry/resources": {
      "version": "1.27.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/resources/-/resources-1.27.0.tgz",
      "integrity": "sha512-jOwt2VJ/lUD5BLc+PMNymDrUCpm5PKi1E9oSVYAvz01U/VdndGmrtV3DU1pG4AwlYhJRHbHfOUIlpBeXCPw6QQ==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/core": "1.27.0",
        "@opentelemetry/semantic-conventions": "1.27.0"
      },
      "engines": {
        "node": ">=14"
      },
      "peerDependencies": {
        "@opentelemetry/api": ">=1.0.0 <1.10.0"
      }
    },
    "node_modules/@opentelemetry/sdk-logs/node_modules/@opentelemetry/semantic-conventions": {
      "version": "1.27.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/semantic-conventions/-/semantic-conventions-1.27.0.tgz",
      "integrity": "sha512-sAay1RrB+ONOem0OZanAR1ZI/k7yDpnOQSQmTMuGImUQb2y8EbSaCJ94FQluM74xoU03vlb2d2U90hZluL6nQg==",
      "license": "Apache-2.0",
      "engines": {
        "node": ">=14"
      }
    },
    "node_modules/@opentelemetry/sdk-metrics": {
      "version": "1.27.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/sdk-metrics/-/sdk-metrics-1.27.0.tgz",
      "integrity": "sha512-JzWgzlutoXCydhHWIbLg+r76m+m3ncqvkCcsswXAQ4gqKS+LOHKhq+t6fx1zNytvLuaOUBur7EvWxECc4jPQKg==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/core": "1.27.0",
        "@opentelemetry/resources": "1.27.0"
      },
      "engines": {
        "node": ">=14"
      },
      "peerDependencies": {
        "@opentelemetry/api": ">=1.3.0 <1.10.0"
      }
    },
    "node_modules/@opentelemetry/sdk-metrics/node_modules/@opentelemetry/core": {
      "version": "1.27.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/core/-/core-1.27.0.tgz",
      "integrity": "sha512-yQPKnK5e+76XuiqUH/gKyS8wv/7qITd5ln56QkBTf3uggr0VkXOXfcaAuG330UfdYu83wsyoBwqwxigpIG+Jkg==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/semantic-conventions": "1.27.0"
      },
      "engines": {
        "node": ">=14"
      },
      "peerDependencies": {
        "@opentelemetry/api": ">=1.0.0 <1.10.0"
      }
    },
    "node_modules/@opentelemetry/sdk-metrics/node_modules/@opentelemetry/resources": {
      "version": "1.27.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/resources/-/resources-1.27.0.tgz",
      "integrity": "sha512-jOwt2VJ/lUD5BLc+PMNymDrUCpm5PKi1E9oSVYAvz01U/VdndGmrtV3DU1pG4AwlYhJRHbHfOUIlpBeXCPw6QQ==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/core": "1.27.0",
        "@opentelemetry/semantic-conventions": "1.27.0"
      },
      "engines": {
        "node": ">=14"
      },
      "peerDependencies": {
        "@opentelemetry/api": ">=1.0.0 <1.10.0"
      }
    },
    "node_modules/@opentelemetry/sdk-metrics/node_modules/@opentelemetry/semantic-conventions": {
      "version": "1.27.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/semantic-conventions/-/semantic-conventions-1.27.0.tgz",
      "integrity": "sha512-sAay1RrB+ONOem0OZanAR1ZI/k7yDpnOQSQmTMuGImUQb2y8EbSaCJ94FQluM74xoU03vlb2d2U90hZluL6nQg==",
      "license": "Apache-2.0",
      "engines": {
        "node": ">=14"
      }
    },
    "node_modules/@opentelemetry/sdk-trace-base": {
      "version": "1.30.1",
      "resolved": "https://registry.npmjs.org/@opentelemetry/sdk-trace-base/-/sdk-trace-base-1.30.1.tgz",
      "integrity": "sha512-jVPgBbH1gCy2Lb7X0AVQ8XAfgg0pJ4nvl8/IiQA6nxOsPvS+0zMJaFSs2ltXe0J6C8dqjcnpyqINDJmU30+uOg==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/core": "1.30.1",
        "@opentelemetry/resources": "1.30.1",
        "@opentelemetry/semantic-conventions": "1.28.0"
      },
      "engines": {
        "node": ">=14"
      },
      "peerDependencies": {
        "@opentelemetry/api": ">=1.0.0 <1.10.0"
      }
    },
    "node_modules/@opentelemetry/sdk-trace-base/node_modules/@opentelemetry/semantic-conventions": {
      "version": "1.28.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/semantic-conventions/-/semantic-conventions-1.28.0.tgz",
      "integrity": "sha512-lp4qAiMTD4sNWW4DbKLBkfiMZ4jbAboJIGOQr5DvciMRI494OapieI9qiODpOt0XBr1LjIDy1xAGAnVs5supTA==",
      "license": "Apache-2.0",
      "engines": {
        "node": ">=14"
      }
    },
    "node_modules/@opentelemetry/sdk-trace-node": {
      "version": "1.30.1",
      "resolved": "https://registry.npmjs.org/@opentelemetry/sdk-trace-node/-/sdk-trace-node-1.30.1.tgz",
      "integrity": "sha512-cBjYOINt1JxXdpw1e5MlHmFRc5fgj4GW/86vsKFxJCJ8AL4PdVtYH41gWwl4qd4uQjqEL1oJVrXkSy5cnduAnQ==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/context-async-hooks": "1.30.1",
        "@opentelemetry/core": "1.30.1",
        "@opentelemetry/propagator-b3": "1.30.1",
        "@opentelemetry/propagator-jaeger": "1.30.1",
        "@opentelemetry/sdk-trace-base": "1.30.1",
        "semver": "^7.5.2"
      },
      "engines": {
        "node": ">=14"
      },
      "peerDependencies": {
        "@opentelemetry/api": ">=1.0.0 <1.10.0"
      }
    },
    "node_modules/@opentelemetry/semantic-conventions": {
      "version": "1.43.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/semantic-conventions/-/semantic-conventions-1.43.0.tgz",
      "integrity": "sha512-eSYWTm620tTk45EKSedaUL8MFYI8hW164hIXsgIHyxu3VobUB3fFCu5t0hQby6OoWRPsG1KkKUG2M5UadiLiVg==",
      "license": "Apache-2.0",
      "engines": {
        "node": ">=14"
      }
    },
    "node_modules/@protobufjs/aspromise": {
      "version": "1.1.2",
      "resolved": "https://registry.npmjs.org/@protobufjs/aspromise/-/aspromise-1.1.2.tgz",
      "integrity": "sha512-j+gKExEuLmKwvz3OgROXtrJ2UG2x8Ch2YZUxahh+s1F2HZ+wAceUNLkvy6zKCPVRkU++ZWQrdxsUeQXmcg4uoQ==",
      "license": "BSD-3-Clause"
    },
    "node_modules/@protobufjs/base64": {
      "version": "1.1.2",
      "resolved": "https://registry.npmjs.org/@protobufjs/base64/-/base64-1.1.2.tgz",
      "integrity": "sha512-AZkcAA5vnN/v4PDqKyMR5lx7hZttPDgClv83E//FMNhR2TMcLUhfRUBHCmSl0oi9zMgDDqRUJkSxO3wm85+XLg==",
      "license": "BSD-3-Clause"
    },
    "node_modules/@protobufjs/codegen": {
      "version": "2.0.5",
      "resolved": "https://registry.npmjs.org/@protobufjs/codegen/-/codegen-2.0.5.tgz",
      "integrity": "sha512-zgXFLzW3Ap33e6d0Wlj4MGIm6Ce8O89n/apUaGNB/jx+hw+ruWEp7EwGUshdLKVRCxZW12fp9r40E1mQrf/34g==",
      "license": "BSD-3-Clause"
    },
    "node_modules/@protobufjs/eventemitter": {
      "version": "1.1.1",
      "resolved": "https://registry.npmjs.org/@protobufjs/eventemitter/-/eventemitter-1.1.1.tgz",
      "integrity": "sha512-vW1GmwMZNnL+gMRaovlh9yZX74kc+TTU3FObkkurpMaRtBfLP3ldjS9KQWlwZgraRE0+dheEEoAxdzcJQ8eXZg==",
      "license": "BSD-3-Clause"
    },
    "node_modules/@protobufjs/fetch": {
      "version": "1.1.1",
      "resolved": "https://registry.npmjs.org/@protobufjs/fetch/-/fetch-1.1.1.tgz",
      "integrity": "sha512-GpptLrs57adMSuHi3VNj0mAF8dwh36LMaYF6XyJ6JMWlVsc+t42tm1HSEDmOs3A8fC9yyeisgLhsTVQokOZ0zw==",
      "license": "BSD-3-Clause",
      "dependencies": {
        "@protobufjs/aspromise": "^1.1.1"
      }
    },
    "node_modules/@protobufjs/float": {
      "version": "1.0.2",
      "resolved": "https://registry.npmjs.org/@protobufjs/float/-/float-1.0.2.tgz",
      "integrity": "sha512-Ddb+kVXlXst9d+R9PfTIxh1EdNkgoRe5tOX6t01f1lYWOvJnSPDBlG241QLzcyPdoNTsblLUdujGSE4RzrTZGQ==",
      "license": "BSD-3-Clause"
    },
    "node_modules/@protobufjs/path": {
      "version": "1.1.2",
      "resolved": "https://registry.npmjs.org/@protobufjs/path/-/path-1.1.2.tgz",
      "integrity": "sha512-6JOcJ5Tm08dOHAbdR3GrvP+yUUfkjG5ePsHYczMFLq3ZmMkAD98cDgcT2iA1lJ9NVwFd4tH/iSSoe44YWkltEA==",
      "license": "BSD-3-Clause"
    },
    "node_modules/@protobufjs/pool": {
      "version": "1.1.0",
      "resolved": "https://registry.npmjs.org/@protobufjs/pool/-/pool-1.1.0.tgz",
      "integrity": "sha512-0kELaGSIDBKvcgS4zkjz1PeddatrjYcmMWOlAuAPwAeccUrPHdUqo/J6LiymHHEiJT5NrF1UVwxY14f+fy4WQw==",
      "license": "BSD-3-Clause"
    },
    "node_modules/@protobufjs/utf8": {
      "version": "1.1.2",
      "resolved": "https://registry.npmjs.org/@protobufjs/utf8/-/utf8-1.1.2.tgz",
      "integrity": "sha512-b1UQwcEZ4yCnMCD8DAL1VlbvBJE9/IX4FTIp7BG1xYpf29SLazLSrqUkj4w7Y5y7cCVP6E5tcqqcI0xemPkHug==",
      "license": "BSD-3-Clause"
    },
    "node_modules/@types/json-schema": {
      "version": "7.0.15",
      "resolved": "https://registry.npmjs.org/@types/json-schema/-/json-schema-7.0.15.tgz",
      "integrity": "sha512-5+fP8P8MFNC+AyZCDxrB2pkZFPGzqQWUzpSeuuVLvm8VMcorNYavBqoFcxK8bQz4Qsbn4oUEEem4wDLfcysGHA==",
      "license": "MIT"
    },
    "node_modules/@types/node": {
      "version": "18.19.130",
      "resolved": "https://registry.npmjs.org/@types/node/-/node-18.19.130.tgz",
      "integrity": "sha512-GRaXQx6jGfL8sKfaIDD6OupbIHBr9jv7Jnaml9tB7l4v068PAOXqfcujMMo5PhbIs6ggR1XODELqahT2R8v0fg==",
      "license": "MIT",
      "dependencies": {
        "undici-types": "~5.26.4"
      }
    },
    "node_modules/@types/node-fetch": {
      "version": "2.6.13",
      "resolved": "https://registry.npmjs.org/@types/node-fetch/-/node-fetch-2.6.13.tgz",
      "integrity": "sha512-QGpRVpzSaUs30JBSGPjOg4Uveu384erbHBoT1zeONvyCfwQxIkUshLAOqN/k9EjGviPRmWTTe6aH2qySWKTVSw==",
      "license": "MIT",
      "dependencies": {
        "@types/node": "*",
        "form-data": "^4.0.4"
      }
    },
    "node_modules/@types/retry": {
      "version": "0.12.0",
      "resolved": "https://registry.npmjs.org/@types/retry/-/retry-0.12.0.tgz",
      "integrity": "sha512-wWKOClTTiizcZhXnPY4wikVAwmdYHp8q6DmC+EJUzAMsycb7HB32Kh9RN4+0gExjmPmZSAQjgURXIGATPegAvA==",
      "license": "MIT"
    },
    "node_modules/@types/shimmer": {
      "version": "1.2.0",
      "resolved": "https://registry.npmjs.org/@types/shimmer/-/shimmer-1.2.0.tgz",
      "integrity": "sha512-UE7oxhQLLd9gub6JKIAhDq06T0F6FnztwMNRvYgjeQSBeMc1ZG/tA47EwfduvkuQS8apbkM/lpLpWsaCeYsXVg==",
      "license": "MIT"
    },
    "node_modules/@types/uuid": {
      "version": "10.0.0",
      "resolved": "https://registry.npmjs.org/@types/uuid/-/uuid-10.0.0.tgz",
      "integrity": "sha512-7gqG38EyHgyP1S+7+xomFtL+ZNHcKv6DwNaCZmJmo1vgMugyF3TCnXVg4t1uk89mLNwnLtnY3TpOpCOyp1/xHQ==",
      "license": "MIT"
    },
    "node_modules/abort-controller": {
      "version": "3.0.0",
      "resolved": "https://registry.npmjs.org/abort-controller/-/abort-controller-3.0.0.tgz",
      "integrity": "sha512-h8lQ8tacZYnR3vNQTgibj+tODHI5/+l06Au2Pcriv/Gmet0eaj4TwWH41sO9wnHDiQsEj19q0drzdWdeAHtweg==",
      "license": "MIT",
      "dependencies": {
        "event-target-shim": "^5.0.0"
      },
      "engines": {
        "node": ">=6.5"
      }
    },
    "node_modules/accepts": {
      "version": "2.0.0",
      "resolved": "https://registry.npmjs.org/accepts/-/accepts-2.0.0.tgz",
      "integrity": "sha512-5cvg6CtKwfgdmVqY1WIiXKc3Q1bkRqGLi+2W/6ao+6Y7gu/RCwRuAhGEzh5B4KlszSuTLgZYuqFqo5bImjNKng==",
      "license": "MIT",
      "dependencies": {
        "mime-types": "^3.0.0",
        "negotiator": "^1.0.0"
      },
      "engines": {
        "node": ">= 0.6"
      }
    },
    "node_modules/accepts/node_modules/mime-db": {
      "version": "1.54.0",
      "resolved": "https://registry.npmjs.org/mime-db/-/mime-db-1.54.0.tgz",
      "integrity": "sha512-aU5EJuIN2WDemCcAp2vFBfp/m4EAhWJnUNSSw0ixs7/kXbd6Pg64EmwJkNdFhB8aWt1sH2CTXrLxo/iAGV3oPQ==",
      "license": "MIT",
      "engines": {
        "node": ">= 0.6"
      }
    },
    "node_modules/accepts/node_modules/mime-types": {
      "version": "3.0.2",
      "resolved": "https://registry.npmjs.org/mime-types/-/mime-types-3.0.2.tgz",
      "integrity": "sha512-Lbgzdk0h4juoQ9fCKXW4by0UJqj+nOOrI9MJ1sSj4nI8aI2eo1qmvQEie4VD1glsS250n15LsWsYtCugiStS5A==",
      "license": "MIT",
      "dependencies": {
        "mime-db": "^1.54.0"
      },
      "engines": {
        "node": ">=18"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/express"
      }
    },
    "node_modules/acorn": {
      "version": "8.18.0",
      "resolved": "https://registry.npmjs.org/acorn/-/acorn-8.18.0.tgz",
      "integrity": "sha512-lGq+9yr1/GuAWaVYIHRjvvySG5/4VfKIvC8EWxStPdcDh/Ka7FG3twP6v4d5BkravUilhIAsG4Qj83t02LWUPQ==",
      "license": "MIT",
      "bin": {
        "acorn": "bin/acorn"
      },
      "engines": {
        "node": ">=0.4.0"
      }
    },
    "node_modules/acorn-import-assertions": {
      "version": "1.9.0",
      "resolved": "https://registry.npmjs.org/acorn-import-assertions/-/acorn-import-assertions-1.9.0.tgz",
      "integrity": "sha512-cmMwop9x+8KFhxvKrKfPYmN6/pKTYYHBqLa0DfvVZcKMJWNyWLnaqND7dx/qn66R7ewM1UX5XMaDVP5wlVTaVA==",
      "deprecated": "package has been renamed to acorn-import-attributes",
      "license": "MIT",
      "peerDependencies": {
        "acorn": "^8"
      }
    },
    "node_modules/agent-base": {
      "version": "6.0.2",
      "resolved": "https://registry.npmjs.org/agent-base/-/agent-base-6.0.2.tgz",
      "integrity": "sha512-RZNwNclF7+MS/8bDg70amg32dyeZGZxiDuQmZxKLAlQjr3jGyLx+4Kkk58UO7D2QdgFIQCovuSuZESne6RG6XQ==",
      "license": "MIT",
      "dependencies": {
        "debug": "4"
      },
      "engines": {
        "node": ">= 6.0.0"
      }
    },
    "node_modules/agentkeepalive": {
      "version": "4.6.0",
      "resolved": "https://registry.npmjs.org/agentkeepalive/-/agentkeepalive-4.6.0.tgz",
      "integrity": "sha512-kja8j7PjmncONqaTsB8fQ+wE2mSU2DJ9D4XKoJ5PFWIdRMa6SLSN1ff4mOr4jCbfRSsxR4keIiySJU0N9T5hIQ==",
      "license": "MIT",
      "dependencies": {
        "humanize-ms": "^1.2.1"
      },
      "engines": {
        "node": ">= 8.0.0"
      }
    },
    "node_modules/ansi-regex": {
      "version": "5.0.1",
      "resolved": "https://registry.npmjs.org/ansi-regex/-/ansi-regex-5.0.1.tgz",
      "integrity": "sha512-quJQXlTSUGL2LH9SUXo8VwsY4soanhgo6LNSm84E1LBcE8s3O0wpdiRzyR9z/ZZJMlMWv37qOOb9pdJlMUEKFQ==",
      "license": "MIT",
      "engines": {
        "node": ">=8"
      }
    },
    "node_modules/ansi-styles": {
      "version": "5.2.0",
      "resolved": "https://registry.npmjs.org/ansi-styles/-/ansi-styles-5.2.0.tgz",
      "integrity": "sha512-Cxwpt2SfTzTtXcfOlzGEee8O+c+MmUgGrNiBcXnuWxuFJHe6a5Hz7qwhwe5OgaSYI0IJvkLqWX1ASG+cJOkEiA==",
      "license": "MIT",
      "engines": {
        "node": ">=10"
      },
      "funding": {
        "url": "https://github.com/chalk/ansi-styles?sponsor=1"
      }
    },
    "node_modules/asynckit": {
      "version": "0.4.0",
      "resolved": "https://registry.npmjs.org/asynckit/-/asynckit-0.4.0.tgz",
      "integrity": "sha512-Oei9OH4tRh0YqU3GxhX79dM/mwVgvbZJaSNaRk+bshkj0S5cfHcgYakreBjrHwatXKbz+IoIdYLxrKim2MjW0Q==",
      "license": "MIT"
    },
    "node_modules/axios": {
      "version": "1.20.0",
      "resolved": "https://registry.npmjs.org/axios/-/axios-1.20.0.tgz",
      "integrity": "sha512-r8aOh8j9cGKpgQAqpzrUHnSIc6a59Y3Xf/cv8sy1DrHCkZHzQGEuoq1tARk6qSyDdtQGSDgpb9kFlruzPvrgwg==",
      "license": "MIT",
      "dependencies": {
        "follow-redirects": "^1.16.0",
        "form-data": "^4.0.6",
        "https-proxy-agent": "^5.0.1",
        "proxy-from-env": "^2.1.0"
      }
    },
    "node_modules/base64-js": {
      "version": "1.5.1",
      "resolved": "https://registry.npmjs.org/base64-js/-/base64-js-1.5.1.tgz",
      "integrity": "sha512-AKpaYlHn8t4SVbOHCy+b5+KKgvR4vrsD8vbvrbiQJps7fKDTkjkDry6ji0rUJjC0kzbNePLwzxq8iypo41qeWA==",
      "funding": [
        {
          "type": "github",
          "url": "https://github.com/sponsors/feross"
        },
        {
          "type": "patreon",
          "url": "https://www.patreon.com/feross"
        },
        {
          "type": "consulting",
          "url": "https://feross.org/support"
        }
      ],
      "license": "MIT"
    },
    "node_modules/body-parser": {
      "version": "2.3.0",
      "resolved": "https://registry.npmjs.org/body-parser/-/body-parser-2.3.0.tgz",
      "integrity": "sha512-2cGmJupaNgg+QUwVLAucDuWuoMZ6EX9iHDRswZ5lsNYEmwPaRknMPCLZz07yTzVq/83p4o/wzbDZbBrTvGGTIw==",
      "license": "MIT",
      "dependencies": {
        "bytes": "^3.1.2",
        "content-type": "^2.0.0",
        "debug": "^4.4.3",
        "http-errors": "^2.0.1",
        "iconv-lite": "^0.7.2",
        "on-finished": "^2.4.1",
        "qs": "^6.15.2",
        "raw-body": "^3.0.2",
        "type-is": "^2.1.0"
      },
      "engines": {
        "node": ">=18"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/express"
      }
    },
    "node_modules/body-parser/node_modules/content-type": {
      "version": "2.1.0",
      "resolved": "https://registry.npmjs.org/content-type/-/content-type-2.1.0.tgz",
      "integrity": "sha512-mj7UPXE0jaqaOsukNZRUEfEi2AcL7C/vwmwcHV0O97eO1E1pxBZuyjlZrx5seTaNBg1U6+o35wpa35Qfcc+7ag==",
      "license": "MIT",
      "engines": {
        "node": ">=18"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/express"
      }
    },
    "node_modules/bytes": {
      "version": "3.1.2",
      "resolved": "https://registry.npmjs.org/bytes/-/bytes-3.1.2.tgz",
      "integrity": "sha512-/Nf7TyzTx6S3yRJObOAV7956r8cr2+Oj8AC5dt8wSP3BQAoeX58NoHyCU8P8zGkNXStjTSi6fzO6F0pBdcYbEg==",
      "license": "MIT",
      "engines": {
        "node": ">= 0.8"
      }
    },
    "node_modules/call-bind-apply-helpers": {
      "version": "1.0.2",
      "resolved": "https://registry.npmjs.org/call-bind-apply-helpers/-/call-bind-apply-helpers-1.0.2.tgz",
      "integrity": "sha512-Sp1ablJ0ivDkSzjcaJdxEunN5/XvksFJ2sMBFfq6x0ryhQV/2b/KwFe21cMpmHtPOSij8K99/wSfoEuTObmuMQ==",
      "license": "MIT",
      "dependencies": {
        "es-errors": "^1.3.0",
        "function-bind": "^1.1.2"
      },
      "engines": {
        "node": ">= 0.4"
      }
    },
    "node_modules/call-bound": {
      "version": "1.0.4",
      "resolved": "https://registry.npmjs.org/call-bound/-/call-bound-1.0.4.tgz",
      "integrity": "sha512-+ys997U96po4Kx/ABpBCqhA9EuxJaQWDQg7295H4hBphv3IZg0boBKuwYpt4YXp6MZ5AmZQnU/tyMTlRpaSejg==",
      "license": "MIT",
      "dependencies": {
        "call-bind-apply-helpers": "^1.0.2",
        "get-intrinsic": "^1.3.0"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/camelcase": {
      "version": "6.3.0",
      "resolved": "https://registry.npmjs.org/camelcase/-/camelcase-6.3.0.tgz",
      "integrity": "sha512-Gmy6FhYlCY7uOElZUSbxo2UCDH8owEk996gkbrpsgGtrJLM3J7jGxl9Ic7Qwwj4ivOE5AWZWRMecDdF7hqGjFA==",
      "license": "MIT",
      "engines": {
        "node": ">=10"
      },
      "funding": {
        "url": "https://github.com/sponsors/sindresorhus"
      }
    },
    "node_modules/chalk": {
      "version": "4.1.2",
      "resolved": "https://registry.npmjs.org/chalk/-/chalk-4.1.2.tgz",
      "integrity": "sha512-oKnbhFyRIXpUuez8iBMmyEa4nbj4IOQyuhc/wy9kY7/WVPcwIO9VA668Pu8RkO7+0G76SLROeyw9CpQ061i4mA==",
      "license": "MIT",
      "dependencies": {
        "ansi-styles": "^4.1.0",
        "supports-color": "^7.1.0"
      },
      "engines": {
        "node": ">=10"
      },
      "funding": {
        "url": "https://github.com/chalk/chalk?sponsor=1"
      }
    },
    "node_modules/chalk/node_modules/ansi-styles": {
      "version": "4.3.0",
      "resolved": "https://registry.npmjs.org/ansi-styles/-/ansi-styles-4.3.0.tgz",
      "integrity": "sha512-zbB9rCJAT1rbjiVDb2hqKFHNYLxgtk8NURxZ3IZwD3F6NtxbXZQCnnSi1Lkx+IDohdPlFp222wVALIheZJQSEg==",
      "license": "MIT",
      "dependencies": {
        "color-convert": "^2.0.1"
      },
      "engines": {
        "node": ">=8"
      },
      "funding": {
        "url": "https://github.com/chalk/ansi-styles?sponsor=1"
      }
    },
    "node_modules/cjs-module-lexer": {
      "version": "1.4.3",
      "resolved": "https://registry.npmjs.org/cjs-module-lexer/-/cjs-module-lexer-1.4.3.tgz",
      "integrity": "sha512-9z8TZaGM1pfswYeXrUpzPrkx8UnWYdhJclsiYMm6x/w5+nN+8Tf/LnAgfLGQCm59qAOxU8WwHEq2vNwF6i4j+Q==",
      "license": "MIT"
    },
    "node_modules/cliui": {
      "version": "8.0.1",
      "resolved": "https://registry.npmjs.org/cliui/-/cliui-8.0.1.tgz",
      "integrity": "sha512-BSeNnyus75C4//NQ9gQt1/csTXyo/8Sb+afLAkzAptFuMsod9HFokGNudZpi/oQV73hnVK+sR+5PVRMd+Dr7YQ==",
      "license": "ISC",
      "dependencies": {
        "string-width": "^4.2.0",
        "strip-ansi": "^6.0.1",
        "wrap-ansi": "^7.0.0"
      },
      "engines": {
        "node": ">=12"
      }
    },
    "node_modules/color-convert": {
      "version": "2.0.1",
      "resolved": "https://registry.npmjs.org/color-convert/-/color-convert-2.0.1.tgz",
      "integrity": "sha512-RRECPsj7iu/xb5oKYcsFHSppFNnsj/52OVTRKb4zP5onXwVF3zVmmToNcOfGC+CRDpfK/U584fMg38ZHCaElKQ==",
      "license": "MIT",
      "dependencies": {
        "color-name": "~1.1.4"
      },
      "engines": {
        "node": ">=7.0.0"
      }
    },
    "node_modules/color-name": {
      "version": "1.1.4",
      "resolved": "https://registry.npmjs.org/color-name/-/color-name-1.1.4.tgz",
      "integrity": "sha512-dOy+3AuW3a2wNbZHIuMZpTcgjGuLU/uBL/ubcZF9OXbDo8ff4O8yVp5Bf0efS8uEoYo5q4Fx7dY9OgQGXgAsQA==",
      "license": "MIT"
    },
    "node_modules/combined-stream": {
      "version": "1.0.8",
      "resolved": "https://registry.npmjs.org/combined-stream/-/combined-stream-1.0.8.tgz",
      "integrity": "sha512-FQN4MRfuJeHf7cBbBMJFXhKSDq+2kAArBlmRBvcvFE5BB1HZKXtSFASDhdlz9zOYwxh8lDdnvmMOe/+5cdoEdg==",
      "license": "MIT",
      "dependencies": {
        "delayed-stream": "~1.0.0"
      },
      "engines": {
        "node": ">= 0.8"
      }
    },
    "node_modules/console-table-printer": {
      "version": "2.16.1",
      "resolved": "https://registry.npmjs.org/console-table-printer/-/console-table-printer-2.16.1.tgz",
      "integrity": "sha512-Sc9FRJ4O9xKGNrvulNdPfK5SyBcZ6lcaRnDE4AQ/uw6IDtjHhsqyzzqcnMikjyGaiOOF2tNOKoBhbVjRvFy9Lw==",
      "license": "MIT",
      "dependencies": {
        "simple-wcswidth": "^1.1.2"
      }
    },
    "node_modules/content-disposition": {
      "version": "1.1.0",
      "resolved": "https://registry.npmjs.org/content-disposition/-/content-disposition-1.1.0.tgz",
      "integrity": "sha512-5jRCH9Z/+DRP7rkvY83B+yGIGX96OYdJmzngqnw2SBSxqCFPd0w2km3s5iawpGX8krnwSGmF0FW5Nhr0Hfai3g==",
      "license": "MIT",
      "engines": {
        "node": ">=18"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/express"
      }
    },
    "node_modules/content-type": {
      "version": "1.0.5",
      "resolved": "https://registry.npmjs.org/content-type/-/content-type-1.0.5.tgz",
      "integrity": "sha512-nTjqfcBFEipKdXCv4YDQWCfmcLZKm81ldF0pAopTvyrFGVbcR6P/VAAd5G7N+0tTr8QqiU0tFadD6FK4NtJwOA==",
      "license": "MIT",
      "engines": {
        "node": ">= 0.6"
      }
    },
    "node_modules/cookie": {
      "version": "0.7.2",
      "resolved": "https://registry.npmjs.org/cookie/-/cookie-0.7.2.tgz",
      "integrity": "sha512-yki5XnKuf750l50uGTllt6kKILY4nQ1eNIQatoXEByZ5dWgnKqbnqmTrBE5B4N7lrMJKQ2ytWMiTO2o0v6Ew/w==",
      "license": "MIT",
      "engines": {
        "node": ">= 0.6"
      }
    },
    "node_modules/cookie-signature": {
      "version": "1.2.2",
      "resolved": "https://registry.npmjs.org/cookie-signature/-/cookie-signature-1.2.2.tgz",
      "integrity": "sha512-D76uU73ulSXrD1UXF4KE2TMxVVwhsnCgfAyTg9k8P6KGZjlXKrOLe4dJQKI3Bxi5wjesZoFXJWElNWBjPZMbhg==",
      "license": "MIT",
      "engines": {
        "node": ">=6.6.0"
      }
    },
    "node_modules/debug": {
      "version": "4.4.3",
      "resolved": "https://registry.npmjs.org/debug/-/debug-4.4.3.tgz",
      "integrity": "sha512-RGwwWnwQvkVfavKVt22FGLw+xYSdzARwm0ru6DhTVA3umU5hZc28V3kO4stgYryrTlLpuvgI9GiijltAjNbcqA==",
      "license": "MIT",
      "dependencies": {
        "ms": "^2.1.3"
      },
      "engines": {
        "node": ">=6.0"
      },
      "peerDependenciesMeta": {
        "supports-color": {
          "optional": true
        }
      }
    },
    "node_modules/decamelize": {
      "version": "1.2.0",
      "resolved": "https://registry.npmjs.org/decamelize/-/decamelize-1.2.0.tgz",
      "integrity": "sha512-z2S+W9X73hAUUki+N+9Za2lBlun89zigOyGrsax+KUQ6wKW4ZoWpEYBkGhQjwAjjDCkWxhY0VKEhk8wzY7F5cA==",
      "license": "MIT",
      "engines": {
        "node": ">=0.10.0"
      }
    },
    "node_modules/delayed-stream": {
      "version": "1.0.0",
      "resolved": "https://registry.npmjs.org/delayed-stream/-/delayed-stream-1.0.0.tgz",
      "integrity": "sha512-ZySD7Nf91aLB0RxL4KGrKHBXl7Eds1DAmEdcoVawXnLD7SDhpNgtuII2aAkg7a7QS41jxPSZ17p4VdGnMHk3MQ==",
      "license": "MIT",
      "engines": {
        "node": ">=0.4.0"
      }
    },
    "node_modules/depd": {
      "version": "2.0.0",
      "resolved": "https://registry.npmjs.org/depd/-/depd-2.0.0.tgz",
      "integrity": "sha512-g7nH6P6dyDioJogAAGprGpCtVImJhpPk/roCzdb3fIh61/s/nPsfR6onyMwkCAR/OlC3yBC0lESvUoQEAssIrw==",
      "license": "MIT",
      "engines": {
        "node": ">= 0.8"
      }
    },
    "node_modules/dunder-proto": {
      "version": "1.0.1",
      "resolved": "https://registry.npmjs.org/dunder-proto/-/dunder-proto-1.0.1.tgz",
      "integrity": "sha512-KIN/nDJBQRcXw0MLVhZE9iQHmG68qAVIBg9CqmUYjmQIhgij9U5MFvrqkUL5FbtyyzZuOeOt0zdeRe4UY7ct+A==",
      "license": "MIT",
      "dependencies": {
        "call-bind-apply-helpers": "^1.0.1",
        "es-errors": "^1.3.0",
        "gopd": "^1.2.0"
      },
      "engines": {
        "node": ">= 0.4"
      }
    },
    "node_modules/ee-first": {
      "version": "1.1.1",
      "resolved": "https://registry.npmjs.org/ee-first/-/ee-first-1.1.1.tgz",
      "integrity": "sha512-WMwm9LhRUo+WUaRN+vRuETqG89IgZphVSNkdFgeb6sS/E4OrDIN7t48CAewSHXc6C8lefD8KKfr5vY61brQlow==",
      "license": "MIT"
    },
    "node_modules/emoji-regex": {
      "version": "8.0.0",
      "resolved": "https://registry.npmjs.org/emoji-regex/-/emoji-regex-8.0.0.tgz",
      "integrity": "sha512-MSjYzcWNOA0ewAHpz0MxpYFvwg6yjy1NG3xteoqz644VCo/RPgnr1/GGt+ic3iJTzQ8Eu3TdM14SawnVUmGE6A==",
      "license": "MIT"
    },
    "node_modules/encodeurl": {
      "version": "2.0.0",
      "resolved": "https://registry.npmjs.org/encodeurl/-/encodeurl-2.0.0.tgz",
      "integrity": "sha512-Q0n9HRi4m6JuGIV1eFlmvJB7ZEVxu93IrMyiMsGC0lrMJMWzRgx6WGquyfQgZVb31vhGgXnfmPNNXmxnOkRBrg==",
      "license": "MIT",
      "engines": {
        "node": ">= 0.8"
      }
    },
    "node_modules/es-define-property": {
      "version": "1.0.1",
      "resolved": "https://registry.npmjs.org/es-define-property/-/es-define-property-1.0.1.tgz",
      "integrity": "sha512-e3nRfgfUZ4rNGL232gUgX06QNyyez04KdjFrF+LTRoOXmrOgFKDg4BCdsjW8EnT69eqdYGmRpJwiPVYNrCaW3g==",
      "license": "MIT",
      "engines": {
        "node": ">= 0.4"
      }
    },
    "node_modules/es-errors": {
      "version": "1.3.0",
      "resolved": "https://registry.npmjs.org/es-errors/-/es-errors-1.3.0.tgz",
      "integrity": "sha512-Zf5H2Kxt2xjTvbJvP2ZWLEICxA6j+hAmMzIlypy4xcBg1vKVnx89Wy0GbS+kf5cwCVFFzdCFh2XSCFNULS6csw==",
      "license": "MIT",
      "engines": {
        "node": ">= 0.4"
      }
    },
    "node_modules/es-module-lexer": {
      "version": "2.3.2",
      "resolved": "https://registry.npmjs.org/es-module-lexer/-/es-module-lexer-2.3.2.tgz",
      "integrity": "sha512-poHGpORABojJJucnV9KbOavETW8lBVnphkW77ER5/BQ5Fz7oXSoCNek7IH3vR5nRjdsEz926ibFYX8KtLQmdyw==",
      "license": "MIT"
    },
    "node_modules/es-object-atoms": {
      "version": "1.1.2",
      "resolved": "https://registry.npmjs.org/es-object-atoms/-/es-object-atoms-1.1.2.tgz",
      "integrity": "sha512-HWcBoN6NileqtSydK2FqHbS/LoDd2pqrnQHLyJzBj4kOp/ky2MWMN694xOfkK8/SnUsW2DH7EfyVlydKCsm1Zw==",
      "license": "MIT",
      "dependencies": {
        "es-errors": "^1.3.0"
      },
      "engines": {
        "node": ">= 0.4"
      }
    },
    "node_modules/es-set-tostringtag": {
      "version": "2.1.0",
      "resolved": "https://registry.npmjs.org/es-set-tostringtag/-/es-set-tostringtag-2.1.0.tgz",
      "integrity": "sha512-j6vWzfrGVfyXxge+O0x5sh6cvxAog0a/4Rdd2K36zCMV5eJ+/+tOAngRO8cODMNWbVRdVlmGZQL2YS3yR8bIUA==",
      "license": "MIT",
      "dependencies": {
        "es-errors": "^1.3.0",
        "get-intrinsic": "^1.2.6",
        "has-tostringtag": "^1.0.2",
        "hasown": "^2.0.2"
      },
      "engines": {
        "node": ">= 0.4"
      }
    },
    "node_modules/escalade": {
      "version": "3.2.0",
      "resolved": "https://registry.npmjs.org/escalade/-/escalade-3.2.0.tgz",
      "integrity": "sha512-WUj2qlxaQtO4g6Pq5c29GTcWGDyd8itL8zTlipgECz3JesAiiOKotd8JU6otB3PACgG6xkJUyVhboMS+bje/jA==",
      "license": "MIT",
      "engines": {
        "node": ">=6"
      }
    },
    "node_modules/escape-html": {
      "version": "1.0.3",
      "resolved": "https://registry.npmjs.org/escape-html/-/escape-html-1.0.3.tgz",
      "integrity": "sha512-NiSupZ4OeuGwr68lGIeym/ksIZMJodUGOSCZ/FSnTxcrekbvqrgdUxlJOMpijaKZVjAJrWrGs/6Jy8OMuyj9ow==",
      "license": "MIT"
    },
    "node_modules/etag": {
      "version": "1.8.1",
      "resolved": "https://registry.npmjs.org/etag/-/etag-1.8.1.tgz",
      "integrity": "sha512-aIL5Fx7mawVa300al2BnEE4iNvo1qETxLrPI/o05L7z6go7fCw1J6EQmbK4FmJ2AS7kgVF/KEZWufBfdClMcPg==",
      "license": "MIT",
      "engines": {
        "node": ">= 0.6"
      }
    },
    "node_modules/event-target-shim": {
      "version": "5.0.1",
      "resolved": "https://registry.npmjs.org/event-target-shim/-/event-target-shim-5.0.1.tgz",
      "integrity": "sha512-i/2XbnSz/uxRCU6+NdVJgKWDTM427+MqYbkQzD321DuCQJUqOuJKIA0IM2+W2xtYHdKOmZ4dR6fExsd4SXL+WQ==",
      "license": "MIT",
      "engines": {
        "node": ">=6"
      }
    },
    "node_modules/eventemitter3": {
      "version": "4.0.7",
      "resolved": "https://registry.npmjs.org/eventemitter3/-/eventemitter3-4.0.7.tgz",
      "integrity": "sha512-8guHBZCwKnFhYdHr2ysuRWErTwhoN2X8XELRlrRwpmfeY2jjuUN4taQMsULKUVo1K4DvZl+0pgfyoysHxvmvEw==",
      "license": "MIT"
    },
    "node_modules/express": {
      "version": "5.2.1",
      "resolved": "https://registry.npmjs.org/express/-/express-5.2.1.tgz",
      "integrity": "sha512-hIS4idWWai69NezIdRt2xFVofaF4j+6INOpJlVOLDO8zXGpUVEVzIYk12UUi2JzjEzWL3IOAxcTubgz9Po0yXw==",
      "license": "MIT",
      "dependencies": {
        "accepts": "^2.0.0",
        "body-parser": "^2.2.1",
        "content-disposition": "^1.0.0",
        "content-type": "^1.0.5",
        "cookie": "^0.7.1",
        "cookie-signature": "^1.2.1",
        "debug": "^4.4.0",
        "depd": "^2.0.0",
        "encodeurl": "^2.0.0",
        "escape-html": "^1.0.3",
        "etag": "^1.8.1",
        "finalhandler": "^2.1.0",
        "fresh": "^2.0.0",
        "http-errors": "^2.0.0",
        "merge-descriptors": "^2.0.0",
        "mime-types": "^3.0.0",
        "on-finished": "^2.4.1",
        "once": "^1.4.0",
        "parseurl": "^1.3.3",
        "proxy-addr": "^2.0.7",
        "qs": "^6.14.0",
        "range-parser": "^1.2.1",
        "router": "^2.2.0",
        "send": "^1.1.0",
        "serve-static": "^2.2.0",
        "statuses": "^2.0.1",
        "type-is": "^2.0.1",
        "vary": "^1.1.2"
      },
      "engines": {
        "node": ">= 18"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/express"
      }
    },
    "node_modules/express/node_modules/mime-db": {
      "version": "1.54.0",
      "resolved": "https://registry.npmjs.org/mime-db/-/mime-db-1.54.0.tgz",
      "integrity": "sha512-aU5EJuIN2WDemCcAp2vFBfp/m4EAhWJnUNSSw0ixs7/kXbd6Pg64EmwJkNdFhB8aWt1sH2CTXrLxo/iAGV3oPQ==",
      "license": "MIT",
      "engines": {
        "node": ">= 0.6"
      }
    },
    "node_modules/express/node_modules/mime-types": {
      "version": "3.0.2",
      "resolved": "https://registry.npmjs.org/mime-types/-/mime-types-3.0.2.tgz",
      "integrity": "sha512-Lbgzdk0h4juoQ9fCKXW4by0UJqj+nOOrI9MJ1sSj4nI8aI2eo1qmvQEie4VD1glsS250n15LsWsYtCugiStS5A==",
      "license": "MIT",
      "dependencies": {
        "mime-db": "^1.54.0"
      },
      "engines": {
        "node": ">=18"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/express"
      }
    },
    "node_modules/finalhandler": {
      "version": "2.1.1",
      "resolved": "https://registry.npmjs.org/finalhandler/-/finalhandler-2.1.1.tgz",
      "integrity": "sha512-S8KoZgRZN+a5rNwqTxlZZePjT/4cnm0ROV70LedRHZ0p8u9fRID0hJUZQpkKLzro8LfmC8sx23bY6tVNxv8pQA==",
      "license": "MIT",
      "dependencies": {
        "debug": "^4.4.0",
        "encodeurl": "^2.0.0",
        "escape-html": "^1.0.3",
        "on-finished": "^2.4.1",
        "parseurl": "^1.3.3",
        "statuses": "^2.0.1"
      },
      "engines": {
        "node": ">= 18.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/express"
      }
    },
    "node_modules/follow-redirects": {
      "version": "1.16.0",
      "resolved": "https://registry.npmjs.org/follow-redirects/-/follow-redirects-1.16.0.tgz",
      "integrity": "sha512-y5rN/uOsadFT/JfYwhxRS5R7Qce+g3zG97+JrtFZlC9klX/W5hD7iiLzScI4nZqUS7DNUdhPgw4xI8W2LuXlUw==",
      "funding": [
        {
          "type": "individual",
          "url": "https://github.com/sponsors/RubenVerborgh"
        }
      ],
      "license": "MIT",
      "engines": {
        "node": ">=4.0"
      },
      "peerDependenciesMeta": {
        "debug": {
          "optional": true
        }
      }
    },
    "node_modules/form-data": {
      "version": "4.0.6",
      "resolved": "https://registry.npmjs.org/form-data/-/form-data-4.0.6.tgz",
      "integrity": "sha512-vKatAh4SlVfgbv+YtmhiRjhEMJsYpsG1Y2rMQtR+SVSbytsSD1YGzDIcrAJmdFec88u/+VoGmxnl+80gL1tRCQ==",
      "license": "MIT",
      "dependencies": {
        "asynckit": "^0.4.0",
        "combined-stream": "^1.0.8",
        "es-set-tostringtag": "^2.1.0",
        "hasown": "^2.0.4",
        "mime-types": "^2.1.35"
      },
      "engines": {
        "node": ">= 6"
      }
    },
    "node_modules/form-data-encoder": {
      "version": "1.7.2",
      "resolved": "https://registry.npmjs.org/form-data-encoder/-/form-data-encoder-1.7.2.tgz",
      "integrity": "sha512-qfqtYan3rxrnCk1VYaA4H+Ms9xdpPqvLZa6xmMgFvhO32x7/3J/ExcTd6qpxM0vH2GdMI+poehyBZvqfMTto8A==",
      "license": "MIT"
    },
    "node_modules/formdata-node": {
      "version": "4.4.1",
      "resolved": "https://registry.npmjs.org/formdata-node/-/formdata-node-4.4.1.tgz",
      "integrity": "sha512-0iirZp3uVDjVGt9p49aTaqjk84TrglENEDuqfdlZQ1roC9CWlPk6Avf8EEnZNcAqPonwkG35x4n3ww/1THYAeQ==",
      "license": "MIT",
      "dependencies": {
        "node-domexception": "1.0.0",
        "web-streams-polyfill": "4.0.0-beta.3"
      },
      "engines": {
        "node": ">= 12.20"
      }
    },
    "node_modules/forwarded": {
      "version": "0.2.0",
      "resolved": "https://registry.npmjs.org/forwarded/-/forwarded-0.2.0.tgz",
      "integrity": "sha512-buRG0fpBtRHSTCOASe6hD258tEubFoRLb4ZNA6NxMVHNw2gOcwHo9wyablzMzOA5z9xA9L1KNjk/Nt6MT9aYow==",
      "license": "MIT",
      "engines": {
        "node": ">= 0.6"
      }
    },
    "node_modules/forwarded-parse": {
      "version": "2.1.2",
      "resolved": "https://registry.npmjs.org/forwarded-parse/-/forwarded-parse-2.1.2.tgz",
      "integrity": "sha512-alTFZZQDKMporBH77856pXgzhEzaUVmLCDk+egLgIgHst3Tpndzz8MnKe+GzRJRfvVdn69HhpW7cmXzvtLvJAw==",
      "license": "MIT"
    },
    "node_modules/fresh": {
      "version": "2.0.0",
      "resolved": "https://registry.npmjs.org/fresh/-/fresh-2.0.0.tgz",
      "integrity": "sha512-Rx/WycZ60HOaqLKAi6cHRKKI7zxWbJ31MhntmtwMoaTeF7XFH9hhBp8vITaMidfljRQ6eYWCKkaTK+ykVJHP2A==",
      "license": "MIT",
      "engines": {
        "node": ">= 0.8"
      }
    },
    "node_modules/function-bind": {
      "version": "1.1.2",
      "resolved": "https://registry.npmjs.org/function-bind/-/function-bind-1.1.2.tgz",
      "integrity": "sha512-7XHNxH7qX9xG5mIwxkhumTox/MIRNcOgDrxWsMt2pAr23WHp6MrRlN7FBSFpCpr+oVO0F744iUgR82nJMfG2SA==",
      "license": "MIT",
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/get-caller-file": {
      "version": "2.0.5",
      "resolved": "https://registry.npmjs.org/get-caller-file/-/get-caller-file-2.0.5.tgz",
      "integrity": "sha512-DyFP3BM/3YHTQOCUL/w0OZHR0lpKeGrxotcHWcqNEdnltqFwXVfhEBQ94eIo34AfQpo0rGki4cyIiftY06h2Fg==",
      "license": "ISC",
      "engines": {
        "node": "6.* || 8.* || >= 10.*"
      }
    },
    "node_modules/get-intrinsic": {
      "version": "1.3.0",
      "resolved": "https://registry.npmjs.org/get-intrinsic/-/get-intrinsic-1.3.0.tgz",
      "integrity": "sha512-9fSjSaos/fRIVIp+xSJlE6lfwhES7LNtKaCBIamHsjr2na1BiABJPo0mOjjz8GJDURarmCPGqaiVg5mfjb98CQ==",
      "license": "MIT",
      "dependencies": {
        "call-bind-apply-helpers": "^1.0.2",
        "es-define-property": "^1.0.1",
        "es-errors": "^1.3.0",
        "es-object-atoms": "^1.1.1",
        "function-bind": "^1.1.2",
        "get-proto": "^1.0.1",
        "gopd": "^1.2.0",
        "has-symbols": "^1.1.0",
        "hasown": "^2.0.2",
        "math-intrinsics": "^1.1.0"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/get-proto": {
      "version": "1.0.1",
      "resolved": "https://registry.npmjs.org/get-proto/-/get-proto-1.0.1.tgz",
      "integrity": "sha512-sTSfBjoXBp89JvIKIefqw7U2CCebsc74kiY6awiGogKtoSGbgjYE/G/+l9sF3MWFPNc9IcoOC4ODfKHfxFmp0g==",
      "license": "MIT",
      "dependencies": {
        "dunder-proto": "^1.0.1",
        "es-object-atoms": "^1.0.0"
      },
      "engines": {
        "node": ">= 0.4"
      }
    },
    "node_modules/gopd": {
      "version": "1.2.0",
      "resolved": "https://registry.npmjs.org/gopd/-/gopd-1.2.0.tgz",
      "integrity": "sha512-ZUKRh6/kUFoAiTAtTYPZJ3hw9wNxx+BIBOijnlG9PnrJsCcSjs1wyyD6vJpaYtgnzDrKYRSqf3OO6Rfa93xsRg==",
      "license": "MIT",
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/has-flag": {
      "version": "4.0.0",
      "resolved": "https://registry.npmjs.org/has-flag/-/has-flag-4.0.0.tgz",
      "integrity": "sha512-EykJT/Q1KjTWctppgIAgfSO0tKVuZUjhgMr17kqTumMl6Afv3EISleU7qZUzoXDFTAHTDC4NOoG/ZxU3EvlMPQ==",
      "license": "MIT",
      "engines": {
        "node": ">=8"
      }
    },
    "node_modules/has-symbols": {
      "version": "1.1.0",
      "resolved": "https://registry.npmjs.org/has-symbols/-/has-symbols-1.1.0.tgz",
      "integrity": "sha512-1cDNdwJ2Jaohmb3sg4OmKaMBwuC48sYni5HUw2DvsC8LjGTLK9h+eb1X6RyuOHe4hT0ULCW68iomhjUoKUqlPQ==",
      "license": "MIT",
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/has-tostringtag": {
      "version": "1.0.2",
      "resolved": "https://registry.npmjs.org/has-tostringtag/-/has-tostringtag-1.0.2.tgz",
      "integrity": "sha512-NqADB8VjPFLM2V0VvHUewwwsw0ZWBaIdgo+ieHtK3hasLz4qeCRjYcqfB6AQrBggRKppKF8L52/VqdVsO47Dlw==",
      "license": "MIT",
      "dependencies": {
        "has-symbols": "^1.0.3"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/hasown": {
      "version": "2.0.4",
      "resolved": "https://registry.npmjs.org/hasown/-/hasown-2.0.4.tgz",
      "integrity": "sha512-T2UbfbBEF32wiepXIsMlTW9+dDYC6wMh/t/vYA4tuOMKqWz/n3vr1NFSxQiyP+zk2mXsoMA/i/7qV6LKut1t1A==",
      "license": "MIT",
      "dependencies": {
        "function-bind": "^1.1.2"
      },
      "engines": {
        "node": ">= 0.4"
      }
    },
    "node_modules/http-errors": {
      "version": "2.0.1",
      "resolved": "https://registry.npmjs.org/http-errors/-/http-errors-2.0.1.tgz",
      "integrity": "sha512-4FbRdAX+bSdmo4AUFuS0WNiPz8NgFt+r8ThgNWmlrjQjt1Q7ZR9+zTlce2859x4KSXrwIsaeTqDoKQmtP8pLmQ==",
      "license": "MIT",
      "dependencies": {
        "depd": "~2.0.0",
        "inherits": "~2.0.4",
        "setprototypeof": "~1.2.0",
        "statuses": "~2.0.2",
        "toidentifier": "~1.0.1"
      },
      "engines": {
        "node": ">= 0.8"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/express"
      }
    },
    "node_modules/https-proxy-agent": {
      "version": "5.0.1",
      "resolved": "https://registry.npmjs.org/https-proxy-agent/-/https-proxy-agent-5.0.1.tgz",
      "integrity": "sha512-dFcAjpTQFgoLMzC2VwU+C/CbS7uRL0lWmxDITmqm7C+7F0Odmj6s9l6alZc6AELXhrnggM2CeWSXHGOdX2YtwA==",
      "license": "MIT",
      "dependencies": {
        "agent-base": "6",
        "debug": "4"
      },
      "engines": {
        "node": ">= 6"
      }
    },
    "node_modules/humanize-ms": {
      "version": "1.2.1",
      "resolved": "https://registry.npmjs.org/humanize-ms/-/humanize-ms-1.2.1.tgz",
      "integrity": "sha512-Fl70vYtsAFb/C06PTS9dZBo7ihau+Tu/DNCk/OyHhea07S+aeMWpFFkUaXRa8fI+ScZbEI8dfSxwY7gxZ9SAVQ==",
      "license": "MIT",
      "dependencies": {
        "ms": "^2.0.0"
      }
    },
    "node_modules/iconv-lite": {
      "version": "0.7.3",
      "resolved": "https://registry.npmjs.org/iconv-lite/-/iconv-lite-0.7.3.tgz",
      "integrity": "sha512-IKXpvIzjnC9XTAUbVBcMfGS0EPaIXtW6v+zr+RRp+hqULEpo0owZax6wyRwPOJbWbzjYspQwusTsfVr0ifh4uQ==",
      "license": "MIT",
      "dependencies": {
        "safer-buffer": ">= 2.1.2 < 3.0.0"
      },
      "engines": {
        "node": ">=0.10.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/express"
      }
    },
    "node_modules/import-in-the-middle": {
      "version": "1.7.1",
      "resolved": "https://registry.npmjs.org/import-in-the-middle/-/import-in-the-middle-1.7.1.tgz",
      "integrity": "sha512-1LrZPDtW+atAxH42S6288qyDFNQ2YCty+2mxEPRtfazH6Z5QwkaBSTS2ods7hnVJioF6rkRfNoA6A/MstpFXLg==",
      "license": "Apache-2.0",
      "dependencies": {
        "acorn": "^8.8.2",
        "acorn-import-assertions": "^1.9.0",
        "cjs-module-lexer": "^1.2.2",
        "module-details-from-path": "^1.0.3"
      }
    },
    "node_modules/inherits": {
      "version": "2.0.4",
      "resolved": "https://registry.npmjs.org/inherits/-/inherits-2.0.4.tgz",
      "integrity": "sha512-k/vGaX4/Yla3WzyMCvTQOXYeIHvqOKtnqBduzTHpzpQZzAskKMhZ2K+EnBiSM9zGSoIFeMpXKxa4dYeZIQqewQ==",
      "license": "ISC"
    },
    "node_modules/ipaddr.js": {
      "version": "1.9.1",
      "resolved": "https://registry.npmjs.org/ipaddr.js/-/ipaddr.js-1.9.1.tgz",
      "integrity": "sha512-0KI/607xoxSToH7GjN1FfSbLoU0+btTicjsQSWQlh/hZykN8KpmMf7uYwPW3R+akZ6R/w18ZlXSHBYXiYUPO3g==",
      "license": "MIT",
      "engines": {
        "node": ">= 0.10"
      }
    },
    "node_modules/is-core-module": {
      "version": "2.16.2",
      "resolved": "https://registry.npmjs.org/is-core-module/-/is-core-module-2.16.2.tgz",
      "integrity": "sha512-evOr8xfXKxE6qSR0hSXL2r3sd7ALj8+7jQEUvPYcm5sgZFdJ+AYzT6yNmJenvIYQBgIGwfwz08sL8zoL7yq2BA==",
      "license": "MIT",
      "dependencies": {
        "hasown": "^2.0.3"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/is-fullwidth-code-point": {
      "version": "3.0.0",
      "resolved": "https://registry.npmjs.org/is-fullwidth-code-point/-/is-fullwidth-code-point-3.0.0.tgz",
      "integrity": "sha512-zymm5+u+sCsSWyD9qNaejV3DFvhCKclKdizYaJUuHA83RLjb7nSuGnddCHGv0hk+KY7BMAlsWeK4Ueg6EV6XQg==",
      "license": "MIT",
      "engines": {
        "node": ">=8"
      }
    },
    "node_modules/is-promise": {
      "version": "4.0.0",
      "resolved": "https://registry.npmjs.org/is-promise/-/is-promise-4.0.0.tgz",
      "integrity": "sha512-hvpoI6korhJMnej285dSg6nu1+e6uxs7zG3BYAm5byqDsgJNWwxzM6z6iZiAgQR4TJ30JmBTOwqZUw3WlyH3AQ==",
      "license": "MIT"
    },
    "node_modules/js-tiktoken": {
      "version": "1.0.21",
      "resolved": "https://registry.npmjs.org/js-tiktoken/-/js-tiktoken-1.0.21.tgz",
      "integrity": "sha512-biOj/6M5qdgx5TKjDnFT1ymSpM5tbd3ylwDtrQvFQSu0Z7bBYko2dF+W/aUkXUPuk6IVpRxk/3Q2sHOzGlS36g==",
      "license": "MIT",
      "dependencies": {
        "base64-js": "^1.5.1"
      }
    },
    "node_modules/langsmith": {
      "version": "0.3.87",
      "resolved": "https://registry.npmjs.org/langsmith/-/langsmith-0.3.87.tgz",
      "integrity": "sha512-XXR1+9INH8YX96FKWc5tie0QixWz6tOqAsAKfcJyPkE0xPep+NDz0IQLR32q4bn10QK3LqD2HN6T3n6z1YLW7Q==",
      "license": "MIT",
      "dependencies": {
        "@types/uuid": "^10.0.0",
        "chalk": "^4.1.2",
        "console-table-printer": "^2.12.1",
        "p-queue": "^6.6.2",
        "semver": "^7.6.3",
        "uuid": "^10.0.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "*",
        "@opentelemetry/exporter-trace-otlp-proto": "*",
        "@opentelemetry/sdk-trace-base": "*",
        "openai": "*"
      },
      "peerDependenciesMeta": {
        "@opentelemetry/api": {
          "optional": true
        },
        "@opentelemetry/exporter-trace-otlp-proto": {
          "optional": true
        },
        "@opentelemetry/sdk-trace-base": {
          "optional": true
        },
        "openai": {
          "optional": true
        }
      }
    },
    "node_modules/lodash.camelcase": {
      "version": "4.3.0",
      "resolved": "https://registry.npmjs.org/lodash.camelcase/-/lodash.camelcase-4.3.0.tgz",
      "integrity": "sha512-TwuEnCnxbc3rAvhf/LbG7tJUDzhqXyFnv3dtzLOPgCG/hODL7WFnsbwktkD7yUV0RrreP/l1PALq/YSg6VvjlA==",
      "license": "MIT"
    },
    "node_modules/long": {
      "version": "5.3.2",
      "resolved": "https://registry.npmjs.org/long/-/long-5.3.2.tgz",
      "integrity": "sha512-mNAgZ1GmyNhD7AuqnTG3/VQ26o760+ZYBPKjPvugO8+nLbYfX6TVpJPseBvopbdY+qpZ/lKUnmEc1LeZYS3QAA==",
      "license": "Apache-2.0"
    },
    "node_modules/math-intrinsics": {
      "version": "1.1.0",
      "resolved": "https://registry.npmjs.org/math-intrinsics/-/math-intrinsics-1.1.0.tgz",
      "integrity": "sha512-/IXtbwEk5HTPyEwyKX6hGkYXxM9nbj64B+ilVJnC/R6B0pH5G4V3b0pVbL7DBj4tkhBAppbQUlf6F6Xl9LHu1g==",
      "license": "MIT",
      "engines": {
        "node": ">= 0.4"
      }
    },
    "node_modules/media-typer": {
      "version": "1.1.1",
      "resolved": "https://registry.npmjs.org/media-typer/-/media-typer-1.1.1.tgz",
      "integrity": "sha512-yz3xRaG20c6/BOzvYoDaGtPmGscs7YivItZEEqe6GbwNfHuxu9YNmvnEkMzKldAGY4/80pRcQRZSEnhquk9XuQ==",
      "license": "MIT",
      "engines": {
        "node": ">= 0.8"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/express"
      }
    },
    "node_modules/merge-descriptors": {
      "version": "2.0.0",
      "resolved": "https://registry.npmjs.org/merge-descriptors/-/merge-descriptors-2.0.0.tgz",
      "integrity": "sha512-Snk314V5ayFLhp3fkUREub6WtjBfPdCPY1Ln8/8munuLuiYhsABgBVWsozAG+MWMbVEvcdcpbi9R7ww22l9Q3g==",
      "license": "MIT",
      "engines": {
        "node": ">=18"
      },
      "funding": {
        "url": "https://github.com/sponsors/sindresorhus"
      }
    },
    "node_modules/mime-db": {
      "version": "1.52.0",
      "resolved": "https://registry.npmjs.org/mime-db/-/mime-db-1.52.0.tgz",
      "integrity": "sha512-sPU4uV7dYlvtWJxwwxHD0PuihVNiE7TyAbQ5SWxDCB9mUYvOgroQOwYQQOKPJ8CIbE+1ETVlOoK1UC2nU3gYvg==",
      "license": "MIT",
      "engines": {
        "node": ">= 0.6"
      }
    },
    "node_modules/mime-types": {
      "version": "2.1.35",
      "resolved": "https://registry.npmjs.org/mime-types/-/mime-types-2.1.35.tgz",
      "integrity": "sha512-ZDY+bPm5zTTF+YpCrAU9nK0UgICYPT0QtT1NZWFv4s++TNkcgVaT0g6+4R2uI4MjQjzysHB1zxuWL50hzaeXiw==",
      "license": "MIT",
      "dependencies": {
        "mime-db": "1.52.0"
      },
      "engines": {
        "node": ">= 0.6"
      }
    },
    "node_modules/module-details-from-path": {
      "version": "1.0.4",
      "resolved": "https://registry.npmjs.org/module-details-from-path/-/module-details-from-path-1.0.4.tgz",
      "integrity": "sha512-EGWKgxALGMgzvxYF1UyGTy0HXX/2vHLkw6+NvDKW2jypWbHpjQuj4UMcqQWXHERJhVGKikolT06G3bcKe4fi7w==",
      "license": "MIT"
    },
    "node_modules/ms": {
      "version": "2.1.3",
      "resolved": "https://registry.npmjs.org/ms/-/ms-2.1.3.tgz",
      "integrity": "sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==",
      "license": "MIT"
    },
    "node_modules/mustache": {
      "version": "4.2.0",
      "resolved": "https://registry.npmjs.org/mustache/-/mustache-4.2.0.tgz",
      "integrity": "sha512-71ippSywq5Yb7/tVYyGbkBggbU8H3u5Rz56fH60jGFgr8uHwxs+aSKeqmluIVzM0m0kB7xQjKS6qPfd0b2ZoqQ==",
      "license": "MIT",
      "bin": {
        "mustache": "bin/mustache"
      }
    },
    "node_modules/negotiator": {
      "version": "1.1.0",
      "resolved": "https://registry.npmjs.org/negotiator/-/negotiator-1.1.0.tgz",
      "integrity": "sha512-NMPBRMJgiQHjbd8phG3Vebdx4kZ1H121rbl5IkMqeOsahptB9BKo/d7oJ3zTXqTgagn2bWlNSXkh0QUGM31RYg==",
      "license": "MIT",
      "dependencies": {
        "content-type": "^2.1.0"
      },
      "engines": {
        "node": ">=18"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/express"
      }
    },
    "node_modules/negotiator/node_modules/content-type": {
      "version": "2.1.0",
      "resolved": "https://registry.npmjs.org/content-type/-/content-type-2.1.0.tgz",
      "integrity": "sha512-mj7UPXE0jaqaOsukNZRUEfEi2AcL7C/vwmwcHV0O97eO1E1pxBZuyjlZrx5seTaNBg1U6+o35wpa35Qfcc+7ag==",
      "license": "MIT",
      "engines": {
        "node": ">=18"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/express"
      }
    },
    "node_modules/node-domexception": {
      "version": "1.0.0",
      "resolved": "https://registry.npmjs.org/node-domexception/-/node-domexception-1.0.0.tgz",
      "integrity": "sha512-/jKZoMpw0F8GRwl4/eLROPA3cfcXtLApP0QzLmUT/HuPCZWyB7IY9ZrMeKw2O/nFIqPQB3PVM9aYm0F312AXDQ==",
      "deprecated": "Use your platform's native DOMException instead",
      "funding": [
        {
          "type": "github",
          "url": "https://github.com/sponsors/jimmywarting"
        },
        {
          "type": "github",
          "url": "https://paypal.me/jimmywarting"
        }
      ],
      "license": "MIT",
      "engines": {
        "node": ">=10.5.0"
      }
    },
    "node_modules/node-fetch": {
      "version": "2.7.0",
      "resolved": "https://registry.npmjs.org/node-fetch/-/node-fetch-2.7.0.tgz",
      "integrity": "sha512-c4FRfUm/dbcWZ7U+1Wq0AwCyFL+3nt2bEw05wfxSz+DWpWsitgmSgYmy2dQdWyKC1694ELPqMs/YzUSNozLt8A==",
      "license": "MIT",
      "dependencies": {
        "whatwg-url": "^5.0.0"
      },
      "engines": {
        "node": "4.x || >=6.0.0"
      },
      "peerDependencies": {
        "encoding": "^0.1.0"
      },
      "peerDependenciesMeta": {
        "encoding": {
          "optional": true
        }
      }
    },
    "node_modules/object-inspect": {
      "version": "1.13.4",
      "resolved": "https://registry.npmjs.org/object-inspect/-/object-inspect-1.13.4.tgz",
      "integrity": "sha512-W67iLl4J2EXEGTbfeHCffrjDfitvLANg0UlX3wFUUSTx92KXRFegMHUVgSqE+wvhAbi4WqjGg9czysTV2Epbew==",
      "license": "MIT",
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/on-finished": {
      "version": "2.4.1",
      "resolved": "https://registry.npmjs.org/on-finished/-/on-finished-2.4.1.tgz",
      "integrity": "sha512-oVlzkg3ENAhCk2zdv7IJwd/QUD4z2RxRwpkcGY8psCVcCYZNq4wYnVWALHM+brtuJjePWiYF/ClmuDr8Ch5+kg==",
      "license": "MIT",
      "dependencies": {
        "ee-first": "1.1.1"
      },
      "engines": {
        "node": ">= 0.8"
      }
    },
    "node_modules/once": {
      "version": "1.4.0",
      "resolved": "https://registry.npmjs.org/once/-/once-1.4.0.tgz",
      "integrity": "sha512-lNaJgI+2Q5URQBkccEKHTQOPaXdUxnZZElQTZY0MFUAuaEqe1E+Nyvgdz/aIyNi6Z9MzO5dv1H8n58/GELp3+w==",
      "license": "ISC",
      "dependencies": {
        "wrappy": "1"
      }
    },
    "node_modules/openai": {
      "version": "4.104.0",
      "resolved": "https://registry.npmjs.org/openai/-/openai-4.104.0.tgz",
      "integrity": "sha512-p99EFNsA/yX6UhVO93f5kJsDRLAg+CTA2RBqdHK4RtK8u5IJw32Hyb2dTGKbnnFmnuoBv5r7Z2CURI9sGZpSuA==",
      "license": "Apache-2.0",
      "dependencies": {
        "@types/node": "^18.11.18",
        "@types/node-fetch": "^2.6.4",
        "abort-controller": "^3.0.0",
        "agentkeepalive": "^4.2.1",
        "form-data-encoder": "1.7.2",
        "formdata-node": "^4.3.2",
        "node-fetch": "^2.6.7"
      },
      "bin": {
        "openai": "bin/cli"
      },
      "peerDependencies": {
        "ws": "^8.18.0",
        "zod": "^3.23.8"
      },
      "peerDependenciesMeta": {
        "ws": {
          "optional": true
        },
        "zod": {
          "optional": true
        }
      }
    },
    "node_modules/p-finally": {
      "version": "1.0.0",
      "resolved": "https://registry.npmjs.org/p-finally/-/p-finally-1.0.0.tgz",
      "integrity": "sha512-LICb2p9CB7FS+0eR1oqWnHhp0FljGLZCWBE9aix0Uye9W8LTQPwMTYVGWQWIw9RdQiDg4+epXQODwIYJtSJaow==",
      "license": "MIT",
      "engines": {
        "node": ">=4"
      }
    },
    "node_modules/p-queue": {
      "version": "6.6.2",
      "resolved": "https://registry.npmjs.org/p-queue/-/p-queue-6.6.2.tgz",
      "integrity": "sha512-RwFpb72c/BhQLEXIZ5K2e+AhgNVmIejGlTgiB9MzZ0e93GRvqZ7uSi0dvRF7/XIXDeNkra2fNHBxTyPDGySpjQ==",
      "license": "MIT",
      "dependencies": {
        "eventemitter3": "^4.0.4",
        "p-timeout": "^3.2.0"
      },
      "engines": {
        "node": ">=8"
      },
      "funding": {
        "url": "https://github.com/sponsors/sindresorhus"
      }
    },
    "node_modules/p-retry": {
      "version": "4.6.2",
      "resolved": "https://registry.npmjs.org/p-retry/-/p-retry-4.6.2.tgz",
      "integrity": "sha512-312Id396EbJdvRONlngUx0NydfrIQ5lsYu0znKVUzVvArzEIt08V1qhtyESbGVd1FGX7UKtiFp5uwKZdM8wIuQ==",
      "license": "MIT",
      "dependencies": {
        "@types/retry": "0.12.0",
        "retry": "^0.13.1"
      },
      "engines": {
        "node": ">=8"
      }
    },
    "node_modules/p-timeout": {
      "version": "3.2.0",
      "resolved": "https://registry.npmjs.org/p-timeout/-/p-timeout-3.2.0.tgz",
      "integrity": "sha512-rhIwUycgwwKcP9yTOOFK/AKsAopjjCakVqLHePO3CC6Mir1Z99xT+R63jZxAT5lFZLa2inS5h+ZS2GvR99/FBg==",
      "license": "MIT",
      "dependencies": {
        "p-finally": "^1.0.0"
      },
      "engines": {
        "node": ">=8"
      }
    },
    "node_modules/parseurl": {
      "version": "1.3.3",
      "resolved": "https://registry.npmjs.org/parseurl/-/parseurl-1.3.3.tgz",
      "integrity": "sha512-CiyeOxFT/JZyN5m0z9PfXw4SCBJ6Sygz1Dpl0wqjlhDEGGBP1GnsUVEL0p63hoG1fcj3fHynXi9NYO4nWOL+qQ==",
      "license": "MIT",
      "engines": {
        "node": ">= 0.8"
      }
    },
    "node_modules/path-parse": {
      "version": "1.0.7",
      "resolved": "https://registry.npmjs.org/path-parse/-/path-parse-1.0.7.tgz",
      "integrity": "sha512-LDJzPVEEEPR+y48z93A0Ed0yXb8pAByGWo/k5YYdYgpY2/2EsOsksJrq7lOHxryrVOn1ejG6oAp8ahvOIQD8sw==",
      "license": "MIT"
    },
    "node_modules/path-to-regexp": {
      "version": "8.4.2",
      "resolved": "https://registry.npmjs.org/path-to-regexp/-/path-to-regexp-8.4.2.tgz",
      "integrity": "sha512-qRcuIdP69NPm4qbACK+aDogI5CBDMi1jKe0ry5rSQJz8JVLsC7jV8XpiJjGRLLol3N+R5ihGYcrPLTno6pAdBA==",
      "license": "MIT",
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/express"
      }
    },
    "node_modules/protobufjs": {
      "version": "7.6.6",
      "resolved": "https://registry.npmjs.org/protobufjs/-/protobufjs-7.6.6.tgz",
      "integrity": "sha512-dYDWdjSl5RNb7SgPxGQcRU+GtvP7s2fpkrY0r432PcOIaZ0/rBcxEZnQN67iJhFuQiVw754JDoPruPCNdGsbjg==",
      "hasInstallScript": true,
      "license": "BSD-3-Clause",
      "dependencies": {
        "@protobufjs/aspromise": "^1.1.2",
        "@protobufjs/base64": "^1.1.2",
        "@protobufjs/codegen": "^2.0.5",
        "@protobufjs/eventemitter": "^1.1.1",
        "@protobufjs/fetch": "^1.1.1",
        "@protobufjs/float": "^1.0.2",
        "@protobufjs/path": "^1.1.2",
        "@protobufjs/pool": "^1.1.0",
        "@protobufjs/utf8": "^1.1.1",
        "@types/node": ">=13.7.0",
        "long": "^5.3.2"
      },
      "engines": {
        "node": ">=12.0.0"
      }
    },
    "node_modules/proxy-addr": {
      "version": "2.0.7",
      "resolved": "https://registry.npmjs.org/proxy-addr/-/proxy-addr-2.0.7.tgz",
      "integrity": "sha512-llQsMLSUDUPT44jdrU/O37qlnifitDP+ZwrmmZcoSKyLKvtZxpyV0n2/bD/N4tBAAZ/gJEdZU7KMraoK1+XYAg==",
      "license": "MIT",
      "dependencies": {
        "forwarded": "0.2.0",
        "ipaddr.js": "1.9.1"
      },
      "engines": {
        "node": ">= 0.10"
      }
    },
    "node_modules/proxy-from-env": {
      "version": "2.1.0",
      "resolved": "https://registry.npmjs.org/proxy-from-env/-/proxy-from-env-2.1.0.tgz",
      "integrity": "sha512-cJ+oHTW1VAEa8cJslgmUZrc+sjRKgAKl3Zyse6+PV38hZe/V6Z14TbCuXcan9F9ghlz4QrFr2c92TNF82UkYHA==",
      "license": "MIT",
      "engines": {
        "node": ">=10"
      }
    },
    "node_modules/qs": {
      "version": "6.16.0",
      "resolved": "https://registry.npmjs.org/qs/-/qs-6.16.0.tgz",
      "integrity": "sha512-h6fhOIaRrID2CbEY2fqs+7t+UXZo+MLAnU5gRIq85uFtdiUPCdsApMlHhXogKVM4HM2DVbIjGNTTYH2OcmP1vA==",
      "license": "BSD-3-Clause",
      "dependencies": {
        "es-define-property": "^1.0.1",
        "side-channel": "^1.1.1"
      },
      "engines": {
        "node": ">=0.6"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/range-parser": {
      "version": "1.3.0",
      "resolved": "https://registry.npmjs.org/range-parser/-/range-parser-1.3.0.tgz",
      "integrity": "sha512-hek2mFQpPuI4E1BBKrSto+BU3e3x4xuarsbiwr3+lf7p44juvFMV0XFWQAP3xUyqXA4RrXLIoaSUGbSt056ZMw==",
      "license": "MIT",
      "engines": {
        "node": ">= 0.6"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/express"
      }
    },
    "node_modules/raw-body": {
      "version": "3.0.2",
      "resolved": "https://registry.npmjs.org/raw-body/-/raw-body-3.0.2.tgz",
      "integrity": "sha512-K5zQjDllxWkf7Z5xJdV0/B0WTNqx6vxG70zJE4N0kBs4LovmEYWJzQGxC9bS9RAKu3bgM40lrd5zoLJ12MQ5BA==",
      "license": "MIT",
      "dependencies": {
        "bytes": "~3.1.2",
        "http-errors": "~2.0.1",
        "iconv-lite": "~0.7.0",
        "unpipe": "~1.0.0"
      },
      "engines": {
        "node": ">= 0.10"
      }
    },
    "node_modules/require-directory": {
      "version": "2.1.1",
      "resolved": "https://registry.npmjs.org/require-directory/-/require-directory-2.1.1.tgz",
      "integrity": "sha512-fGxEI7+wsG9xrvdjsrlmL22OMTTiHRwAMroiEeMgq8gzoLC/PQr7RsRDSTLUg/bZAZtF+TVIkHc6/4RIKrui+Q==",
      "license": "MIT",
      "engines": {
        "node": ">=0.10.0"
      }
    },
    "node_modules/require-in-the-middle": {
      "version": "7.5.2",
      "resolved": "https://registry.npmjs.org/require-in-the-middle/-/require-in-the-middle-7.5.2.tgz",
      "integrity": "sha512-gAZ+kLqBdHarXB64XpAe2VCjB7rIRv+mU8tfRWziHRJ5umKsIHN2tLLv6EtMw7WCdP19S0ERVMldNvxYCHnhSQ==",
      "license": "MIT",
      "dependencies": {
        "debug": "^4.3.5",
        "module-details-from-path": "^1.0.3",
        "resolve": "^1.22.8"
      },
      "engines": {
        "node": ">=8.6.0"
      }
    },
    "node_modules/resolve": {
      "version": "1.22.12",
      "resolved": "https://registry.npmjs.org/resolve/-/resolve-1.22.12.tgz",
      "integrity": "sha512-TyeJ1zif53BPfHootBGwPRYT1RUt6oGWsaQr8UyZW/eAm9bKoijtvruSDEmZHm92CwS9nj7/fWttqPCgzep8CA==",
      "license": "MIT",
      "dependencies": {
        "es-errors": "^1.3.0",
        "is-core-module": "^2.16.1",
        "path-parse": "^1.0.7",
        "supports-preserve-symlinks-flag": "^1.0.0"
      },
      "bin": {
        "resolve": "bin/resolve"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/retry": {
      "version": "0.13.1",
      "resolved": "https://registry.npmjs.org/retry/-/retry-0.13.1.tgz",
      "integrity": "sha512-XQBQ3I8W1Cge0Seh+6gjj03LbmRFWuoszgK9ooCpwYIrhhoO80pfq4cUkU5DkknwfOfFteRwlZ56PYOGYyFWdg==",
      "license": "MIT",
      "engines": {
        "node": ">= 4"
      }
    },
    "node_modules/router": {
      "version": "2.2.0",
      "resolved": "https://registry.npmjs.org/router/-/router-2.2.0.tgz",
      "integrity": "sha512-nLTrUKm2UyiL7rlhapu/Zl45FwNgkZGaCpZbIHajDYgwlJCOzLSk+cIPAnsEqV955GjILJnKbdQC1nVPz+gAYQ==",
      "license": "MIT",
      "dependencies": {
        "debug": "^4.4.0",
        "depd": "^2.0.0",
        "is-promise": "^4.0.0",
        "parseurl": "^1.3.3",
        "path-to-regexp": "^8.0.0"
      },
      "engines": {
        "node": ">= 18"
      }
    },
    "node_modules/safer-buffer": {
      "version": "2.1.2",
      "resolved": "https://registry.npmjs.org/safer-buffer/-/safer-buffer-2.1.2.tgz",
      "integrity": "sha512-YZo3K82SD7Riyi0E1EQPojLz7kpepnSQI9IyPbHHg1XXXevb5dJI7tpyN2ADxGcQbHG7vcyRHk0cbwqcQriUtg==",
      "license": "MIT"
    },
    "node_modules/semver": {
      "version": "7.8.5",
      "resolved": "https://registry.npmjs.org/semver/-/semver-7.8.5.tgz",
      "integrity": "sha512-Y7/KDsb8LjooZpwaqGyulO6DQlksgCncchHGk+sZIY4SBvUocMBEFH5Ur1fI4dV+Jvl0w6cjvucaIi40puRioA==",
      "license": "ISC",
      "bin": {
        "semver": "bin/semver.js"
      },
      "engines": {
        "node": ">=10"
      }
    },
    "node_modules/send": {
      "version": "1.2.1",
      "resolved": "https://registry.npmjs.org/send/-/send-1.2.1.tgz",
      "integrity": "sha512-1gnZf7DFcoIcajTjTwjwuDjzuz4PPcY2StKPlsGAQ1+YH20IRVrBaXSWmdjowTJ6u8Rc01PoYOGHXfP1mYcZNQ==",
      "license": "MIT",
      "dependencies": {
        "debug": "^4.4.3",
        "encodeurl": "^2.0.0",
        "escape-html": "^1.0.3",
        "etag": "^1.8.1",
        "fresh": "^2.0.0",
        "http-errors": "^2.0.1",
        "mime-types": "^3.0.2",
        "ms": "^2.1.3",
        "on-finished": "^2.4.1",
        "range-parser": "^1.2.1",
        "statuses": "^2.0.2"
      },
      "engines": {
        "node": ">= 18"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/express"
      }
    },
    "node_modules/send/node_modules/mime-db": {
      "version": "1.54.0",
      "resolved": "https://registry.npmjs.org/mime-db/-/mime-db-1.54.0.tgz",
      "integrity": "sha512-aU5EJuIN2WDemCcAp2vFBfp/m4EAhWJnUNSSw0ixs7/kXbd6Pg64EmwJkNdFhB8aWt1sH2CTXrLxo/iAGV3oPQ==",
      "license": "MIT",
      "engines": {
        "node": ">= 0.6"
      }
    },
    "node_modules/send/node_modules/mime-types": {
      "version": "3.0.2",
      "resolved": "https://registry.npmjs.org/mime-types/-/mime-types-3.0.2.tgz",
      "integrity": "sha512-Lbgzdk0h4juoQ9fCKXW4by0UJqj+nOOrI9MJ1sSj4nI8aI2eo1qmvQEie4VD1glsS250n15LsWsYtCugiStS5A==",
      "license": "MIT",
      "dependencies": {
        "mime-db": "^1.54.0"
      },
      "engines": {
        "node": ">=18"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/express"
      }
    },
    "node_modules/serve-static": {
      "version": "2.2.1",
      "resolved": "https://registry.npmjs.org/serve-static/-/serve-static-2.2.1.tgz",
      "integrity": "sha512-xRXBn0pPqQTVQiC8wyQrKs2MOlX24zQ0POGaj0kultvoOCstBQM5yvOhAVSUwOMjQtTvsPWoNCHfPGwaaQJhTw==",
      "license": "MIT",
      "dependencies": {
        "encodeurl": "^2.0.0",
        "escape-html": "^1.0.3",
        "parseurl": "^1.3.3",
        "send": "^1.2.0"
      },
      "engines": {
        "node": ">= 18"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/express"
      }
    },
    "node_modules/setprototypeof": {
      "version": "1.2.0",
      "resolved": "https://registry.npmjs.org/setprototypeof/-/setprototypeof-1.2.0.tgz",
      "integrity": "sha512-E5LDX7Wrp85Kil5bhZv46j8jOeboKq5JMmYM3gVGdGH8xFpPWXUMsNrlODCrkoxMEeNi/XZIwuRvY4XNwYMJpw==",
      "license": "ISC"
    },
    "node_modules/shimmer": {
      "version": "1.2.1",
      "resolved": "https://registry.npmjs.org/shimmer/-/shimmer-1.2.1.tgz",
      "integrity": "sha512-sQTKC1Re/rM6XyFM6fIAGHRPVGvyXfgzIDvzoq608vM+jeyVD0Tu1E6Np0Kc2zAIFWIj963V2800iF/9LPieQw==",
      "license": "BSD-2-Clause"
    },
    "node_modules/side-channel": {
      "version": "1.1.1",
      "resolved": "https://registry.npmjs.org/side-channel/-/side-channel-1.1.1.tgz",
      "integrity": "sha512-6x6dK6zJdpTzF4sQeNYxwtvBzf6Eg4GtlesS94HOvTudUeyK2WXAaIfmDgsyslYrRBeFIlsi54AYsFGUuhmvrQ==",
      "license": "MIT",
      "dependencies": {
        "es-errors": "^1.3.0",
        "object-inspect": "^1.13.4",
        "side-channel-list": "^1.0.1",
        "side-channel-map": "^1.0.1",
        "side-channel-weakmap": "^1.0.2"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/side-channel-list": {
      "version": "1.0.1",
      "resolved": "https://registry.npmjs.org/side-channel-list/-/side-channel-list-1.0.1.tgz",
      "integrity": "sha512-mjn/0bi/oUURjc5Xl7IaWi/OJJJumuoJFQJfDDyO46+hBWsfaVM65TBHq2eoZBhzl9EchxOijpkbRC8SVBQU0w==",
      "license": "MIT",
      "dependencies": {
        "es-errors": "^1.3.0",
        "object-inspect": "^1.13.4"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/side-channel-map": {
      "version": "1.0.1",
      "resolved": "https://registry.npmjs.org/side-channel-map/-/side-channel-map-1.0.1.tgz",
      "integrity": "sha512-VCjCNfgMsby3tTdo02nbjtM/ewra6jPHmpThenkTYh8pG9ucZ/1P8So4u4FGBek/BjpOVsDCMoLA/iuBKIFXRA==",
      "license": "MIT",
      "dependencies": {
        "call-bound": "^1.0.2",
        "es-errors": "^1.3.0",
        "get-intrinsic": "^1.2.5",
        "object-inspect": "^1.13.3"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/side-channel-weakmap": {
      "version": "1.0.2",
      "resolved": "https://registry.npmjs.org/side-channel-weakmap/-/side-channel-weakmap-1.0.2.tgz",
      "integrity": "sha512-WPS/HvHQTYnHisLo9McqBHOJk2FkHO/tlpvldyrnem4aeQp4hai3gythswg6p01oSoTl58rcpiFAjF2br2Ak2A==",
      "license": "MIT",
      "dependencies": {
        "call-bound": "^1.0.2",
        "es-errors": "^1.3.0",
        "get-intrinsic": "^1.2.5",
        "object-inspect": "^1.13.3",
        "side-channel-map": "^1.0.1"
      },
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/simple-wcswidth": {
      "version": "1.1.2",
      "resolved": "https://registry.npmjs.org/simple-wcswidth/-/simple-wcswidth-1.1.2.tgz",
      "integrity": "sha512-j7piyCjAeTDSjzTSQ7DokZtMNwNlEAyxqSZeCS+CXH7fJ4jx3FuJ/mTW3mE+6JLs4VJBbcll0Kjn+KXI5t21Iw==",
      "license": "MIT"
    },
    "node_modules/statuses": {
      "version": "2.0.2",
      "resolved": "https://registry.npmjs.org/statuses/-/statuses-2.0.2.tgz",
      "integrity": "sha512-DvEy55V3DB7uknRo+4iOGT5fP1slR8wQohVdknigZPMpMstaKJQWhwiYBACJE3Ul2pTnATihhBYnRhZQHGBiRw==",
      "license": "MIT",
      "engines": {
        "node": ">= 0.8"
      }
    },
    "node_modules/string-width": {
      "version": "4.2.3",
      "resolved": "https://registry.npmjs.org/string-width/-/string-width-4.2.3.tgz",
      "integrity": "sha512-wKyQRQpjJ0sIp62ErSZdGsjMJWsap5oRNihHhu6G7JVO/9jIB6UyevL+tXuOqrng8j/cxKTWyWUwvSTriiZz/g==",
      "license": "MIT",
      "dependencies": {
        "emoji-regex": "^8.0.0",
        "is-fullwidth-code-point": "^3.0.0",
        "strip-ansi": "^6.0.1"
      },
      "engines": {
        "node": ">=8"
      }
    },
    "node_modules/strip-ansi": {
      "version": "6.0.1",
      "resolved": "https://registry.npmjs.org/strip-ansi/-/strip-ansi-6.0.1.tgz",
      "integrity": "sha512-Y38VPSHcqkFrCpFnQ9vuSXmquuv5oXOKpGeT6aGrr3o3Gc9AlVa6JBfUSOCnbxGGZF+/0ooI7KrPuUSztUdU5A==",
      "license": "MIT",
      "dependencies": {
        "ansi-regex": "^5.0.1"
      },
      "engines": {
        "node": ">=8"
      }
    },
    "node_modules/supports-color": {
      "version": "7.2.0",
      "resolved": "https://registry.npmjs.org/supports-color/-/supports-color-7.2.0.tgz",
      "integrity": "sha512-qpCAvRl9stuOHveKsn7HncJRvv501qIacKzQlO/+Lwxc9+0q2wLyv4Dfvt80/DPn2pqOBsJdDiogXGR9+OvwRw==",
      "license": "MIT",
      "dependencies": {
        "has-flag": "^4.0.0"
      },
      "engines": {
        "node": ">=8"
      }
    },
    "node_modules/supports-preserve-symlinks-flag": {
      "version": "1.0.0",
      "resolved": "https://registry.npmjs.org/supports-preserve-symlinks-flag/-/supports-preserve-symlinks-flag-1.0.0.tgz",
      "integrity": "sha512-ot0WnXS9fgdkgIcePe6RHNk1WA8+muPa6cSjeR3V8K27q9BB1rTE3R1p7Hv0z1ZyAc8s6Vvv8DIyWf681MAt0w==",
      "license": "MIT",
      "engines": {
        "node": ">= 0.4"
      },
      "funding": {
        "url": "https://github.com/sponsors/ljharb"
      }
    },
    "node_modules/toidentifier": {
      "version": "1.0.1",
      "resolved": "https://registry.npmjs.org/toidentifier/-/toidentifier-1.0.1.tgz",
      "integrity": "sha512-o5sSPKEkg/DIQNmH43V0/uerLrpzVedkUh8tGNvaeXpfpuwjKenlSox/2O/BTlZUtEe+JG7s5YhEz608PlAHRA==",
      "license": "MIT",
      "engines": {
        "node": ">=0.6"
      }
    },
    "node_modules/tr46": {
      "version": "0.0.3",
      "resolved": "https://registry.npmjs.org/tr46/-/tr46-0.0.3.tgz",
      "integrity": "sha512-N3WMsuqV66lT30CrXNbEjx4GEwlow3v6rr4mCcv6prnfwhS01rkgyFdjPNBYd9br7LpXV1+Emh01fHnq2Gdgrw==",
      "license": "MIT"
    },
    "node_modules/type-is": {
      "version": "2.1.0",
      "resolved": "https://registry.npmjs.org/type-is/-/type-is-2.1.0.tgz",
      "integrity": "sha512-faYHw0anBbc/kWF3zFTEnxSFOAGUX9GFbOBthvDdLsIlEoWOFOtS0zgCiQYwIskL9iGXZL3kAXD8OoZ4GmMATA==",
      "license": "MIT",
      "dependencies": {
        "content-type": "^2.0.0",
        "media-typer": "^1.1.0",
        "mime-types": "^3.0.0"
      },
      "engines": {
        "node": ">= 18"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/express"
      }
    },
    "node_modules/type-is/node_modules/content-type": {
      "version": "2.1.0",
      "resolved": "https://registry.npmjs.org/content-type/-/content-type-2.1.0.tgz",
      "integrity": "sha512-mj7UPXE0jaqaOsukNZRUEfEi2AcL7C/vwmwcHV0O97eO1E1pxBZuyjlZrx5seTaNBg1U6+o35wpa35Qfcc+7ag==",
      "license": "MIT",
      "engines": {
        "node": ">=18"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/express"
      }
    },
    "node_modules/type-is/node_modules/mime-db": {
      "version": "1.54.0",
      "resolved": "https://registry.npmjs.org/mime-db/-/mime-db-1.54.0.tgz",
      "integrity": "sha512-aU5EJuIN2WDemCcAp2vFBfp/m4EAhWJnUNSSw0ixs7/kXbd6Pg64EmwJkNdFhB8aWt1sH2CTXrLxo/iAGV3oPQ==",
      "license": "MIT",
      "engines": {
        "node": ">= 0.6"
      }
    },
    "node_modules/type-is/node_modules/mime-types": {
      "version": "3.0.2",
      "resolved": "https://registry.npmjs.org/mime-types/-/mime-types-3.0.2.tgz",
      "integrity": "sha512-Lbgzdk0h4juoQ9fCKXW4by0UJqj+nOOrI9MJ1sSj4nI8aI2eo1qmvQEie4VD1glsS250n15LsWsYtCugiStS5A==",
      "license": "MIT",
      "dependencies": {
        "mime-db": "^1.54.0"
      },
      "engines": {
        "node": ">=18"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/express"
      }
    },
    "node_modules/undici-types": {
      "version": "5.26.5",
      "resolved": "https://registry.npmjs.org/undici-types/-/undici-types-5.26.5.tgz",
      "integrity": "sha512-JlCMO+ehdEIKqlFxk6IfVoAUVmgz7cU7zD/h9XZ0qzeosSHmUJVOzSQvvYSYWXkFXC+IfLKSIffhv0sVZup6pA==",
      "license": "MIT"
    },
    "node_modules/unpipe": {
      "version": "1.0.0",
      "resolved": "https://registry.npmjs.org/unpipe/-/unpipe-1.0.0.tgz",
      "integrity": "sha512-pjy2bYhSsufwWlKwPc+l3cN7+wuJlK6uz0YdJEOlQDbl6jo/YlPi4mb8agUkVC8BF7V8NuzeyPNqRksA3hztKQ==",
      "license": "MIT",
      "engines": {
        "node": ">= 0.8"
      }
    },
    "node_modules/uuid": {
      "version": "10.0.0",
      "resolved": "https://registry.npmjs.org/uuid/-/uuid-10.0.0.tgz",
      "integrity": "sha512-8XkAphELsDnEGrDxUOHB3RGvXz6TeuYSGEZBOjtTtPm2lwhGBjLgOzLHB63IUWfBpNucQjND6d3AOudO+H3RWQ==",
      "deprecated": "uuid@10 and below is no longer supported.  For ESM codebases, update to uuid@latest.  For CommonJS codebases, use uuid@11 (but be aware this version will likely be deprecated in 2028).",
      "funding": [
        "https://github.com/sponsors/broofa",
        "https://github.com/sponsors/ctavan"
      ],
      "license": "MIT",
      "bin": {
        "uuid": "dist/bin/uuid"
      }
    },
    "node_modules/vary": {
      "version": "1.1.2",
      "resolved": "https://registry.npmjs.org/vary/-/vary-1.1.2.tgz",
      "integrity": "sha512-BNGbWLfd0eUPabhkXUVm0j8uuvREyTh5ovRa/dyow/BqAbZJyC+5fU+IzQOzmAKzYqYRAISoRhdQr3eIZ/PXqg==",
      "license": "MIT",
      "engines": {
        "node": ">= 0.8"
      }
    },
    "node_modules/web-streams-polyfill": {
      "version": "4.0.0-beta.3",
      "resolved": "https://registry.npmjs.org/web-streams-polyfill/-/web-streams-polyfill-4.0.0-beta.3.tgz",
      "integrity": "sha512-QW95TCTaHmsYfHDybGMwO5IJIM93I/6vTRk+daHTWFPhwh+C8Cg7j7XyKrwrj8Ib6vYXe0ocYNrmzY4xAAN6ug==",
      "license": "MIT",
      "engines": {
        "node": ">= 14"
      }
    },
    "node_modules/webidl-conversions": {
      "version": "3.0.1",
      "resolved": "https://registry.npmjs.org/webidl-conversions/-/webidl-conversions-3.0.1.tgz",
      "integrity": "sha512-2JAn3z8AR6rjK8Sm8orRC0h/bcl/DqL7tRPdGZ4I1CjdF+EaMLmYxBHyXuKL849eucPFhvBoxMsflfOb8kxaeQ==",
      "license": "BSD-2-Clause"
    },
    "node_modules/whatwg-url": {
      "version": "5.0.0",
      "resolved": "https://registry.npmjs.org/whatwg-url/-/whatwg-url-5.0.0.tgz",
      "integrity": "sha512-saE57nupxk6v3HY35+jzBwYa0rKSy0XR8JSxZPwgLr7ys0IBzhGviA1/TUGJLmSVqs8pb9AnvICXEuOHLprYTw==",
      "license": "MIT",
      "dependencies": {
        "tr46": "~0.0.3",
        "webidl-conversions": "^3.0.0"
      }
    },
    "node_modules/wrap-ansi": {
      "version": "7.0.0",
      "resolved": "https://registry.npmjs.org/wrap-ansi/-/wrap-ansi-7.0.0.tgz",
      "integrity": "sha512-YVGIj2kamLSTxw6NsZjoBxfSwsn0ycdesmc4p+Q21c5zPuZ1pl+NfxVdxPtdHvmNVOQ6XSYG4AUtyt/Fi7D16Q==",
      "license": "MIT",
      "dependencies": {
        "ansi-styles": "^4.0.0",
        "string-width": "^4.1.0",
        "strip-ansi": "^6.0.0"
      },
      "engines": {
        "node": ">=10"
      },
      "funding": {
        "url": "https://github.com/chalk/wrap-ansi?sponsor=1"
      }
    },
    "node_modules/wrap-ansi/node_modules/ansi-styles": {
      "version": "4.3.0",
      "resolved": "https://registry.npmjs.org/ansi-styles/-/ansi-styles-4.3.0.tgz",
      "integrity": "sha512-zbB9rCJAT1rbjiVDb2hqKFHNYLxgtk8NURxZ3IZwD3F6NtxbXZQCnnSi1Lkx+IDohdPlFp222wVALIheZJQSEg==",
      "license": "MIT",
      "dependencies": {
        "color-convert": "^2.0.1"
      },
      "engines": {
        "node": ">=8"
      },
      "funding": {
        "url": "https://github.com/chalk/ansi-styles?sponsor=1"
      }
    },
    "node_modules/wrappy": {
      "version": "1.0.2",
      "resolved": "https://registry.npmjs.org/wrappy/-/wrappy-1.0.2.tgz",
      "integrity": "sha512-l4Sp/DRseor9wL6EvV2+TuQn63dMkPjZ/sp9XkghTEbV9KlPS1xUsZ3u7/IQO4wxtcFB4bgpQPRcR3QCvezPcQ==",
      "license": "ISC"
    },
    "node_modules/y18n": {
      "version": "5.0.8",
      "resolved": "https://registry.npmjs.org/y18n/-/y18n-5.0.8.tgz",
      "integrity": "sha512-0pfFzegeDWJHJIAmTLRP2DwHjdF5s7jo9tuztdQxAhINCdvS+3nGINqPd00AphqJR/0LhANUS6/+7SCb98YOfA==",
      "license": "ISC",
      "engines": {
        "node": ">=10"
      }
    },
    "node_modules/yargs": {
      "version": "17.7.3",
      "resolved": "https://registry.npmjs.org/yargs/-/yargs-17.7.3.tgz",
      "integrity": "sha512-GZtjxm/J/4TSxuL3FNYjCmLktBTnIw/rVmKSIyKeYAZpmJB2ig9VauCC5xsa82GNKVKDAqpOn3KVzNt0zmrU0g==",
      "license": "MIT",
      "dependencies": {
        "cliui": "^8.0.1",
        "escalade": "^3.1.1",
        "get-caller-file": "^2.0.5",
        "require-directory": "^2.1.1",
        "string-width": "^4.2.3",
        "y18n": "^5.0.5",
        "yargs-parser": "^21.1.1"
      },
      "engines": {
        "node": ">=12"
      }
    },
    "node_modules/yargs-parser": {
      "version": "21.1.1",
      "resolved": "https://registry.npmjs.org/yargs-parser/-/yargs-parser-21.1.1.tgz",
      "integrity": "sha512-tVpsJW7DdjecAiFpbIB1e3qxIQsE6NoPc5/eTdrbbIC4h0LVsWhnoa3g+m2HclBIujHzsxZ4VJVA+GUuc2/LBw==",
      "license": "ISC",
      "engines": {
        "node": ">=12"
      }
    },
    "node_modules/zod": {
      "version": "3.25.76",
      "resolved": "https://registry.npmjs.org/zod/-/zod-3.25.76.tgz",
      "integrity": "sha512-gzUt/qt81nXsFGKIFcC3YnfEAx5NkunCfnDlvuBSSFS02bcXu4Lmea0AFIUwbLWxWPx3d9p8S5QoaujKcNQxcQ==",
      "license": "MIT",
      "funding": {
        "url": "https://github.com/sponsors/colinhacks"
      }
    },
    "node_modules/zod-to-json-schema": {
      "version": "3.25.2",
      "resolved": "https://registry.npmjs.org/zod-to-json-schema/-/zod-to-json-schema-3.25.2.tgz",
      "integrity": "sha512-O/PgfnpT1xKSDeQYSCfRI5Gy3hPf91mKVDuYLUHZJMiDFptvP41MSnWofm8dnCm0256ZNfZIM7DSzuSMAFnjHA==",
      "license": "ISC",
      "peerDependencies": {
        "zod": "^3.25.28 || ^4"
      }
    }
  }
}
```

## ./demo-app/ai-poc-node/parallel-agents.js
```
/**
 * POC — Appels d'agents en PARALLÈLE (fan-out / fan-in).
 * Le Supervisor délègue SIMULTANÉMENT à deux sous-agents indépendants,
 * puis attend que LES DEUX aient terminé avant de synthétiser.
 *
 * Teste si le tracing reste cohérent (une seule trace) quand des agents
 * s'exécutent en parallèle plutôt que séquentiellement.
 *
 * Usage :
 *   export LITELLM_KEY="..."
 *   export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4317"
 *   node parallel-agents.js
 */

const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");
const { BatchSpanProcessor } = require("@opentelemetry/sdk-trace-base");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-grpc");
const { Resource } = require("@opentelemetry/resources");
const { SemanticResourceAttributes } = require("@opentelemetry/semantic-conventions");
const { diag, DiagConsoleLogger, DiagLogLevel } = require("@opentelemetry/api");
const { LangChainInstrumentation } = require("@arizeai/openinference-instrumentation-langchain");
const CallbackManagerModule = require("@langchain/core/callbacks/manager");

const { StateGraph, END, Annotation, START } = require("@langchain/langgraph");
const { ChatOpenAI } = require("@langchain/openai");
const { HumanMessage, SystemMessage } = require("@langchain/core/messages");

diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

function setupTracing() {
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4317";
  const serviceName = process.env.OTEL_SERVICE_NAME || "aizo-poc-parallel-agents";

  const provider = new NodeTracerProvider({
    resource: new Resource({ [SemanticResourceAttributes.SERVICE_NAME]: serviceName }),
  });

  const exporter = new OTLPTraceExporter({ url: otlpEndpoint });
  provider.addSpanProcessor(new BatchSpanProcessor(exporter));
  provider.register();

  const lcInstrumentation = new LangChainInstrumentation();
  lcInstrumentation.manuallyInstrument(CallbackManagerModule);

  return provider;
}

const MOCK_MODE = !process.env.LITELLM_KEY;

function getLlm(agentName) {
  if (MOCK_MODE) {
    const { FakeListChatModel } = require("@langchain/core/utils/testing");
    return new FakeListChatModel({
      responses: [`[${agentName}] Réponse simulée (test parallèle).`],
    });
  }
  return new ChatOpenAI({
    modelName: "qwen3.6-35b",
    openAIApiKey: process.env.LITELLM_KEY,
    configuration: { baseURL: "https://litellm.itransform365.com" },
    temperature: 0,
  });
}

// --- État partagé - deux résultats distincts remplis en parallèle ---
const GraphState = Annotation.Root({
  query: Annotation({ reducer: (_, u) => u, default: () => "" }),
  researchResult: Annotation({ reducer: (_, u) => u, default: () => null }),
  translationResult: Annotation({ reducer: (_, u) => u, default: () => null }),
  finalAnswer: Annotation({ reducer: (_, u) => u, default: () => null }),
});

function supervisorRouterNode(state) {
  console.log("[Supervisor] Délégation SIMULTANÉE vers Research Agent + Translation Agent");
  return {};
}

// --- Agent A : recherche factuelle (branche parallèle 1) ---
async function researchAgentNode(state) {
  const startedAt = Date.now();
  console.log("[Research Agent] Démarrage...");
  const llm = getLlm("ResearchAgent");
  const response = await llm.invoke([
    new SystemMessage("Réponds en 2 phrases factuelles maximum, en français."),
    new HumanMessage(state.query),
  ]);
  console.log(`[Research Agent] Terminé en ${Date.now() - startedAt}ms`);
  return { researchResult: response.content };
}

// --- Agent B : traduction/reformulation (branche parallèle 2, indépendante de A) ---
async function translationAgentNode(state) {
  const startedAt = Date.now();
  console.log("[Translation Agent] Démarrage...");
  const llm = getLlm("TranslationAgent");
  const response = await llm.invoke([
    new SystemMessage("Traduis cette question en anglais, rien d'autre."),
    new HumanMessage(state.query),
  ]);
  console.log(`[Translation Agent] Terminé en ${Date.now() - startedAt}ms`);
  return { translationResult: response.content };
}

// --- Supervisor : ne s'exécute qu'après que LES DEUX branches sont terminées ---
async function supervisorJoinNode(state) {
  console.log("[Supervisor] Les deux agents ont terminé - synthèse en cours");
  const llm = getLlm("Supervisor");
  const response = await llm.invoke([
    new SystemMessage("Combine ces deux résultats en une réponse claire pour l'utilisateur."),
    new HumanMessage(
      `Résultat recherche: ${state.researchResult}\n` +
      `Traduction de la question: ${state.translationResult}`
    ),
  ]);
  return { finalAnswer: response.content };
}

function buildGraph() {
  const graph = new StateGraph(GraphState)
    .addNode("supervisor_router", supervisorRouterNode)
    .addNode("research_agent", researchAgentNode)
    .addNode("translation_agent", translationAgentNode)
    .addNode("supervisor_join", supervisorJoinNode)
    .addEdge(START, "supervisor_router")
    // Fan-out : le router envoie vers LES DEUX agents en même temps
    .addEdge("supervisor_router", "research_agent")
    .addEdge("supervisor_router", "translation_agent")
    // Fan-in : supervisor_join attend que LES DEUX branches soient terminées
    // (comportement natif de LangGraph : un nœud avec plusieurs prédécesseurs
    // n'est déclenché qu'une fois que tous ses prédécesseurs du même "superstep"
    // ont fini - pas besoin de logique de synchronisation manuelle)
    .addEdge("research_agent", "supervisor_join")
    .addEdge("translation_agent", "supervisor_join")
    .addEdge("supervisor_join", END);

  return graph.compile();
}

const { trace } = require("@opentelemetry/api");

async function main() {
  const tracerProvider = setupTracing();
  const app = buildGraph();
  const tracer = trace.getTracer("aizo-poc-parallel-agents-runner");

  console.log("=== Test agents en PARALLÈLE : Research + Translation simultanés ===\n");

  let result;
  let capturedTraceId;

  await tracer.startActiveSpan("main-invocation", async (span) => {
    capturedTraceId = span.spanContext().traceId;
    console.log(`[Trace ID] ${capturedTraceId}\n`);

    const globalStart = Date.now();
    result = await app.invoke({
      query: "Qu'est-ce que le tracing distribué en observabilité ?",
    });
    const totalTime = Date.now() - globalStart;

    console.log(`\n--- Réponse finale (temps total: ${totalTime}ms) ---`);
    console.log(result.finalAnswer);

    span.end();
  });

  console.log("\n=== Vérification à faire dans Grafana ===");
  console.log(`Cherche directement par Trace ID : ${capturedTraceId}`);
  console.log("(TraceQL -> tape juste l'ID, sans accolades)");
  console.log("Question clé 1 : research_agent et translation_agent apparaissent-ils");
  console.log("comme DEUX SPANS QUI SE CHEVAUCHENT DANS LE TEMPS (parallèles), ou l'un après l'autre ?");
  console.log("Question clé 2 : le temps total est-il proche du PLUS LONG des deux appels");
  console.log("(vrai parallélisme) ou de la SOMME des deux (exécution séquentielle déguisée) ?");

  await tracerProvider.forceFlush();
  await new Promise((resolve) => setTimeout(resolve, 3000));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

## ./demo-app/ai-poc-node/README.md
```
# POC — LangGraph.js + OpenTelemetry (Node.js)

Équivalent Node.js du POC Python — même graphe (Router → Chatbot ⇄ Tool → End),
même pipeline d'observabilité (OpenInference → Collector → Tempo), pour
correspondre à la stack réelle de l'équipe (Node.js, pas Python).

## Setup

```bash
npm install
```

## Variables d'environnement nécessaires

```bash
export LITELLM_KEY="..."          # clé fournie par le tutor (gateway LiteLLM)
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4317"
export OTEL_SERVICE_NAME="aizo-poc-langgraph-js"
```

## Prérequis côté cluster

Port-forward vers le Collector actif :
```bash
kubectl port-forward -n observability svc/otel-collector-opentelemetry-collector 4317:4317
```

## Lancer le POC

```bash
node app.js
```

Ou sans clé (mode mock, pour valider juste le pipeline de tracing) :
```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4317"
node app.js
```

## Vérifier le résultat

Grafana → Explore → Tempo → Service Name = `aizo-poc-langgraph-js`

## Différence clé avec la version Python

En Python, l'instrumentation OpenInference est **automatique** (`LangChainInstrumentor().instrument()`).

En **Node.js, elle doit être activée manuellement** sur le module de callbacks :
```js
lcInstrumentation.manuallyInstrument(CallbackManagerModule);
```
C'est nécessaire à cause de la structure non conventionnelle du chargement des
callbacks dans `@langchain/core` — documenté officiellement par OpenInference.
En dehors de ce détail, le comportement (spans capturés, attributs `llm.*`,
tokens, tool calls) est identique à la version Python.

## Prochaine étape une fois validé

- Ajouter un attribut `task_type` explicite sur les spans
- Vérifier que les mêmes attributs (`llm.model_name`, `llm.token_count.*`,
  `llm.output_messages.*.tool_calls`) apparaissent bien dans Tempo, comme en Python
```

## ./demo-app/ai-poc-node/three-agent-chain.js
```
/**
 * POC — Chaîne de 3 agents (Supervisor -> Research Sub-agent -> Validation Sub-agent -> Supervisor).
 * Variante plus complexe du test agent-à-agent : vérifie que le tracing reste
 * UNE SEULE TRACE CONTINUE même avec plusieurs sauts successifs entre agents,
 * pas juste un aller-retour simple.
 *
 * Usage :
 *   export LITELLM_KEY="..."
 *   export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4317"
 *   node three-agent-chain.js
 */

const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");
const { BatchSpanProcessor } = require("@opentelemetry/sdk-trace-base");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-grpc");
const { Resource } = require("@opentelemetry/resources");
const { SemanticResourceAttributes } = require("@opentelemetry/semantic-conventions");
const { diag, DiagConsoleLogger, DiagLogLevel } = require("@opentelemetry/api");
const { LangChainInstrumentation } = require("@arizeai/openinference-instrumentation-langchain");
const CallbackManagerModule = require("@langchain/core/callbacks/manager");

const { StateGraph, END, Annotation } = require("@langchain/langgraph");
const { ChatOpenAI } = require("@langchain/openai");
const { HumanMessage, SystemMessage, AIMessage } = require("@langchain/core/messages");

diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR); // WARN/ERROR seulement cette fois - moins verbeux

function setupTracing() {
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4317";
  const serviceName = process.env.OTEL_SERVICE_NAME || "aizo-poc-three-agent-chain";

  const provider = new NodeTracerProvider({
    resource: new Resource({ [SemanticResourceAttributes.SERVICE_NAME]: serviceName }),
  });

  const exporter = new OTLPTraceExporter({ url: otlpEndpoint });
  provider.addSpanProcessor(new BatchSpanProcessor(exporter));
  provider.register();

  const lcInstrumentation = new LangChainInstrumentation();
  lcInstrumentation.manuallyInstrument(CallbackManagerModule);

  return provider;
}

const MOCK_MODE = !process.env.LITELLM_KEY;

function getLlm(agentName) {
  if (MOCK_MODE) {
    const { FakeListChatModel } = require("@langchain/core/utils/testing");
    return new FakeListChatModel({
      responses: [`[${agentName}] Réponse simulée pour tester la chaîne de tracing.`],
    });
  }
  return new ChatOpenAI({
    modelName: "qwen3.6-35b",
    openAIApiKey: process.env.LITELLM_KEY,
    configuration: { baseURL: "https://litellm.itransform365.com" },
    temperature: 0,
  });
}

// --- État partagé entre les 3 agents ---
const GraphState = Annotation.Root({
  messages: Annotation({
    reducer: (existing, update) => existing.concat(update),
    default: () => [],
  }),
  researchResult: Annotation({ reducer: (_, u) => u, default: () => null }),
  validationResult: Annotation({ reducer: (_, u) => u, default: () => null }),
});

// --- Agent 1 : Supervisor (routeur, ne fait qu'orchestrer) ---
function supervisorRouterNode(state) {
  console.log("[1. Supervisor] Réception de la requête, délégation vers le Research Agent");
  return {};
}

// --- Agent 2 : Research Sub-agent (premier maillon de la chaîne) ---
async function researchAgentNode(state) {
  console.log("[2. Research Agent] Recherche d'informations en cours...");
  const llm = getLlm("ResearchAgent");
  const userQuery = state.messages[0].content;

  const response = await llm.invoke([
    new SystemMessage(
      "Tu es un agent de recherche. Trouve des informations factuelles et " +
      "concises sur le sujet demandé, en 2 phrases maximum."
    ),
    new HumanMessage(userQuery),
  ]);

  return { researchResult: response.content };
}

// --- Agent 3 : Validation Sub-agent (deuxième maillon, reçoit le résultat de l'Agent 2) ---
async function validationAgentNode(state) {
  console.log("[3. Validation Agent] Vérification et enrichissement du résultat de recherche...");
  const llm = getLlm("ValidationAgent");

  const response = await llm.invoke([
    new SystemMessage(
      "Tu es un agent de validation. Vérifie la cohérence de l'information " +
      "fournie et ajoute une précision technique complémentaire, en 1-2 phrases."
    ),
    new HumanMessage(`Information à valider: ${state.researchResult}`),
  ]);

  return { validationResult: response.content };
}

// --- Retour à l'Agent 1 : Supervisor (synthèse finale) ---
async function supervisorSynthesizeNode(state) {
  console.log("[4. Supervisor] Synthèse finale à partir des résultats des 2 sous-agents");
  const llm = getLlm("Supervisor");

  const response = await llm.invoke([
    new SystemMessage(
      "Tu es le superviseur. Combine la recherche et la validation ci-dessous " +
      "en une réponse finale claire pour l'utilisateur."
    ),
    new HumanMessage(
      `Recherche: ${state.researchResult}\nValidation: ${state.validationResult}`
    ),
  ]);

  return { messages: [response] };
}

function buildGraph() {
  const graph = new StateGraph(GraphState)
    .addNode("supervisor_router", supervisorRouterNode)
    .addNode("research_agent", researchAgentNode)
    .addNode("validation_agent", validationAgentNode)
    .addNode("supervisor_synthesize", supervisorSynthesizeNode)
    .setEntryPoint("supervisor_router")
    .addEdge("supervisor_router", "research_agent")
    .addEdge("research_agent", "validation_agent")
    .addEdge("validation_agent", "supervisor_synthesize")
    .addEdge("supervisor_synthesize", END);

  return graph.compile();
}

async function main() {
  const tracerProvider = setupTracing();
  const app = buildGraph();

  console.log("=== Test chaîne de 3 agents : Supervisor -> Research -> Validation -> Supervisor ===\n");

  const result = await app.invoke({
    messages: [new HumanMessage("Explique ce qu'est le tracing distribué en observabilité")],
    researchResult: null,
    validationResult: null,
  });

  console.log("\n--- Réponse finale (après passage dans les 3 agents) ---");
  console.log(result.messages[result.messages.length - 1].content);

  console.log("\n=== Vérification à faire dans Grafana ===");
  console.log("Explore -> Tempo -> service.name = " + (process.env.OTEL_SERVICE_NAME || "aizo-poc-three-agent-chain"));
  console.log("Question clé : les 4 étapes (router, research, validation, synthesize)");
  console.log("apparaissent-elles TOUTES dans UNE SEULE trace, même avec 2 sauts d'agent à agent ?");

  await tracerProvider.forceFlush();
  await new Promise((resolve) => setTimeout(resolve, 3000));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

## ./demo-app/ai-poc/README.md
```
# POC — LangGraph + OpenTelemetry

Petit graphe LangGraph (Router → Chatbot ⇄ Tool → End) instrumenté avec
OpenTelemetry via OpenInference, pour valider l'approche d'observabilité
avant de toucher au vrai backend AIZO Adviser.

## Setup

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt --break-system-packages
```

## Variables d'environnement nécessaires

```bash
export OPENAI_API_KEY="sk-..."          # clé fournie par Haykel (ou provider équivalent)
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4317"
export OTEL_SERVICE_NAME="aizo-poc-langgraph"
```

## Prérequis côté cluster

Le Collector OpenTelemetry doit être accessible en local via port-forward
(déjà fait si tu utilises `scripts/start-port-forwards-tmux.sh`) :

```bash
kubectl port-forward -n observability svc/otel-collector-opentelemetry-collector 4317:4317
```

## Lancer le POC

```bash
python app.py
```

## Vérifier le résultat

1. **Traces** : Grafana → Explore → Tempo → Service Name = `aizo-poc-langgraph`
   → tu dois voir une trace avec plusieurs spans imbriqués (Router → Chatbot → Tool → Chatbot)

2. **Structure attendue** : chaque nœud du graphe LangGraph doit apparaître
   comme un span distinct, avec les appels LLM sous-jacents visibles en détail
   (modèle utilisé, tokens, latence) — grâce à l'auto-instrumentation OpenInference.

## Note sur le choix de librairie

**OpenInference** (par Arize) a été choisi plutôt que l'intégration OTel
native de LangSmith, car :
- Vendor-neutral — n'importe quel backend OTel peut recevoir les traces
  (pas besoin du SDK/plateforme LangSmith)
- Auto-instrumentation — aucune modification du code du graphe nécessaire
  pour obtenir les spans, juste `LangChainInstrumentor().instrument()`
- Cohérent avec l'approche déjà utilisée en Phase 1 (auto-instrumentation
  OpenTelemetry pour Flask, même principe ici pour LangChain)

## Prochaine étape une fois validé

- Ajouter un attribut `task_type` explicite sur chaque span (via
  `trace.get_current_span().set_attribute(...)`) pour pouvoir filtrer
  les métriques par type de tâche dans Grafana
- Tester avec un vrai LiteLLM proxy en amont plutôt qu'un appel direct
  à `ChatOpenAI`, pour valider le routing multi-provider
```

## ./demo-app/ai-poc/requirements.txt
```
langgraph>=0.2.0
langchain>=0.3.0
langchain-openai>=0.2.0
langchain-core>=0.3.0

opentelemetry-api>=1.27.0
opentelemetry-sdk>=1.27.0
opentelemetry-exporter-otlp-proto-grpc>=1.27.0

openinference-instrumentation-langchain>=0.1.29
```

## ./demo-app/api/=
```
```

## ./demo-app/api/app.py
```
import time
import random
import logging
import json
import pyroscope
from flask import Flask, jsonify
from opentelemetry import trace

pyroscope.configure(
    application_name="demo-api",
    server_address="http://pyroscope.observability.svc.cluster.local:4040",
)

app = Flask(__name__)

class JSONFormatter(logging.Formatter):
    def format(self, record):
        span = trace.get_current_span()
        ctx = span.get_span_context()
        trace_id = format(ctx.trace_id, "032x") if ctx.is_valid else None
        log_entry = {
            "timestamp": self.formatTime(record),
            "level": record.levelname,
            "message": record.getMessage(),
            "trace_id": trace_id,
        }
        return json.dumps(log_entry)

logger = logging.getLogger("demo-api")
handler = logging.StreamHandler()
handler.setFormatter(JSONFormatter())
logger.addHandler(handler)
logger.setLevel(logging.INFO)
logging.getLogger("werkzeug").disabled = True

@app.route("/work")
def work():
    with pyroscope.tag_wrapper({"endpoint": "work"}):
        duration = random.uniform(0.05, 0.4)
        time.sleep(duration)

        if random.random() < 0.1:
            logger.info(f"request failed after {round(duration*1000)}ms")
            return jsonify({"error": "something went wrong"}), 500

        logger.info(f"request succeeded after {round(duration*1000)}ms")
        return jsonify({"status": "ok", "duration_ms": round(duration * 1000)})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8081)
```

## ./demo-app/api/CACHED
```
```

## ./demo-app/api/Dockerfile
```
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir setuptools==75.1.0 && \
    pip install --no-cache-dir -r requirements.txt && \
    opentelemetry-bootstrap -a install

COPY app.py .

EXPOSE 8081

CMD ["opentelemetry-instrument", "python", "app.py"]
```

## ./demo-app/api/exporting
```
```

## ./demo-app/api/[internal]
```
```

## ./demo-app/api/naming
```
```

## ./demo-app/api/requirements.txt
```
flask==3.0.3
opentelemetry-distro==0.48b0
opentelemetry-exporter-otlp==1.27.0
pyroscope-io==0.8.11
```

## ./demo-app/api/resolve
```
```

## ./demo-app/api/transferring
```
```

## ./demo-app/api/unpacking
```
```

## ./demo-app/dashboards/ai-agents-dashboard-configmap.yaml
```
apiVersion: v1
data:
  ai-agents-dashboard.json: |
    {
      "annotations": {
        "list": []
      },
      "editable": true,
      "fiscalYearStartMonth": 0,
      "graphTooltip": 0,
      "links": [],
      "liveNow": false,
      "panels": [
        {
          "gridPos": { "h": 4, "w": 24, "x": 0, "y": 0 },
          "id": 1,
          "options": {
            "mode": "markdown",
            "content": "## Observability — Agents IA (Phase 2)\n\nCe dashboard regroupe les traces des différents scénarios d'agents testés, tous instrumentés via **OpenTelemetry + OpenInference**, appelant le modèle **qwen3.6-35b** via le **LiteLLM Gateway** (`litellm.itransform365.com`).\n\n**Scénarios couverts :**\n1. Agent seul (Router → Chatbot → Tool)\n2. Supervisor → Sub-agent (délégation simple)\n3. Chaîne de 3 agents (Supervisor → Research → Validation → Supervisor)\n4. Agents en parallèle (fan-out / fan-in)\n\nChaque panel liste les traces récentes du scénario correspondant — clique sur une trace pour voir le détail des spans, les tokens consommés, et le modèle utilisé."
          },
          "title": "À propos",
          "type": "text"
        },
        {
          "datasource": { "type": "tempo", "uid": "P8D6546721A1D106C" },
          "gridPos": { "h": 8, "w": 12, "x": 0, "y": 4 },
          "id": 2,
          "options": {},
          "targets": [
            {
              "datasource": { "type": "tempo", "uid": "P8D6546721A1D106C" },
              "queryType": "traceql",
              "query": "{resource.service.name=\"aizo-poc-langgraph-js\"}",
              "limit": 20,
              "refId": "A"
            }
          ],
          "title": "1. Agent seul — traces récentes",
          "type": "table"
        },
        {
          "datasource": { "type": "tempo", "uid": "P8D6546721A1D106C" },
          "gridPos": { "h": 8, "w": 12, "x": 12, "y": 4 },
          "id": 3,
          "options": {},
          "targets": [
            {
              "datasource": { "type": "tempo", "uid": "P8D6546721A1D106C" },
              "queryType": "traceql",
              "query": "{resource.service.name=\"aizo-poc-agent-to-agent\"}",
              "limit": 20,
              "refId": "A"
            }
          ],
          "title": "2. Supervisor -> Sub-agent — traces récentes",
          "type": "table"
        },
        {
          "datasource": { "type": "tempo", "uid": "P8D6546721A1D106C" },
          "gridPos": { "h": 8, "w": 12, "x": 0, "y": 12 },
          "id": 4,
          "options": {},
          "targets": [
            {
              "datasource": { "type": "tempo", "uid": "P8D6546721A1D106C" },
              "queryType": "traceql",
              "query": "{resource.service.name=\"aizo-poc-three-agent-chain\"}",
              "limit": 20,
              "refId": "A"
            }
          ],
          "title": "3. Chaîne de 3 agents — traces récentes",
          "type": "table"
        },
        {
          "datasource": { "type": "tempo", "uid": "P8D6546721A1D106C" },
          "gridPos": { "h": 8, "w": 12, "x": 12, "y": 12 },
          "id": 5,
          "options": {},
          "targets": [
            {
              "datasource": { "type": "tempo", "uid": "P8D6546721A1D106C" },
              "queryType": "traceql",
              "query": "{resource.service.name=\"aizo-poc-parallel-agents\"}",
              "limit": 20,
              "refId": "A"
            }
          ],
          "title": "4. Agents en parallèle — traces récentes",
          "type": "table"
        },
        {
          "gridPos": { "h": 5, "w": 24, "x": 0, "y": 20 },
          "id": 6,
          "options": {
            "mode": "markdown",
            "content": "### Ce qu'il faut regarder dans chaque trace\n\n- **Attributs `llm.model_name`, `llm.token_count.prompt/completion/total`** — captés automatiquement par OpenInference, sans instrumentation manuelle\n- **Structure des spans** — chaque nœud LangGraph (router, chatbot, sub-agent...) apparaît comme un span distinct, imbriqué correctement même à travers plusieurs agents\n- **Pour le scénario \"parallèle\"** — vérifier visuellement que les spans `research_agent` et `translation_agent` se chevauchent dans le temps (voir `AGENT-TO-AGENT-RESULTS.md` pour la preuve déjà validée)\n\nDétails complets : `AGENT-TO-AGENT-RESULTS.md` à la racine du repo."
          },
          "title": "Guide de lecture",
          "type": "text"
        }
      ],
      "refresh": "",
      "schemaVersion": 39,
      "tags": ["observability", "ai-agents", "phase2"],
      "templating": {
        "list": []
      },
      "time": { "from": "now-24h", "to": "now" },
      "timepicker": {},
      "timezone": "",
      "title": "Observability — Agents IA (Phase 2)",
      "uid": "aizo-ai-agents-v1",
      "version": 1
    }
kind: ConfigMap
metadata:
  labels:
    grafana_dashboard: "1"
  creationTimestamp: null
  name: ai-agents-dashboard
  namespace: observability
```

## ./demo-app/dashboards/ai-agents-dashboard.json
```
{
  "annotations": {
    "list": []
  },
  "editable": true,
  "fiscalYearStartMonth": 0,
  "graphTooltip": 0,
  "links": [],
  "liveNow": false,
  "panels": [
    {
      "gridPos": { "h": 4, "w": 24, "x": 0, "y": 0 },
      "id": 1,
      "options": {
        "mode": "markdown",
        "content": "## Observability — Agents IA (Phase 2)\n\nCe dashboard regroupe les traces des différents scénarios d'agents testés, tous instrumentés via **OpenTelemetry + OpenInference**, appelant le modèle **qwen3.6-35b** via le **LiteLLM Gateway** (`litellm.itransform365.com`).\n\n**Scénarios couverts :**\n1. Agent seul (Router → Chatbot → Tool)\n2. Supervisor → Sub-agent (délégation simple)\n3. Chaîne de 3 agents (Supervisor → Research → Validation → Supervisor)\n4. Agents en parallèle (fan-out / fan-in)\n\nChaque panel liste les traces récentes du scénario correspondant — clique sur une trace pour voir le détail des spans, les tokens consommés, et le modèle utilisé."
      },
      "title": "À propos",
      "type": "text"
    },
    {
      "datasource": { "type": "tempo", "uid": "P8D6546721A1D106C" },
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 4 },
      "id": 2,
      "options": {},
      "targets": [
        {
          "datasource": { "type": "tempo", "uid": "P8D6546721A1D106C" },
          "queryType": "traceql",
          "query": "{resource.service.name=\"aizo-poc-langgraph-js\"}",
          "limit": 20,
          "refId": "A"
        }
      ],
      "title": "1. Agent seul — traces récentes",
      "type": "table"
    },
    {
      "datasource": { "type": "tempo", "uid": "P8D6546721A1D106C" },
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 4 },
      "id": 3,
      "options": {},
      "targets": [
        {
          "datasource": { "type": "tempo", "uid": "P8D6546721A1D106C" },
          "queryType": "traceql",
          "query": "{resource.service.name=\"aizo-poc-agent-to-agent\"}",
          "limit": 20,
          "refId": "A"
        }
      ],
      "title": "2. Supervisor -> Sub-agent — traces récentes",
      "type": "table"
    },
    {
      "datasource": { "type": "tempo", "uid": "P8D6546721A1D106C" },
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 12 },
      "id": 4,
      "options": {},
      "targets": [
        {
          "datasource": { "type": "tempo", "uid": "P8D6546721A1D106C" },
          "queryType": "traceql",
          "query": "{resource.service.name=\"aizo-poc-three-agent-chain\"}",
          "limit": 20,
          "refId": "A"
        }
      ],
      "title": "3. Chaîne de 3 agents — traces récentes",
      "type": "table"
    },
    {
      "datasource": { "type": "tempo", "uid": "P8D6546721A1D106C" },
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 12 },
      "id": 5,
      "options": {},
      "targets": [
        {
          "datasource": { "type": "tempo", "uid": "P8D6546721A1D106C" },
          "queryType": "traceql",
          "query": "{resource.service.name=\"aizo-poc-parallel-agents\"}",
          "limit": 20,
          "refId": "A"
        }
      ],
      "title": "4. Agents en parallèle — traces récentes",
      "type": "table"
    },
    {
      "gridPos": { "h": 5, "w": 24, "x": 0, "y": 20 },
      "id": 6,
      "options": {
        "mode": "markdown",
        "content": "### Ce qu'il faut regarder dans chaque trace\n\n- **Attributs `llm.model_name`, `llm.token_count.prompt/completion/total`** — captés automatiquement par OpenInference, sans instrumentation manuelle\n- **Structure des spans** — chaque nœud LangGraph (router, chatbot, sub-agent...) apparaît comme un span distinct, imbriqué correctement même à travers plusieurs agents\n- **Pour le scénario \"parallèle\"** — vérifier visuellement que les spans `research_agent` et `translation_agent` se chevauchent dans le temps (voir `AGENT-TO-AGENT-RESULTS.md` pour la preuve déjà validée)\n\nDétails complets : `AGENT-TO-AGENT-RESULTS.md` à la racine du repo."
      },
      "title": "Guide de lecture",
      "type": "text"
    }
  ],
  "refresh": "",
  "schemaVersion": 39,
  "tags": ["observability", "ai-agents", "phase2"],
  "templating": {
    "list": []
  },
  "time": { "from": "now-24h", "to": "now" },
  "timepicker": {},
  "timezone": "",
  "title": "Observability — Agents IA (Phase 2)",
  "uid": "aizo-ai-agents-v1",
  "version": 1
}
```

## ./demo-app/dashboards/demo-api-dashboard-configmap.yaml
```
apiVersion: v1
data:
  demo-api-dashboard.json: |
    {
      "annotations": {
        "list": []
      },
      "editable": true,
      "fiscalYearStartMonth": 0,
      "graphTooltip": 0,
      "links": [],
      "liveNow": false,
      "panels": [
        {
          "datasource": { "type": "prometheus", "uid": "prometheus" },
          "gridPos": { "h": 8, "w": 12, "x": 0, "y": 0 },
          "id": 1,
          "options": {
            "legend": { "displayMode": "list", "placement": "bottom" },
            "tooltip": { "mode": "multi" }
          },
          "targets": [
            {
              "datasource": { "type": "prometheus", "uid": "prometheus" },
              "expr": "sum(rate(http_server_duration_milliseconds_count{exported_job=\"demo-api\"}[5m])) by (http_status_code)",
              "legendFormat": "status {{http_status_code}}",
              "refId": "A"
            }
          ],
          "title": "demo-api — Taux de requêtes par code HTTP",
          "type": "timeseries"
        },
        {
          "datasource": { "type": "prometheus", "uid": "prometheus" },
          "fieldConfig": {
            "defaults": {
              "unit": "percentunit",
              "max": 1,
              "min": 0,
              "thresholds": {
                "mode": "absolute",
                "steps": [
                  { "color": "green", "value": null },
                  { "color": "red", "value": 0.05 }
                ]
              }
            }
          },
          "gridPos": { "h": 8, "w": 12, "x": 12, "y": 0 },
          "id": 2,
          "options": {
            "orientation": "auto",
            "showThresholdLabels": false,
            "showThresholdMarkers": true
          },
          "targets": [
            {
              "datasource": { "type": "prometheus", "uid": "prometheus" },
              "expr": "sum(rate(http_server_duration_milliseconds_count{exported_job=\"demo-api\", http_status_code=\"500\"}[5m])) / sum(rate(http_server_duration_milliseconds_count{exported_job=\"demo-api\"}[5m]))",
              "legendFormat": "taux d'erreur",
              "refId": "A"
            }
          ],
          "title": "demo-api — Taux d'erreur (SLO: <5%)",
          "type": "gauge"
        },
        {
          "datasource": { "type": "prometheus", "uid": "prometheus" },
          "fieldConfig": {
            "defaults": { "unit": "ms" }
          },
          "gridPos": { "h": 8, "w": 12, "x": 0, "y": 8 },
          "id": 3,
          "options": {
            "legend": { "displayMode": "list", "placement": "bottom" },
            "tooltip": { "mode": "multi" }
          },
          "targets": [
            {
              "datasource": { "type": "prometheus", "uid": "prometheus" },
              "expr": "histogram_quantile(0.50, sum(rate(http_server_duration_milliseconds_bucket{exported_job=\"demo-api\"}[5m])) by (le))",
              "legendFormat": "p50",
              "refId": "A"
            },
            {
              "datasource": { "type": "prometheus", "uid": "prometheus" },
              "expr": "histogram_quantile(0.95, sum(rate(http_server_duration_milliseconds_bucket{exported_job=\"demo-api\"}[5m])) by (le))",
              "legendFormat": "p95",
              "refId": "B"
            },
            {
              "datasource": { "type": "prometheus", "uid": "prometheus" },
              "expr": "histogram_quantile(0.99, sum(rate(http_server_duration_milliseconds_bucket{exported_job=\"demo-api\"}[5m])) by (le))",
              "legendFormat": "p99",
              "refId": "C"
            }
          ],
          "title": "demo-api — Latence (p50 / p95 / p99)",
          "type": "timeseries"
        },
        {
          "datasource": { "type": "prometheus", "uid": "prometheus" },
          "gridPos": { "h": 8, "w": 12, "x": 12, "y": 8 },
          "id": 4,
          "options": {
            "legend": { "displayMode": "list", "placement": "bottom" },
            "tooltip": { "mode": "multi" }
          },
          "targets": [
            {
              "datasource": { "type": "prometheus", "uid": "prometheus" },
              "expr": "ALERTS{alertname=\"DemoAPIHighErrorRate\"}",
              "legendFormat": "{{alertstate}}",
              "refId": "A"
            }
          ],
          "title": "Alerte SLO — DemoAPIHighErrorRate (état)",
          "type": "state-timeline"
        },
        {
          "datasource": { "type": "loki", "uid": "P982945308D3682D1" },
          "gridPos": { "h": 10, "w": 24, "x": 0, "y": 16 },
          "id": 5,
          "options": {
            "showTime": true,
            "showLabels": false,
            "wrapLogMessage": true,
            "sortOrder": "Descending"
          },
          "targets": [
            {
              "datasource": { "type": "loki", "uid": "P982945308D3682D1" },
              "expr": "{namespace=\"observability\", pod=~\"demo-api.*\"} | json",
              "refId": "A"
            }
          ],
          "title": "demo-api — Logs structurés (JSON, avec trace_id)",
          "type": "logs"
        },
        {
          "datasource": { "type": "tempo", "uid": "P8D6546721A1D106C" },
          "gridPos": { "h": 8, "w": 12, "x": 0, "y": 26 },
          "id": 6,
          "options": {},
          "targets": [
            {
              "datasource": { "type": "tempo", "uid": "P8D6546721A1D106C" },
              "queryType": "search",
              "serviceName": "demo-api",
              "limit": 20,
              "refId": "A"
            }
          ],
          "title": "demo-api — Traces récentes",
          "type": "table"
        },
        {
          "datasource": { "type": "tempo", "uid": "P8D6546721A1D106C" },
          "gridPos": { "h": 8, "w": 12, "x": 12, "y": 26 },
          "id": 7,
          "options": {},
          "targets": [
            {
              "datasource": { "type": "tempo", "uid": "P8D6546721A1D106C" },
              "queryType": "search",
              "serviceName": "demo-frontend",
              "limit": 20,
              "refId": "A"
            }
          ],
          "title": "demo-frontend — Traces récentes (vue multi-services)",
          "type": "table"
        },
        {
          "gridPos": { "h": 4, "w": 24, "x": 0, "y": 34 },
          "id": 8,
          "options": {
            "mode": "markdown",
            "content": "### Profiling (Pyroscope)\n\nLe panel de flamegraph natif n'est pas inclus directement dans ce dashboard (nécessite le plugin Pyroscope avec configuration spécifique par version de Grafana). Pour consulter les profils CPU/mémoire de `demo-api` :\n\n**Explore → sélectionner la source de données `pyroscope` → requête `{service_name=\"demo-api\"}`**"
          },
          "title": "Profiling — accès",
          "type": "text"
        }
      ],
      "refresh": "30s",
      "schemaVersion": 39,
      "tags": ["observability", "demo-api", "phase1"],
      "templating": {
        "list": []
      },
      "time": { "from": "now-1h", "to": "now" },
      "timepicker": {},
      "timezone": "",
      "title": "Observability — demo-api (4 piliers)",
      "uid": "demo-api-unified-v1",
      "version": 1
    }
kind: ConfigMap
metadata:
  labels:
    grafana_dashboard: "1"
  creationTimestamp: null
  name: demo-api-dashboard
  namespace: observability
```

## ./demo-app/dashboards/demo-api-dashboard.json
```
{
  "annotations": {
    "list": []
  },
  "editable": true,
  "fiscalYearStartMonth": 0,
  "graphTooltip": 0,
  "links": [],
  "liveNow": false,
  "panels": [
    {
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 0 },
      "id": 1,
      "options": {
        "legend": { "displayMode": "list", "placement": "bottom" },
        "tooltip": { "mode": "multi" }
      },
      "targets": [
        {
          "datasource": { "type": "prometheus", "uid": "prometheus" },
          "expr": "sum(rate(http_server_duration_milliseconds_count{exported_job=\"demo-api\"}[5m])) by (http_status_code)",
          "legendFormat": "status {{http_status_code}}",
          "refId": "A"
        }
      ],
      "title": "demo-api — Taux de requêtes par code HTTP",
      "type": "timeseries"
    },
    {
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "fieldConfig": {
        "defaults": {
          "unit": "percentunit",
          "max": 1,
          "min": 0,
          "thresholds": {
            "mode": "absolute",
            "steps": [
              { "color": "green", "value": null },
              { "color": "red", "value": 0.05 }
            ]
          }
        }
      },
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 0 },
      "id": 2,
      "options": {
        "orientation": "auto",
        "showThresholdLabels": false,
        "showThresholdMarkers": true
      },
      "targets": [
        {
          "datasource": { "type": "prometheus", "uid": "prometheus" },
          "expr": "sum(rate(http_server_duration_milliseconds_count{exported_job=\"demo-api\", http_status_code=\"500\"}[5m])) / sum(rate(http_server_duration_milliseconds_count{exported_job=\"demo-api\"}[5m]))",
          "legendFormat": "taux d'erreur",
          "refId": "A"
        }
      ],
      "title": "demo-api — Taux d'erreur (SLO: <5%)",
      "type": "gauge"
    },
    {
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "fieldConfig": {
        "defaults": { "unit": "ms" }
      },
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 8 },
      "id": 3,
      "options": {
        "legend": { "displayMode": "list", "placement": "bottom" },
        "tooltip": { "mode": "multi" }
      },
      "targets": [
        {
          "datasource": { "type": "prometheus", "uid": "prometheus" },
          "expr": "histogram_quantile(0.50, sum(rate(http_server_duration_milliseconds_bucket{exported_job=\"demo-api\"}[5m])) by (le))",
          "legendFormat": "p50",
          "refId": "A"
        },
        {
          "datasource": { "type": "prometheus", "uid": "prometheus" },
          "expr": "histogram_quantile(0.95, sum(rate(http_server_duration_milliseconds_bucket{exported_job=\"demo-api\"}[5m])) by (le))",
          "legendFormat": "p95",
          "refId": "B"
        },
        {
          "datasource": { "type": "prometheus", "uid": "prometheus" },
          "expr": "histogram_quantile(0.99, sum(rate(http_server_duration_milliseconds_bucket{exported_job=\"demo-api\"}[5m])) by (le))",
          "legendFormat": "p99",
          "refId": "C"
        }
      ],
      "title": "demo-api — Latence (p50 / p95 / p99)",
      "type": "timeseries"
    },
    {
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 8 },
      "id": 4,
      "options": {
        "legend": { "displayMode": "list", "placement": "bottom" },
        "tooltip": { "mode": "multi" }
      },
      "targets": [
        {
          "datasource": { "type": "prometheus", "uid": "prometheus" },
          "expr": "ALERTS{alertname=\"DemoAPIHighErrorRate\"}",
          "legendFormat": "{{alertstate}}",
          "refId": "A"
        }
      ],
      "title": "Alerte SLO — DemoAPIHighErrorRate (état)",
      "type": "state-timeline"
    },
    {
      "datasource": { "type": "loki", "uid": "P982945308D3682D1" },
      "gridPos": { "h": 10, "w": 24, "x": 0, "y": 16 },
      "id": 5,
      "options": {
        "showTime": true,
        "showLabels": false,
        "wrapLogMessage": true,
        "sortOrder": "Descending"
      },
      "targets": [
        {
          "datasource": { "type": "loki", "uid": "P982945308D3682D1" },
          "expr": "{namespace=\"observability\", pod=~\"demo-api.*\"} | json",
          "refId": "A"
        }
      ],
      "title": "demo-api — Logs structurés (JSON, avec trace_id)",
      "type": "logs"
    },
    {
      "datasource": { "type": "tempo", "uid": "P8D6546721A1D106C" },
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 26 },
      "id": 6,
      "options": {},
      "targets": [
        {
          "datasource": { "type": "tempo", "uid": "P8D6546721A1D106C" },
          "queryType": "search",
          "serviceName": "demo-api",
          "limit": 20,
          "refId": "A"
        }
      ],
      "title": "demo-api — Traces récentes",
      "type": "table"
    },
    {
      "datasource": { "type": "tempo", "uid": "P8D6546721A1D106C" },
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 26 },
      "id": 7,
      "options": {},
      "targets": [
        {
          "datasource": { "type": "tempo", "uid": "P8D6546721A1D106C" },
          "queryType": "search",
          "serviceName": "demo-frontend",
          "limit": 20,
          "refId": "A"
        }
      ],
      "title": "demo-frontend — Traces récentes (vue multi-services)",
      "type": "table"
    },
    {
      "gridPos": { "h": 4, "w": 24, "x": 0, "y": 34 },
      "id": 8,
      "options": {
        "mode": "markdown",
        "content": "### Profiling (Pyroscope)\n\nLe panel de flamegraph natif n'est pas inclus directement dans ce dashboard (nécessite le plugin Pyroscope avec configuration spécifique par version de Grafana). Pour consulter les profils CPU/mémoire de `demo-api` :\n\n**Explore → sélectionner la source de données `pyroscope` → requête `{service_name=\"demo-api\"}`**"
      },
      "title": "Profiling — accès",
      "type": "text"
    }
  ],
  "refresh": "30s",
  "schemaVersion": 39,
  "tags": ["observability", "demo-api", "phase1"],
  "templating": {
    "list": []
  },
  "time": { "from": "now-1h", "to": "now" },
  "timepicker": {},
  "timezone": "",
  "title": "Observability — demo-api (4 piliers)",
  "uid": "demo-api-unified-v1",
  "version": 1
}
```

## ./demo-app/frontend/app.py
```
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
```

## ./demo-app/frontend/Dockerfile
```
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir setuptools==75.1.0 && \
    pip install --no-cache-dir -r requirements.txt && \
    opentelemetry-bootstrap -a install

COPY app.py .

EXPOSE 8082

CMD ["opentelemetry-instrument", "python", "app.py"]
```

## ./demo-app/frontend/requirements.txt
```
flask==3.0.3
requests==2.32.3
opentelemetry-distro==0.48b0
opentelemetry-exporter-otlp==1.27.0
```

## ./demo-app/k8s/demo-api-alerts.yaml
```
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
```

## ./demo-app/k8s/demo-api-deployment.yaml
```
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
          image: demo-api:v3
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
```

## ./demo-app/k8s/demo-frontend-deployment.yaml
```
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
```

## ./demo-app/KNOWN-LIMITATIONS.md
```
# Limitations connues — à reprendre plus tard si besoin

## Exemplars (lien metrics → traces)

**Statut** : Non fonctionnel malgré une configuration complète et correcte.

**Ce qui a été fait** :
- `exemplar-storage` activé côté Prometheus (`enableFeatures: [exemplar-storage]`)
- `enable_open_metrics: true` activé sur l'exporter Prometheus du Collector
- Format OpenMetrics confirmé actif (vérifié via `curl -H "Accept: application/openmetrics-text"`)

**Cause racine identifiée** : l'auto-instrumentation Python d'OpenTelemetry
(`opentelemetry-instrumentation-flask` v0.48b0) ne génère pas d'exemplars
automatiquement sur les métriques HTTP qu'elle produit. C'est une limite connue
de l'écosystème OpenTelemetry côté Python, moins mature que les SDK Go/Java
sur ce point précis.

**Solutions possibles pour plus tard** :
1. Instrumentation manuelle des métriques de latence (remplacer les métriques
   auto-générées par des métriques créées à la main, avec le trace_id courant
   attaché explicitement en exemplar)
2. Surveiller les futures versions du SDK Python OpenTelemetry — cette
   fonctionnalité est activement développée dans l'écosystème

**Contournement actuel** : le pivot metric→trace se fait indirectement en
filtrant Tempo par service_name + fenêtre de temps correspondant au pic
observé dans Prometheus. Le pivot log→trace, lui, fonctionne parfaitement
(trace_id injecté dans les logs JSON structurés, voir demo-api/app.py).
```

## ./demo-app/otel-collector-servicemonitor.yaml
```
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
```

## ./.gitignore
```
# Environnements virtuels Python
venv/
**/venv/
.venv/
**/__pycache__/
*.pyc

# Fichiers sensibles
.env
**/.env

# Node.js
node_modules/
**/node_modules/
package-lock.json
```

## ./learning-notes/GUIDE-STACK-OBSERVABILITY.md
```
# Guide complet — Stack d'Observabilité
### Théorie et pratique de tout ce qui a été construit

---

## 1. Vue d'ensemble — pourquoi cette architecture

Un système d'observabilité répond à une question simple mais large : **quand quelque chose ne va pas, comment je le sais, et comment je comprends pourquoi ?**

Le cahier des charges (iTransform365) définit 4 piliers complémentaires :

| Pilier | Répond à | Outil déployé |
|---|---|---|
| **Metrics** | "Quelque chose ne va pas — quoi, où, depuis quand ?" | Prometheus |
| **Logs** | "Que s'est-il passé exactement, en texte ?" | Loki |
| **Traces** | "Quel chemin la requête a-t-elle suivi, et où le temps a-t-il été perdu ?" | Tempo |
| **Profiling** | "Quelle ligne de code précise consomme les ressources ?" | Pyroscope |

Le flux d'investigation officiel est le **"how → why"** : les métriques révèlent qu'un problème existe (le "how" — sa forme), puis logs/traces/profils expliquent pourquoi (le "why" — la cause).

Tous ces piliers sont alimentés par un point d'entrée unique, le **OpenTelemetry Collector**, qui reçoit les données des applications dans un format standard (OTLP) et les route vers le bon backend.

```
Application (demo-api)
      │  OTLP (metrics + logs + traces)
      ▼
OpenTelemetry Collector
      │
      ├──► Prometheus  (metrics)
      ├──► Loki         (logs)
      └──► Tempo        (traces)

Grafana ──► interroge les 4 backends, affiche tout au même endroit
```

---

## 2. Kubernetes — les fondations

### Pourquoi Kubernetes plutôt que des conteneurs Docker isolés

Docker fait tourner des conteneurs individuels. Kubernetes **orchestre** des conteneurs à travers plusieurs machines (nœuds), avec des garanties automatiques : redémarrage en cas de crash, répartition de charge, découverte de service.

### Les objets clés rencontrés, et pourquoi chacun existe

**Pod** — plus petite unité déployable. Contient un ou plusieurs conteneurs partageant réseau et stockage. Un Pod créé "nu" (sans contrôleur) n'est surveillé par personne ; s'il meurt, il ne revient jamais.

**Deployment → ReplicaSet → Pods** — un Deployment ne crée jamais directement de Pods. Il délègue à un **ReplicaSet**, qui applique la **boucle de réconciliation** : il compare en permanence l'état réel (combien de Pods tournent) à l'état désiré (combien devraient tourner), et corrige l'écart automatiquement. C'est ce qui donne à Kubernetes sa résilience.

**Service** — une adresse réseau stable. Les Pods ont des IP et des noms qui changent à chaque recréation ; le Service route le trafic vers eux via un système de **labels/selector**, indépendamment de leur identité du moment. C'est ce qui permet à `http://loki:3100` de fonctionner peu importe combien de fois le Pod Loki a redémarré.

**DaemonSet** — garantit exactement **1 Pod par nœud**, ni plus ni moins. Utilisé quand un composant doit lire quelque chose de **local à chaque machine** :
- `node-exporter` (métriques système du nœud)
- `Alloy` pour les logs (fichiers de logs stockés localement sur chaque nœud)

**StatefulSet** — garantit une **identité stable** (`nom-0`, `nom-1`...) et un **stockage persistant** lié à cette identité. Utilisé pour tout composant qui **stocke des données** dans le temps et a besoin de cohérence :
- Prometheus, Alertmanager, Loki (SingleBinary), Tempo, Pyroscope

**Deployment (simple)** — utilisé quand un composant **traite du trafic réseau sans état lié à un nœud précis** — peu importe combien de replicas ni où ils tournent, tant qu'ils sont joignables via le Service :
- OpenTelemetry Collector (reçoit des requêtes OTLP, ne stocke rien lui-même)

### Tableau récapitulatif du "pourquoi" de chaque choix

| Composant | Type | Raison |
|---|---|---|
| node-exporter | DaemonSet | lit les métriques système de CHAQUE nœud |
| Alloy (logs) | DaemonSet | lit les fichiers de logs locaux de CHAQUE nœud |
| Alloy (pyroscope) | StatefulSet | scrape des endpoints pprof via annotations, pas de lecture locale par nœud |
| Prometheus | StatefulSet | stocke les séries temporelles, besoin de persistance |
| Loki | StatefulSet | stocke les logs, besoin de persistance |
| Tempo | StatefulSet | stocke les traces, besoin de persistance |
| Pyroscope | StatefulSet | stocke les profils, besoin de persistance |
| OTel Collector | Deployment | reçoit/route du trafic réseau, aucun état à conserver |

### Le DNS interne du cluster (CoreDNS)

N'importe quel Service est joignable **depuis l'intérieur du cluster** par son nom simple (`http://loki:3100`) ou son nom complet (`http://loki.observability.svc.cluster.local:3100`). Ce nom n'existe que dans le réseau virtuel du cluster — inaccessible depuis ta machine sans un `kubectl port-forward`, qui crée un tunnel temporaire entre un port de ta machine et un port à l'intérieur du cluster.

### Port interne vs port externe

Le port **interne** (celui du conteneur) peut être réutilisé librement par différents clusters isolés dans leurs propres réseaux Docker. Le port **externe** (celui de ta machine hôte) est une ressource partagée par tout ce qui tourne sur la machine — source de conflits (ex: le port 8080 déjà pris par un autre conteneur).

---

## 3. Helm — la gestion des déploiements

### Le problème que Helm résout

Déployer un composant complexe (ex: Prometheus) à la main demanderait d'écrire et maintenir 6-10 fichiers YAML (Deployment, Service, ConfigMap, PVC, RBAC...). Multiplié par tous les composants de la stack, c'est ingérable.

### Chart et Release

Un **chart** est un paquet préassemblé de manifests Kubernetes, avec des valeurs configurables (via un fichier `values.yaml`). Une **release** est une instance déployée de ce chart — Helm garde en mémoire la liste exacte des objets créés, ce qui permet de tout supprimer ou mettre à jour en une seule commande (`helm uninstall`, `helm upgrade`), contrairement à `kubectl apply` où il faudrait suivre chaque fichier manuellement.

### Piège rencontré : sous-paramètres vs mode global

Certains charts (comme `grafana/loki`) ont un paramètre de "mode" de haut niveau (`deploymentMode: SingleBinary`) qui doit être explicitement activé, en plus des sous-paramètres détaillés (`singleBinary.replicas: 1`). Régler uniquement le sous-paramètre ne suffit pas toujours — toujours vérifier avec `helm get values <release>` si le comportement ne correspond pas à ce qui est attendu.

### Charts dépréciés — un piège récurrent

`grafana/loki-stack` est déprécié et déploie une version de Loki trop ancienne (2.6.1) pour être compatible avec un Grafana récent. Toujours vérifier les warnings Helm ("This chart is deprecated") et privilégier le chart activement maintenu quand un choix existe.

---

## 4. Prometheus — les métriques

### Modèle de données

Prometheus collecte des métriques par un système de **labels** (paires clé-valeur attachées à chaque série temporelle), interrogeables via le langage **PromQL**. Exemple : la requête `up` retourne `1` pour chaque cible surveillée qui répond correctement, `0` sinon.

### Composants déployés

- **node-exporter** (DaemonSet) — métriques système bas niveau (CPU, RAM, disque, réseau) de chaque nœud
- **kube-state-metrics** — état des objets Kubernetes eux-mêmes (nombre de Pods, statut des Deployments...)
- **Alertmanager** — reçoit les alertes déclenchées par Prometheus et les route (Slack, email...) — déployé mais sans règles définies pour l'instant

---

## 5. Loki — les logs

### Le choix d'architecture clé : indexer les labels, pas le texte

Contrairement à Elasticsearch (qui construit un index inversé sur chaque mot de chaque log — coûteux en disque et CPU), Loki **n'indexe que les labels** (`namespace`, `pod`, `app`...). Le contenu texte est stocké tel quel, compressé, dans des chunks, sans index dessus.

**Conséquence** : une requête "logs du pod X entre 14h et 15h" est très rapide (Loki trouve directement le bon chunk via les labels). Une requête "trouve le mot 'timeout' n'importe où" est plus lente (il faut scanner le texte des chunks concernés).

**Pourquoi c'est un bon compromis pour ce projet** : le flux d'investigation "how → why" suppose qu'on sait déjà quel service regarder (la métrique l'a indiqué) — on filtre par label, on ne fait jamais de recherche exploratoire à l'aveugle.

### Multi-tenancy

Loki isole les données par "tenant" via le header `X-Scope-OrgID`, envoyé sur chaque requête (lecture et écriture). Utile en entreprise pour isoler les logs par équipe/produit — sécurité (une équipe ne voit pas les logs d'une autre) et performance (requêtes limitées à un périmètre).

### Alloy — la collecte

Alloy est l'agent qui lit les logs des conteneurs sur chaque nœud et les pousse vers Loki. Déployé en DaemonSet pour lire les fichiers locaux de chaque machine. Alloy est en fait un agent polyvalent — la même techno sert aussi pour scraper des profils (Pyroscope), mais dans ce cas déployé en StatefulSet, car il ne lit pas de fichiers locaux mais scrape des endpoints HTTP via annotations sur des Pods désignés.

---

## 6. Tempo — les traces

### Concept de trace et de span

Une **trace** suit une requête individuelle de bout en bout à travers plusieurs services. Elle est composée de **spans** — chaque span représente une opération (ex: "appel à la base de données"), avec un début, une durée, et un lien vers son span parent. Ça permet de voir exactement où le temps a été dépensé dans un chemin de requête complexe.

### Différence fondamentale avec metrics/logs

Metrics et logs peuvent être générés passivement par l'infrastructure elle-même (Prometheus scrape des cibles, les conteneurs écrivent des logs par défaut). **Les traces n'existent que si une application les émet explicitement** — il n'y a pas de traces "gratuites".

### Formats acceptés

Tempo peut recevoir des traces dans plusieurs formats (Jaeger, Zipkin...), mais le standard moderne utilisé ici est **OTLP** (OpenTelemetry Protocol), sur les ports 4317 (gRPC) et 4318 (HTTP).

---

## 7. Pyroscope — le profiling continu

### Ce que ça apporte de plus

Aucun des 3 piliers précédents ne dit "quelle ligne de code précise consomme le CPU/la mémoire". Pyroscope échantillonne périodiquement la pile d'appels d'une application et construit un **flamegraph** — une visualisation montrant où le temps CPU est réellement dépensé, au niveau du code.

### Instrumentation

Une app expose un endpoint `pprof` (standard dans l'écosystème), et on ajoute des annotations sur son Pod pour qu'Alloy sache le scraper :
```yaml
profiles.grafana.com/cpu.scrape: "true"
profiles.grafana.com/cpu.port: "8080"
```

---

## 8. OpenTelemetry — le standard unificateur

### Le problème sans lui

Sans standard commun, une application devrait connaître l'adresse de Prometheus, Loki, ET Tempo séparément, et gérer 3 protocoles différents pour chacun.

### La solution

L'application parle **un seul protocole (OTLP)** vers **une seule adresse** (le Collector). Le Collector reçoit tout, et route chaque type de signal (metrics/logs/traces) vers le bon backend selon sa configuration de **pipeline**.

### Auto-instrumentation vs instrumentation manuelle

- **Auto-instrumentation** : un outil (`opentelemetry-instrument`) enveloppe le lancement normal de l'app (`opentelemetry-instrument python app.py` au lieu de `python app.py`). Il détecte les librairies connues (Flask, requests...) et leur injecte du code de tracing/métriques à la volée — zéro ligne de code OpenTelemetry écrite à la main.
- **Instrumentation manuelle** : créer soi-même des spans/métriques à des endroits précis du code, pour des mesures métier custom que l'auto-instrumentation ne peut pas deviner.

### Le piège du binding réseau

Un Collector doit explicitement se lier à `0.0.0.0` (toutes les interfaces réseau) sur ses ports d'écoute — sinon, selon la configuration du chart, il peut se lier uniquement à l'IP interne du Pod, rendant `kubectl port-forward` (qui tente une connexion via `localhost` à l'intérieur du Pod) impossible avec une erreur "connection refused".

---

## 9. L'application démo — `demo-api`

### Objectif

Une petite app Flask qui simule un travail avec une durée variable et une chance d'échec (10%), pour avoir de vraies données à observer — succès et erreurs, latences variables.

### Pourquoi Python + Flask pour ce projet

Simplicité de l'auto-instrumentation (peu de bruit syntaxique), et cohérence avec les futurs composants IA de la Phase 2 (généralement en Python aussi).

### L'environnement virtuel (venv)

Un `venv` crée une copie isolée de Python avec son propre dossier de paquets, séparée de l'installation système. Depuis Python 3.12+, Ubuntu/Debian bloque `pip install` global pour éviter de casser les paquets système — d'où l'obligation d'utiliser un venv pour tout projet Python moderne sur ces distributions.

### Les variables d'environnement OpenTelemetry utilisées

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317   # où envoyer les données
OTEL_SERVICE_NAME=demo-api                          # nom affiché dans Grafana/Tempo
OTEL_EXPORTER_OTLP_PROTOCOL=grpc                     # protocole de transport
```

En local (app sur la machine hôte), on pointe vers `localhost:4317` via un `kubectl port-forward` vers le Collector. Une fois l'app déployée **dans** le cluster (en tant que Pod), l'adresse deviendra le nom DNS interne du Service Collector (ex: `otel-collector-opentelemetry-collector.observability.svc.cluster.local:4317`) — plus besoin de port-forward, puisque l'app sera elle-même à l'intérieur du réseau du cluster.

---

## 10. Méthode de diagnostic généralisable

Face à un composant qui ne démarre pas ou ne communique pas, l'ordre d'élimination qui a fonctionné tout au long du projet :

1. **Espace disque / ressources globales** (`df -h`, `docker system df`, `free -h`, `nproc`)
2. **Limites système du noyau** (inotify, file descriptors, PIDs)
3. **Conflits réseau/port** (ports déjà utilisés, binding sur la mauvaise interface)
4. **Version/compatibilité des composants** (charts dépréciés, versions incompatibles entre deux outils)
5. **Config applicative précise** (YAML mal formé, paramètre manquant, exporter inexistant)

Et le réflexe transversal le plus important : **toujours lire les vrais logs du composant concerné** (`kubectl logs`, `kubectl describe` → section Events) avant de conclure à une cause — un message d'erreur générique dans une UI cache presque toujours une cause plus précise dans les logs.
```

## ./learning-notes/LIVRE-THEORIE-OBSERVABILITY.md
```
# Livre de Théorie — Observability Engineering
### De zéro à une stack complète : tous les concepts, dans l'ordre d'apprentissage

---

## Chapitre 1 — Conteneurs et Docker

### Pourquoi les conteneurs existent
Avant les conteneurs, faire tourner une application demandait soit de l'installer directement sur une machine (risque de conflits de versions entre applications), soit de lui donner une VM entière (isolation parfaite mais lourde — chaque VM duplique un noyau complet).

Un **conteneur** isole une application sans dupliquer le noyau. Tous les conteneurs d'une machine partagent le même noyau Linux de l'hôte, mais chacun croit être seul — via deux mécanismes :
- **namespaces** : isolent la vue du conteneur sur le réseau, les processus (PID), le filesystem
- **cgroups** : limitent les ressources (CPU, RAM) qu'un conteneur peut consommer

Résultat : un conteneur démarre en millisecondes (vs dizaines de secondes pour une VM).

### Image vs conteneur
Une **image** est le snapshot figé du filesystem + de la configuration de démarrage. Un **conteneur** est une instance en cours d'exécution de cette image. Un conteneur arrêté existe toujours (visible avec `docker ps -a`) jusqu'à suppression explicite — il ne consomme presque rien mais garde son état.

### Les couches (layers) et le cache Docker
Une image est construite en couches empilées, chacune étant un diff par rapport à la précédente, définie par les instructions d'un `Dockerfile` :
```dockerfile
FROM python:3.12-slim      # couche 1
COPY requirements.txt .    # couche 2
RUN pip install ...        # couche 3
COPY app.py .              # couche 4
```
Docker **cache** chaque couche. Si on modifie seulement `app.py`, Docker réutilise les couches 1-3 déjà construites (installation des dépendances, souvent lente) et ne refait que la couche 4 (copie du code, instantanée). D'où la règle : mettre en premier ce qui change le moins souvent. Inverser l'ordre (tout copier avant d'installer les dépendances) casse ce cache à chaque modification de code, même mineure.

### Ports interne vs externe
Le port **interne** (côté conteneur) est isolé dans son propre réseau Docker — réutilisable librement par différents projets/clusters sans conflit. Le port **externe** (côté machine hôte) est une ressource partagée par tout ce qui tourne sur la machine — source fréquente de conflits (ex : deux projets voulant tous les deux le port 8080).

---

## Chapitre 2 — Kubernetes, les fondations

### Pourquoi Kubernetes
Docker fait tourner des conteneurs individuels sur une seule machine. Kubernetes **orchestre** des conteneurs à travers plusieurs machines (nœuds), avec des garanties automatiques : redémarrage en cas de crash, répartition de charge, découverte de service.

### Pod
Plus petite unité déployable de Kubernetes. Contient un ou plusieurs conteneurs partageant réseau et stockage. Un Pod créé "nu" (sans contrôleur, ex: `kubectl run`) n'est surveillé par personne — s'il meurt, il ne revient jamais.

### Deployment → ReplicaSet → Pods, et la boucle de réconciliation
Un Deployment ne crée jamais directement de Pods — il délègue à un **ReplicaSet** intermédiaire. Le ReplicaSet applique la **boucle de réconciliation** : il compare en continu l'état réel (combien de Pods tournent) à l'état désiré (combien devraient tourner selon le Deployment), et corrige automatiquement tout écart en créant ou supprimant des Pods. C'est ce mécanisme qui donne à Kubernetes sa résilience : supprimer un Pod géré par un Deployment entraîne sa recréation quasi instantanée (avec un nouveau nom, car c'est une nouvelle instance, pas une résurrection).

Nom des Pods générés : `<deployment>-<hash-replicaset>-<suffixe-aléatoire>`. Le hash change quand l'image/config change, ce qui permet les rollouts progressifs (bascule graduelle vers un nouveau ReplicaSet).

### Service
Les Pods ont des IP et des noms éphémères (changent à chaque recréation). Un **Service** fournit une adresse stable qui route le trafic via un système de **labels/selector** — chaque Pod porte un label (ex: `app=demo-api`), le Service a un selector qui matche ce label, et route automatiquement vers tous les Pods correspondants peu importe leur nombre ou identité du moment.

### DaemonSet vs StatefulSet vs Deployment — le critère de choix
Le choix n'est **jamais** une question de préférence, mais de ce que fait le composant :

- **DaemonSet** : garantit exactement 1 Pod par nœud. Utilisé pour tout ce qui doit lire quelque chose de **local à chaque machine** — node-exporter (métriques système du nœud), Alloy pour les logs (fichiers stockés localement sur chaque nœud).
- **StatefulSet** : garantit une identité stable (`nom-0`, `nom-1`...) et un stockage persistant lié à cette identité. Utilisé pour tout ce qui **stocke des données** avec besoin de cohérence — Prometheus, Loki, Tempo, Pyroscope.
- **Deployment** : utilisé quand un composant traite du trafic/requêtes **sans état lié à un nœud précis** — peu importe le nombre de replicas ni où ils tournent, tant qu'ils sont joignables via le Service. Le OpenTelemetry Collector en est l'exemple : il reçoit des requêtes réseau et route, sans rien stocker lui-même.

Piège classique : un même agent (comme Alloy) peut être déployé en DaemonSet dans un rôle (collecte de logs, lecture locale par nœud) et en StatefulSet dans un autre rôle (scraping de profils via annotations sur des Pods désignés, pas de lecture locale).

### DNS interne du cluster (CoreDNS)
Tout Service est joignable depuis l'intérieur du cluster par son nom court (`http://loki:3100`) si l'appelant est dans le **même namespace**, ou par son nom complet (`http://loki.observability.svc.cluster.local:3100`) depuis n'importe où — le nom court se résout implicitement en ajoutant le namespace courant de l'appelant. Ce DNS n'existe que dans le réseau virtuel du cluster, inaccessible depuis l'extérieur sans un tunnel (`kubectl port-forward`).

### imagePullPolicy
Par défaut, Kubernetes tente de retélécharger une image depuis un registre externe si elle n'est pas explicitement marquée comme locale. Pour une image construite et importée manuellement (via `k3d image import`), il faut `imagePullPolicy: Never` — sinon Kubernetes tente un pull vers Docker Hub, échoue (l'image n'y existe pas), et le Pod reste bloqué en erreur malgré la présence de l'image localement.

---

## Chapitre 3 — Helm

### Le problème résolu
Déployer un composant complexe à la main demande d'écrire et maintenir de nombreux fichiers YAML (Deployment, Service, ConfigMap, PVC, RBAC...). Multiplié par tous les composants d'une stack, c'est ingérable manuellement.

### Chart et Release
Un **chart** est un paquet préassemblé de manifests Kubernetes avec des valeurs configurables (`values.yaml`). Une **release** est une instance déployée d'un chart — Helm garde en mémoire la liste exacte des objets créés, permettant une suppression/mise à jour complète en une seule commande (`helm uninstall`, `helm upgrade`), contrairement à `kubectl apply` où chaque objet devrait être suivi manuellement.

### Pièges rencontrés
- **Sous-paramètres vs mode global** : certains charts ont un paramètre de "mode" de haut niveau qui doit être explicitement activé, en plus des sous-paramètres détaillés. Régler uniquement le sous-paramètre ne suffit pas toujours.
- **Charts dépréciés** : toujours vérifier les warnings Helm ("This chart is deprecated") et privilégier le chart activement maintenu.
- **Structure exacte des values** : quand un paramètre custom ne fonctionne pas comme attendu, `helm show values <chart>` révèle la structure exacte attendue, plutôt que de deviner.

---

## Chapitre 4 — Les 4 piliers de l'observabilité

### Vue d'ensemble et flux "how → why"
- **Metrics** répondent à "quelque chose ne va pas — quoi, où, depuis quand ?"
- **Logs** répondent à "que s'est-il passé exactement, en texte ?"
- **Traces** répondent à "quel chemin la requête a-t-elle suivi, où le temps a-t-il été perdu ?"
- **Profiling** répond à "quelle ligne de code précise consomme les ressources ?"

Le flux d'investigation standard : les métriques révèlent qu'un problème existe (le "how" — sa forme), puis logs/traces/profils expliquent pourquoi (le "why" — la cause).

### Prometheus (metrics)
Modèle de collecte par **labels** (paires clé-valeur attachées à chaque série temporelle), interrogeable en **PromQL**. Fonctionne en modèle **pull** : Prometheus va chercher activement les métriques en interrogeant périodiquement des endpoints `/metrics` — il ne reçoit jamais rien passivement. Pour qu'il scrape un nouvel endpoint, il faut un objet **ServiceMonitor** (CRD du Prometheus Operator) qui déclare explicitement où scraper.

### Loki (logs) — le choix d'indexer les labels, pas le texte
Contrairement à Elasticsearch (qui indexe chaque mot de chaque log — coûteux en disque/CPU), Loki n'indexe que les **labels** (`namespace`, `pod`, `app`...). Le contenu texte est stocké tel quel, compressé, sans index dessus.

Conséquence : une requête "logs du pod X entre 14h et 15h" est rapide (trouve directement le bon chunk via labels). Une requête "trouve le mot 'timeout' n'importe où" est plus lente (scan du texte). C'est un bon compromis pour le flux "how → why" : on sait déjà quel service regarder (la métrique l'a indiqué), on filtre par label, jamais de recherche exploratoire à l'aveugle.

**Multi-tenancy** : Loki isole les données par "tenant" via le header `X-Scope-OrgID`, envoyé sur chaque requête. Utile pour isoler les logs par équipe/produit en entreprise — sécurité et performance.

**Collecte (Alloy)** : agent qui lit les logs des conteneurs sur chaque nœud (stdout capté automatiquement par Kubernetes) et les pousse vers Loki. DaemonSet, car lecture locale par machine.

### Tempo (traces)
Une **trace** suit une requête individuelle de bout en bout à travers plusieurs services. Composée de **spans** — chaque span est une opération avec un début, une durée, et un lien vers son span parent.

**Différence fondamentale avec metrics/logs** : les traces n'existent que si une application les émet explicitement. Contrairement aux métriques (scrapées passivement) ou aux logs (générés par défaut), il n'y a pas de traces "gratuites" venant de l'infrastructure elle-même.

**Propagation de contexte (W3C traceparent)** : quand un service A appelle un service B en HTTP, l'auto-instrumentation injecte automatiquement un header `traceparent` dans la requête sortante. Le service B, via sa propre auto-instrumentation, lit ce header et rattache son span à la trace du parent au lieu d'en créer une nouvelle. Résultat : une seule trace unifiée avec plusieurs spans imbriqués, montrant visuellement où le temps a été dépensé entre services — sans une ligne de code écrite spécifiquement pour ça.

### Pyroscope (profiling continu)
Échantillonne périodiquement la pile d'appels d'une application et construit un **flamegraph** — visualisation de où le temps CPU/mémoire est réellement dépensé, au niveau du code.

**Deux modèles distincts, ne pas les mélanger** :
- **Pull** : l'app expose un endpoint pprof, un agent (Alloy) le scrape via annotations sur le Pod (`profiles.grafana.com/cpu.scrape: "true"`) — typique des applications Go.
- **Push** : un SDK dans le code de l'app envoie activement les profils vers Pyroscope (`pyroscope.configure(server_address=...)`) — utilisé pour Python. Les annotations de scraping sont inutiles et sans effet dans ce modèle.

---

## Chapitre 5 — OpenTelemetry, le standard unificateur

### Le problème sans lui
Sans standard commun, une application devrait connaître l'adresse de Prometheus, Loki, et Tempo séparément, et gérer 3 protocoles différents.

### La solution : Collector + OTLP
L'application parle un seul protocole (**OTLP** — OpenTelemetry Protocol) vers une seule adresse (le **Collector**). Le Collector reçoit tout et route chaque type de signal vers le bon backend selon sa configuration de **pipeline** (receivers → exporters).

Limite actuelle : OTLP couvre officiellement metrics/logs/traces, **pas le profiling** — Pyroscope reste un pilier à part avec son propre chemin de communication direct, car le format pprof n'est pas (encore) unifié sous OTLP dans l'écosystème.

### Auto-instrumentation vs instrumentation manuelle
- **Auto-instrumentation** : un outil (`opentelemetry-instrument`) enveloppe le lancement normal de l'app (`opentelemetry-instrument python app.py`). Il détecte les librairies connues (Flask, requests...) et leur injecte du code de tracing/métriques à la volée — zéro ligne de code OpenTelemetry écrite à la main pour ce niveau de base.
- **Instrumentation manuelle** : créer soi-même des spans/métriques à des endroits précis, pour des mesures métier custom.

### Piège du binding réseau
Un Collector doit se lier explicitement à `0.0.0.0` sur ses ports d'écoute (`endpoint: 0.0.0.0:4317`) — sinon, selon la configuration, il peut se lier uniquement à l'IP interne du Pod, rendant tout accès externe (port-forward, appels d'autres services) impossible avec une erreur "connection refused".

---

## Chapitre 6 — SLI, SLO, et Alerting

### Définitions
- **SLI** (Service Level Indicator) : une mesure quantifiable du comportement du service (ex : taux de requêtes réussies).
- **SLO** (Service Level Objective) : un seuil cible sur ce SLI (ex : "moins de 5% d'erreurs sur 5 minutes").
- **Alerte** : une règle qui se déclenche quand le SLO est violé.

### Le modèle pull et la fiabilité statistique
`rate(...[5m])` calcule un taux par seconde, moyenné sur la fenêtre indiquée. Sur un trafic très faible (2-3 requêtes isolées), cette moyenne devient peu fiable — une seule erreur au milieu de peu de requêtes fait sauter le taux à des valeurs extrêmes qui ne reflètent pas un vrai comportement systémique. Un trafic continu et soutenu est nécessaire pour que `rate()` ait un sens statistique exploitable.

### PrometheusRule et le cycle Pending → Firing
Un objet `PrometheusRule` (CRD du Prometheus Operator) définit une expression PromQL et un seuil. Le champ `for: 2m` évite qu'un pic isolé déclenche immédiatement l'alerte — la condition doit rester vraie pendant toute la durée indiquée avant que l'état passe de **Pending** (condition remplie, en observation) à **Firing** (alerte officiellement déclenchée, transmise à Alertmanager).

### Alertmanager
Reçoit les alertes en Firing émises par Prometheus et se charge de leur routage (Slack, email, PagerDuty...) — dans ce projet, le mécanisme est en place mais le routage externe n'a pas été configuré, seule la détection/déclenchement a été validée.

---

## Chapitre 7 — Méthode de diagnostic généralisable

Face à un composant qui ne démarre pas, ne communique pas, ou affiche "no data", l'ordre d'élimination qui s'est révélé efficace tout au long du projet :

1. **Espace disque / ressources globales** (`df -h`, `docker system df`, `free -h`, `nproc`)
2. **Limites système du noyau** (inotify, file descriptors, PIDs)
3. **Conflits réseau/port** (ports déjà utilisés, binding sur la mauvaise interface)
4. **Version/compatibilité des composants** (charts dépréciés, versions incompatibles entre deux outils)
5. **Config applicative précise** (YAML mal formé, paramètre manquant, exporter inexistant, mauvais filtre dans l'UI)

**Réflexe transversal le plus important** : toujours lire les vrais logs du composant concerné (`kubectl logs`, `kubectl describe` → section Events) avant de conclure à une cause. Un message d'erreur générique dans une UI ("Unable to connect", "No data") cache presque toujours une cause précise ailleurs — dans les logs applicatifs, pas dans le message affiché.

**Second réflexe** : tester la connectivité réseau directement et isolément (`kubectl exec ... curl/wget`, ou un script Python minimal) avant de blâmer le réseau — si le réseau répond correctement, le problème est ailleurs (applicatif, config, filtre UI), et il ne faut pas y retourner en boucle.
```

## ./learning-notes/module2-kubernetes-basics.md
```
# Module 2 — Kubernetes: Pods, Deployments, Services

## Pod
- Plus petite unité déployable dans K8s (un ou plusieurs conteneurs partageant réseau + stockage)
- Un Pod créé directement (`kubectl run`) est "nu" : personne ne le surveille.
  S'il est supprimé ou crashe, il ne revient jamais.

## Deployment
- Déclare un état désiré : "je veux N replicas de ce Pod, en permanence"
- Ne crée pas les Pods directement : passe par un objet intermédiaire, le ReplicaSet
- Le ReplicaSet fait la boucle de réconciliation : vérifie en continu l'état réel vs désiré,
  et recrée un Pod si un manque (testé : suppression d'un Pod géré -> nouveau Pod recréé
  en ~1 seconde, avec un nouveau nom/suffixe)
- Nom des Pods générés : <deployment>-<hash-replicaset>-<suffixe-aléatoire>
  (le hash change si l'image/config du Pod change -> permet les rollouts progressifs)

## Service
- Les Pods ont des identités éphémères (noms + IP changent à chaque recréation)
- Le Service donne une IP stable qui ne change jamais
- Il route le trafic via un système de labels/selector, pas par nom de Pod :
  chaque Pod du Deployment porte un label (ex: app=nginx-demo), le Service a un
  selector qui matche ce label -> route automatiquement vers tous les Pods correspondants,
  peu importe leur nombre ou identité

## Commandes clés testées
    kubectl run <name> --image=<image>            # Pod nu, pas de résilience
    kubectl create deployment <name> --image=<image>
    kubectl get pods / get replicasets / get services
    kubectl expose deployment <name> --port=80 --type=ClusterIP
    kubectl describe service <name>                # voir le selector
    kubectl get pods --show-labels                 # voir les labels des Pods

## Pourquoi c'est important pour le projet observability
Les noms de Pods changent constamment -> pour l'observabilité (metrics/logs/traces),
il faut filtrer/grouper par label ou par Deployment, jamais par nom de Pod exact.
```

## ./learning-notes/rapport-apprentissage-observability.md
```
# Rapport d'apprentissage — Observability Engineering
### iTransform365 / AIZO Suite — Phase 0-1 (Setup local + Metrics/Logs)

Ce rapport couvre tout ce qui a été fait, appris, cassé et réparé jusqu'à présent, dans l'ordre chronologique — pour pouvoir réviser et identifier les trous.

---

## 1. Ce qui a été construit concrètement

### Infrastructure
- Cluster Kubernetes local avec **k3d** (`observability-lab`) : 1 server + 2 agents
- Ports exposés : 8090 (HTTP), 8453 (HTTPS) — évite le conflit avec un `web_nginx` déjà sur le port 8080
- Repo Git initialisé et relié à GitHub en **SSH**

### Stack observability déployée (namespace `observability`)
| Pilier | Outil | Statut |
|---|---|---|
| Metrics | kube-prometheus-stack (Prometheus + Grafana + Alertmanager + node-exporter + kube-state-metrics) | ✅ Fonctionnel, vérifié via requête `up` |
| Logs | Loki (chart `grafana/loki`, mode SingleBinary) + Grafana Alloy (DaemonSet) | ✅ Fonctionnel, vérifié via `{namespace="observability"}` |
| Traces | Tempo | ❌ Pas encore fait |
| Profiling | Pyroscope | ❌ Pas encore fait |

---

## 2. Chronologie des erreurs rencontrées (et pourquoi c'est formateur)

Chaque erreur ci-dessous n'est pas juste un "bug résolu" — chacune illustre un concept réel que tu retrouveras en production.

### Erreur 1 — Conflit de port (8080 déjà utilisé)
- **Symptôme** : le load balancer du cluster k3d (`serverlb`) restait bloqué en "Created", ne démarrait jamais
- **Cause réelle** : un autre conteneur (`web_nginx`) occupait déjà le port 8080 sur la machine hôte
- **Diagnostic utilisé** : `docker logs`, `docker start` (pour forcer l'erreur à s'afficher), `sudo lsof -i :8080`
- **Concept à retenir** : le port **externe** (côté machine hôte) est une ressource partagée par tous les conteneurs Docker, contrairement au port **interne** (côté conteneur), qui peut être réutilisé sans conflit par différents clusters isolés dans leurs propres réseaux Docker

### Erreur 2 — Résidus de suppression incomplète
- **Symptôme** : après un `k3d cluster delete`, des conteneurs/volumes restaient bloqués ("removal already in progress", "volume in use")
- **Cause réelle** : suppression asynchrone pas encore terminée au moment de la vérification
- **Diagnostic utilisé** : `docker ps -a`, `docker volume ls`, `docker network ls` (vérifier ce qui reste), puis suppression forcée manuelle
- **Concept à retenir** : les opérations Docker/Kubernetes ne sont pas toujours instantanées — toujours re-vérifier l'état réel avant de conclure qu'une commande a échoué

### Erreur 3 (le vrai bug de fond) — Limite système `inotify` trop basse
- **Symptôme** : dès qu'un cluster avait **au moins un agent**, son containerd restait bloqué indéfiniment (`Waiting for containerd startup`), et le load balancer échouait en cascade (`stat /etc/confd/values.yaml: no such file`)
- **Cause réelle** : `fs.inotify.max_user_instances` était à la valeur par défaut (128), une limite **globale à tout l'utilisateur sur la machine**, insuffisante quand plusieurs nœuds Kubernetes tournent en parallèle (chacun consomme sa part du quota)
- **Diagnostic utilisé** (par élimination méthodique) :
  1. Écarté : espace disque (`df -h`, `docker system df`)
  2. Isolé la variable en cause : `k3d cluster create` sans agents → marche ; avec 1 agent → bloque (donc le problème vient bien des agents, pas des autres flags)
  3. Écarté : CPU/RAM (`docker stats`, `nproc`, `free -h`)
  4. Trouvé : `cat /proc/sys/fs/inotify/max_user_instances` → 128 (valeur par défaut connue pour être trop basse)
- **Résolution** : `sudo sysctl fs.inotify.max_user_instances=512` + rendu permanent dans `/etc/sysctl.conf`
- **Concept à retenir (le plus important de toute la session)** : face à un composant qui ne démarre jamais, la méthode de diagnostic est un ordre d'élimination — **espace disque → CPU/RAM → limites noyau (inotify, file descriptors, PIDs) → conflits réseau/port → config applicative**. Ne jamais deviner, toujours vérifier chaque couche.

### Erreur 4 — Cluster disparu sans raison apparente
- **Symptôme** : après une pause, `docker ps -a` ne montrait plus aucun conteneur du cluster, alors que `uptime` prouvait qu'il n'y avait pas eu de redémarrage machine
- **Cause réelle** : jamais identifiée avec certitude (probablement une suppression manuelle accidentelle pendant les tests répétés) — les logs Docker (`journalctl -u docker`) n'ont montré que les créations, pas de suppression explicite
- **Concept à retenir** : parfois il faut accepter de ne pas trouver la cause exacte et se concentrer sur la remédiation (nettoyer le kubeconfig fantôme, recréer) plutôt que de creuser indéfiniment — un réflexe de triage important en debug réel

### Erreur 5 — Version incompatible entre Grafana et Loki
- **Symptôme** : "Unable to connect with Loki" dans Grafana, malgré un `wget` réussi depuis l'intérieur du Pod Grafana vers Loki (donc pas un problème réseau)
- **Cause réelle** : le chart `grafana/loki-stack` (obsolète) déployait Loki en version **2.6.1** (2022), trop ancienne pour parser correctement les requêtes de health-check envoyées par la version récente de Grafana — erreur exacte : `parse error at line 1, col 1: syntax error: unexpected IDENTIFIER`
- **Diagnostic utilisé** : test de connectivité réseau direct (`kubectl exec ... wget`) pour éliminer l'hypothèse réseau, puis lecture des vrais logs Grafana (`kubectl logs`) plutôt que le message générique de l'UI
- **Résolution** : remplacement par le chart maintenu `grafana/loki` (v7.1.0, Loki 3.6.8), avec `deploymentMode: SingleBinary` et `loki.useTestSchema=true`
- **Concept à retenir** : un message d'erreur générique dans une UI ("Unable to connect") cache souvent une cause plus précise dans les logs du service concerné — toujours creuser les vrais logs avant de conclure

### Erreur 6 — Mode de déploiement Loki mal configuré
- **Symptôme** : après la migration vers le nouveau chart, le Pod principal de Loki n'apparaissait pas (seulement les composants secondaires : cache, gateway, canary)
- **Cause réelle** : le paramètre `deploymentMode` n'avait pas été explicitement fixé à `SingleBinary`, donc le chart restait sur son mode par défaut (distribué, read/write/backend séparés) malgré `singleBinary.replicas=1`
- **Concept à retenir** : dans Helm, régler un sous-paramètre (`singleBinary.replicas`) ne suffit pas toujours — il faut parfois aussi activer explicitement le "mode" global qui active cette section de la config

### Erreur 7 — Multi-tenancy Loki non configurée dans Grafana
- **Symptôme** : après avoir corrigé la version, la connexion Loki-Grafana échouait encore (`404 no org id`) au moment d'envoyer des vraies requêtes
- **Cause réelle** : le nouveau chart Loki active la multi-tenancy par défaut, exigeant un header `X-Scope-OrgID` sur chaque requête
- **Résolution** : ajout du header `X-Scope-OrgID: foo` dans la config de la data source Grafana
- **Concept à retenir** : la multi-tenancy isole les données par "tenant" (équipe/produit) — utile en entreprise pour la sécurité (une équipe ne voit pas les logs d'une autre) et la performance (requêtes limitées à un tenant)

### Erreur 8 — Échec de pull d'image (`ErrImagePull`) pour Alloy
- **Symptôme** : les 3 Pods Alloy (DaemonSet) restaient bloqués en `ContainerCreating` puis `ErrImagePull` pendant plusieurs minutes
- **Cause réelle** : coupure réseau transitoire pendant le téléchargement de l'image depuis Docker Hub (`connection reset by peer`) — confirmé en testant un `docker pull` direct sur la machine hôte, qui a réussi sans problème
- **Diagnostic utilisé** : `kubectl describe pod` (section Events) pour voir l'erreur précise, puis test de connectivité Docker Hub (`curl -I`), puis test de pull direct hors cluster pour isoler si le souci était spécifique au réseau interne k3d ou général
- **Résolution** : suppression des Pods bloqués pour forcer un nouveau pull (Kubernetes retente automatiquement avec un backoff) — a fini par réussir sans intervention manuelle supplémentaire
- **Concept à retenir** : Kubernetes retente automatiquement les pulls d'image échoués (backoff exponentiel) — pas toujours besoin d'intervenir immédiatement, mais utile de savoir forcer une nouvelle tentative en supprimant le Pod concerné (le contrôleur — ici le DaemonSet — le recrée aussitôt)

---

## 3. Concepts appris (récapitulatif classé par thème)

### Docker / conteneurs
- Un conteneur isole un processus via **namespaces** (vue isolée réseau/PID/filesystem) et **cgroups** (limites CPU/RAM), sans dupliquer le noyau — plus léger qu'une VM
- Une image est construite en **couches (layers)** empilées, chacune cachée par Docker ; l'ordre des instructions dans un Dockerfile impacte directement l'efficacité du cache (mettre ce qui change le moins souvent en premier)
- Un conteneur arrêté existe toujours (`docker ps -a` le montre) jusqu'à suppression explicite

### Kubernetes — objets de base
- **Pod** : plus petite unité déployable ; un Pod créé "nu" (`kubectl run`) n'est surveillé par personne et ne revient jamais s'il est supprimé
- **Deployment → ReplicaSet → Pods** : le Deployment ne crée jamais directement de Pods, il passe par un ReplicaSet intermédiaire qui applique la **boucle de réconciliation** (état réel vs état désiré, recréation automatique)
- **Service** : adresse stable qui route via un système de **labels/selector** plutôt que par nom de Pod (les noms de Pods changent à chaque recréation)
- **DaemonSet** : garantit exactement 1 Pod par nœud — utilisé pour tout ce qui doit lire des données **locales à chaque machine** (node-exporter, Alloy/Promtail)
- **StatefulSet** : garantit une identité stable + stockage persistant lié à cette identité — utilisé pour tout ce qui **stocke des données** avec besoin de cohérence (Loki, Prometheus, Alertmanager)
- **kubeconfig et contextes** : `kubectl` ne parle qu'à un seul cluster à la fois, celui du contexte actif (`kubectl config get-contexts` / `use-context`)
- **DNS interne du cluster (CoreDNS)** : un Service est joignable par son nom depuis n'importe quel Pod du cluster (ex: `http://loki:3100`), mais ce nom n'existe que dans le réseau virtuel interne — inutilisable depuis l'extérieur (ta machine) sans port-forward

### Helm
- Un **chart** = paquet préassemblé de manifests Kubernetes avec des valeurs configurables ; une **release** = instance déployée d'un chart, dont Helm garde la trace complète pour permettre suppression/mise à jour propres en une commande
- Toujours vérifier qu'un repo est ajouté (`helm repo add` + `helm repo update`) avant d'installer un chart
- `helm upgrade` permet de modifier une release existante sans tout redéployer depuis zéro

### Prometheus
- Modèle de collecte par **labels**, requêtable en PromQL (ex: `up`)
- `node-exporter` (infra) et `kube-state-metrics` (état des objets K8s) sont deux sources de métriques complémentaires

### Loki
- Choix d'architecture clé : Loki n'indexe que les **labels**, pas le texte complet des logs (contrairement à Elasticsearch) — beaucoup moins cher, mais moins bon pour une recherche exploratoire de type "cherche ce mot n'importe où"
- Bon compromis pour le flux d'investigation "how → why" : on sait déjà quel service regarder (la métrique l'a indiqué), donc filtrer par label est suffisant
- La **multi-tenancy** (header `X-Scope-OrgID`) isole les logs par équipe/produit

### Réseau interne Kubernetes
- Différence entre port **interne** (côté conteneur, réutilisable par différents clusters isolés) et port **externe** (côté machine hôte, ressource partagée, source de conflits)

---

## 4. Concepts que tu as manqués ou mal compris en cours de route (à retravailler)

Ce sont les points où une hésitation ou une fausse piste est apparue — vaut le coup de les revoir activement.

1. **DaemonSet vs StatefulSet — critère de choix** : tu avais initialement retenu "le nom dynamique vs stable" comme LE critère de différenciation. Ce n'est qu'une conséquence secondaire — le vrai critère est **la garantie fournie** (1 par nœud vs identité+stockage stable). À revoir : relire la distinction et être capable de l'expliquer sans mentionner les noms en premier.

2. **Confusion transmise par une tierce source** : tu as reçu l'information "on utilise StatefulSet à cause des noms dynamiques" de ton mentor, information qui semblait viser un autre composant (probablement Loki, qui est bien un StatefulSet) mais appliquée à tort à Alloy/Promtail (qui doivent être des DaemonSets). Point de vigilance générale : toujours vérifier qu'une recommandation s'applique bien au composant précis dont on parle, pas juste au sujet général.

3. **Distinction port interne/externe dans le mapping Docker** (`8090:80@loadbalancer`) : ce concept a demandé plusieurs allers-retours avant d'être clair — à vérifier que tu peux l'expliquer sans hésitation : pourquoi deux clusters différents peuvent utiliser le même port interne sans conflit.

4. **`helm upgrade` avec sous-paramètres vs mode global** : le cas Loki (`singleBinary.replicas=1` insuffisant sans `deploymentMode=SingleBinary`) est un piège classique de Helm — beaucoup de charts ont un paramètre "mode" de haut niveau qui doit être explicitement activé, en plus des sous-paramètres détaillés. Bon réflexe à généraliser : quand un chart complexe ne se comporte pas comme attendu, vérifier avec `helm get values` puis chercher s'il existe un paramètre de mode/type global dans la doc du chart.

5. **Lire les vrais logs applicatifs avant de conclure à un problème réseau** : dans le cas Loki/Grafana, le réflexe initial pouvait être de re-tester le réseau en boucle — mais la vraie réponse était dans `kubectl logs` du Pod Grafana. À généraliser : quand un test réseau direct (`wget`/`curl` depuis le Pod) réussit mais que l'application signale toujours une erreur, le problème est presque toujours applicatif (format de requête, version, auth), pas réseau — chercher dans les logs applicatifs en priorité à ce stade.

---

## 5. Ce qu'il reste à couvrir (gaps pour la suite du projet)

D'après le cahier des charges officiel, en Phase 1 il manque encore :

- **Tempo** (traces distribuées) — pas encore abordé du tout
- **Pyroscope** (profiling continu) — pas encore abordé du tout
- **OpenTelemetry Collector** — concept mentionné en théorie (au tout début), jamais déployé concrètement
- **Une application démo instrumentée** — jusqu'ici, seule l'observabilité *de l'infrastructure elle-même* a été testée (Prometheus/Loki s'observent eux-mêmes) ; aucune app à toi n'a encore émis de métriques/logs/traces custom
- **Exemplars** (lien metrics↔traces) — dépend de Tempo + une app instrumentée
- **SLIs/SLOs concrets + règles d'alerte** — Alertmanager est déployé mais complètement vide de règles pour l'instant
- Le concept d'**OpenTelemetry SDK** (auto-instrumentation vs instrumentation manuelle) n'a pas encore été pratiqué

Ces manques sont normaux à ce stade — ils correspondent simplement à la suite logique du parcours (Tempo → Pyroscope → app démo → OTel → SLOs), pas à des erreurs de parcours.
```

## ./learning-notes/RAPPORT-FINAL-PHASE1.md
```
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
```

## ./learning-notes/RAPPORT-FINAL-PHASE1-MENTOR.md
```
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
```

## ./learning-notes/RECAP-MEET-MENTOR.md
```
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
```

## ./learning-notes/RUNBOOK-FINAL.md
```
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
```

## ./learning-notes/runbook-observability-setup.md
```
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
```

## ./learning-notes/RUNBOOK-v2.md
```
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
```

## ./learning-notes/session-metrics-pipeline.md
```
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
```

## ./report.txt
```
1. version docker : 

iyed@iyedM:~/iTransform365$ docker version
Client: Docker Engine - Community
 Version:           29.4.3
 API version:       1.54
 Go version:        go1.26.2
 Git commit:        055a478
 Built:             Wed May  6 17:07:36 2026
 OS/Arch:           linux/amd64
 Context:           default

2. K3d now ( install it witrh curl)

iyed@iyedM:~/iTransform365$ k3d version
k3d version v5.9.0
k3s version v1.35.5-k3s1 (default)
iyed@iyedM:~/iTransform365$ 

3. kubectl:
iyed@iyedM:~/iTransform365$ kubectl version --client
Client Version: v1.32.13
Kustomize Version: v5.5.0
iyed@iyedM:~/iTransform365$ 

4. Helm:

iyed@iyedM:~/iTransform365$ helm version
version.BuildInfo{Version:"v3.21.3", GitCommit:"1ad6e68924fdf6fb0c7dcef8e9e1dfc0f36eaed6", GitTreeState:"clean", GoVersion:"go1.26.5"}
iyed@iyedM:~/iTransform365$ 


5. k9s : terminal ui for k8s 


II.Creating the cluster :

1.:
k3d cluster create observability-lab \
  --agents 2 \
  --port "8080:80@loadbalancer" \
  --port "8443:443@loadbalancer" \
  --k3s-arg "--disable=traefik@server:0"   # optional: disable default ingress if you'll use your own
  
  
  . 
  poblems i met:
  D'abord, confirmation : ton cluster final est créé en 24 secondes, propre, sans aucune erreur cette fois — exactement la commande qu'on visait depuis le début. Vérifie juste pour clôturer :

```bash
docker ps -a --filter "name=k3d-observability-lab"
kubectl get nodes
```

Tu devrais voir `server-0`, `agent-0`, `agent-1`, et `serverlb` tous "Up", et `kubectl get nodes` listant 3 nœuds Ready.

---

## Réponse à la question posée

Le premier essai avec `kind-mycluster` qui tournait encore (3 nœuds en plus) était plus susceptible de buter sur la limite inotify parce que **chaque nœud actif consomme une part fixe du quota `max_user_instances`**, qui est une limite **globale par utilisateur sur toute la machine**, pas par cluster. Donc kind (3 nœuds) + k3d (3 nœuds server+2agents) tournaient en même temps et se partageaient un quota de seulement 128 — largement insuffisant. Une fois kind supprimé, il restait de la marge, mais toujours pas assez pour un agent k3d en plus du serveur — d'où le fix définitif : augmenter la limite elle-même plutôt que de juste réduire le nombre de nœuds.

---

## Post-mortem complet de la session de debug

### Problème 1 — Conflit de port (8080 déjà utilisé)
**Symptôme** : `k3d-observability-lab-serverlb` restait bloqué en statut `Created`, ne démarrait jamais.
**Erreur clé** :
```
Bind for 0.0.0.0:8080 failed: port is already allocated
```
**Commandes de vérification** :
```bash
docker ps -a --filter "name=k3d-observability-lab"   # a montré serverlb en "Created" au lieu de "Up"
docker logs k3d-observability-lab-serverlb            # vide -> jamais vraiment démarré
docker start k3d-observability-lab-serverlb           # a révélé l'erreur de port en clair
sudo lsof -i :8080                                    # a identifié le process en conflit
docker ps --format "table {{.Names}}\t{{.Ports}}" | grep 8080   # a identifié web_nginx comme coupable
```
**Résolution** : recréer le cluster avec un port hôte différent (`8090:80` au lieu de `8080:80`) plutôt que de toucher au conteneur `web_nginx` existant.

### Problème 2 — Résidus de suppression incomplète
**Symptôme** : après un `k3d cluster delete`, des conteneurs/volumes restaient bloqués dans un état intermédiaire, provoquant des erreurs en cascade sur les tentatives suivantes.
**Erreur clé** :
```
removal of container ... is already in progress
volume is in use - Try to delete it manually
```
**Commandes de vérification/nettoyage** :
```bash
docker ps -a --filter "name=k3d-observability-lab"
docker volume ls | grep k3d-observability-lab
docker network ls | grep k3d-observability-lab
docker rm -f $(docker ps -a -q --filter "name=k3d-observability-lab")
docker volume rm -f k3d-observability-lab-images
docker network rm k3d-observability-lab
```
**Résolution** : nettoyage manuel forcé des résidus avant de recréer.

### Problème 3 (le vrai bug de fond) — Limite système `inotify` trop basse
**Symptôme** : dès qu'un cluster avait **au moins un agent**, son containerd restait bloqué indéfiniment (`Waiting for containerd startup: rpc error: ... Unimplemented ... RuntimeService`), pendant que le load balancer, lui, échouait à lire sa config (`stat /etc/confd/values.yaml: no such file or directory`) faute de pouvoir terminer son initialisation en parallèle.
**Démarche de diagnostic** (par élimination, variable par variable) :
```bash
df -h /var/lib/docker              # écarté : espace disque OK
docker system df                   # écarté : rien d'anormal
k3d cluster create test-clean      # sans options -> a marché (0 agent)
k3d cluster create obs-lab --agents 0    # a marché aussi
k3d cluster create obs-lab --agents 1    # a bloqué -> le coupable est l'agent, pas les autres flags
docker stats --no-stream / nproc / uptime / free -h   # écarté : CPU et RAM largement dispo
cat /proc/sys/fs/inotify/max_user_instances   # -> 128, valeur par défaut trop basse
```
**Résolution** :
```bash
sudo sysctl fs.inotify.max_user_instances=512
sudo sysctl fs.inotify.max_user_watches=524288
echo "fs.inotify.max_user_instances=512" | sudo tee -a /etc/sysctl.conf
echo "fs.inotify.max_user_watches=524288" | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```
Combiné à la suppression de `kind-mycluster` (qui consommait sa part du même quota), ça a définitivement débloqué le démarrage des agents.

---

## La leçon à retenir, au-delà de ce bug précis

Face à un pod/nœud/conteneur qui ne démarre jamais : élimine dans cet ordre — **espace disque → CPU/RAM → limites système du noyau (inotify, file descriptors, PIDs) → conflits réseau/port → config applicative**. C'est un réflexe de debug Kubernetes qui reviendra très souvent, bien au-delà de k3d.

Tu es prêt à continuer sur le Module 2 (Kubernetes : pods, services, deployments) quand tu veux, ou on peut enchaîner directement sur le déploiement de kube-prometheus-stack sur ce cluster maintenant qu'il est stable.






```

## ./scripts/start-port-forwards.sh
```
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
```

## ./scripts/start-port-forwards-tmux.sh
```
#!/bin/bash
# Lance tous les port-forwards dans une seule session tmux organisée en panneaux.
# Prérequis : sudo apt install tmux
# Usage : ./start-port-forwards-tmux.sh
# Pour revenir dessus plus tard : tmux attach -t observability

NAMESPACE="observability"
SESSION="observability"

# Si la session existe déjà, on s'y attache directement plutôt que d'en recréer une
if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "La session tmux '$SESSION' existe déjà. Connexion..."
    tmux attach -t "$SESSION"
    exit 0
fi

# Crée la session avec la première fenêtre/panneau : Grafana
tmux new-session -d -s "$SESSION" -n "observability" \
    "kubectl port-forward -n $NAMESPACE svc/kube-prom-grafana 3000:80"

# Découpe en panneaux successifs pour les autres services
tmux split-window -h -t "$SESSION" \
    "kubectl port-forward -n $NAMESPACE svc/otel-collector-opentelemetry-collector 4317:4317"

tmux split-window -v -t "$SESSION" \
    "kubectl port-forward -n $NAMESPACE svc/otel-collector-opentelemetry-collector 8889:8889"

tmux select-pane -t "$SESSION":0.0
tmux split-window -v -t "$SESSION" \
    "kubectl port-forward -n $NAMESPACE svc/demo-frontend 8082:8082"

tmux select-pane -t "$SESSION":0.1
tmux split-window -v -t "$SESSION" \
    "kubectl port-forward -n $NAMESPACE svc/demo-api 8081:8081"

tmux select-pane -t "$SESSION":0.2
tmux split-window -h -t "$SESSION" \
    "kubectl port-forward -n $NAMESPACE svc/kube-prom-kube-prometheus-prometheus 9090:9090"

tmux select-pane -t "$SESSION":0.4
tmux split-window -h -t "$SESSION" \
    "kubectl port-forward -n $NAMESPACE svc/kube-prom-kube-prometheus-alertmanager 9093:9093"

tmux split-window -v -t "$SESSION" \
    "kubectl port-forward -n $NAMESPACE svc/loki-gateway 3100:80"

# Réorganise proprement en grille (tiled = répartition égale façon mosaïque)
tmux select-layout -t "$SESSION" tiled

echo "Session tmux '$SESSION' créée avec les 8 port-forwards."
echo ""
echo "Connexion à la session..."
sleep 1
tmux attach -t "$SESSION"
```

## ./scripts/stop-port-forwards.sh
```
#!/bin/bash
# Arrête tous les port-forwards lancés par start-port-forwards.sh

PID_FILE="$HOME/.port-forwards.pids"

if [ ! -f "$PID_FILE" ]; then
    echo "Aucun fichier de PIDs trouvé ($PID_FILE) — rien à arrêter."
    exit 0
fi

echo "Arrêt des port-forwards..."
while read -r pid; do
    if kill "$pid" 2>/dev/null; then
        echo "  PID $pid arrêté"
    else
        echo "  PID $pid déjà arrêté ou introuvable"
    fi
done < "$PID_FILE"

rm -f "$PID_FILE"
echo "Terminé."
```

## ./scripts/stop-port-forwards-tmux.sh
```
#!/bin/bash
# Arrête tous les port-forwards en tuant la session tmux entière.

SESSION="observability"

if tmux has-session -t "$SESSION" 2>/dev/null; then
    tmux kill-session -t "$SESSION"
    echo "Session tmux '$SESSION' arrêtée — tous les port-forwards sont coupés."
else
    echo "Aucune session tmux '$SESSION' active."
fi
```

