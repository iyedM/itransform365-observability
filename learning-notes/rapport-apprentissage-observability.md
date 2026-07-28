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
