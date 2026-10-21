# Validation navigateur du dashboard — 17 octobre 2026

## Résultat

Le parcours Playwright a utilisé Chromium réel contre le serveur Next.js construit et l’API locale, avec PostgreSQL 17 jetable. OAuth et les réponses Discord (profil et guildes) étaient simulés dans l’intégration. Les écritures d’avertissement ont été réellement insérées dans la base de test, puis nettoyées. Aucune requête de modération n’a été envoyée à Discord.

Environnement : Node `24.21.0`, pnpm `10.18.3`, Next.js `16.4.0`, Playwright `1.62.1`, axe-core `4.14.0`, Chromium `151.0.7922.34`, Firefox `153.0` fourni par Playwright, PostgreSQL `17`. Les captures de référence utilisent Chromium à l’échelle 1 : bureau `1440×900`, mobile `390×844`; une vue de profil a également été vérifiée à `900×800`.

## Parcours vérifiés

- Redirection d’un visiteur d’une route protégée; ouverture OAuth simulée; accès à l’accueil utilisateur et aux pages Profil par navigation directe, actualisation, précédent et suivant.
- Navigation clavier compte → serveur → paramètres, noms accessibles des liens et commandes, ouverture directe et actualisation de la vue d’ensemble, infobulle de serveur au focus. Le même parcours automatisé s’exécute sous Chromium et Firefox.
- Chargement de la liste de serveurs en erreur 429 simulée, respect de `Retry-After`, nouvelle tentative manuelle après le délai et conservation de la session.
- Réglages de langue au clavier, contrôle de couleur au clavier, sauvegarde réelle en PostgreSQL, rechargement, réinitialisation d’un brouillon, puis confirmation d’abandon avant de changer de page.
- Activation et sauvegarde du module Avertissements dans la base isolée. Un avertissement créé par le navigateur apparaît dans l’historique. Une seconde écriture réussit alors que la lecture suivante reçoit un 429 simulé; le succès est visible, l’ancien historique reste affiché, une seule écriture a lieu par clic et aucune nouvelle lecture automatique ne part pendant le délai.
- Affichage mobile du menu, focus visible, fermeture par Échap, absence de débordement horizontal à `390×844` et `900×800`, défilement vertical des réglages au clavier, et limites de position du sélecteur de couleur.
- Ouverture au clavier d’une confirmation BAN, vérification que le focus entre dans la boîte, fermeture par Échap et par Annuler avec retour du focus au déclencheur. Le test vérifie qu’aucun POST d’action ne part. Le sélecteur de couleur rend également le focus à son déclencheur après Échap.
- Déconnexion, puis refus d’une route protégée. axe-core ne signale aucune violation de sévérité sérieuse ou critique sur l’accueil utilisateur, les réglages avec sélecteur ouvert, le menu mobile et la page Avertissements.

Le parcours s’exécute avec :

```powershell
$env:DATABASE_URL = '<URL PostgreSQL 17 jetable, migrée>'
$env:RUN_POSTGRES_INTEGRATION = '1'
$env:RUN_DASHBOARD_ROUTE_INTEGRATION = '1'
$env:RUN_DASHBOARD_BROWSER_INTEGRATION = '1'
$env:VEYROBOT_RECOVERY_EPOCH = '<epoch de test uniquement>'
corepack pnpm exec node apps/api/test/integration.mjs
```

En CI, `pnpm test` lance le parcours Chromium avec PostgreSQL/Redis isolés. Une étape dédiée relance l’intégration API/Next et le parcours complet avec Firefox. Playwright installe Chromium et Firefox sur le runner; l’intégration utilise `DASHBOARD_BROWSER_ENGINE=firefox`. Le flag navigateur exige le flag d’intégration API/Next; sans ces flags, il n’est pas exécuté.

## Défauts reproduits et corrigés

- Les initiales visibles sur les icônes de serveur n’étaient pas incluses dans le nom accessible du lien. Le nom conserve maintenant le texte visible et ajoute une description du serveur pour les technologies d’assistance.
- Le dialogue du sélecteur de couleur était sans nom accessible et le nom de son déclencheur n’incluait pas la valeur hexadécimale visible. Le dialogue est maintenant nommé et le déclencheur annonce la couleur courante.
- axe-core a relevé des contrastes insuffisants sur le bouton principal, les catégories et l’onglet actif, l’aperçu, les en-têtes et métadonnées du tableau ainsi que le compteur du formulaire. Les couleurs concernées utilisent maintenant des tons plus lisibles dans la palette existante. La couleur de fond de marque reste inchangée.
- Le parcours E2E utilise des états d’attente déterministes et nettoie chaque dossier créé même si un test échoue.
- La vérification du défilement `End` mobile lisait `window.scrollY` juste après l’envoi de la touche, sans attendre que le navigateur applique son déplacement. Le diagnostic Chromium a trouvé le focus sur `BODY` et le document comme conteneur réellement défilant (`HTML`: `scrollHeight=844`, `clientHeight=600`, `scrollTop=0`; `BODY`: `scrollHeight=844`, `clientHeight=844`). Dans le run local, `window.scrollY` est passé de `0` à `244` immédiatement après `End`; aucun défilement interne de panneau n’était impliqué. Le test attend maintenant, au maximum 1 seconde, la condition observable `window.scrollY > valeurAvant`, puis conserve une assertion avec focus, dimensions et positions dans son message d’échec. Le diagnostic local n’a pas observé de mouvement différé; les échecs CI étaient compatibles avec une lecture trop précoce, mais leurs traces ne permettent pas d’affirmer le délai exact sur ces runners. Une mutation temporaire qui empêchait le défaut clavier avec `preventDefault()` a bien fait échouer cette même assertion (`0→0`), confirmant qu’elle ne peut pas réussir sans défilement réel.
- Le parcours compte → serveur → paramètres est maintenant exercé par clavier dans les deux moteurs. Sous Firefox, les sélecteurs Playwright basés sur rôles et noms accessibles couvrent les liens, combobox, interrupteur, commandes de reprise et boutons; axe-core s’exécute sur les états pertinents. L’intégration vérifie la conservation des dossiers après un 429 de lecture, l’absence de nouvelle écriture, le nom du dialogue, l’entrée du focus dans celui-ci et son retour après Échap ou Annuler. Le menu mobile et le sélecteur de couleur vérifient également leur état et le retour du focus.

Les tests et corrections sont dans `apps/dashboard/tools/browser-journey.mjs`, `apps/api/test/integration.mjs`, `apps/dashboard/app/navigation.tsx`, `apps/dashboard/app/configuration.tsx` et `apps/dashboard/app/style.css`.

## Reproduction de la régression CI — 17 octobre 2026

Les runs push `39050260256` et PR `39050263425` ont échoué au même contrôle après `End`. Le parcours complet a été rejoué avec Node `24.21.0`, pnpm `10.18.3`, Chromium/Playwright `1.62.1` et PostgreSQL `17` isolé. La nouvelle attente ne déclenche pas le défilement : elle attend uniquement la modification réelle de `window.scrollY` après la touche et est bornée à 1 seconde. Le parcours complet passe après la correction; l’expérience de mutation ci-dessus confirme que bloquer l’action clavier entraîne un échec explicite. Aucun changement de comportement du dashboard n’a été nécessaire.

## Parcours Firefox et contrôle NVDA — 19 octobre 2026

Le parcours Firefox a été exécuté localement avec Firefox `153.0` téléchargé dans un répertoire temporaire Playwright, Node `24.21.0`, Next.js construit et PostgreSQL 17 dans un conteneur jetable. Le parcours complet a réussi : compte → serveur → paramètres par clavier; noms accessibles utilisés par les rôles/noms Playwright; `Retry-After` simulé et données affichées conservées; menu mobile, sélecteur et confirmation; focus placé et rendu aux déclencheurs; déconnexion. L’API locale était réelle; OAuth et les réponses Discord étaient simulés. Aucun appel Discord réel ni aucune sanction n’ont eu lieu. Les captures canoniques restent celles de Chromium.

NVDA n’est pas installé dans l’environnement d’exécution vérifié (`PATH`, processus et emplacements standards utilisateur/système). L’inventaire Computer Use du PC Windows ne retourne pas d’application ni de navigateur, donc cet environnement d’exécution ne permet pas de déterminer les installations du PC interactif de l’utilisateur. **Aucune validation NVDA n’est revendiquée.**

Le contrôle manuel dispose maintenant d’un lanceur isolé, à exécuter depuis la racine du dépôt :

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\apps\dashboard\tools\run-nvda-manual.ps1
```

Il exige Docker, Node `24.17+`, pnpm `10.18.3` et le navigateur Firefox de Playwright en cache. Il démarre un conteneur PostgreSQL 17 unique, temporaire et lié seulement à `127.0.0.1`, applique les migrations, construit les applications et démarre l’intégration API/Next avec OAuth/Discord simulés. Une session et un dossier fictifs sont créés dans cette base. Firefox s’ouvre visiblement sur l’accueil du compte. Les POST d’avertissement et d’action sont bloqués par le navigateur de test; aucune connexion bot/Gateway ni action Discord ne peut partir. Dans la page Dossiers, le premier GET charge le dossier fixture depuis l’API; le bouton **Actualiser** déclenche le 429 simulé avec `Retry-After: 120`. Le harnais vérifie l’annonce d’erreur dans le DOM, la conservation du dossier, le bouton de nouvelle tentative désactivé et l’absence de POST. Appuyer sur Entrée dans le terminal lanceur ferme Firefox et supprime le conteneur jetable. Le script ne lit ni n’écrase le `.env` ou la base de développement.

Si le cache Playwright Firefox est absent, l’installer dans le cache utilisateur, sans installation globale, puis relancer le lanceur :

```powershell
corepack pnpm --filter @veyrobot/dashboard exec playwright install firefox
```

Pour NVDA, utiliser la [page officielle de téléchargement NV Access](https://www.nvaccess.org/download/), démarrer NVDA et ouvrir **Tools → Speech Viewer**.

### Protocole NVDA manuel

1. À l’accueil compte, écouter au Speech Viewer en utilisant Tab puis Entrée sur le lien du serveur de test. Depuis le serveur, atteindre **Paramètres** dans **Pages principales**. Dans les réglages, parcourir **Langue du serveur** et le commutateur **Avertissements** sans les modifier ni sauvegarder; noter nom, rôle et état annoncés (la formulation exacte dépend de la version NVDA/Firefox).
2. Ouvrir **Dossiers**. Vérifier qu’une ligne de dossier de test est présente, puis activer **Actualiser** une seule fois. Le Speech Viewer doit annoncer l’erreur temporaire de l’historique; la ligne déjà affichée doit rester présente et **Attente de Retry-After** être désactivé. Ne pas créer d’avertissement ni envoyer d’action.
3. Dans Paramètres, ouvrir et fermer le menu de langue avec Échap; ouvrir et fermer le sélecteur de couleur avec Échap; vérifier que le focus revient à chaque déclencheur. Ouvrir **Actions membres**, saisir uniquement l’ID fictif `123456789012345678` (le placeholder du champ) et une raison de test, choisir BAN et ouvrir la confirmation. Vérifier l’annonce du dialogue et le retour du focus à **Envoyer la demande** après Échap ou **Annuler**. Ne jamais confirmer l’action; le harnais bloque aussi les requêtes POST.

Après les trois contrôles, appuyer sur Entrée dans le terminal. Rapporter la version NVDA/Firefox et les annonces effectivement entendues. Ce résultat sera consigné comme validation manuelle rapportée, distincte des tests automatisés.

## Captures de contrôle

Les images sont des captures d’un jeu de test synthétique et peuvent être régénérées par le parcours navigateur. Elles ne constituent pas des comparaisons pixel à pixel, et la capture du sélecteur montre volontairement un brouillon non enregistré.

**Accueil utilisateur — 1440×900**

![Accueil du dashboard sur ordinateur](dashboard-browser-captures/desktop-user-home.png)

**Paramètres et sélecteur de couleur — 1440×900**

![Paramètres et sélection de couleur](dashboard-browser-captures/desktop-settings-color-picker.png)

**Navigation mobile ouverte — 390×844**

![Navigation mobile du dashboard](dashboard-browser-captures/mobile-user-navigation.png)

## Limites

- Les moteurs automatisés sont Chromium et Firefox; WebKit, zoom navigateur et lecteurs d’écran (dont NVDA) ne sont pas validés. axe-core et les noms/rôles Playwright complètent les contrôles interactifs; ils ne prouvent pas la parole d’un lecteur d’écran.
- Les 429 et les réponses OAuth/Discord sont des fixtures Playwright ou API; aucun 429 public réel ni OAuth Discord réel n’a été reproduit pendant cette tranche.
- La base PostgreSQL est réelle mais jetable. Le bot/Gateway n’a pas été connecté et aucun résultat ne démontre un comportement Discord réel.
- Les parcours manuels déjà rapportés par le propriétaire restent des validations séparées; ce rapport ne les revendique pas comme exécutions de l’agent.
- L’essai cible ces vues et dimensions, sans prétendre couvrir tous les navigateurs, tailles, langues, états réseau ou technologies d’assistance.
