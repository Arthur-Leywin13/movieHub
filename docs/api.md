# API MoviesHub — référence (état actuel)

Format JSON. Erreurs : `{ "error": { "code", "message", "details?", "requestId?" } }`. Chaque réponse porte `x-request-id`.
Codes : 400 validation, 401 non authentifié, 403 interdit, 404 introuvable, 409 conflit, 413 corps trop gros, 415 mauvais Content-Type, 429 trop de requêtes, 502 stockage R2.

## Santé
| Route | Rôle |
|---|---|
| `GET /health` | l'API répond |
| `GET /health/ready` | la base répond (503 sinon) |

## Authentification
| Route | Corps | Réponse |
|---|---|---|
| `POST /auth/register` | `email`, `password` (8-128), `displayName` (2-50), `deviceName?`, `platform?` (ANDROID/WEB) | 201 `{ user, accessToken, refreshToken, expiresIn }` |
| `POST /auth/login` | `email`, `password`, `deviceName?`, `platform?` | 200 idem |
| `POST /auth/refresh` | `refreshToken` | 200 nouveaux jetons (l'ancien refresh token devient invalide) ; 409 si déjà renouvelé il y a moins de 10 s |
| `POST /auth/logout` | `refreshToken` | 204 (idempotent) |
| `POST /auth/logout-all` | — (Bearer) | 204 |
| `GET /me` | — (Bearer) | 200 `{ user }` |

Jeton d'accès : `Authorization: Bearer <accessToken>` (15 min). Refresh token : 30 jours glissants, à stocker de façon sécurisée côté application.

## Administration — envois de fichiers (rôles SUPER_ADMIN, ADMIN, EDITOR)
Authentification : Bearer (dashboard) ou `Authorization: Bot <BOT_SERVICE_TOKEN>` + `X-Telegram-User-Id: <id numérique>` (bot).

| Route | Rôle |
|---|---|
| `POST /admin/uploads` `{ kind, filename, sizeBytes }` | `kind` : VIDEO, TRAILER_VIDEO (≤ 2000 Mo, multipart), IMAGE (≤ 25 Mo), SUBTITLE (≤ 5 Mo), envoi unique. Renvoie `mediaFileId` et, selon le cas, `parts[{partNumber,url}]` + `partSize` ou `url` |
| `GET /admin/uploads/:id` | état ; pour un multipart : `uploadedParts`, `missingParts` avec liens renouvelés (reprise) |
| `POST /admin/uploads/:id/complete` | vérifie les morceaux et la taille, passe le fichier en READY (idempotent) ; 400 avec `details.missingParts` si incomplet |
| `POST /admin/uploads/:id/abort` | annule l'envoi (refusé si déjà READY) |

Envoi d'un morceau par le client : `PUT <url>` avec le contenu du morceau, sans autre en-tête d'autorisation. Les morceaux font tous `partSize` octets sauf le dernier.

## Catalogue — lecture publique (sans connexion)
Seuls les éléments au statut PUBLISHED sont visibles (contenu, saison, épisode et version doivent tous l'être). Les liens d'images sont des liens R2 signés (1 h).

| Route | Rôle |
|---|---|
| `GET /contents` | liste : `type` (MOVIE/SERIES/ANIME), `genre` (slug), `year`, `audio`, `subtitle` (codes de langue), `sort` (`new` = date de sortie officielle décroissante, `title`), `page`, `limit` (≤ 50) |
| `GET /contents/:slugOuId` | fiche : titres alternatifs, genres, langues annoncées, affiche principale + images, bande-annonce principale + autres, `available`, et `versions` (film) ou `seasons` (série/animé). Contenu retiré : **410** « Ce contenu a été retiré de l’application. » ; non publié : 404 |
| `GET /seasons/:id/episodes` | épisodes publiés d'une saison publiée, avec leurs versions publiées (langues audio, sous-titres) |
| `GET /search?q=` | recherche classée : accents et majuscules ignorés, fautes de frappe tolérées, titres alternatifs, début de mot, description ; filtres `type`, `genre`, `year`, `audio`, `subtitle`, `page`, `limit` ; `q` de 2 à 100 caractères ; jamais de brouillon ni de contenu retiré |
| `GET /genres`, `GET /languages` | listes pour les filtres |

## Catalogue — administration (rôles SUPER_ADMIN, ADMIN, EDITOR)
Même authentification que les envois (Bearer ou bot). Toute modification est écrite dans le journal d'audit.

| Route | Rôle |
|---|---|
| `GET /admin/contents?q&type&status&page&limit` | recherche (brouillons inclus, titres alternatifs) |
| `GET /admin/contents/:id` | vue complète : saisons, épisodes, versions, affiches (archivées comprises), bandes-annonces |
| `POST /admin/contents` | création (`type`, `title`, `year?`, `releaseDate?`, `description?`, `altTitles?`, `genres?`, `audioLanguages?`, `subtitleLanguages?`). Doublon (même titre/année/type, casse et accents ignorés) : 409 avec le contenu existant |
| `PATCH /admin/contents/:id` | « Personnaliser » : champs à changer, avec `altTitles`, `genres`, `audioLanguages`, `subtitleLanguages` sous la forme `{ add, remove }`. **Sans `confirm: true`** : renvoie seulement le résumé `summary` (avant → après), rien n'est modifié. **Avec** : applique. Ne touche jamais aux saisons, épisodes, versions ni fichiers |
| `POST /admin/contents/:id/status` | `status` : DRAFT, IN_PREPARATION, PUBLISHED, UNPUBLISHED, ARCHIVED (transitions contrôlées ; le retrait et la programmation ont leurs propres parcours, à venir) |
| `POST /admin/contents/:id/seasons`, `PATCH /admin/seasons/:id`, `POST /admin/seasons/:id/status` | saisons (`number`, `releaseDate` obligatoire, `featuredAsNewSeason`) |
| `POST /admin/seasons/:id/episodes`, `PATCH /admin/episodes/:id`, `POST /admin/episodes/:id/status` | épisodes (pas de date propre ; `releaseNote` facultative) |
| `POST /admin/contents/:id/versions` (film), `POST /admin/episodes/:id/versions` | ajoute une **version** (fichier R2 prêt de type VIDEO, `audioLanguages`, `embeddedSubtitles?`, `label?`, `height?`…). Ajoute toujours, ne remplace jamais ; la version naît en DRAFT ; `warnings` signale les langues non annoncées sur la fiche |
| `POST /admin/versions/:id/subtitles` | sous-titres externes (fichier SUBTITLE ; format déduit de l'extension) |
| `POST /admin/versions/:id/status` | publier / dépublier / archiver une version |
| `POST /admin/contents/:id/posters`, `POST /admin/posters/:id/primary\|archive\|restore` | affiches : la 1re devient principale ; changer de principale **archive** l'ancienne (conservée, restaurable) |
| `POST /admin/contents/:id/trailers`, `POST /admin/trailers/:id/primary\|archive\|restore`, `POST /admin/contents/:id/trailers/reorder` | bandes-annonces (fichier R2 **ou** lien https ; générale ou par saison) ; changer de principale ne supprime rien |

Chaque fichier R2 ne peut être utilisé qu'une fois dans le catalogue et doit être `READY` (envoi terminé).

## Accueil et à venir (public)
| Route | Rôle |
|---|---|
| `GET /home` | `newReleases` (films dont la date de sortie officielle est passée, plus récents d'abord), `newSeasons` (saisons mises en avant sorties cette année), `trending` (usage récent pondéré, sans bonus de nouveauté), `upcoming` (sortie future) |
| `GET /upcoming?page&limit` | contenus publiés dont la date de sortie est dans le futur, les plus proches d'abord |

Tendances : score = consultations x1 + téléchargements x5 + favoris x3 + lectures x2 sur 7 jours par défaut ; pondérations et fenêtre modifiables via le réglage « trending » (valeurs invalides ignorées).

## Utilisateur connecté (Bearer)
| Route | Rôle |
|---|---|
| `GET /me/favorites`, `PUT\|DELETE /me/favorites/:contentId` | favoris (contenus publiés seulement ; un favori dépublié est masqué puis retrouvé à la republication) |
| `GET /me/follows`, `PUT\|DELETE /me/follows/:contentId` | suivi des séries et animés ; `PUT` accepte `notifyNewEpisodes`, `notifyNewSeasons` (réglage par série) |
| `GET /me/history`, `PUT /me/history`, `DELETE /me/history/:id`, `DELETE /me/history` | historique : `PUT { contentId \| episodeId, versionId?, positionSeconds, durationSeconds?, completed? }` met à jour la même ligne ; terminé automatiquement à 95 % ; si la synchronisation est désactivée, `{ stored: false }` et rien n'est conservé |
| `GET\|PATCH /me/settings` | `locale`, `notificationsEnabled`, `historySyncEnabled`, `adSoundEnabled` |
| `GET\|POST\|DELETE /me/search-history` | recherches récentes (50 max, doublons fusionnés) |
| `POST /versions/:id/download` | lien signé temporaire (15 min par défaut) + nom de fichier + taille + `allowLocalShare` ; refusé si la version, l'épisode, la saison ou le contenu n'est pas publié (410 si retiré) ; 60 par heure et par utilisateur |
| `POST /downloads/:id/status` | `COMPLETED`, `FAILED` ou `CANCELED` (idempotent ; propriétaire seulement). Le fichier téléchargé reste sur l'appareil : aucune suppression à distance |
