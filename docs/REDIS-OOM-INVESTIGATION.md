# Investigation ciblée de l’arrêt Redis sans preuve OOM

Ce workflow manuel est séparé de la CI principale et ne modifie pas le test de production `deploy/redis-memory.integration.mjs`. Il compare uniquement deux façons d’écrire dans un Redis isolé, avec une limite cgroup identique de 48 MiB : `docker exec redis-cli --pipe` (client dans le cgroup Redis) et un client Redis dans un conteneur séparé partageant seulement son espace réseau.

Le workflow peut être lancé manuellement ou par `pull_request` lorsque l’un des trois fichiers d’investigation change. Il utilise `pull_request`, jamais `pull_request_target`.

Le workflow utilise `redis:7.4.12-alpine`, comme le run PR 42146210252, et consigne le digest, la version du noyau, le runtime Docker/cgroup et la version Redis. Chaque scénario est borné à 96 écritures de 1 MiB, 30 secondes d’alimentation et 5 secondes d’attente de fermeture du client. Un remplisseur encore vivant n’est pas tué pour fabriquer un résultat OOM.

Avant le remplissage, le script ouvre les fichiers cgroup accessibles (`memory.current`, `memory.peak`, `memory.max`, `memory.events`, `memory.events.local`, `memory.oom.group`, `cgroup.procs`) et conserve les descripteurs pour tenter une lecture après la sortie. Il échantillonne les processus membres, leurs états, RSS et scores OOM ; il conserve aussi les événements Docker, `inspect`, `stats`, `top` et les logs du conteneur avant tout redémarrage ou nettoyage. Les données vont dans un artefact de 14 jours. Les lignes de commande sont réduites aux noms de processus et aucun environnement ou contenu de secret n’est collecté.

Un code 137, `EPIPE` ou l’événement Docker `die` ne prouve pas un OOM. La sortie diagnostique rapporte séparément `State.OOMKilled`, événements `oom` et compteurs cgroup. Si le conteneur s’est arrêté, le script tente ensuite un redémarrage pour constater l’état du témoin AOF, sans présenter cette observation comme une preuve de la cause de l’arrêt.

## Limites

Le workflow établit une comparaison sur le runner GitHub Linux disponible au moment de l’exécution ; il ne prouve pas la cause d’un run antérieur à moins que la même signature soit reproduite. Les descripteurs ouverts ne garantissent pas que le noyau conserve un cgroup supprimé lisible : l’artefact enregistre explicitement les fichiers et lectures disponibles. Les événements noyau et journaux `dmesg` peuvent être interdits sur le runner. Une absence de compteurs post-sortie laisse la cause indéterminée.

Dans le run 42146210252, le dernier échantillon cgroup était de 46 809 088 octets, soit environ **44,6 Mio**, sur une limite de 48 Mio. Les compteurs visibles à cet échantillon étaient nuls ; cette valeur ne constitue pas une preuve d’OOM.

Déclencher **Redis OOM investigation** manuellement depuis GitHub Actions sur la branche à examiner. Ne pas substituer ce diagnostic au test strict qui exige `OOMKilled=true` et un événement Docker `oom`.
