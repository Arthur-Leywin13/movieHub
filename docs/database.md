# Base de données

Schéma : `packages/database/prisma/schema.prisma` (48 modèles, 33 enums). Conventions : UUID natifs, horodatages UTC, tables nommées comme les modèles.

## Groupes de modèles

| Groupe | Modèles |
|---|---|
| Comptes | User, Session, PasswordResetToken, DeviceToken, Admin |
| Référentiels | Language, Genre |
| Catalogue | Content, ContentAltTitle, ContentGenre, ContentAudioLanguage, ContentSubtitleLanguage, Season, Episode |
| Médias | MediaFile, Poster, Trailer |
| Versions | VideoAsset, AudioTrack, SubtitleTrack |
| Engagement | Favorite, Follow, WatchHistory, SearchHistory, DownloadMetadata, ContentStatDaily |
| Notifications | NotificationPreference, Notification, NotificationDelivery, Announcement |
| Argent | Donation, PaymentTransaction, PaymentWebhookEvent, AdFreeEntitlement |
| Jetons et pubs | TokenWallet, TokenTransaction, RewardedAdView, AdFreePlan, PromoCode, PromoRedemption, AdPlacement |
| Administration | ScheduledPublication, ContentWithdrawal, AuditLog, AppSetting |
| Modération | ContentRequest, Report, UserSanction |

## Ce que Prisma ne décrit pas (fichier `sql/search_and_constraints.sql`)

- Triggers qui maintiennent `Content.searchVector`.
- Contraintes CHECK : film XOR épisode (`VideoAsset`, `WatchHistory`), source de bande-annonce présente, cohérence des sous-titres intégrés/externes, bornes numériques, destinataire obligatoire pour une notification ciblée, dates de retrait ordonnées, solde de jetons >= 0, plafonds de codes promo, champs obligatoires d'un droit sans pub selon sa source.
- Extensions `pg_trgm` et `unaccent` : migration manuelle `00000000000000_extensions`, exécutée avant la migration `init`.

## Recherche

Colonnes et index prévus : `Content.searchVector` (GIN), index trigrammes sur `Content.title` et `ContentAltTitle.title`, index de filtres `(type, status, releaseDate)`.

Requête type (NON TESTÉE, à valider avec la couche de recherche) :

```sql
SELECT c."id", c."title"
FROM "Content" c
WHERE c."status" = 'PUBLISHED'
  AND (
    c."searchVector" @@ websearch_to_tsquery('simple', unaccent($1))
    OR c."title" % $1
  )
ORDER BY ts_rank(c."searchVector", websearch_to_tsquery('simple', unaccent($1))) DESC,
         similarity(c."title", $1) DESC
LIMIT 20;
```

## Règles métier portées par le schéma

- Langues audio et sous-titres annoncées : deux listes indépendantes ; pistes réelles : `AudioTrack` / `SubtitleTrack` par fichier.
- Nouvelles versions : on ajoute un `VideoAsset`, on ne remplace jamais l'existant.
- Saison : `releaseDate` obligatoire ; épisode : pas de date de sortie propre.
- Nouveautés des films : `Content.releaseDate`, pas la date d'ajout.
- Tendances : `ContentStatDaily` agrégé ; pondérations dans `AppSetting`.
- Retrait : `ContentWithdrawal` (avertissement, date d'effet) distinct de la suppression des fichiers R2 (`MediaFile.status = DELETED`, opération séparée).
- Téléchargements : `DownloadMetadata` ne sert qu'aux statistiques ; aucun mécanisme de suppression à distance.

## Jetons et sans-pub : garde-fous en base

- Pub récompensée : `admobTransactionId` unique (rappel rejoué), `(userId, rewardDay, slot)` unique (plafond quotidien).
- Dépense de jetons : `TokenTransaction.idempotencyKey` unique ; solde `>= 0` par CHECK.
- Plan par jetons : `AdFreeEntitlement.tokenTransactionId` unique ; l'unicité du plan actif par utilisateur est assurée par le service (voir `architecture.md`).
- Code promo : `(promoCodeId, userId)` unique.
