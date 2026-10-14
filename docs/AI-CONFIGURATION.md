# Configuration des assistants — audit du 14 octobre 2026

Le dépôt n'avait pas de consignes racine suivies. `AGENTS.md` décrit maintenant l'architecture, les commandes, les règles de sécurité et la preuve attendue des validations. Le fichier `apps/dashboard/AGENTS.md` est généré par Next.js et ignoré par Git ; son instruction locale demande de consulter la documentation de la version installée de Next.js avant de modifier l'application. Les consignes racine renvoient à ce fichier lorsqu'il existe.

La configuration Codex accessible sur cette machine est globale. L'audit s'est limité à sa structure : choix de modèle et de comportement, extensions, serveur d'outils, paramètres du bureau et niveaux de confiance par projet. Elle contient des chemins et réglages personnels qui ne sont pas nécessaires pour reproduire VeyroBot. Aucun réglage global n'a été modifié ou copié dans le dépôt. Pour un autre assistant, cloner le dépôt, lire `AGENTS.md`, utiliser `.env.example` pour les noms des variables et suivre les commandes du README suffit ; les identifiants doivent être fournis localement hors Git.

## État et suites

- Revue de cette session avec Node 24.21.0 : `corepack pnpm typecheck`, `lint` et `build` passent. `corepack pnpm test` passe avec une `DATABASE_URL` factice et `RUN_POSTGRES_INTEGRATION=0` ; les cas PostgreSQL réels sont donc ignorés. Sans `DATABASE_URL`, deux fichiers de tests DB échouent dès l'import. Le moteur Docker était arrêté ; aucune nouvelle intégration PostgreSQL n'a été exécutée.
- Les tests avec doubles et l'intégration locale décrits dans la roadmap ne prouvent pas les actions Discord en direct. Les nouveaux réglages et l'interface routée doivent encore être vérifiés sur le serveur de test et dans un navigateur à 100 % de zoom. Voir `ROADMAP.md` et `DASHBOARD-DESIGN.md`.
- La présente revue n'a pas changé la configuration globale de l'assistant. Si des réglages propres au projet deviennent nécessaires, proposer d'abord un exemple nettoyé dans le dépôt et expliquer les effets sur les autres projets avant toute modification globale.
- Les limites de débit et de mémoire restent celles du banc PostgreSQL local ; une mesure Gateway/Discord et une stratégie de réplication sont encore nécessaires avant d'annoncer une capacité en serveurs.
