# Matrice des fonctions Discord

État du code au 17 octobre 2026, avec validations manuelles du propriétaire consignées séparément des tests automatisés. Les coûts décrivent le type de charge, sans annoncer de capacité. Le bot n'active que l'intent `Guilds`; les permissions effectives de l'acteur et du bot sont revérifiées par le service métier.

| Fonction | Utilité | Permissions acteur / bot | Intents et contraintes Discord | Coût / repli | État réel |
|---|---|---|---|---|---|
| OAuth et sélection | Choisir les serveurs accessibles au compte | OAuth `identify guilds`; propriétaire ou `ManageGuild` pour l'API | Aucun intent Gateway | Liste OAuth plafonnée à 200 par page; cache API 10 s, borné | Le propriétaire rapporte OAuth, navigation, actualisation, déconnexion et refus après déconnexion validés manuellement; aucune validation indépendante de cette tranche |
| Avertissement/dossier | Note durable visible depuis Dashboard et `/warn` | `ModerateMembers` vérifié par l'API/commande; le bot n'a pas de permission Discord à utiliser en SQL | `Guilds`; aucun message/intention privilégiée | Une écriture PG; historique paginé côté API | Le propriétaire rapporte dashboard et `/warn` validés; cela n'a pas validé de sanction Discord |
| Timeout/retrait | Restreindre ou rétablir un membre | `ModerateMembers` acteur + bot; hiérarchie membre | `Guilds`; fetch ciblé | Lectures ciblées et 1 mutation | Le propriétaire rapporte timeout et retrait immédiat validés; cette revue n'a pas reproduit d'action réelle |
| Kick | Retirer un membre | `KickMembers` acteur + bot; hiérarchie | `Guilds`; fetch membre | 1 mutation; réponse incertaine jamais rejouée | Slash + Dashboard via service partagé; tests doubles |
| Ban/unban/ban temporaire | Bannir, débannir, expirer une décision | `BanMembers` acteur + bot; hiérarchie lorsqu'une cible est membre | `Guilds`; unban par snowflake possible | Vérification du ban et mutation; expiration persistée; 429 géré par REST, 5xx/timeouts incertains | Tests automatisés seulement; aucune validation réelle déclarée pour bans, débans ou expirations |
| Suppression de messages | Nettoyage borné, filtré par auteur | Acteur et bot : `ManageMessages`, `ViewChannel`, `ReadMessageHistory` effectifs dans le salon | Pas d'intent `GuildMessages` ni de `MessageContent`; fetch REST ciblé. 1–100 messages, bulk entre 2 et 100, les messages de plus de 14 jours sont ignorés | Fetch d'au plus 100 puis au plus un DELETE individuel ou un bulk DELETE; résultat avec nombre supprimé/ignoré | Dashboard + `/purge`, filtre auteur uniquement, résultat journalisé. Aucun filtre texte ni lecture/conservation du contenu |
| Slowmode | Configurer/désactiver le délai par utilisateur | Acteur + bot : `ManageChannels` dans le salon | `Guilds`; types texte compatibles seulement; valeur 0–21600 s | 1 lecture salon + 1 PATCH | Le propriétaire rapporte slowmode et restauration validés manuellement; aucune mesure de volume |
| Verrou/restauration salon | Refuser/rétablir `SendMessages` pour `@everyone` | Acteur + bot : `ManageRoles` dans le salon | `Guilds`; overwrite salon doit exister/être éditable | Une lecture + une modification d'overwrite; snapshot durable par serveur/salon | Dashboard + `/lock`, `/unlock`; restaure seulement si le bit vaut encore `deny`; ambiguïté si un admin écrit exactement la même valeur |
| Softban | Ban puis retrait afin de retirer les messages récents | `BanMembers`; cible et rôles | `Guilds`; deux mutations non atomiques, purge API limitée aux sept derniers jours | Deux appels et compensation incertaine | À faire; aucun bouton ni commande présenté comme actif |
| Slowmode/verrou par catégorie | Appliquer aux salons ciblés/catégories | `ManageChannels`/`ManageRoles` | Changements d'overwrites par salon; aucune restauration globale | N appels proportionnels aux salons concernés | À faire |
| Surnoms | Changer le surnom en contexte de modération | `ManageNicknames`; hiérarchie/owner | `Guilds`; membre récupéré à la demande | 1 fetch + 1 mutation | À faire |
| Actions vocales | Mute serveur/déplacer un membre | `MuteMembers`/`MoveMembers`; hiérarchie | `Guilds`, `GuildVoiceStates` | Fetch vocal + mutation | À faire; aucune capture audio |
| Filtres automatiques | Détecter spam, invites, liens, répétitions, mentions, caps, emojis, pièces jointes | `ManageMessages` pour suppression; `ManageGuild` pour AutoMod natif | Gateway `GuildMessages` et éventuellement intent privilégié `MessageContent` pour le texte; AutoMod Discord bloque avant publication, bot agit après publication | Coût par message; mode observation et limites nécessaires | À faire; aucune détection IA ni protection automatisée active |
| Signalements/recours | Recevoir, examiner et suivre une contestation | Pas de permission Discord de stockage; accès d'équipe explicite à créer | Aucun intent | DB, limitation d'abus et rétention nécessaires | À faire |
| Raid / âge du compte | Détecter des arrivées rapides et confiner prudemment | Alertes seules; actions `ModerateMembers`/`KickMembers` opt-in | `GuildMembers` privilégié; approbation Discord potentielle | Événements de membres, fenêtres temporelles, faux positifs | À faire; aucune réaction automatique en production |
| Journaux d'audit serveur | Corréler bans, suppressions et modifications sensibles | `ViewAuditLog`; permission d'action distincte | `Guilds`; entrées différées et attribution incertaine | Requêtes REST; jamais attribuer une action sur un rapprochement ambigu | À faire |
| Présence bot | Afficher l'état shard/dashboard | Aucun droit OAuth supplémentaire | Un heartbeat PG par shard toutes les 30 s; TTL 90 s | O(shards) par heartbeat, présence installée par guild | Implémenté; connexion Gateway réelle observée passivement sur le serveur privé du propriétaire pour F14, sans valider la mémoire sur une grande population |
| Abonnements | Quotas et droits commerciaux | Aucun droit Discord | Premium Apps/éligibilité/prix à revalider avant vente | Frais, support, stockage à mesurer | Aucun paiement, offre payante ou entitlement implémenté |

`ManageRoles`, `ManageChannels`, `ManageMessages`, `ViewChannel` et `ReadMessageHistory` s'ajoutent aux permissions de modération déjà livrées pour l'installation complète. Aucun module ne demande `Administrator`. Les commandes de test sont publiées uniquement sur `DISCORD_TEST_GUILD_ID`.

## Mise à jour : modules et réglages par serveur

| Fonction | Autorisation / intent / limite | État vérifié |
|---|---|---|
| Rail de serveurs | OAuth `guilds`, propriétaire ou `ManageGuild`; installation vérifiée par `GET /guilds/{id}` avec le bot après action explicite. Aucune permission Gateway supplémentaire. | Bot absent, installé hors ligne et en ligne distingués côté API. Test local Discord simulé; installation réelle à revérifier dans l’interface. |
| Activation Avertissements | `ModerateMembers` utilisateur, `Guilds`; aucune mutation Discord. Valeur par défaut `false`. | PostgreSQL + API + `/warn` et dashboard. Refus testé via API simulée et transaction PG. |
| Activation Actions membres | Permission Discord liée à l’action pour l’utilisateur et le bot; `Guilds`, hiérarchie au moment de l’exécution. Valeur par défaut `false`. | PostgreSQL + API + commandes slash + worker. Refus de soumission testé avec doubles; aucune sanction réelle lancée. |
| Activation Actions salons | Permissions effectives de salon selon l’action; `Guilds`. Valeur par défaut `false`. | PostgreSQL + API + commandes slash + worker. Refus partagé; aucune suppression réelle lancée. |
| Dossiers | OAuth `ManageGuild`; consultation possible quand un module est désactivé. | Non désactivable afin de préserver historique et échéances. Isolation vérifiée avec API et PostgreSQL locaux. |
| Langue, fuseau, couleur | OAuth `ManageGuild`; `fr`/`en`, IANA, `#RRGGBB`; aucune permission Discord supplémentaire. | Persistés et validés; réponses éphémères du bot localisées et colorées, dates affichées au fuseau; aperçu local. Application en direct sur Discord non rejouée. |

Les demandes acceptées avant la désactivation et les échéances de bans temporaires confirmés restent engagées. La désactivation ne lance aucune annulation ni débannissement anticipé. Les exemples « Arrivées et départs » et « Rôles automatiques » sont uniquement des entrées indisponibles du registre, sans commande, API ni interrupteur.

Validation manuelle rapportée par le propriétaire sur le serveur privé : OAuth, navigation, actualisation, déconnexion et refus d'accès après déconnexion; paramètres persistants et activation/désactivation; avertissements du dashboard et `/warn`; timeout/retrait immédiat; slowmode/restauration. Cette déclaration n'a pas été reproduite indépendamment. Aucun ban, unban, kick, purge ou résultat réel non cité n'est déclaré validé.

## Navigation et édition de configuration (13 octobre 2026)

| Capacité | État réel / contrôle |
|---|---|
| Routes par serveur | Routes Next.js `overview`, `settings`, `premium`, `warnings`, `member-actions`, `channel-actions`, `records`; layout serveur vérifié par l’API. Redirection des accès non authentifiés vérifiée par HTTP; navigation visuelle à contrôler. |
| Premium | Page d’information seulement. Aucun abonnement, prix, paiement ou droit premium actif. |
| Activation dans le module | Interrupteurs liés au brouillon pour les trois modules fonctionnels. Une action reste soumise à la version enregistrée côté API/bot/worker. |
| Sauvegarde groupée | API `kind=patch`, validation et version optimiste, transaction PG et audit. Intégration PG : champs multiples, conflit, valeur IANA refusée, isolation et redémarrage vérifiés. |
| Couleur et langue | Radix Select pour `fr`/`en`; sélecteur local avec vingt couleurs référencées dans `docs/DASHBOARD-DESIGN.md`, HSV et hex. Persistance API vérifiée; interaction visuelle et clavier à contrôler dans le navigateur. |
