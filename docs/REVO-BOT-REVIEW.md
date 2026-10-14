# Revue en lecture seule de RevoBot

Inspection limitée à l'inventaire des sources et à la lecture de modules ciblés. Le dépôt n'a pas été modifié, son code n'a pas été exécuté, ses dépendances n'ont pas été installées et les fichiers `.env`/secrets ont été exclus. Aucun secret n'est reproduit ici.

## Idées utiles

- Les réglages de modération sont organisés par familles : détection, sécurité, sanctions automatiques/prédéfinies et confidentialité.
- Les anciens réglages envisagent invitations Discord, liens externes, majuscules et répétition/spam.
- Une configuration visible en catégories et des exceptions par type d'utilisateur/salon sont de bonnes idées UX à reprendre dans un futur éditeur de règles versionné.
- Les sanctions prédéfinies peuvent servir de préréglages explicables, avec aperçu et validation côté serveur.

Ces observations concernent surtout l'organisation de l'interface/configuration. Elles ne prouvent pas que tous les détecteurs sont activés, fiables ou testés sur un serveur réel.

## Problèmes observés

- `messageCreate` contient du calcul d'XP et des accès DB par message; cette logique n'est pas utile au produit actuel et ne doit pas être reprise.
- Un `Map` de dernier message par utilisateur grandit avec les utilisateurs vus et n'a pas de politique d'éviction visible dans le module inspecté.
- Les événements d'arrivée/départ entraînent des lectures de configuration SQL; une forte activité multiplie ces lectures.
- Le traitement de création de serveur charge des collections de salons et consulte l'audit log immédiatement. Les événements d'audit peuvent être retardés ou ambigus; il ne faut pas attribuer une action sensible à l'auteur sur cette seule proximité temporelle.
- Le dépôt utilise une architecture sharder/loader et MySQL, avec des modules et dépendances orientés musique, Canvas ou niveaux. Ils ne justifient pas une copie dans le nouveau produit.

## Reprise propre

Conserver les familles d'options, les exemptions explicites, des sanctions prédéfinies et les idées de protection anti-invitation/liens/spam/caps. Les reconstruire ultérieurement avec PostgreSQL, validation Zod, règles simulables, mode observation, quotas de sanctions, exceptions visibles et état de propagation. Aucun scan massif de membres/salons ni cache d'événements sans limite n'est repris.
