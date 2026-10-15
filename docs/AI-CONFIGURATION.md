# Configuration des assistants — audit du 14 octobre 2026

Le dépôt n'avait pas de consignes racine suivies. `AGENTS.md` décrit maintenant l'architecture, les commandes, les règles de sécurité et la preuve attendue des validations. Le fichier `apps/dashboard/AGENTS.md` est généré par Next.js et ignoré par Git ; son instruction locale demande de consulter la documentation de la version installée de Next.js avant de modifier l'application. Les consignes racine renvoient à ce fichier lorsqu'il existe.

La configuration Codex accessible sur cette machine est globale. L'audit s'est limité à sa structure : choix de modèle et de comportement, extensions, serveur d'outils, paramètres du bureau et niveaux de confiance par projet. Elle contient des chemins et réglages personnels qui ne sont pas nécessaires pour reproduire VeyroBot. Aucun réglage global n'a été modifié ou copié dans le dépôt. Pour un autre assistant, cloner le dépôt, lire `AGENTS.md`, utiliser `.env.example` pour les noms des variables et suivre les commandes du README suffit ; les identifiants doivent être fournis localement hors Git.

## État et suites

- La revue de fiabilité du 14 octobre utilise Node 24.21.0 et une base PostgreSQL isolée `veyrobot_arch_bench` avec migrations appliquées ; les tests d'intégration PostgreSQL sont activés par `RUN_POSTGRES_INTEGRATION=1`. Les validations exactes et limites figurent dans [RELIABILITY-REVIEW-2026-10-14.md](RELIABILITY-REVIEW-2026-10-14.md). Sans `DATABASE_URL`, les tests qui importent le package DB échouent dès l'import.
- Les tests avec doubles et l'intégration locale décrits dans la roadmap ne prouvent pas les actions Discord en direct. Les nouveaux réglages et l'interface routée doivent encore être vérifiés sur le serveur de test et dans un navigateur à 100 % de zoom. Voir `ROADMAP.md` et `DASHBOARD-DESIGN.md`.
- La présente revue n'a pas changé la configuration globale de l'assistant. Si des réglages propres au projet deviennent nécessaires, proposer d'abord un exemple nettoyé dans le dépôt et expliquer les effets sur les autres projets avant toute modification globale.
- Le banc PostgreSQL a été complété par un pipeline local PostgreSQL/BullMQ/HTTP simulé et un essai d'objets discord.js synthétiques. Une mesure Gateway/Discord réelle et une stratégie de réplication sont encore nécessaires avant d'annoncer une capacité en serveurs.
