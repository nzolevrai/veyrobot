# F14 — mémoire et cycle de vie Gateway

## Périmètre et méthode

Relevé passif du processus `apps/bot/dist/index.js` connecté au Gateway discord.js, sur l’unique serveur privé déjà autorisé. Démarrage : 17 octobre 2026, Node 24.19.0, discord.js 14.27.0, Windows; PostgreSQL 17 et Redis 7 étaient des conteneurs jetables dédiés, sans opérations de modération ni jobs. La base ne contenait pas de demandes à exécuter; seul le heartbeat de présence écrivait dans PostgreSQL. Aucun avertissement, sanction, message ou suppression Discord n’a été créé. Aucun serveur, rôle ou droit n’a été modifié.

Après connexion et stabilisation, 11 instantanés d’exploitation espacés d’environ une minute ont couvert environ dix minutes au repos. Il n’y a eu ni trafic synthétique ni objets discord.js synthétiques. Aucun GC forcé n’a été demandé. Les valeurs de mémoire viennent de `process.memoryUsage()` dans le bot réel; le retard de boucle vient de `monitorEventLoopDelay` à résolution 20 ms. Ce relevé est court et ne constitue pas une campagne de croissance ou un dimensionnement.

## Résultats

| Mesure | Min–max observé | Note |
|---|---:|---|
| RSS du processus | 110,1–115,9 MiB | Pas une limite cgroup ni une attribution par composant. |
| Heap utilisé | 39,7–44,3 MiB | Le dernier échantillon est revenu à environ 40,7 MiB sans GC forcé; les oscillations ne démontrent pas une croissance retenue. |
| Mémoire externe | 10,1–12,1 MiB | Inclut les ArrayBuffers. |
| ArrayBuffers | 0,5–2,2 MiB | Sous-ensemble de `external`; ne pas additionner ces valeurs. |
| Retard event loop p95 échantillonné | 31,9–32,0 ms | Histogramme de résolution 20 ms à très faible activité; bruit de quantification, pas une latence utilisateur. |
| Utilisation event loop | 0,28–0,41 % | Fenêtres d’environ une minute au repos. |
| Cache discord.js | 1 guild, 4 salons, 1 utilisateur, 0 emoji, 3 rôles, 1 membre, 0 ban | Identifiants non journalisés; cardinalités constantes pendant la fenêtre. |
| Connexions et travail | Redis 3 clients; pool PG 3 connexions idle, 0 attente; file 0/0/0/0 | Dans ces services jetables et au repos. |

L’augmentation progressive du heap aux premiers échantillons s’est suivie d’une baisse naturelle; sans GC forcé ni campagne plus longue, elle n’est pas interprétée comme une fuite. Le RSS est resté dans une plage étroite pendant cette fenêtre, mais un seul serveur ne représente pas les tailles ni la variété des guildes en production.

## Politique de caches et cycle de vie observés

Le Client ne demande que l’intent Gateway `Guilds`. Il n’active pas les intents privilégiés Membres, Présence ou Contenu des messages. Les membres acteur/cible et les bans sont lus à la demande avec `cache:false`; le membre du bot obtenu par `fetchMe()` peut rester dans le cache. La purge lit les messages avec `cache:false`. Les caches de guildes, salons et rôles restent actifs, car le routage des interactions et les vérifications de permissions/hierarchie en dépendent. Aucun changement de taille de cache n’est justifié par un échantillon d’une guilde.

Avec discord.js 14.27.0, les réglages par défaut documentés limitent le cache des messages à 200 et nettoient périodiquement des threads archivés anciens; ils ne bornent pas globalement les caches de guildes, salons, rôles ou membres. La documentation avertit que les remplacements de cache de certains managers cœur ne sont pas pris en charge. Une modification globale risquerait donc d’affecter des parcours sans preuve de gain. Les lectures ciblées `cache:false` sont documentées par le manager de membres. Références : [Options discord.js 14.27.0](https://discord.js.org/docs/packages/discord.js/14.27.0/Options%3AClass), [GuildMemberManager discord.js 14.27.0](https://discord.js.org/docs/packages/discord.js/14.27.0/GuildMemberManager%3AClass), [intents privilégiés Discord](https://support-dev.discord.com/hc/fr/articles/6207308062871-Que-sont-les-Intents-de-Privil%C3%A9ge).

Le bot utilise des timers partagés pour la présence (30 s), le dispatcher (1 s), la réconciliation (60 s) et l’instantané (60 s); un timer de reprise d’appartenance n’existe que si la synchronisation échoue. Le worker démarre un heartbeat de bail lorsqu’une action est active. À l’arrêt normal, worker et queue BullMQ sont fermés, le pool Prisma est déconnecté, puis le Client Gateway est fermé avant de libérer le verrou PostgreSQL. `Client.destroy()` est asynchrone et termine la connexion Gateway selon sa documentation officielle. L’ancien ordre n’attendait pas sa promesse avant de libérer le verrou. Le correctif ciblé attend désormais cette fermeture; `apps/bot/test/shutdown-order.test.mjs` vérifie avec une barrière que le bail ne peut pas être libéré avant la fin de la fermeture. Le code enregistre cinq listeners Client (erreur, Ready, interaction, arrivée/départ de guilde) et deux handlers de processus d’erreur; les handlers SIGINT/SIGTERM ne sont posés qu’après Ready. Aucun listener/timer par guilde n’est créé dans le chemin sain observé.

## Instrumentation

`bot_operational_snapshot` contient RSS, heap utilisé, mémoire externe, ArrayBuffers, retard event-loop p95, utilisation event-loop et nombres agrégés des caches. `readBotCacheCounts` parcourt les guildes une fois par instantané (O(nombre de guildes); environ une fois par minute) et lit les tailles des managers, sans parcourir les membres, rôles ou bans et sans émettre d’identifiants. Une panne de collecte reste prise en charge par le logger d’erreurs borné existant.

## Vérifications

- Connexion réelle au Gateway du serveur privé : oui, observation passive; aucun appel de modération.
- PostgreSQL 17 et Redis 7 jetables dédiés : oui; aucune opération de modération en file.
- Mesure avant/après d’une optimisation mémoire : non applicable, aucun cache n’a été modifié.
- Test ciblé de l’ordre d’arrêt : double contrôlé et barrière asynchrone; pas un test d’arrêt d’un Gateway Discord réel.
- Tests PostgreSQL/Redis/Next globaux : non relancés pour cette instrumentation bot; leur état CI doit être consulté sur le commit livré.

## Limites restantes

La fenêtre ne couvre qu’une guilde et environ dix minutes au repos. Elle ne mesure pas le coût de guildes de tailles variées, les pointes d’événements, la rétention longue, une reconnexion répétée, le trafic REST ni la mémoire cgroup en hébergement. Aucun nombre de serveurs supportés n’en découle. Répéter l’observation sur l’hébergement avec ses vraies limites et tailles de guildes avant de modifier les caches ou les budgets.
