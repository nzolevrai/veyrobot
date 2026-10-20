# Bot connecté : cycle de reconnexion et d’arrêt (axe 8)

## Critères fixés avant l’essai

Le test lance le vrai `apps/bot/dist/index.js` et son vrai Client discord.js. Seuls le transport REST/Gateway et les services de données sont simulés/jetables. Il ne crée aucune guilde et ne soumet aucune demande de modération.

Les critères observables sont :

1. Un Ready initial, puis trois reconnexions de la même instance Client, chacune aboutissant à une connexion Gateway ouverte.
2. Aucun nouveau shard, intervalle périodique, listener du Client/shard, connexion Redis ou connexion du pool PostgreSQL après les reconnexions. `pool.idle` peut varier entre 0 et `total` selon qu’une requête courte est en cours; `pool.waiting` doit rester à zéro.
3. Au terme des cycles, les caches gardent leurs cardinalités, le RSS et le heap restent à moins de 32 MiB au-dessus de l’échantillon stabilisé initial. Ce seuil, volontairement large, représente plus de cinq fois l’amplitude de la fenêtre passive précédente (RSS 5,8 MiB, heap 4,6 MiB); il vise une multiplication manifeste, pas les petites fuites.
4. À l’arrêt, le socket Gateway est fermé, le Client n’est plus prêt, les intervalles globaux suivis sont effacés, le pool PostgreSQL est fermé, et le verrou advisory ne devient disponible qu’après le retour de `Client.destroy()`.
5. Le processus sort proprement avec le code 0; après sa sortie, Redis ne conserve aucun client de production.

Les échantillons sont pris deux secondes après Ready initial, puis une seconde après chaque reconnexion complète. Aucun GC forcé n’est demandé. La hausse de mémoire est rapportée comme fluctuation/croissance d’allocation sur cette courte séquence, sans la qualifier de fuite ou de mémoire durablement retenue.

## Banc

`deploy/bot-lifecycle.integration.mjs` crée un conteneur PostgreSQL 17 jetable (768 MiB) et Redis 7 jetable (256 MiB), tous deux liés seulement à `127.0.0.1`, applique les migrations à une base unique créée pour le test et inscrit son epoch de reprise. Un faux serveur HTTP répond aux routes REST Gateway utilisées par discord.js; un serveur WebSocket local parle HELLO, IDENTIFY/READY, RESUME/RESUMED et ferme la connexion selon le scénario. Le token et l’identifiant d’application sont des valeurs fictives.

Le test démarre le binaire bot compilé, avec le preload d’observation `apps/bot/test/lifecycle-observer-preload.mjs`. Ce preload ne remplace pas le Client : il redirige l’URL REST vers le serveur local, expose un instantané par IPC, compte les `setInterval` globaux et ajoute une barrière autour du retour de `Client.destroy()` pour vérifier le verrou. Pour chaque cycle, le faux Gateway envoie l’opcode officiel `Reconnect` (7), attend `shardReconnecting`, puis le handshake `RESUMED`; il ne ferme pas une socket au hasard. Le Gateway annonce un heartbeat de 45 s, cohérent avec la plage de production, tandis que le preload fixe son jitter initial à zéro : un essai préliminaire avec 150 ms produisait artificiellement des reconnexions « zombie » à cette cadence et n’est pas utilisé comme résultat. Le compte Redis provient de `INFO clients` (quatre connexions observées pendant le service, dont celle de la commande de mesure). Le compteur Redis après arrêt comprend uniquement la connexion de la commande de diagnostic.

Reproduction depuis la racine, sous Node 24.21.0 et après build des packages :

```powershell
$env:RUN_BOT_LIFECYCLE_INTEGRATION = '1'
$env:VEYROBOT_ISOLATED_INTEGRATION = '1'
node deploy/bot-lifecycle.integration.mjs
```

Le script exige Docker, démarre et détruit ses propres conteneurs et sa propre base. Il ne lit pas le `.env` du projet et ne transmet au processus bot qu’un environnement minimal avec des identifiants fictifs. La CI exécute ce même script sur Node 24.21.0 après `pnpm build`; le travail dépend du moteur Docker disponible au runner.

## Résultats locaux

Environnement : Windows, Node 24.21.0, discord.js 14.27.0, PostgreSQL 17, Redis 7, Docker Desktop 29.8.2. Trois exécutions finales consécutives ont réussi; chacune a couvert trois reconnexions, soit neuf cycles simulés au total. Elles ont duré environ 15–17 s par exécution.

| Mesure par processus bot | Plage observée | Résultat |
|---|---:|---|
| Intervalles globaux actifs pendant la stabilisation | 6, identiques sur les quatre snapshots | Pas de multiplication après reconnexion. Ce compteur instrumente `globalThis.setInterval`, pas les fonctions timer privées de chaque dépendance. |
| Événements/listeners Client | 8 types, 1 listener chacun | Signature identique aux quatre étapes. |
| Listeners du shard | `allReady: 1` | Stable. |
| Shards | 1 | Stable; 4 connexions WebSocket créées au total par exécution (initiale + 3 reconnexions). |
| Connexions Redis | 4 à chaque étape | Stable; inclut l’appel diagnostique `redis-cli`. Après arrêt : 1, l’appel de mesure seul. |
| Pool PG Prisma | total 1, idle 0–1, waiting 0 | Total et attente stables; idle varie avec une requête du dispatcher en cours. Après Client.destroy : total 0. |
| Caches discord.js | guildes 0, salons 0, utilisateurs 1, emojis/rôles/membres/bans 0 | Aucun objet de guilde dans la fixture; mesure de cycle de vie, pas de coût par guilde. |
| RSS | 135,7–136,8 MiB | Hausse maximale par rapport à la ligne de base inférieure à 0,7 MiB. |
| Heap utilisé | 46,7–48,0 MiB | Hausse observée d’environ 1,2 MiB au plus; sans GC forcé, ce n’est pas une estimation du heap retenu après GC. |
| Mémoire externe | 10,36–10,42 MiB | Variation < 0,07 MiB; `external` inclut les ArrayBuffers. |
| ArrayBuffers | 0,53–0,59 MiB | Sous-ensemble de la mémoire externe; ne pas additionner. |

À la barrière d’arrêt, le serveur local avait reçu la fermeture du socket, le Client n’était plus Ready, zéro intervalle global restait actif et le pool PG était fermé. Une tentative `pg_try_advisory_lock` échouait encore; après autorisation de laisser retourner `Client.destroy()`, le verrou devenait disponible et le processus sortait avec le code 0. La fermeture a laissé un événement `shardReconnecting` côté discord.js mais aucune connexion supplémentaire; l’assertion porte sur les sockets et l’arrêt effectif, pas sur ce seul événement.

Les résultats sont des mesures de deux démarrages courts de la même machine, avec zéro guilde et zéro charge de modération. Ils démontrent l’absence de multiplication visible de ces ressources dans le scénario et le bon ordre de fermeture; ils ne démontrent pas l’absence de fuite lente, le coût de caches actifs, ni une capacité de guildes. Les compteurs de handles agrégés comprennent aussi les pipes et sockets du banc, et les intervalles internes aux bibliothèques ne sont pas étiquetés individuellement.

## Conclusion de l’axe 8

La fermeture du pool, de la file/du worker et du Gateway, ainsi que la libération tardive du verrou, sont démontrées par le processus et ses vrais adaptateurs avec transport local. Aucune réduction de cache ni correction de production n’est justifiée par cet essai. L’observation passive précédente sur une guilde privée demeure la seule donnée Gateway réelle; aucun incident répétitif n’a été injecté sur Discord. Pour conclure sur la rétention selon des guildes de tailles variées, il faudra une observation plus longue sur un hébergement contrôlé ou un harnais synthétique rapporté séparément.
