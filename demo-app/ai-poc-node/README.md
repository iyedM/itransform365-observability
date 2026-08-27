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
