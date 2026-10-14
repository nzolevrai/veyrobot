# Exploitation VeyroBot

## Démarrage et santé

Déployer les migrations additives avant le nouveau code, après sauvegarde et revue SQL. Démarrer PostgreSQL et Redis (`maxmemory-policy noeviction`), puis l'API, le dashboard et **un seul** processus bot. Le second bot est refusé par le verrou PostgreSQL tant que le routage des shards et la coordination REST ne sont pas livrés. L'API expose `/health` pour la vie du processus et `/ready` pour PostgreSQL ; le statut Gateway/Redis du bot doit être surveillé séparément. Le pool Prisma prend 10 connexions par processus par défaut ; compter API, bot, maintenance et migrations dans le budget `max_connections` avec marge d'administration.

Observer dans la même fenêtre : demandes `requested`/`running`/`uncertain`, âge de la plus vieille demande, échéances `scheduled` en retard, profondeur BullMQ, CPU, RSS, heap, event loop, connexions et attente PostgreSQL, 429 REST et erreurs d'autorisation. Agréger les métriques par action et état ; ne pas ajouter de série par utilisateur, opération ou serveur. Les logs peuvent porter `requestId` et `operationId` pour corrélation interne, mais jamais cookie, token, code OAuth ou motif sensible complet. La corrélation bout en bout n'est pas encore systématique.

L'API et le bot émettent désormais un instantané JSON par minute. Les compteurs API `acceptedResponses`/`backlogRefusals` sont cumulatifs par processus, y compris les réponses idempotentes répétées ; les reprendre à zéro après redémarrage. Le bot lit les états actifs/incertains et échéances via des requêtes ciblées, les nombres BullMQ et `pg_stat_activity`, puis enregistre mémoire et boucle. Les lignes `moderation_action_attempt` et `moderation_expiry_attempt` donnent la durée d'une tentative avec `operationId`/`caseId` pour corrélation, sans motif ni token. Sur une base très grande, mesurer le coût des comptages d'états incertains ; réduire la fréquence ou adopter des compteurs durables si cela devient significatif. L'attente interne du pool Prisma, les délais REST Discord/OAuth et le taux 429 Discord ne sont pas encore exposés en métriques cumulatives ; ne pas les déduire de ces instantanés.

## Incident

Si Redis est indisponible, l'API peut garder les nouvelles demandes en PostgreSQL jusqu'au plafond. Le dispatcher bot ne publie qu'après rétablissement ; vérifier les demandes persistées puis leur âge. Si PostgreSQL est indisponible, `/ready` répond 503 et les nouvelles décisions ne doivent pas être annoncées acceptées. Si le worker tombe pendant un appel Discord, attendre la réconciliation du bail (120 s + jusqu'à 60 s) et examiner les dossiers `uncertain` avant toute intervention. Un `operationId` déjà accepté ne doit pas être remplacé pour forcer une répétition ; vérifier d'abord l'état Discord et l'audit humain. Les échéances `TEMPBAN` restent dans PostgreSQL après redémarrage.

Le producteur Redis et le Worker ont des politiques de reconnexion distinctes ; le Worker attend la reprise, le dispatcher évite une publication pendant une déconnexion. Une réponse 429 Discord doit respecter `Retry-After` et les en-têtes de bucket via discord.js. Une erreur explicite et une réponse ambiguë n'autorisent pas la même reprise. Ne lancer aucune sanction de diagnostic sur un serveur réel.

## Sauvegarde, restauration, rétention

Sauvegarder PostgreSQL avant migration et à une fréquence compatible avec la perte de données acceptée. Un exemple de développement avec le service Compose, en conservant le fichier **hors dépôt** :

```powershell
New-Item -ItemType Directory -Force backups | Out-Null
docker compose exec -T postgres pg_dump -U sentinelle -Fc -f /tmp/veyrobot.backup sentinelle
docker cp "$(docker compose ps -q postgres):/tmp/veyrobot.backup" backups/veyrobot.backup
```

Tester la restauration vers une base **distincte et isolée**, jamais au-dessus de la base active :

```powershell
docker compose exec -T postgres createdb -U sentinelle veyrobot_restore_test
docker cp backups/veyrobot.backup "$(docker compose ps -q postgres):/tmp/veyrobot.restore.backup"
docker compose exec -T postgres pg_restore -U sentinelle -d veyrobot_restore_test --no-owner /tmp/veyrobot.restore.backup
```

Un essai a été réalisé le 14 octobre 2026 : source isolée `veyrobot_arch_bench`, archive `pg_dump -Fc`, cible nouvelle `veyrobot_restore_proof_20261014`, `pg_restore --no-owner`. La ligne de preuve restaurée contient version de configuration 7, module membre activé, génération 4, `operationId` conservé, statut `succeeded` et échéance `scheduled` future ; les mêmes valeurs ont été lues à la source. Aucun bot ne pointait vers la cible. Cet essai vérifie ces données représentatives, pas la restauration de chaque table ni le temps de reprise d'une base de production. Les fichiers `*.backup`, `*.dump` et `backups/` sont exclus de Git. Un retour à l'ancien binaire ne défait pas une migration destructive : concevoir les changements de schéma en deux phases compatibles, garder un plan de restauration et ne supprimer une colonne qu'après transition vérifiée.

Après restauration d'une archive ancienne, **ne pas démarrer le bot ni le dispatcher**. Une sanction peut avoir été envoyée à Discord après la sauvegarde alors que la copie restaurée indique encore `requested` ou `running` ; un rejeu immédiat serait dangereux. Isoler la base, comparer son âge et les journaux d'opérations avec Discord, classer les demandes dont le résultat n'est pas prouvé en `uncertain`, réconcilier les échéances et décisions de ban avec leurs marqueurs et générations, puis autoriser explicitement la reprise des mutations. Ce démarrage contrôlé reste une procédure manuelle : aucun outil automatisé de réconciliation d'une restauration ancienne n'est livré.

La rétention s'exécute séparément des requêtes : `corepack pnpm --filter @veyrobot/db maintenance:retention`. Délais et lots sont dans `.env.example` et [la revue](RELIABILITY-REVIEW-2026-10-14.md). Contrôler les compteurs de lignes supprimées et relancer par fenêtre de maintenance si un retard important existe. Elle préserve les dossiers d'action, les résultats incertains et échéances ; les données d'action continuent de croître et demandent une solution de tombstones avant purge.

Politique cible pour les dossiers d'action (pas encore activée) : conserver les détails pendant 730 jours après issue terminale ; conserver sans délai automatique les résultats `uncertain`, demandes en cours et échéances actives. Une opération archivée doit laisser un tombstone transactionnel minimal avec `operationId` unique et guilde, afin que toute ancienne demande soit refusée sans nouvel appel Discord, même après suppression des détails. Les tombstones restent indéfiniment : le coût de leur index croît avec le nombre total de demandes, compromis nécessaire pour une reconnaissance durable des identifiants. Un quota de stockage ne peut pas justifier leur suppression silencieuse ; fixer une capacité, alerter avant saturation et décider explicitement d'un horizon d'idempotence avant de changer cette garantie. Nettoyer par lots bornés hors trafic, avec verrouillage compatible avec l'admission et test de course entre archivage et nouvelle soumission. Le code actuel conserve les dossiers entiers ; aucune suppression des dossiers d'action n'a été ajoutée faute de tombstone et de test de course.

## Montée en charge

Ne choisir un nouveau palier qu'après campagnes prolongées sous arrivées contrôlées et guildes de tailles variées : hausse durable de l'âge de file, p95/p99 hors objectif fixé, saturation CPU/event loop, RSS proche du budget, attente pool, 429 ou Identify/reconnect problématiques. D'abord réduire les requêtes redondantes et revoir l'admission si sa latence domine. Puis concevoir propriété de shards, routage et coordination REST avant de lever le verrou du bot. Le proxy REST central, un proxy maintenu compatible Discord et une coordination distribuée ont des coûts de disponibilité/latence différents ; voir [la revue](RELIABILITY-REVIEW-2026-10-14.md). Aucun seuil de nombre de serveurs public n'a été démontré.
