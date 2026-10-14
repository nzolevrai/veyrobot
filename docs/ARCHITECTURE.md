# Architecture et garanties actuelles

## Processus et état durable

Le monorepo pnpm contient un dashboard Next.js, une API Fastify, un processus Gateway discord.js, un worker BullMQ intégré au processus bot, et des packages partagés pour Prisma/PostgreSQL, contrats et modération. Le dashboard n'héberge jamais le Gateway. PostgreSQL porte les dossiers, demandes, générations de décisions ban/déban, états de verrouillage, sessions révocables et présence des shards. L'API compose des plugins OAuth, serveurs et modération ; le bot sépare commandes, interactions, dispatcher, worker et verrou de démarrage. Voir [la revue de fiabilité](RELIABILITY-REVIEW-2026-10-14.md) et [la convention de module](MODULE-CONVENTION.md).

Une demande d'action est insérée dans PostgreSQL avec un `operationId` unique et l'état `requested`. L'API ne se connecte plus à Redis. Le processus bot sélectionne au plus une demande par serveur, exclut les serveurs ayant déjà une action `running`, puis publie un job BullMQ ayant le même identifiant stable. La sélection SQL s'appuie sur l'index `(status, guildId, createdAt)`. Après chaque job, le bot réveille immédiatement le dispatcher; une réconciliation périodique toutes les cinq secondes récupère aussi les demandes manquées et les échéances de ban temporaire. PostgreSQL joue donc le rôle d'outbox durable; Redis transporte les réveils, pas l'état métier.

BullMQ utilise une concurrence de quatre jobs; le bot n'exécute qu'un job à la fois par serveur. Les actions de modération passent avant le nettoyage de messages; les expirations ont une priorité intermédiaire, avec risque de famine à mesurer. Les jobs terminés/échoués sont supprimés de Redis. Ils sont republiables depuis PostgreSQL tant que la demande reste `requested` ou que l'échéance reste `scheduled`. L'admission refuse explicitement au-delà de 5 000 demandes actives globales ou 100 par serveur par défaut ; le verrou transactionnel de ce plafond a un coût mesuré.

## Acquisition, baux et fenêtres de panne

L'acquisition est un `UPDATE ... WHERE status='requested'` atomique qui ajoute un jeton aléatoire, un bail de 120 secondes et une phase. Un heartbeat toutes les 20 secondes renouvelle le bail pendant les opérations Discord lentes. Toute écriture finale exige encore le même statut et le même jeton : après reprise du bail, un ancien worker ne peut pas écraser le résultat du nouveau propriétaire.

La phase `preparing` signifie qu'aucune mutation Discord n'a commencé. Un bail expiré dans cette phase est marqué `failed`, sans tentative automatique. Le service passe à `discord_request_inflight` immédiatement avant la mutation; une interruption dans cette phase devient `uncertain`, car l'appel a pu atteindre Discord. Aucun résultat ambigu n'est automatiquement rejoué. La réconciliation tourne chaque minute; un bail expire après deux minutes, donc le délai d'identification d'une interruption peut atteindre environ trois minutes.

Une demande créée avec Redis indisponible reste `requested` en PostgreSQL; elle est publiée à la reprise. Le dispatcher attend que son producteur Redis soit prêt avant de publier, car `Queue.add` peut autrement attendre indéfiniment la connexion initiale. Une publication répétée conserve le même `jobId`, et le claim SQL évite le double effet. Une panne PostgreSQL bloque la création ou l'écriture du résultat. Si Discord a confirmé une action pendant une panne SQL, le dossier sera ensuite marqué `uncertain`, pas rejoué. Une panne Redis retarde le traitement et n'autorise pas le worker à improviser une sanction.

Les 403/404 et autres réponses 4xx Discord connues sont des échecs explicites, sauf les opérations idempotentes où l'état demandé est déjà atteint. Les 429 sont normalement temporisés par le gestionnaire REST discord.js; si une erreur 429 remonte, le dossier échoue explicitement et aucune sanction n'est répétée par notre code. Le client discord.js désactive ses répétitions automatiques des 5xx/timeouts pour les mutations; ces erreurs deviennent `uncertain`. Il n'existe pas de transaction atomique entre PostgreSQL et Discord.

## Bans temporaires

Chaque décision BAN, TEMPBAN ou UNBAN augmente atomiquement la génération persistée pour la paire serveur/utilisateur et enregistre cette génération sur le dossier. Une ancienne échéance constate la génération la plus récente deux fois, dont une immédiatement avant la requête DELETE de débannissement. Si un ban a déjà été retiré manuellement, l'expiration est `superseded`. Si une nouvelle décision arrive après la dernière lecture et pendant l'appel HTTP, Discord ne fournit pas de comparaison-et-suppression conditionnelle : cette course externe ne peut pas être rendue atomique. Le dispatcher sérialise les décisions du serveur, et un BAN permanent redemande le ban si l'expiration vient de retirer l'ancien ban; un UNBAN déjà satisfait est enregistré comme tel. Le motif Discord porte également le marqueur d'expiration, mais un administrateur externe peut le remplacer ou le recopier. Dans ces cas ambigus, une vérification humaine est requise.

Après redémarrage, les échéances viennent de `expiresAt` dans PostgreSQL, et non de timers en mémoire ni d'une tâche Redis seule. Un worker interrompu avant le DELETE est replanifié; interrompu après son début, il devient `uncertain` et n'est pas répété.

## Présence, cache et rythme

Le bot n'active que l'intent Gateway `Guilds`; il ne charge aucun catalogue de membres. Les membres, utilisateurs, bans, salons et messages utiles aux actions sont récupérés à la demande. Les dossiers sont paginés et les opérations de nettoyage sont plafonnées à 100 messages par demande.

La présence est maintenue par une ligne par serveur installé et un heartbeat par shard toutes les 30 secondes. L'API considère le bot en ligne si le heartbeat du shard date de moins de 90 secondes; après une coupure, l'interface peut donc afficher l'état précédent pendant au plus cette fenêtre. L'appartenance serveur est synchronisée au démarrage par lots de 500 puis sur les événements d'ajout/retrait; elle n'est plus réécrite chaque minute.

discord.js conserve toutefois ses objets Guild et structures de salons/rôles pour les serveurs reçus par Gateway. Cette mémoire croît avec les guildes par processus; elle n'a pas de plafond configuré. Un découpage par shards/processus et des mesures mémoire sont requis avant d'augmenter le nombre de processus. Les requêtes Dashboard relisent la liste OAuth Discord au plus une fois par session toutes les dix secondes; le cache API est borné à 1 000 sessions, expire après dix secondes et mutualise les lectures concurrentes identiques. Les dossiers récents se rafraîchissent toutes les trente secondes seulement sur les vues qui les affichent et quand l'onglet est visible ; une réponse devenue obsolète est annulée ou ignorée.

Le dashboard Next.js possède une route par vue et un layout par serveur. Le layout relaie le cookie de session HttpOnly à l'API pour vérifier l'accès au serveur et lire une seule fois sa configuration lors de la navigation initiale. Le fournisseur client du layout partage identité, liste de serveurs et configuration entre vues d'un même serveur; changer de serveur recrée ce fournisseur. Les mutations utilisent toujours l'API avec CSRF et version optimiste. Une sauvegarde de plusieurs réglages utilise `kind=patch` et une seule transaction PostgreSQL avec audit. Le contenu métier de chaque route utilise ses propres appels API autorisés. Les changements externes de droits après le chargement initial sont revérifiés à chaque appel; une vue déjà chargée peut rester visible jusqu'à son prochain appel ou son actualisation, sans autoriser une nouvelle opération.

Chaque processus PostgreSQL a un pool borné à 10 connexions par défaut (`DATABASE_POOL_SIZE`). Le nombre total croît avec les réplicas; le déploiement supporté reste une API et un processus bot. BullMQ/Redis n'est utilisé que par le bot. La limitation REST discord.js coordonne les requêtes d'un seul client; elle n'est pas globale entre plusieurs clients utilisant le même token. Le même token ne doit pas être partagé entre plusieurs processus bot tant qu'un routage/limiteur distribué n'est pas implémenté.

## Actions de salon

- Purge : examine au plus 100 messages récents, filtre sur l'identifiant d'auteur, ignore ceux de plus de 14 jours et envoie un seul DELETE ou un bulk DELETE de 2–100 IDs avec un motif d'audit. Le contenu du message n'est jamais lu; aucun intent `MessageContent` n'est demandé. Discord répond sans compte individuel; le dossier note les IDs soumis après réponse HTTP réussie et les éléments ignorés, pas une preuve par message. Un échec réseau après suppression peut rester incertain.
- Slowmode : valeur bornée de 0 à 21 600 secondes, modifiée uniquement sur les types de salons compatibles.
- Verrou : enregistre la valeur antérieure de `SendMessages` pour `@everyone`, puis ne touche qu'à ce bit. La restauration intervient seulement si ce bit vaut encore `deny`; les autres bits d'autorisation ne sont pas écrasés. Si un administrateur réapplique exactement la même valeur `deny`, Discord ne fournit pas de preuve permettant de distinguer son écriture de celle du bot; cette ambiguïté demeure.

Le service commun aux commandes slash et au Dashboard revérifie l'acteur, les permissions effectives dans le salon, les permissions du bot, et la hiérarchie de rôle pour les actions membres juste avant l'appel REST. Les IDs transmis par le navigateur ne remplacent pas ces contrôles.

## Base, coûts et entretien

Les index couvrent les dossiers par serveur/cible, les demandes par statut/serveur/date, les baux expirés, les échéances `TEMPBAN` et les audits anciens. Le dispatcher sélectionne une demande par serveur actif. Une commande de rétention supprime par petits lots les sessions anciennes, audits de configuration anciens et avertissements terminés sans `operationId`, avec délais configurables. Les dossiers d'action restent conservés pour la sécurité des reprises et continueront de croître. Aucun contenu de message n'est conservé par cette tranche.

Les objectifs de p95 et de propagation sont des cibles à mesurer, pas des SLA. Le protocole et les résultats du banc de charge local sont dans [PERFORMANCE-BASELINE.md](PERFORMANCE-BASELINE.md); ils ne constituent pas une capacité de serveurs Discord démontrée.

## Configuration par serveur et navigation (octobre 2026)

`GuildConfig` conserve séparément trois interrupteurs (avertissements, actions membres, actions salons), la langue `fr`/`en`, le fuseau IANA et la couleur hexadécimale d’embed. La migration ajoute les colonnes avec défaut `false` pour les modules, sans réécrire les dossiers ni les migrations antérieures. Une ligne absente équivaut à trois modules désactivés, français, UTC et indigo. L’API utilise `version` pour les mises à jour conditionnelles et ajoute une entrée `ConfigAudit` dans la même transaction. Les commandes slash relisent PostgreSQL à chaque interaction : aucun Pub/Sub volatil n’est nécessaire pour propager les réglages. Les réponses éphémères `/warn` et actions emploient la langue et la couleur du serveur. Les dates persistées demeurent UTC.

`GuildPresence` représente l’installation connue; `ShardPresence` représente la disponibilité temporaire. Le Gateway ajoute et retire les appartenances; à la reprise, chaque processus réconcilie les lignes de ses shards avec les guilds reçues. La vérification explicite d’installation utilise un `GET /guilds/{id}` authentifié par le bot, uniquement à la demande de l’utilisateur et après contrôle OAuth `ManageGuild`. Une réponse 403/404 retire l’appartenance connue; un autre échec ne modifie pas l’état. Cette requête REST part de l’API et partage le token du bot : dans le déploiement actuel à un bot et une API, son faible volume est contrôlé par une limite HTTP, mais il n’existe pas encore de coordinateur REST distribué. Ne pas multiplier les processus API sans le concevoir.

Les actions déjà enregistrées avant une désactivation continuent à être traitées; les échéances de bans temporaires confirmées continuent aussi. Le worker refuse une demande créée après que la configuration a été désactivée si un ancien producteur l’a laissée passer. Les avertissements vérifient le module dans une transaction PostgreSQL. Il n’y a pas de révocation automatique d’une sanction déjà demandée ni de transaction atomique avec Discord.

## Limitations restantes

- Un processus bot seulement; aucun routage de commande Dashboard vers un propriétaire shard, aucune coordination globale REST entre processus.
- Les objets Guild Discord.js croissent avec les serveurs du processus; pas de seuil mémoire de production mesuré.
- La rétention est manuelle et partielle ; export et suppression complète des données client ne sont pas implémentés.
- Les modifications externes des bans, salons et règles Discord restent partiellement ambiguës; aucune promesse de restauration identique.
- L’utilisateur a validé précédemment OAuth, la sélection et `/warn` sur son serveur privé. La présente évolution n’a pas été rejouée contre Discord; l’état réel des nouveaux interrupteurs et embeds reste à confirmer sur ce serveur sans exécuter de sanction.
