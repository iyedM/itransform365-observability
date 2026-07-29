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
