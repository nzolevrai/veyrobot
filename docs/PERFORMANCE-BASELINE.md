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

## Pipeline de production après corrections OAuth et dispatcher — 15 octobre 2026

Campagne exécutée avec `apps/bot/tools/bench-production.mjs`, Node 24.21.0, Windows 11 10.0.26300, 8 CPU logiques et Intel Core i5-1135G7 @ 2.40 GHz. PostgreSQL 17 dédié `veyrobot_foundation_bench`, Redis 7 DB logique 14, dispatcher, worker et exécuteur de production; seul l'adaptateur Discord est contrôlé/simulé. Admission directe par le cas d'usage PostgreSQL, donc pas de mesure HTTP API, OAuth ou réseau Discord. Paramètres: 1 800 s de charge, 300 s d'observation après drainage, 100 serveurs calmes, 3 dominants, 2/s normal, 8/s dominant total, rafales à 20/s pendant 10 s, 6 échéances/minute, 150 ms par mutation Discord simulée; concurrence 4, une action par serveur, pool 10, plafonds d'admission 5 000/100, dispatcher 1 s. 480 échantillons de ressources espacés de 5 s.

Après avoir créé une base PostgreSQL vide et appliqué `pnpm db:migrate`, cette exécution se reproduit avec Node 24.21 actif, Docker PostgreSQL/Redis local, et les variables ci-dessous (le script refuse une base ou Redis hors noms/DB isolés):

```powershell
$line = [System.IO.File]::ReadLines('.env') | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1
$env:DATABASE_URL = [regex]::Replace($line.Substring('DATABASE_URL='.Length), '/[^/?]+(?=\?|$)', '/veyrobot_foundation_bench')
$env:REDIS_URL = 'redis://127.0.0.1:6379/14'
$env:BENCH_SECONDS = '1800'
$env:BENCH_IDLE_SECONDS = '300'
$env:BENCH_DOMINANT_GUILDS = '3'
node apps/bot/tools/bench-production.mjs
```

| Mesure | Résultat |
|---|---:|
| Actions proposées / acceptées / terminées | 9 300 / 9 300 / 9 300; 0 refus, erreur, failed ou uncertain |
| Échéances créées / terminées | 179 / 179; 0 failed ou uncertain |
| Serveurs calmes — admission | p50/p95/p99 15,29 / 26,86 / 470,63 ms |
| Serveurs calmes — admission à fin | p50/p95/p99 319 / 896 / 1 009 ms |
| Serveurs dominants — attente de sérialisation | p50/p95/p99 0 / 1 409 / 1 882 ms |
| Serveurs dominants — admission à début | p50/p95/p99 113 / 1 436 / 1 937 ms |
| Serveurs dominants — admission à fin | p50/p95/p99 286 / 1 610 / 2 131 ms |
| Échéances — dû à fin | p50/p95/p99 300 / 828 / 1 206 ms |
| Retard maximal d'échéance échantillonné | 702 ms; maximum échantillonné toutes les 5 s, pas maximum par échéance |
| Échéance par opération — dû au démarrage | p50/p95/p99 132 / 664 / 1 022 ms; maximum par échéance 2 002 ms |
| Pool PostgreSQL | total maximal 10, attente maximale 5; attente d'acquisition mesurée max 1 140 ms |
| Verrou d'admission | attente totale mesurée 81,7 s; maximum par acquisition 1 888 ms; tenue maximale observée 270 ms |
| Comptages d'admission | cumul 32,1 s; maximum observé 105 ms; base de 9 479 dossiers finaux |
| Mémoire | RSS maximum 271 MiB, avant drainage 271 MiB, après repos 128 MiB; heap 49,5 → 39,7 MiB |
| Event loop et CPU | p95 maximal de retard 23,9 ms; 77,9 s CPU utilisateur + 36,8 s système sur le processus |
| Drainage | 520 ms; 0 opération en attente après drainage |

Ces percentiles sont calculés séparément par groupe et par opération; ils ne s'additionnent pas. Le p95 des serveurs dominants est surtout la sérialisation par serveur, tandis que les serveurs calmes terminent à p95 896 ms dans ce mélange précis. Les maximums d'échéance ne sont pas directement comparables: 702 ms est le plus grand retard vu par l'échantillonneur périodique; 2 002 ms est le plus grand retard dû-au-début parmi les 179 échéances individuelles. Le pool et le verrou ont connu des pics pendant la charge, sans attente/refus soutenus ni accumulation au repos. Le RSS a baissé pendant l'observation au repos; un seul run ne permet pas d'exclure une fuite lente ou une croissance retenue lors de campagnes répétées.

Le profil n'a pas saturé les plafonds: profondeur maximale de file BullMQ 0 à l'échantillonnage, 32 demandes PostgreSQL requested/running au maximum et aucun refus. Il valide un chemin et une charge contrôlés, pas la capacité maximale. Il ne couvre ni HTTP API, OAuth, 429, pannes, tailles variées de vraies guildes, Gateway, plusieurs machines ni événements réels. Le benchmark legacy PostgreSQL de ce document est un autre protocole et ne doit pas être comparé directement à ces percentiles.

Les plafonds cgroup proposés en octobre 2026 sont postérieurs à cette campagne. Le pic RSS 271 MiB, le repos 128 MiB et le heap observé 49,5 → 39,7 MiB justifient une première enveloppe bot 768 MiB / Node old-space 384 MiB, mais ne démontrent pas son comportement sous la limite, une croissance Gateway à long terme ou une capacité en serveurs. Les résultats de saturation Redis isolée sont consignés séparément dans [MEMORY-REDIS-BUDGETS-2026-10-16.md](MEMORY-REDIS-BUDGETS-2026-10-16.md) et ne constituent pas une mesure de débit.
