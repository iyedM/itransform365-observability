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
