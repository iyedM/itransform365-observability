# Sorties de la solution — Observability AIZO Adviser
### Document technique complet : ce que produit concrètement l'instrumentation

**Branche** : `feat/observability-instrumentation`
**Repo** : `aizo-adviser-ai-prod`

---

## 1. Ce qui a été ajouté au code — explication complète

Deux nouveaux fichiers ont été créés, et deux fichiers existants ont été
légèrement modifiés — sans toucher à la logique métier existante.

### 1.1 `app/core/tracing.py` (nouveau fichier)

Ce fichier active le **tracing automatique** de tout le graphe LangGraph.
Une seule ligne fait le vrai travail : `LangChainInstrumentor().instrument()`
— elle dit à Python de surveiller automatiquement tous les appels LangChain
dans tout le programme, sans qu'on ait besoin de modifier `router.py`,
`chatbot.py`, `tools.py`, etc.

Sécurité intégrée : si la variable d'environnement
`OTEL_EXPORTER_OTLP_ENDPOINT` n'est pas définie, cette fonction ne fait
rien du tout — l'application démarre normalement, sans tracing. Aucun
risque de casser un environnement qui n'a pas encore configuré
l'observabilité.

### 1.2 `app/core/metrics.py` (nouveau fichier)

Ce fichier compte et chronomètre chaque appel au modèle de langage. La
technique utilisée : on enveloppe l'objet LLM retourné par
`get_llm(task_name)` — chaque appel `.invoke()`/`.ainvoke()` est
automatiquement chronométré et comptabilisé, sans avoir à modifier les
fichiers qui utilisent ce LLM (`chatbot.py`, `router.py`, etc. restent
inchangés).

Un détail technique rencontré et résolu : `ChatOpenAI` est un objet
Pydantic, qui interdit normalement d'ajouter des attributs non prévus.
On a contourné ça proprement avec `object.__setattr__()`, une technique
standard pour ce genre de cas.

Même sécurité que le tracing : désactivé si la variable d'environnement
n'est pas configurée.

### 1.3 `app/main.py` (modifié — 2 lignes ajoutées)

Les deux fonctions ci-dessus sont appelées au démarrage de l'application,
juste avant que le graphe LangGraph ne soit construit :
```
setup_tracing()
setup_metrics()
workflow = build_graph()
```

### 1.4 `app/utils/llm_loader.py` (modifié — 1 import + 3 petits ajouts)

Le fichier `llm_loader.py` a une fonction `get_llm(task_name)` qui crée
l'objet LLM selon le provider utilisé (OpenAI, vLLM, ou LiteLLM — 3
branches de code). Dans chacune de ces 3 branches, juste avant de renvoyer
l'objet créé, on l'enveloppe avec la fonction de métriques :
```
llm = ChatOpenAI(**kwargs)
return wrap_llm_with_metrics(llm, task_name)
```
C'est le seul endroit du code métier touché, et c'est un ajout minimal
(2 lignes par branche), aucune ligne supprimée.

### Résumé du périmètre de changement

- 2 nouveaux fichiers
- 2 fichiers existants avec des ajouts minimes (aucune suppression)
- Zéro changement dans la logique métier réelle (router, chatbot, tools,
  memory, etc.)

---

## 2. Ce que le tracing produit concrètement — exemple réel

Voici une vraie trace, générée aujourd'hui, avec le vrai code de
production, lors d'un test local. Trace ID :
`eae39c82ee6be9c9011146972516247`, durée totale **3.41 secondes**, **12
spans**, dont **2 en erreur**.

### Ce qu'on voit dans cette trace précise

```
LangGraph (3.41s) — la conversation complète
├─ router (880ms)                    → classification de la requête
├─ RunnableSequence → ChatOpenAI (650ms)   → premier appel au modèle
├─ chatbot (656ms) → ChatOpenAI + chatbot_logic
├─ tools → lookup_documents (559ms)  → l'IA a demandé un outil de recherche
│                                       documentaire — CET APPEL A ÉCHOUÉ
│                                       (clé API embeddings manquante en local)
└─ chatbot (1.3s) → ChatOpenAI + chatbot_logic
                                     → le système est REVENU vers le
                                       chatbot pour se rattraper et
                                       répondre quand même à l'utilisateur,
                                       malgré l'échec de l'outil
```

### Pourquoi cet exemple est particulièrement parlant

Cette trace ne montre pas juste un cas simple qui fonctionne — elle montre
le système **en train de gérer un vrai échec** en conditions réelles :
un outil a échoué (`lookup_documents`), et on voit exactement, avec les
timings précis, comment le graphe a réagi (retour au chatbot, nouvelle
tentative, réponse quand même donnée à l'utilisateur). C'est exactement
le genre de situation qu'on veut pouvoir diagnostiquer rapidement en
production — ici, on voit immédiatement où et pourquoi ça a échoué, sans
avoir à fouiller dans des logs texte.

### Ce que chaque span contient en détail

Pour chaque appel au modèle (`ChatOpenAI`), les informations suivantes
sont capturées automatiquement, sans code supplémentaire :
- Le nom exact du modèle utilisé (ici `qwen3.6-35b`, via le gateway LiteLLM)
- Le nombre de tokens consommés (prompt et réponse, séparément)
- La durée exacte de l'appel
- Le statut (succès ou erreur)

---

## 3. Ce que les métriques produisent concrètement — vrais chiffres

### 3.1 Taux de succès/erreur, par tâche

Sur une série de tests locaux avec le vrai code de production :

- `router` : 7 erreurs enregistrées
- `chatbot` : 8 succès, 0 erreur
- `memory_summary` : 1 succès

Ces chiffres sont filtrables et agrégeables dans le temps — on peut par
exemple calculer un taux d'erreur en pourcentage sur une fenêtre glissante
de 5 minutes, comme on le fait déjà pour le reste de l'infrastructure.

### 3.2 Consommation de tokens, par tâche

Exemple réel observé sur la tâche `memory_summary` :
- 1528 tokens de prompt (ce qui a été envoyé au modèle)
- 469 tokens de réponse (ce que le modèle a généré)

Séparer prompt et completion permet un suivi de coût précis, puisque les
deux types de tokens sont généralement facturés différemment selon le
provider.

### 3.3 Latence

Le mécanisme de mesure de latence est fonctionnel — chaque appel LLM est
chronométré et exporté sous forme d'histogramme vers Prometheus, ce qui
permet de calculer des percentiles (p50, p95, p99) comme on le fait déjà
pour le reste de l'infrastructure de la Phase 1. Sur les tests réalisés
jusqu'ici, le volume de requêtes était encore un peu faible pour que le
calcul du p95 se stabilise statistiquement — c'est un comportement normal
de Prometheus avec peu de données, pas un défaut du mécanisme lui-même.

---

## 4. Vérifications déjà faites sur l'infrastructure réelle

- **Tempo (traces)** : namespace `tempo` sur le cluster de production
  (`aizoplan-mgt`), connecté à un vrai bucket OVH Object Storage,
  rétention configurée à 7 jours. Une vraie trace a été confirmée écrite
  dans ce bucket de production cette semaine.
- **Grafana de production** (`grafana.itransform365.com`) : accès obtenu
  et vérifié. Data sources actuellement configurées : Loki (logs) et
  Pyroscope (profiling) apparaissent dans le menu. **Tempo n'est pas
  encore branché comme data source visible dans ce Grafana**, même si les
  données y sont bien stockées côté infrastructure — un point à ajouter
  pour rendre les traces consultables visuellement en production, pas
  seulement en local.
- **Prometheus (métriques)** : vérifié, **n'existe pas encore** sur le
  Grafana de production. Les métriques ne peuvent donc être validées qu'en
  local pour l'instant, en attendant que cette pièce d'infrastructure soit
  ajoutée côté production.
