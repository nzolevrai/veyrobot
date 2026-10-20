# Banc de charge local (hors Discord)

## Protocole prévu — parcours HTTP complet

Avant l'exécution du banc `deploy/http-performance.integration.mjs`, les critères sont les suivants. Le test utilise PostgreSQL 17 et Redis 7 isolés, deux sessions OAuth de test valides, autorisations et CSRF actifs, et des plafonds de quota explicitement actifs mais supérieurs au nombre d'appels prévu. Le plafond d'admission par serveur est réglé à 8 pour rendre le refus déterministe; il n'est pas désactivé. Le simulateur d'action Discord attend 35 ms par action terminée et n'ouvre aucune connexion Discord.

* Charge normale : 2 demandes HTTP/s pendant 20 s, réparties entre quatre serveurs. Les 40 demandes proposées doivent être admises, puis terminer en état `succeeded` sans erreur inattendue ni mutation en double.
* Charge mixte : 4 demandes/s pendant 20 s, 75 % vers un serveur dominant et le reste vers trois serveurs calmes. Sans refus attendu, les opérations calmes et dominantes doivent toutes finir; p95 admission HTTP < 2 s, p95 acceptation HTTP → fin simulée < 5 s pour les serveurs calmes et < 10 s pour le dominant.
* Surcharge bornée : maintenir une mutation du serveur dominant dans l'adaptateur contrôlé, puis proposer 20 demandes simultanées sur ce serveur avec le plafond actif de 8 dossiers `requested`/`running`. Avec une mutation active, 7 demandes au plus doivent être acceptées et les autres doivent recevoir le refus 429 de l'admission. Des opérations de serveurs calmes doivent finir pendant que le dominant est bloqué.
* Drainage : après arrêt des nouvelles admissions et libération de la barrière, toutes les opérations acceptées doivent finir en moins de 60 s; le nombre de dossiers et mutations doit correspondre aux opérations uniques acceptées. Le scénario d'échéance doit terminer son déban simulé sans résultat incertain.
* Ressources : le banc doit rapporter RSS/heap du processus API et du harnais worker, mémoire hôte échantillonnée, CPU des processus lorsque disponible, connexions/pool et taille DB PostgreSQL, mémoire/clients/profondeur de file Redis. Ces observations caractérisent ce run, sans seuil de capacité ni extrapolation en serveurs supportés.

Ces seuils constituent les critères du test avant mesure, pas un SLA de production. Le banc vérifie un profil contrôlé et borné; il ne cherche pas le débit maximal.

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

## Parcours HTTP complet — 20 octobre 2026

### Reproduction

Le banc `deploy/http-performance.integration.mjs` crée une base PostgreSQL aléatoire à partir d'une URL locale autorisée, applique les migrations, initialise son recovery gate, puis supprime uniquement cette base à la fin. Il utilise un DB Redis logique dédié et refuse d'exécuter sur un hôte non local ou un espace de clés qui contient autre chose que la Queue portant son UUID. La session est obtenue par le vrai flux OAuth API, avec les endpoints Discord remplacés par `apps/api/test/mock-discord.mjs`. Le test injecte deux sessions valides distinctes, conserve les contrôles d'autorisation, Origin/CSRF, validation du grant et les deux limiteurs actifs. Les quotas de test sont réglés à 10 000/minute pour rester au-dessus des 145 requêtes offertes; les réponses de surcharge proviennent donc du plafond d'admission par serveur (8), pas du rate limit.

Le worker, l'exécuteur, le dispatcher et BullMQ sont ceux de production. Seul l'adaptateur Discord est simulé, avec 35 ms d'attente pour chaque mutation; aucune connexion Gateway/REST n'est ouverte. La file vérifie un serveur dominant, l'ordre par serveur, une échéance de ban temporaire et le drainage. Les plafonds et la concurrence active restent en place. Les expirations sont rendues dues en avançant `expiresAt` dans la base de test après le succès du TEMPBAN simulé; la durée réelle minimale d'une minute n'est donc pas attendue.

Préconditions : Node 24.21.0, pnpm 10.18.3, PostgreSQL 17, Redis 7 et un rôle PostgreSQL local autorisé à créer/supprimer des bases de test. Depuis la racine, après avoir défini `DATABASE_URL` vers une base locale jetable et `REDIS_URL` vers un Redis local jetable :

```powershell
corepack pnpm db:generate
corepack pnpm build
$env:RUN_HTTP_PERFORMANCE_INTEGRATION = '1'
$env:ALLOW_LOCAL_HTTP_PERFORMANCE = '1'
# Facultatif : fixe un DB logique Redis dédié 1..15 s'il est libre.
$env:HTTP_PERFORMANCE_REDIS_DB = '12'
node deploy/http-performance.integration.mjs
```

CI exécute le même script après les builds sur PostgreSQL 17 et Redis 7 dédiés au job. Le script vérifie que son DB logique Redis ne contient pas d'autres clés; ne le lancez pas sur un Redis partagé ou important.

Les critères de réussite ont été écrits avant les campagnes : 40 admissions normales sans erreur, 80 admissions mixtes sans refus, refus déterministe des 13 demandes au-delà du plafond pendant qu'une action reste bloquée, fin d'au moins deux dossiers calmes avant de libérer cette barrière, p95 d'admission HTTP sous 2 s, p95 acceptation → fin sous 5 s pour les guildes calmes et 10 s pour la guilde dominante, échéance terminée et drainage en moins de 60 s. Une rediffusion idempotente doit renvoyer le même dossier sans nouvelle mutation.

### Mesures locales

Cinq exécutions complètes ont été faites avec les mêmes profils, sur Windows 11 build 26300, Intel i5-1135G7 à 2,40 GHz, 8 CPU logiques et 16 GiB de RAM visible; Docker Server 29.8.2, PostgreSQL 17.11, Redis 7.4.11, Node 24.21.0 et pnpm 10.18.3. Chaque run a duré environ une minute, avec 40 demandes à 2/s, puis 80 à 4/s (75 % vers une guilde dominante et 25 % réparties sur trois calmes), puis la barrière de surcharge, l'échéance et le drainage. Les cinq runs ont donné les mêmes comptes :

| Résultat par run | Valeur |
|---|---:|
| Requêtes HTTP proposées / réponses acceptées / refus d'admission | 145 / 132 / 13 |
| Opérations durables uniques / dossiers finaux | 131 / 131; tous `succeeded` |
| Erreurs API inattendues / erreurs worker ou dispatcher | 0 / 0 |
| Rejeu HTTP idempotent / dossiers supplémentaires / mutations supplémentaires | 1 / 0 / 0 |
| Refus dans la rafale de 20 (une action déjà active, plafond 8) | 7 acceptées / 13 HTTP 429 explicites |
| Mutations simulées (actions / ban / déban d'échéance) | 130 timeouts / 1 ban / 1 déban |
| File en fin de drainage | 0 waiting / 0 active / 0 delayed / 0 failed |

Distributions échantillonnées séparément par run; p95 n'est pas additif et ne doit pas être recomposé à partir des phases :

| Groupe et mesure | p95 observé |
|---|---:|
| HTTP admission, profil normal (41 appels, avec 1 rejeu) | 33–359 ms sur cinq runs |
| HTTP admission, profil mixte (81 appels, échéance incluse) | 23–27 ms |
| Dispatch PostgreSQL → début de publication, normal | 933–950 ms |
| Publication BullMQ → début du worker, normal | 7–25 ms |
| Exécution worker/exécuteur, normal (simulateur de 35 ms) | 58–59 ms |
| HTTP accepté → fin, normal | 991–1 008 ms |
| Mixte, guildes calmes : admission HTTP / attente dispatch / attente BullMQ / exécution / acceptation → fin | 19,52 ms / 805 ms / 6,50 ms / 57,17 ms / 860,81 ms (dernier run) |
| Mixte, guilde dominante : mêmes phases | 26,73 ms / 700 ms / 6,60 ms / 58,05 ms / 758,04 ms (dernier run) |
| Échéance, dû → début worker / exécution / dû → fin | 1 919 ms / 58,20 ms / 1 977,20 ms (dernier run) |

Sur les cinq runs, mémoire API maximale échantillonnée : environ 120–126 MiB RSS et 38–42 MiB heap; processus worker + dispatcher + générateur : environ 132–133 MiB RSS et 44–49 MiB heap. PostgreSQL a atteint 13 connexions actives observées et environ 8,2 MiB pour la base de test; Redis a atteint 2,3–2,4 MiB `used_memory`. Le générateur a pris environ 1,6–2,2 s CPU utilisateur+système et l'API 2,3–2,7 s cumulées. L'échantillon de retard event loop maximal p95 était proche de 32 ms. Ressources prises toutes les 5 s : la profondeur BullMQ maximale rapportée (0) est un maximum **échantillonné** et ne prouve pas qu'aucun job court n'a attendu entre deux échantillons. Le processus worker inclut le générateur; son RSS/CPU ne les sépare pas. Le host avait environ 5,5 GiB de mémoire libre en fin de run.

Les serveurs calmes ont terminé pendant que l'appel simulé de la guilde dominante était maintenu en attente; les assertions portaient sur les états PostgreSQL terminaux et la télémétrie de fin du worker avant la libération de la barrière, pas sur le drainage global de BullMQ à ce moment-là. Dans les cinq runs, les 13 refus n'ont créé aucun dossier; chaque opération acceptée a un seul dossier. Le p95 HTTP normal a varié fortement (33 à 359 ms sur 41 appels), tout en restant sous le plafond de 2 s; les petits échantillons n'établissent pas un SLA.

Le banc ne mesure ni OAuth/Discord externe réel (le mock répond sans réseau), ni la latence/rate limits REST, ni les caches Gateway, ni le proxy Next, ni les plafonds globaux de 5 000 et par guilde de production de 100 (le plafond par guilde est ramené à 8 pour rendre le refus testable). Le pool PostgreSQL et les services partagent une machine locale, et la charge n'est pas un test de capacité prolongé. Aucun nombre de serveurs supportés, débit Discord ou disponibilité publique n'est déduit. Aucune optimisation du code de production n'a été justifiée par ces mesures.

### Réévaluation de l'axe 7

**9/10, confiance moyenne pour le socle local mono-processus.** Le critère local est maintenant couvert sur le parcours HTTP authentifié → validation OAuth/session et autorisation/CSRF/quota → admission PostgreSQL → dispatcher → BullMQ → worker/exécuteur de production, avec surcharge bornée, drainage, mesure des phases et progression de serveurs calmes. Le score reste limité par le simulateur Discord, la petite campagne locale, le rate limit configuré plus haut que le trafic proposé et l'absence de campagne sur l'hébergement réel. Cela ne signifie pas qu'une capacité ou un SLA de production soit démontré.

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
