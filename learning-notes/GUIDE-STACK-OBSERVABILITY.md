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
