# stashdb-release-bot

Bot Discord qui **annonce les nouvelles sorties des studios et interprètes que
vous suivez sur [StashDB](https://stashdb.org)**. Mettez un studio ou un
interprète en favori sur votre compte StashDB : dès qu'une nouvelle scène sort,
le bot la publie dans vos salons Discord, avec titre, studio, date, durée,
interprètes, image, lien et la raison de l'annonce (« suivi : … »).

Chaque annonce ressemble à ceci :

```
Titre de la scène                      ← lien vers la page StashDB
Studio: Nom du studio
Date: 2026-11-16
Durée: 34m
Performeurs: Interprète A, Interprète B
[ image de la scène ]
StashDB — Nouvelle sortie · suivi : Nom du studio • 16/11/2026
[ Télécharger image ]
```

Le bouton **Télécharger image** renvoie l'image en pièce jointe, visible
seulement par la personne qui a cliqué (un clic toutes les 5 secondes,
8 Mo au plus).

![Tests](../../actions/workflows/tests.yml/badge.svg)

- **Zéro configuration côté Discord pour suivre** : la liste suivie, ce sont
  vos favoris StashDB, studios comme interprètes.
- **Une seule annonce par scène**, même si elle est trouvée par un studio et
  par un ou plusieurs interprètes suivis.
- **Aucun doublon** : l'identifiant de chaque scène est enregistré, salon par
  salon, au moment de l'envoi ; une scène déjà postée dans un salon n'y
  repart jamais, même après un redémarrage ou un plantage.
- **Pas d'avalanche** : un studio ou interprète nouvellement suivi ne déverse pas son
  historique, seules les sorties suivantes sont annoncées.
- **Rien n'est perdu** : une scène n'est marquée « annoncée » qu'une fois
  réellement postée ; une panne de StashDB ou de Discord est simplement
  rattrapée au tour suivant.
- **Scènes annoncées à l'avance** : publiées le jour de leur sortie, pas avant.
- **Léger** : un processus Node.js, une base SQLite locale, aucun port ouvert.

> StashDB référence du contenu pour adultes : le bot ne publie **que dans des
> salons marqués NSFW**, vérifiés à la configuration et à chaque envoi.

---

## Sommaire

1. [Prérequis](#prérequis)
2. [Créer l'application Discord](#1-créer-lapplication-discord)
3. [Récupérer la clé API StashDB](#2-récupérer-la-clé-api-stashdb)
4. [Installer et lancer](#3-installer-et-lancer)
5. [Utilisation : la commande `/sorties`](#utilisation--la-commande-sorties)
6. [Configuration](#configuration)
7. [Fonctionnement](#fonctionnement)
8. [Développement](#développement)

---

## Prérequis

- **Node.js 20 ou plus récent** (ou Docker) ;
- un **compte StashDB** et sa clé API ;
- un **serveur Discord** sur lequel vous avez la permission *Gérer le serveur*.

## 1. Créer l'application Discord

1. Ouvrez le [portail développeur Discord](https://discord.com/developers/applications)
   → **New Application**.
2. Page **General Information** : copiez l'**Application ID** → `CLIENT_ID`.
3. Page **Bot** : **Reset Token**, copiez le jeton → `DISCORD_TOKEN`.
   Aucun *Privileged Gateway Intent* n'est nécessaire.
4. Page **OAuth2 → URL Generator** : cochez les scopes `bot` et
   `applications.commands`, puis les permissions **View Channels**,
   **Send Messages** et **Embed Links**. Ouvrez l'URL générée pour inviter le
   bot sur votre serveur.

   Raccourci (remplacez `CLIENT_ID`) :
   ```
   https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot+applications.commands&permissions=19456
   ```

## 2. Récupérer la clé API StashDB

1. Connectez-vous à StashDB, ouvrez votre **profil** et copiez votre **API key**
   → `STASH_API_KEY`.
2. Mettez en **favori** (étoile sur sa page) chaque studio et chaque
   interprète à suivre.

## 3. Installer et lancer

```bash
git clone https://github.com/passasa/stashdb-release-bot.git
cd stashdb-release-bot
cp .env.example .env    # puis renseignez DISCORD_TOKEN, CLIENT_ID et STASH_API_KEY
```

### Avec Node.js

```bash
npm ci --omit=dev
npm start
```

La base est créée dans `./data/bot.db`.

### Avec Docker (image prête à l'emploi)

Une image multi-architecture (**amd64** et **arm64**, PC comme NAS) est
publiée sur `ghcr.io/passasa/stashdb-release-bot` à chaque version. Le dépôt
n'est pas nécessaire : il suffit de [`docker-compose.yml`](docker-compose.yml)
et d'un `.env` dans un même dossier.

```bash
mkdir stashdb-release-bot && cd stashdb-release-bot
curl -fsSLO https://raw.githubusercontent.com/passasa/stashdb-release-bot/main/docker-compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/passasa/stashdb-release-bot/main/.env.example
# renseignez DISCORD_TOKEN, CLIENT_ID et STASH_API_KEY dans .env, puis :
docker compose up -d
docker compose logs -f
```

| Action | Commande |
|---|---|
| Mettre à jour | `docker compose pull && docker compose up -d` |
| Arrêter | `docker compose down` (les données restent) |
| Repartir de zéro | `docker compose down -v` (supprime `bot.db`) |
| Construire depuis les sources | `docker compose -f docker-compose.yml -f compose.build.yml up -d --build` |

Le conteneur redémarre tout seul (`restart: unless-stopped`), garde ses données
dans le volume `bot-data`, n'expose aucun port et tourne durci : système de
fichiers en lecture seule hors `/data`, aucune capacité Linux, 256 Mo de
mémoire au plus.

Étiquettes : `latest` (branche `main`), `X.Y.Z` et `X.Y` (versions taguées
`vX.Y.Z`), `sha-<commit>`. Pour figer une version, remplacez `latest` dans
`docker-compose.yml`.

Portainer, Synology, Unraid… : créez une *stack* avec le contenu de
`docker-compose.yml` et renseignez les variables de `.env.example`.

Au démarrage, le journal doit afficher :

```
✓ Connecté à Discord : MonBot#1234
  ✓ Commande /sorties enregistrée
  Vérification toutes les 60 min, sorties de moins de 30 jours.
```

Dernière étape, dans Discord : `/sorties salon canal:#nouveautes`.

---

## Utilisation : la commande `/sorties`

Réservée aux membres ayant *Gérer le serveur* ; toutes les réponses ne sont
visibles que par vous.

| Sous-commande | Effet |
|---|---|
| `/sorties salon canal:` | Annonce les nouvelles sorties dans ce salon (NSFW obligatoire). Plusieurs salons possibles. |
| `/sorties retirer-salon canal:` | N'annonce plus dans ce salon. |
| `/sorties suivis` | Studios et interprètes suivis (vos favoris StashDB). |
| `/sorties dernieres` | Les 10 dernières sorties annoncées, avec lien. |
| `/sorties etat` | Salons, nombre de suivis, dernier et prochain tour, erreurs éventuelles. |
| `/sorties verifier` | Lance une vérification immédiatement. |

Pour **suivre** ou **ne plus suivre** un studio ou un interprète, ajoutez-le ou retirez-le de vos
favoris sur StashDB : la liste se met à jour au tour suivant
(ou tout de suite avec `/sorties verifier`).

---

## Configuration

Toutes les options se règlent dans `.env` (voir [`.env.example`](.env.example)).

| Variable | Requis | Défaut | Rôle |
|---|---|---|---|
| `DISCORD_TOKEN` | oui | | Jeton du bot |
| `CLIENT_ID` | oui | | ID de l'application Discord |
| `STASH_API_KEY` | oui | | Clé API du compte StashDB dont les favoris sont suivis |
| `STASH_ENDPOINT` | | `https://stashdb.org/graphql` | Point GraphQL (une autre instance stash-box fonctionne aussi) ; les liens des annonces en sont déduits |
| `FOLLOW_PERFORMERS` | | `true` | `false` : ne suivre que les studios, même si des interprètes sont en favori |
| `POLL_STASHDB_MS` | | `3600000` (1 h) | Intervalle de vérification, 5 min minimum |
| `RELEASES_MAX_AGE_DAYS` | | `30` | Une scène plus ancienne n'est jamais annoncée |
| `BOT_TIMEZONE` | | `Europe/Paris` | Fuseau qui décide de « aujourd'hui » |
| `ALLOWED_GUILDS` | | *(tous)* | IDs de serveurs autorisés, séparés par des virgules ; le bot quitte les autres |
| `BOT_DATA_DIR` | | `./data` | Répertoire de `bot.db` (`/data` en Docker) |

---

## Fonctionnement

Un tour de vérification a lieu 15 s après le démarrage, puis à chaque
intervalle (jamais deux tours en même temps) :

1. lecture de vos **studios et interprètes favoris** sur StashDB ;
2. pour chacun, lecture de ses **25 dernières scènes** (les suivis déjà
   connus d'abord, les nouveaux ensuite) ;
3. sélection des scènes **sorties** (date ≤ aujourd'hui et de moins de
   `RELEASES_MAX_AGE_DAYS` jours) et **jamais vues** ;
4. pour un studio ou interprète **suivi pour la première fois**, ces scènes sont enregistrées
   sans être annoncées ;
5. les autres sont annoncées une seule fois chacune de la plus ancienne à la plus récente, **20 au
   plus par tour** (le reste suit au tour d'après), dans tous les salons
   configurés.

### Fiabilité

| Situation | Comportement |
|---|---|
| Aucun salon configuré | Les sorties attendent ; elles partent dès qu'un salon est défini. |
| Envoi impossible partout | La scène est retentée au tour suivant. |
| Discord refuse le message dans un salon | Retenté au tour suivant dans ce salon seulement ; les autres ne la reçoivent pas deux fois. |
| Issue d'envoi inconnue (coupure réseau pendant l'envoi) | Pas de nouvel essai dans ce salon : dans le doute, mieux vaut ne pas risquer un doublon. |
| Arrêt du bot juste après un envoi | Au redémarrage, la scène est reconnue comme déjà envoyée et n'est pas repostée. |
| Un studio ou interprète ne répond pas | Ce suivi seul est sauté, et repris au tour suivant (⚠ dans `/sorties suivis`). |
| StashDB injoignable | Le tour est annulé sans rien modifier. |
| Interprète ajouté le jour d'une sortie d'un studio déjà suivi | La sortie est bien annoncée (les suivis connus passent avant l'amorçage). |
| Salon en échec 5 fois de suite | Désactivé ; `/sorties salon` le réactive. |
| Suivi retiré puis remis en favori | Traité comme nouveau : pas de rattrapage massif. |

### Sécurité

- publication **uniquement en salon NSFW** ;
- aucune mention possible (`@everyone`, rôles, membres) ;
- Markdown échappé et longueurs bornées sur tout texte venant de StashDB ;
- liens construits depuis l'identifiant de scène validé, images en HTTPS seulement ;
- bouton « Télécharger image » : identifiant vérifié, image relue sur StashDB
  (jamais une adresse fournie par le clic), type `image/*` et taille bornés ;
- secrets uniquement dans `.env`, jamais dans l'image Docker.

### Données

`bot.db` (SQLite) contient les salons, les studios et interprètes suivis, les scènes déjà vues,
le journal des envois (identifiant de scène × salon) et l'état du dernier tour. Le supprimer revient à repartir de zéro (les
sorties récentes seront de nouveau amorcées, pas annoncées).

---

## Développement

```
src/
├── bot.js       démarrage, appels StashDB, envoi Discord, commande /sorties
├── tracker.js   base SQLite et tour de vérification (dépendances injectées)
└── releases.js  règles pures : date de sortie, sélection, embed
test/            tests Vitest (sans réseau ni Discord)
```

```bash
npm ci
npm test
```

`tracker.js` et `releases.js` ne font aucune entrée/sortie : StashDB, Discord et
la base leur sont fournis, ce qui permet de tester des tours complets sur une
base SQLite en mémoire. Les tests tournent à chaque push (GitHub Actions).

---

## Licence

Aucune licence n'est accordée : le code est visible, mais tous droits sont
réservés à son auteur. Contactez-le pour toute réutilisation.

StashDB est un service tiers, sans lien avec ce projet ; respectez ses
conditions d'utilisation et limitez la fréquence des requêtes.
