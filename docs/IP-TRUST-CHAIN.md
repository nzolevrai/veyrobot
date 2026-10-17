# Chaîne de confiance et identité IP de limitation

État vérifié pour le socle mono-hôte au 17 octobre 2026. L'identité IP ne sert qu'à choisir des compteurs de limitation; elle n'autorise jamais une session ou une action.

## Frontières supportées

```text
Navigateur ──TLS──> ingress public ──loopback──> Next ──réseau Compose privé──> API
                         │                         │                              │
              remplace X-Real-IP       canonicalise et signe HMAC       vérifie HMAC et
              depuis son pair socket   uniquement ce champ configuré    canonicalise à nouveau
```

La référence Compose ne contient pas d'ingress TLS. Elle lie le port Next à `127.0.0.1:3000`; l'exploitant doit placer devant lui un ingress qui n'est pas joignable par le navigateur via un autre chemin. PostgreSQL et l'API ne publient aucun port. L'API conserve `trustProxy` désactivé; `req.ip` en repli est donc l'adresse de son pair socket (normalement Next sur le réseau privé Compose). Un pare-feu doit empêcher l'accès externe direct à Next et à l'API.

L'exemple Nginx de `PRODUCTION-REFERENCE.md` convient si Nginx voit directement le client. Si un load balancer se trouve devant Nginx, `$remote_addr` désigne ce load balancer: configurer explicitement le module `real_ip` et ses pairs CIDR de confiance, ou utiliser l'adresse source attestée par le fournisseur. Ne jamais accepter `X-Forwarded-For` fourni par le navigateur comme source. Le proxy doit écraser `X-Real-IP` avec une seule adresse, jamais concaténer sa valeur entrante.

Next retire les en-têtes `Forwarded`, tous les `X-Forwarded-*`, `X-Real-IP` et les deux en-têtes internes `X-Veyrobot-Client-IP*` reçus du visiteur avant l'appel API. Il lit ensuite `X-Real-IP` seulement lorsque `DASHBOARD_TRUSTED_CLIENT_IP_HEADER=x-real-ip`, valide et canonicalise cette valeur, puis produit une identité HMAC. Le HMAC prouve que Next a émis la valeur vers l'API; il ne prouve pas que Next a reçu cette adresse d'un ingress honnête. Cette dernière garantie vient uniquement de la séparation réseau et du comportement d'écrasement de l'ingress.

L'API ne lit jamais un en-tête d'identité sans signature valide. Une signature absente, altérée, avec un autre secret ou une adresse invalide fait retomber sur `req.ip`; aucun `X-Forwarded-*` ou `X-Real-IP` brut ne sert de repli. Si une seule des deux applications manque de configuration, ou si les secrets diffèrent, les clients anonymes partagent le bucket de pair socket derrière Next: le service reste fermé sur l'identité, mais la séparation par adresse client disparaît. En production Compose, la variable HMAC est obligatoire côté API et Dashboard et le header source est fixé à `x-real-ip`; le démarrage échoue si le secret est absent. Garder le secret HMAC partagé seulement entre ces deux services et le faire tourner ensemble.

## Format et canonicalisation

`ipaddr.js` 2.5.0 parse l'adresse, avec une validation stricte de l'enveloppe avant son appel. Les valeurs acceptées sont une seule adresse littérale nue, jusqu'à 45 caractères:

- IPv4 décimale à quatre octets, sans zéros initiaux ambigus (sauf `0`), chacun entre 0 et 255;
- IPv6 compressée ou développée, casse quelconque, rendue en forme RFC 5952 minuscule;
- IPv4 mappée IPv6 (notation pointée ou hexadécimale) ramenée à l'IPv4 correspondante, donc même bucket que cette IPv4.

Les listes et doublons fusionnés par HTTP (`,`), espaces, ports, crochets, zones (`%`), CIDR, séparateurs `/` ou `\`, notations IPv4 abrégées/non décimales, valeurs non ASCII inattendues et longueurs supérieures sont rejetés. Les adresses IPv6 ne sont pas regroupées par préfixe: chaque adresse distincte a son propre bucket. Une représentation équivalente donne la même chaîne avant la signature et après sa vérification.

Le payload HMAC-SHA256 versionné est `veyrobot-client-ip:v1\n<adresse-canonique>`; la signature hexadécimale est comparée en temps constant. Il n'y a pas d'horodatage ni de stockage anti-rejeu. La signature n'est ni un jeton d'autorisation ni un secret retourné au navigateur; son rejeu exige l'accès aux en-têtes internes Next→API et ne confère que l'identité d'un bucket de limite. Le réseau privé API et la non-exposition des en-têtes internes bornent ce risque. Un anti-rejeu à état ajouterait une dépendance par requête sans bénéfice d'autorisation démontré.

## Quotas et limites opérationnelles

Les demandes passent d'abord par le plafond pré-authentification par IP, puis le quota général par session seulement après validation PostgreSQL du grant; les sessions révoquées, expirées, incomplètes et les pannes de validation utilisent l'identité IP. Les limites sont en mémoire par processus. Un ingress/WAF garde donc le plafond public global; un réplica API n'obtient pas de compteurs partagés par cette signature.

La CI vérifie la canonicalisation, la signature, les refus de valeurs ambiguës, les quotas API réels sur PostgreSQL isolé et Next→API à travers un ingress HTTP jetable qui remplace `X-Real-IP` par son pair socket. Cela prouve le comportement de ce test local, pas la configuration réelle de l'hôte, du load balancer, du DNS, du TLS ou du pare-feu de production. Il n'y a pas eu de test d'intrusion ni de trafic public.
