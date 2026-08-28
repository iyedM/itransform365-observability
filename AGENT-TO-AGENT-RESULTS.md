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
