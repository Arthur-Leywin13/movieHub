# Bot Telegram d'administration

Le bot est un **client de l'API** : il n'accède ni à la base de données ni à R2, et ne détient aucune clé R2. Son arrêt n'affecte ni l'API, ni les applications. Il identifie l'administrateur par son **identifiant Telegram numérique** (jamais le @username), vérifié deux fois : par le bot (`TELEGRAM_ADMIN_IDS`) puis par l'API (fiche Admin en base).

## Commandes

| Commande | Rôle |
|---|---|
| `/addfilm`, `/addserie`, `/addanime` | parcours d'ajout guidé (affiche, titre, titres alternatifs, description, année, genres, date de sortie, langues audio et sous-titres annoncées, bande-annonce, fichier vidéo et sous-titres, vérification, publication ou brouillon). Série/animé : saison, date de sortie de la saison, épisodes (plusieurs langues par épisode) |
| `/search [texte]`, `/customize`, `/edit` | cherche un contenu (brouillons inclus) puis ouvre sa fiche et ses actions : description, langues, affiche, bande-annonce, version vidéo, saison, épisodes, version d'épisode, statut, médias |
| `/delete [texte]` | dépublier ou archiver (aucune suppression définitive depuis le bot) |
| `/stats` | nombre de films, séries, animés, publiés, brouillons |
| `/resume` | reprend un traitement interrompu |
| `/cancel` | interrompt un traitement en cours ; un second `/cancel` (ou `/cancel` hors traitement) abandonne l'opération |

## Comportements garantis

- **Résumé puis confirmation** avant toute modification de fiche (calculé par l'API, rien n'est modifié tant que vous ne confirmez pas) et avant publication d'un nouveau contenu.
- **Ajout ≠ remplacement** : une nouvelle langue ajoute une version (en brouillon ou publiée à votre choix), la version existante n'est jamais touchée. Une nouvelle affiche principale archive l'ancienne (restaurable depuis « Médias »).
- **Doublon** : l'échec cite le contenu existant.
- **Fichiers jusqu'à 2000 Mo** : lus sur le disque du serveur Bot API local, envoyés vers R2 par morceaux de 16 Mio via des liens signés. Le bot renvoie uniquement les morceaux manquants après une coupure.
- **Traitement en arrière-plan** : le bot reste réactif pendant un envoi long (progression affichée, `/cancel` possible).
- **Reprise** : l'état de chaque conversation et l'avancement des envois sont écrits sur disque (`BOT_STATE_DIR`) ; après un redémarrage, la conversation continue et `/resume` reprend sans recréer ni renvoyer en double.

## Installation

1. Créez le bot avec @BotFather (jeton) et l'application Telegram sur my.telegram.org (`api_id`, `api_hash`, pour le serveur local).
2. Démarrez le serveur Bot API local : `docker compose --profile bot up -d` (service `telegram-bot-api`, voir `docker-compose.yml`).
3. **Le bot doit lire les mêmes fichiers que ce serveur** : même machine, et le même dossier visible au même chemin (`/var/lib/telegram-bot-api`). Sinon : « Fichier introuvable sur le disque ».
4. Variables du bot : `TELEGRAM_BOT_TOKEN`, `TELEGRAM_API_BASE_URL` (serveur local), `API_BASE_URL`, `BOT_SERVICE_TOKEN` (le même que l'API), `TELEGRAM_ADMIN_IDS`, `BOT_MAX_FILE_BYTES`, `BOT_STATE_DIR` (dossier persistant).
5. Le premier administrateur est créé au démarrage de l'API avec `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` et `BOOTSTRAP_ADMIN_TELEGRAM_ID` (le même identifiant que dans `TELEGRAM_ADMIN_IDS`). Sans effet dès qu'un administrateur existe.
6. Lancement : `npm run start -w @movieshub/bot`.

## Limites actuelles

- Pas de publication programmée, de retrait annoncé d'un contenu, de notifications ni de suppression de fichiers R2 (l'API ne les offre pas encore).
- `/stats` ne donne que des totaux de catalogue (les statistiques d'usage viendront avec le dashboard).
- Un administrateur à la fois par conversation ; plusieurs administrateurs en parallèle sont possibles.
