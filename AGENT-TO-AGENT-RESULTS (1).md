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
