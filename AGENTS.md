# Consignes de reprise — VeyroBot

Lire `README.md`, `docs/ARCHITECTURE.md`, `docs/FEATURE-MATRIX.md`, `docs/DASHBOARD-DESIGN.md`, `docs/PERFORMANCE-BASELINE.md` et `docs/ROADMAP.md` selon le domaine modifié. Ces documents décrivent l'état actuel et les travaux restants ; ce fichier fixe les règles de travail. Signaler les écarts entre le code et la documentation et les corriger dans la même modification.

## Monorepo et exécution

- `apps/dashboard` : interface Next.js, routes par compte et par serveur, composants et styles communs. Elle appelle l'API ; elle ne détient pas de Gateway ni de logique de sanction.
- `apps/api` : Fastify, OAuth et sessions, contrôle d'accès aux serveurs, configuration, dossiers et demandes d'action durables dans PostgreSQL.
- `apps/bot` : Gateway discord.js, commandes slash et worker BullMQ. Il distribue les demandes enregistrées, appelle Discord et réconcilie les résultats et échéances.
- `packages/db` : schéma, migrations et accès Prisma/PostgreSQL ; `packages/contracts` : types et permissions partagés ; `packages/moderation` : service métier et vérifications d'action communs à l'API et au bot.

Utiliser Node >= 24.17.0 (24.21.0 dans `.node-version`, `.nvmrc`, CI et Docker), pnpm 10.18.3 et un gestionnaire Node qui sélectionne réellement cette version. Vérifier `node --version` : le `corepack.cmd` de Windows peut utiliser un autre Node. Les commandes depuis la racine sont :

```text
corepack prepare pnpm@10.18.3 --activate
corepack pnpm install --frozen-lockfile
docker compose up -d postgres redis
corepack pnpm db:generate
corepack pnpm db:migrate
corepack pnpm dev
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm build
```

Créer `.env` localement à partir de `.env.example` sans recopier de valeurs dans la documentation. `db:migrate` exige PostgreSQL et `DATABASE_URL`. La suite `test` exige également que `DATABASE_URL` soit définie, même quand `RUN_POSTGRES_INTEGRATION` est absent ; une URL factice suffit alors pour les tests simulés. Le développement exige aussi Redis et les identifiants Discord pour les parcours réels ; les tests d'intégration PostgreSQL exigent migrations appliquées et `RUN_POSTGRES_INTEGRATION=1`. CI lance PostgreSQL 17 puis génération, migration, typecheck, build, lint et tests. `corepack pnpm --filter @veyrobot/bot deploy:commands` publie les commandes uniquement dans `DISCORD_TEST_GUILD_ID` ; ne l'exécuter qu'avec la guilde de test voulue.

## Code et autorisations

- TypeScript strict et modules ESM. Modifier les contrats et le service commun avant les adaptateurs API, bot et interface ; garder validation Zod, migrations Prisma et tests ciblés cohérents. Ne pas dupliquer une décision de permission dans une vue.
- Toute lecture ou mutation liée à un serveur doit utiliser son `guildId` vérifié, une session OAuth autorisée et, selon l'action, les permissions effectives de l'acteur et du bot. Revérifier au moment de l'action les permissions du salon, la hiérarchie et l'état du module enregistré. Le navigateur et les IDs fournis par le client ne font pas autorité. Protéger les écritures Dashboard par session, origine, CSRF et version de configuration ; garder les commandes slash dans la même politique métier.
- Garder l'isolation des données et files par serveur. Le bot traite au plus une action active par serveur ; plusieurs serveurs peuvent avancer en parallèle. Le déploiement actuellement supporté est une API et un processus bot. Ne pas répliquer les processus utilisant le même token sans routage des shards et coordination REST globale.
- Insérer chaque demande dans PostgreSQL avec un `operationId` stable avant sa publication BullMQ. Préserver claim atomique, bail, heartbeat et jeton de fencing ; un doublon de job ou de requête ne doit pas provoquer une seconde mutation. Redis transporte le travail ; PostgreSQL garde l'état durable. Après une panne, réconcilier depuis PostgreSQL.
- Distinguer les échecs explicites Discord (notamment permissions et autres 4xx connus) des réponses ambiguës (timeout, 5xx, interruption après début de mutation). Une mutation ambiguë devient `uncertain` et demande examen humain : aucune répétition automatique aveugle. Les 429 sont normalement gérés par l'ordonnanceur REST discord.js ; si l'erreur remonte, enregistrer l'échec selon le chemin existant. Aucun appel Discord et écriture SQL ne forment une transaction atomique. Préserver les générations de bans temporaires et documenter les courses externes qui restent possibles.

## Performance et interface

- Conserver pagination des dossiers, fetch Discord ciblés, limites de purge de 100 messages et absence de lecture du contenu des messages. Le pool PostgreSQL est borné à 10 connexions par processus par défaut ; BullMQ a une concurrence de quatre, avec une seule action par serveur. Mesurer avant d'augmenter les limites ou le nombre de processus.
- `docs/PERFORMANCE-BASELINE.md` mesure seulement un banc PostgreSQL local : 60 000 transitions simulées, environ 1 370/s et p95 SQL 16,39 ms sur un run. Il ne mesure ni Gateway, ni Discord REST, ni BullMQ réel, ni capacité en nombre de serveurs. Les objets Guild conservés par discord.js n'ont pas de plafond mémoire mesuré. Ne pas convertir ces chiffres en promesse de débit, de latence ou de disponibilité en production.
- Respecter l'identité du dashboard décrite dans `docs/DASHBOARD-DESIGN.md` : anthracite `#15161b`, navigation `#191b21`, surface `#202229`, accent indigo `#7775f5`. Réutiliser `apps/dashboard/app/components.tsx`, `navigation.tsx`, `dashboard-context.tsx`, `module-registry.ts` et les styles communs ; préserver les états chargement/erreur, le clavier, le focus et le brouillon non sauvegardé. Les modules désactivés ou non livrés ne doivent pas sembler utilisables. Avant de coder avec Next.js, lire le guide correspondant dans `apps/dashboard/node_modules/next/dist/docs/`, car la version installée peut différer des connaissances de l'assistant. Le fichier `apps/dashboard/AGENTS.md` est généré localement par Next.js et ignoré par Git : lorsqu'il existe, lire aussi ses consignes.

## Vérification, secrets et documentation

- Distinguer dans tout compte rendu : tests unitaires avec doubles, intégration locale réelle PostgreSQL/API, appels Discord réels sur serveur de test et validation visuelle dans un navigateur. Un build, un HTTP 200 ou un test simulé ne prouvent ni une sanction Discord réelle ni un rendu visuel correct. Indiquer les commandes exécutées, le résultat, les étapes non exécutées et leurs raisons. Ne jamais annoncer une vérification non effectuée, une absence totale d'erreurs ou une note parfaite par obligation.
- Ne pas lire, afficher, committer ou publier `.env`, jetons, cookies, codes OAuth, clés, journaux sensibles ou configuration personnelle de l'assistant. Utiliser `.env.example` avec des valeurs fictives et des noms de variables. Inspecter les noms de fichiers suivis/préparés et le diff avant chaque commit ; arrêter la publication si un secret ou un fichier personnel est présent. Ne pas modifier une configuration globale d'assistant qui touche d'autres projets sans présenter au propriétaire les changements proposés.
- Après chaque changement de comportement, mettre à jour le document pertinent : `README.md` pour l'installation et les limites visibles, `ARCHITECTURE.md` pour flux et garanties, `FEATURE-MATRIX.md` pour les capacités, `DASHBOARD-DESIGN.md` pour l'interface, `PERFORMANCE-BASELINE.md` pour les mesures, `ROADMAP.md` pour l'état et les suites. Garder cet AGENTS.md concis et durable, sans journal de session.
