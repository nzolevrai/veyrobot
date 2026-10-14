# Banc de charge local (hors Discord)

Ce document conserve la référence historique **PostgreSQL seul** du 13 octobre. La [revue du 14 octobre](RELIABILITY-REVIEW-2026-10-14.md) ajoute des essais API, BullMQ avec HTTP simulé, objets discord.js, plans SQL et leurs limites. Aucun de ces bancs ne mesure la capacité Gateway ou REST Discord réelle.

## Reproduction

Avec PostgreSQL local démarré et les migrations à jour :

```powershell
$env:BENCH_EVENTS_PER_PROFILE='20000'
$env:BENCH_CONCURRENCY='16'
$env:BENCH_MAX_RSS_MB='512'
corepack pnpm --filter @veyrobot/db benchmark
```

Le banc écrit de vrais dossiers dans PostgreSQL, simule leur acquisition puis leur achèvement, mesure une requête de réconciliation et supprime uniquement les dossiers dont `operationId` porte son UUID de run. Il n'appelle ni Discord, ni BullMQ. Chaque profil injecte autant d'événements : 1 000 serveurs à faible activité, 10 serveurs chargés, un seul serveur en rafale. Les profils sont intercalés de manière déterministe et les écritures utilisent une concurrence maximale de 16 avec un pool PostgreSQL de 10.

## Résultat observé

Run du 13 octobre 2026, Node 24.21.0, Windows 10.0.26300 x64, Intel Core i5-1135G7 2.40 GHz (8 CPU logiques), 16.9 Go RAM visible. PostgreSQL 17.11 tournait dans le conteneur Docker `postgres:17-alpine` local; le bench et le serveur DB partageaient la machine de développement.

| Mesure | Valeur |
|---|---:|
| Durée / volume | 43,797 s / 60 000 dossiers simulés |
| Débit agrégé | 1 370 transitions de dossier/s |
| Latence SQL par dossier (insert + claim + finish) | p50 10,96 ms · p95 16,39 ms · p99 22,03 ms |
| Attente dans la file simulée (lots préchargés) | p50 21,41 s · p95 41,45 s · p99 43,23 s |
| Profils | 20 000 événements chacun; p95 15,09 / 16,83 / 16,80 ms |
| Requêtes PostgreSQL comptées par le banc | 180 002 |
| Réconciliation vide/locale | 16,55 ms, 9 demandes préexistantes non liées au bench observées |
| Pool PostgreSQL | max 10, 10 connexions ouvertes/idle au terme, 6 requêtes en attente observées |
| CPU processus | 9,954 s utilisateur + 9,375 s système |
| Retard event loop | p95 10,99 ms · maximum 24,04 ms |
| Mémoire | RSS en fin de rapport 142,5 Mo; maximum échantillonné toutes les 25 ms 116,5 Mo; budget configuré 512 Mo, atteint par aucun échantillon |
| File simulée | profondeur initiale maximale 60 000 |

Le RSS de fin est supérieur au dernier pic échantillonné; il constitue la borne observée conservatrice de ce run, pas un profil de pic exact. Le script a depuis été durci pour comparer également le RSS observé en fin de mesure au budget configurable.

Après ce run, validation reproductible courte du 13 octobre 2026 avec le même matériel : 6 000 dossiers (2 000 par profil), pool 10, concurrence 16, 4,034 s, 1 487 dossiers/s, p50/p95/p99 10,29/13,74/16,62 ms, 94,3 Mo RSS final, 94,5 Mo pic échantillonné, 1,203 s CPU utilisateur + 0,750 s système, event loop p95/max 10,82/13,18 ms, attente pool maximale observée 6 et réconciliation 2,48 ms. Le budget de 512 MiB a passé. La variation par rapport au run de 60 000 est attendue et ne démontre pas une capacité stable; répéter les profils et isoler les ressources hôte avant toute extrapolation.

## Interprétation et limites

Ce run mesure trois requêtes PG par dossier, un pool local, un volume préchargé et une simulation de workers. Il ne mesure ni le débit d'un bot réel, ni le temps réseau Discord, ni la limitation 429, ni le coût des objets Guild discord.js, ni l'ordonnancement BullMQ, ni l'API OAuth, ni un démarrage/redémarrage. Les profils séparés donnent des distributions de latence dans la même charge mixte; leur débit individuel n'est pas inféré. L'attente p95 de 41,45 s vient du lot préchargé de 60 000 tâches et ne représente pas le délai de l'application.

Un essai préalable de 15 000 événements a échoué avec un timeout de connexion PostgreSQL à 3 s pendant l'ouverture du pool. Après réduction des copies de tableaux quadratiques dans le générateur du bench, deux autres runs (15 000 et 60 000 événements) ont abouti; la cause de ce premier timeout n'est pas démontrée. Répéter plusieurs fois avant d'utiliser cette mesure comme référence de déploiement.

Le résultat ne convertit pas les guildes simulées en capacité de guildes Discord. Aucun seuil de production, SLA ou capacité à plusieurs dizaines de milliers de serveurs n'est revendiqué. La mémoire Guild discord.js varie avec les serveurs et salons réels et doit faire l'objet d'un test Gateway distinct. Le script n'est pas une charge Discord et n'envoie aucun message ni aucune sanction.
