# Ajouter un module VeyroBot

Le monorepo reste un monolithe modulaire. Un module est une capacité métier déclarée dans les contrats et raccordée aux entrées API, commandes/événements bot et page dashboard qui en ont besoin. Ne pas créer un package, listener ou timer par module ou par serveur sans preuve de nécessité.

1. Définir un identifiant stable en majuscules pour les actions et un slug URL durable, une catégorie et des métadonnées de présentation dans `packages/contracts` et `apps/dashboard/app/module-registry.ts`. Les contrats partagés ne doivent exporter ni Prisma, ni Redis, ni discord.js, ni secret serveur vers le navigateur.
2. Définir le schéma Zod public de configuration, la migration PostgreSQL additive, le champ `false` par défaut et la version optimiste. Une ligne de config absente signifie module désactivé. Préserver les brouillons et la sauvegarde groupée.
3. Écrire les règles et transitions métier dans `packages/moderation` ou `packages/db` selon leur responsabilité. Garder les types Fastify et React aux entrées ; ne prendre un `Guild` discord.js concret que dans l'adaptateur d'exécution. Partager les décisions de permission et de configuration entre API et slash.
4. Déclarer les permissions acteur/bot, intents Gateway strictement nécessaires, commande ou événement, contrôles au moment de l'exécution et politique d'erreur. Les opérations acceptées avant désactivation et les échéances déjà confirmées restent engagées selon `ARCHITECTURE.md`.
5. Utiliser un `operationId` stable, écriture durable PostgreSQL, claim conditionnel, bail, jeton de fencing, statut `uncertain` sur résultat ambigu et réconciliation. Une notification BullMQ perdue ne doit perdre ni action ni échéance. Borner admission, concurrence, collections et pagination.
6. Ajouter une route API avec autorisation de serveur, origine, CSRF et validation, puis une page dans le layout dashboard actuel. Éviter de charger un outil lourd sur les pages sans rapport et annuler les réponses réseau obsolètes.
7. Ajouter des tests de règles, isolation entre guildes, doublons, désactivation, erreurs Discord et transitions ; utiliser PostgreSQL réel pour les garanties SQL. Dire explicitement si le navigateur ou Discord réel n'ont pas été testés. Mettre à jour `FEATURE-MATRIX.md`, `ARCHITECTURE.md`, les mesures si elles changent, et `ROADMAP.md`.

`node tools/check-boundaries.mjs` interdit les imports client vers les adaptateurs serveur et signale des cycles d'imports locaux. Il complète, sans remplacer, une revue des dépendances dynamiques et effets de bord au chargement.
