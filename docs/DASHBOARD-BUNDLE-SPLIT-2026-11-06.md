# Découpage des bundles des vues serveur

Mesure effectuée le 6 novembre 2026 avant et après le commit de découpage, sur le même poste Windows, avec Node 24.22.2, Next.js 16.4.5, React 19.3.0, Playwright 1.62.1 et un build de production. Les deux essais utilisent une API HTTP factice sur loopback, une session de test fixe et une guild fictive. Il n'y a eu aucun appel Discord. Le profil de bundle se reproduit après build avec `tools/pnpm.ps1 exec node apps/dashboard/tools/measure-route-bundles.mjs`; les variables `VEYROBOT_BUNDLE_ROOT` et `VERIFY_ROUTE_SPLIT=0` permettent de mesurer un checkout de référence.

Le script ouvre chaque route dans un contexte navigateur neuf, attend son titre, relève les ressources JavaScript réellement chargées, actualise la route et vérifie de nouveau son titre. Il navigue ensuite dans l'application Avertissements → Paramètres → Actions sur membres → Dossiers. Il vérifie que chaque route possède un chunk propre et que la navigation récupère ce chunk différé. Les octets encodés et transférés viennent de Resource Timing. Gzip et Brotli sont aussi calculés sur chacun des fichiers JavaScript émis ; ces deux colonnes sont des mesures des fichiers, distinctes des octets transférés qui incluent les en-têtes HTTP.

## Résultats au chargement direct

Le build de référence au commit `6e2248f15e3e6cd6c393e879bb86bc317b3c209d` chargeait les mêmes 11 chunks pour chacune des quatre vues. Le build découpé charge toujours 11 chunks à l'entrée de la route (les chunks communs plus le chunk de la vue concernée), avec des tailles différentes selon la vue.

| Vue | Décodé avant → après | Encodé avant → après | Transféré avant → après | Gzip fichiers avant → après | Brotli fichiers avant → après |
|---|---:|---:|---:|---:|---:|
| Paramètres | 622 787 → 606 443 (-2,6 %) | 190 135 → 186 507 (-1,9 %) | 193 435 → 189 807 (-1,9 %) | 189 656 → 186 162 (-1,8 %) | 163 809 → 160 624 (-1,9 %) |
| Dossiers | 622 787 → 513 497 (-17,5 %) | 190 135 → 155 541 (-18,2 %) | 193 435 → 158 841 (-17,9 %) | 189 656 → 155 196 (-18,2 %) | 163 809 → 133 152 (-18,7 %) |
| Avertissements | 622 787 → 510 890 (-18,0 %) | 190 135 → 154 724 (-18,6 %) | 193 435 → 158 024 (-18,3 %) | 189 656 → 154 379 (-18,6 %) | 163 809 → 132 400 (-19,2 %) |
| Actions sur membres | 622 787 → 515 207 (-17,3 %) | 190 135 → 156 100 (-17,9 %) | 193 435 → 159 400 (-17,6 %) | 189 656 → 155 755 (-17,9 %) | 163 809 → 133 642 (-18,4 %) |

Chromium et Firefox ont produit les mêmes tailles de fichiers et les mêmes octets Resource Timing sur cet essai local. Le résultat n'est pas une mesure de latence utilisateur : aucun réseau distant ni bridage de CPU n'a été simulé.

## Coût différé et navigation

Avant le découpage, le passage Avertissements → Paramètres → Actions → Dossiers ne téléchargeait aucun nouveau chunk de vue : tout le code des vues était déjà chargé par la première route. Après le découpage, cette séquence télécharge un chunk de vue à chaque changement vers une nouvelle fonctionnalité : Paramètres 33 337 octets gzip / 29 576 Brotli, Actions 2 930 / 2 594, Dossiers 2 371 / 2 104. Une route directe et son actualisation ont fonctionné dans les deux navigateurs. Les chunks communs restent en cache pendant la navigation ; les coûts différés correspondent au contenu propre à la destination et non à une répétition du bundle initial.

La baisse de 25 % n'est pas atteinte. Dossiers, Avertissements et Actions réduisent leurs octets transférés initiaux d'environ 18 %. Paramètres baisse d'environ 2 %, car sa configuration interactive reste nécessaire sur cette page. L'économie provient du fait que les routes non consacrées aux paramètres ne chargent plus la configuration, ainsi que de la séparation des vues. Il reste environ 155–160 ko encodés à transférer pour chaque route : le shell, React/Next et les composants communs dominent encore ces mesures. La tranche s'arrête ici, sans chercher un gain supplémentaire par une architecture ou une refonte du shell.

## Changements et vérifications

`route-view.tsx` utilise `next/dynamic` pour séparer l'import de la configuration, des dossiers, des avertissements et des actions. Les quatre vues résident dans leurs modules propres (`configuration.tsx`, `records-view.tsx`, `warnings-view.tsx`, `actions-view.tsx`); les composants partagés de `components.tsx`, le contexte serveur, la navigation, les gardes d'accès et la CSP restent communs. `overview-view.tsx` est également isolé pour éviter qu'une route d'accueil ne réimporte les modules de formulaire.

Le script de mesure vérifie les routes directes, actualisations, chunks spécifiques et navigation différée sous Chromium et Firefox. Les parcours navigateur complets avec API et PostgreSQL isolés ont aussi réussi sous les deux moteurs, avec OAuth simulé, paramètres, brouillons, erreurs 429 simulées, focus, mobile et déconnexion. Ces parcours ne constituent ni un test OAuth/Discord réel ni une validation de déploiement. Le comportement fonctionnel et visuel des vues n'a pas été intentionnellement modifié.
