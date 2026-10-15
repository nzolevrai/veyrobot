# Roadmap, décisions et reprise

## Validation utilisateur et qualité du socle — 15 octobre 2026

Le propriétaire confirme avoir testé en réel sur son serveur privé : OAuth, navigation, actualisation et déconnexion; refus d'accès après déconnexion; persistance des paramètres et activation/désactivation; avertissements depuis le Dashboard et `/warn`; timeout et retrait immédiat; slowmode et restauration. Ce sont des validations manuelles rapportées par le propriétaire, non rejouées par la CI ni reproduites dans cette tranche. Les autres actions Discord, notamment kick, ban, unban, ban temporaire et purge, restent non validées en réel.

Un contrôle automatisé Chrome headless a testé le dashboard construit avec la CSP nonce (réponse HTTP 200, nonce transmis aux scripts Next, pas de `unsafe-inline` dans `script-src`, aucune violation CSP signalée pendant le chargement). La revue visuelle desktop/mobile reste manquante. Une campagne de 30 minutes du pipeline réel (dispatcher/worker/exécuteur, Discord simulé), avec trois serveurs dominants, échéances et repos, est maintenant consignée dans `PERFORMANCE-BASELINE.md`; elle ne valide ni Discord réel ni capacité maximale.

Les limites consolidées et leur classification figurent dans [FOUNDATION-QUALITY-REVIEW-2026-10-15.md](FOUNDATION-QUALITY-REVIEW-2026-10-15.md). La production est préparée par une topologie de référence, mais aucun service n'est provisionné ni déployé.

## Étape 1 — socle et premier parcours

Monorepo TypeScript strict, PostgreSQL/Prisma, Redis/BullMQ, API Fastify, Dashboard Next, bot Gateway séparé, OAuth Discord, sélection des serveurs, avertissements et dossiers paginés sont livrés. Les migrations locales PostgreSQL ont été appliquées et les tests d'intégration du dossier ont déjà été exécutés sur le service local. Les validations manuelles actuelles du propriétaire sont listées dans la section de statut ci-dessus; l'historique ci-dessous ne remplace pas cette liste.

## Étape 2 — modération manuelle (en cours)

Livré : timeout/retrait, kick, ban/unban/ban temporaire, purge 1–100 avec filtre auteur, slowmode 0–21600, verrouillage et restauration du bit `SendMessages` conservé. Slash commands et Dashboard passent par le même service métier, les résultats restent dans les dossiers, les actions risquées demandent une confirmation dans le Dashboard. Les permissions de salon et les hiérarchies sont revérifiées par le bot.

Le worker utilise PostgreSQL comme outbox, dispatch équitable une opération par serveur, leases/jetons de fencing, heartbeat, statut `uncertain` sans répétition aveugle et reprise des expirations temporaires depuis la base. Le Dashboard pagine désormais les dossiers par curseur et recherche par ID de cible côté API ; ses autres filtres portent seulement sur la page chargée. Cette étape reste incomplète : softban, surnoms, actions vocales, menus contextuels, recherche serveur sur d'autres champs, rapports/recours et historique de configuration consultable.

## Interface du Dashboard

Nouvelle identité anthracite et indigo, en-tête de 64 px, navigation stable de 240 px, menu mobile repliable, registre typé des modules réellement disponibles, formulaires de modération séparés et confirmation intégrée pour les demandes sensibles. Les anciennes polices et captures ne sont plus utilisées. Les interrupteurs persistants des trois modules d'action et les préférences de langue, fuseau et couleur sont livrés ; les réglages métier détaillés par module restent à faire. Voir [DASHBOARD-DESIGN.md](DASHBOARD-DESIGN.md). Le contrôle headless de CSP est réussi; la revue visuelle en plusieurs tailles d'écran reste nécessaire.

## Étape 3 — règles et AutoMod

Moteur de règles configurable, simulateur, mode observation, exceptions, sanctions progressives, limites de sanctions, intégration AutoMod natif, surveillance des modifications externes et arrêt rapide d'une règle.

## Étape 4 — sécurité et opérations

Détection de raid et procédures de confinement à plafonds explicites, corrélation prudente des journaux d'audit, tableaux de bord de métriques, rétention/purge/export/effacement, sauvegarde/restauration, sharding et routage vers processus propriétaires. Mesurer les limites mémoire Guild discord.js avant expansion.

## Étape 5 — équipe et revenus

Délégations d'équipe révocables, droits/quota centralisés, configuration d'offres, coût estimatif modifiable. Revalider l'éligibilité et les obligations Premium Apps avant toute vente. Aucun prix de rentabilité n'est inventé.

## Décisions importantes

- Node 24.21.0, minimum discord.js 14.27.0 : Node 24.17.0. Le runtime compatible est sélectionné dans les fichiers locaux, Docker et CI.
- Un processus bot supporté actuellement. Plusieurs bots partageant le même token n'ont ni coordination REST globale ni routage shard livré.
- L'API écrit les demandes dans PostgreSQL sans Redis. Le bot est seul responsable de la publication BullMQ; une panne Redis retarde le travail sans perdre la demande.
- Worker concurrence quatre, mais une opération active maximum par guild. La sélection SQL est indexée et publie au plus un dossier par guild à la fois. Les sanctions précèdent la purge par priorité.
- Discord REST n'est jamais transactionnel avec PostgreSQL. Une réponse réseau/5xx ambiguë passe à `uncertain`; discord.js ne répète pas automatiquement les mutations après timeout/5xx. Les 429 restent normalement temporisés par son ordonnanceur local.
- Les baux sont renouvelés toutes les 20 s, durée 120 s. Le reaper toutes les 60 s marque un appel en cours incertain ou une préparation sans appel échouée. Toute écriture de résultat est conditionnée au jeton de claim.
- Ban temp: le marqueur de raison est un indice, pas un verrou atomique. Les générations internes protègent les décisions antérieures au contrôle final; une modification externe ou une action externe concurrente pendant l'appel Discord reste ambiguë.
- La présence par shard évite le balayage permanent des guildes, mais chaque objet Guild Discord.js et ses salons/rôles restent en mémoire et croissent avec le nombre de serveurs.
- Une rétention manuelle par lots existe pour sessions anciennes, audits et avertissements terminés. Les dossiers d'action gardent leur `operationId` et continuent de croître ; planification, export et politique de tombstones restent à définir.

## Validation réalisée dans cette étape

- Douze migrations présentes dans le dépôt et appliquées dans la base de test isolée ; les deux plus récentes ajoutent la révocation des sessions et l'index de rétention des audits. Les migrations antérieures conservent les préférences et la présence par serveur.
- Tests doubles des permissions retirées, claims concurrents, fencing après échéance, génération tempban changée entre les lectures, ban marqueur modifié, échéance dupliquée, redémarrage/ambiguïté, purge bornée/filtrée, restauration de verrou. Aucun test ne contacte Discord.
- Build TypeScript vérifié pour packages DB/modération et applications bot/API; build de Dashboard effectué après l'ajout des formulaires.
- Mesure de charge reproducible : voir [PERFORMANCE-BASELINE.md](PERFORMANCE-BASELINE.md). Aucune mesure n'est une promesse de capacité Discord.
- Une configuration locale `.env` existe désormais. L’utilisateur a validé précédemment OAuth, sélection et `/warn` sur son serveur privé. Les nouveaux réglages de cette tranche n’ont pas encore été vérifiés en direct sur Discord. Aucune sanction réelle n’a été lancée dans cette tranche.

## Reprise

### Tranche navigation et configuration par serveur — 13 octobre 2026

- Livré : barre d’icônes de serveurs avec états installé/hors ligne/absent, vérification d’installation via Discord sur demande, navigation repliable, recherche locale sans accents, modules activables en base et paramètres de langue/fuseau/couleur. Les modules historiques sont désactivés par défaut sur les nouveaux et anciens serveurs. Les commandes et l’API refusent les nouvelles demandes désactivées; le worker garde les décisions antérieures et les échéances confirmées.
- Validé localement : deux migrations appliquées, tests PostgreSQL réels des défauts et de la persistance, essai API complet avec Discord simulé (OAuth, absence, hors ligne, installation, isolation, conflit, redémarrage), tests de registre et tests de modération existants. Aucune sanction Discord réelle.
- À contrôler : rendu visuel desktop/mobile à 100 % et focus des infobulles lorsque le navigateur intégré sera disponible; confirmation en direct sur le serveur privé des réglages, de `/warn` activé/désactivé et de la présence après invitation. Aucun essai de bannissement, kick, timeout ou suppression sans cible explicitement désignée.
- Suites : config métier détaillée par module, diagnostics de permissions du bot dans l’interface, coordination REST entre processus avant réplication de l’API, rétention et autres modules de la roadmap.

La prochaine vérification en direct doit activer Avertissements sur sa page dédiée, sauvegarder, relancer `/warn` sur le serveur privé puis désactiver le module et constater le refus, sans sanction ni suppression. Vérifier ensuite la persistance des paramètres et le rendu visuel en navigateur. Ne pas essayer les actions destructrices avant qu’une cible ou un salon de test soit explicitement désigné.

## Reprise après la revue du 14 octobre 2026

Les frontières API/bot, le verrou d'instance unique, la révocation de session, la borne d'admission, la reprise du producteur Redis, la rétention partielle et le proxy Next résolu au runtime sont livrés sur la branche d'architecture. Les validations locales, les coupures isolées Redis/PostgreSQL et les performances avec leurs incertitudes figurent dans [RELIABILITY-REVIEW-2026-10-14.md](RELIABILITY-REVIEW-2026-10-14.md). Les prochaines priorités sont des pannes pendant l'exécution Discord et charge prolongée, des métriques corrélées, un essai de restauration, la politique de croissance des dossiers d'action et la validation navigateur/Discord réel sans sanction. Aucun déploiement multi-processus n'est autorisé par le code actuel.

Suite sur la même branche : lecture bornée et timeout du proxy, tests d'interruption sur l'exécuteur réel, quarantaine à la restauration, banc PostgreSQL/BullMQ/worker de 30 minutes, attente du pool et admission sont consignés dans [RELIABILITY-VERIFICATION-2026-10-14.md](RELIABILITY-VERIFICATION-2026-10-14.md). Les dossiers d'action ne sont pas purgés : ils croissent jusqu'à une conception et un test de course des tombstones; suivre la taille de `ModerationCase` avant saturation. Avant mise en production, valider le rendu dans un navigateur et les parcours Discord autorisés sans sanction destructive. Les résultats simulés ne prouvent pas les limites de Discord réel. La PR reste en brouillon.

### Tâches restantes, priorisées

1. Pour cette PR : vérifier la CI sur la tête exacte et recueillir les revues indépendantes via [le guide de revue](REVIEW-GUIDE.md). Pour mise en production : contrôle visuel navigateur et vérifications Discord autorisées; aucune sanction réelle n'est requise pour la fusion des correctifs backend.
2. Avant rétention des dossiers : concevoir tombstone transactionnel à `operationId` durable, course entre admission et archivage, restauration et politique explicite d'horizon/capacité. La purge reste désactivée.
3. Évolution future : coordination REST multi-processus et sharding uniquement après les signaux de saturation listés dans `OPERATIONS.md`; le verrou d'instance bot reste actif.

### Sauvegarde/restauration — 15 octobre 2026

Le script `deploy/backup-postgres.ps1` publie maintenant uniquement une archive PostgreSQL 17 relue par `pg_restore --list`, avec un sidecar SHA-256 publié en dernier comme marqueur de complétude, permissions privées et noms concurrents uniques. Le test Compose isolé a restauré configurations, dossier WARN, décision TEMPBAN, génération et échéance, puis exécuté la quarantaine avant de vérifier que le dispatcher de production publie zéro opération et que les sessions restaurées sont révoquées. L'API et le bot ne sont pas démarrés pendant cet essai.

La procédure de restauration et ses commandes sont dans [BACKUP-RESTORE-VERIFICATION-2026-10-15.md](BACKUP-RESTORE-VERIFICATION-2026-10-15.md). Restent à éprouver : planification/copie vers stockage distant chiffré, surveillance de la capacité/rétention, contrôle de l'accès à ce stockage et exercice à la taille réelle de la base. Les durées locales mesurées ne constituent pas des objectifs RPO/RTO.

### Navigation routée et édition commune — 13 octobre 2026

- Livré dans le code : routes Next.js par module, layout partagé avec vérification d’accès initiale, rail et catégories réorganisés, page Premium honnête, activation dans chaque page métier, réglages avec Radix Select et couleur locale, barre de brouillon avec sauvegarde groupée et conflit optimiste.
- Vérifié localement : lint et TypeScript du dashboard, build des sept routes, tests de brouillon/registre, API TypeScript/build, test API/PostgreSQL avec OAuth et Discord simulé couvrant patch, conflit, validation et redémarrage. Un accès direct non authentifié redirige vers l’accueil. Aucun essai de sanction réelle.
- À contrôler dans un navigateur dès que l’outil fonctionne : layout à zoom 100 % sur ordinateur/mobile, navigation avant/arrière avec brouillon, focus et menus, collisions des bulles, défilement indépendant et choix de couleur. Le navigateur intégré a échoué avant connexion; aucun contrôle visuel n’est déclaré réussi.
- À faire ensuite : diagnostic des permissions du bot plus détaillé et modules métier de la roadmap. L’interrupteur Avertissements est sur `/dashboard/[guildId]/warnings`.
