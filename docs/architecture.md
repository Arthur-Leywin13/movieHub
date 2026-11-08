# Architecture MoviesHub — décisions de la fondation

## Stack retenue

| Couche | Choix | Raison |
|---|---|---|
| Runtime | Node.js >= 22.18, TypeScript ~6.0 | LTS ; type stripping natif pour les tests |
| Monorepo | npm workspaces | aucun outil supplémentaire ; les apps non-JS (Android) restent hors workspace |
| BDD | PostgreSQL 16 | pg_trgm, unaccent, full-text intégrés |
| ORM | Prisma ~6.19 (générateur `prisma-client-js`) | voir « Prisma 6 vs 7 » |
| HTTP | `node:http` + routeur minimal (`apps/api/src/http`) | aucune dépendance à installer : tout est testable ; adaptateur mince remplaçable par Fastify sans toucher aux services |
| Stockage | Cloudflare R2 (client SigV4 maison, sans SDK) | métadonnées en BDD, jamais de fichier en BDD ; signature validée contre les exemples officiels AWS |
| Planification | prévu : pg-boss (file dans PostgreSQL) | pas de Redis ; indépendant du bot |
| Android | prévu : Kotlin natif + Media3 | téléchargement en arrière-plan, partage Wi-Fi direct, sous-titres ASS |
| Web/dashboard | prévu : Next.js | |
| Bot | prévu : grammY, client de l'API uniquement + serveur Bot API local (2 Go) | |

Les lignes « prévu » ne sont pas encore implémentées.

## Prisma 6 vs 7

Prisma 7 introduit `prisma.config.ts`, un nouveau générateur et des adaptateurs de pilote obligatoires. Je n'ai pas pu vérifier son état de stabilité (pas d'accès au registre npm). Choix prudent : rester sur la dernière 6.x connue (6.19), migrer plus tard dans une tâche dédiée.

## Décisions de modélisation

- **Un `Content`, trois types** (film/série/animé) ; versions vidéo d'un film rattachées au `Content`, celles des séries/animés aux `Episode`. Un épisode reste une seule ligne quel que soit le nombre de langues.
- **Langues annoncées vs pistes réelles** : `ContentAudioLanguage` / `ContentSubtitleLanguage` (catalogue, filtres) sont indépendantes de `AudioTrack` / `SubtitleTrack` (pistes détectées par ffprobe dans chaque fichier, avec `origin` PROBED/DECLARED).
- **Affiches / bandes-annonces** : le « principal » est un pointeur (`primaryPosterId`, `primaryTrailerId`), l'ancien reste en base, `archivedAt` pour archiver, aucune suppression automatique. Choix du pointeur plutôt que d'un booléen : l'unicité du principal est garantie par la base sans index partiel (que Prisma gère mal).
- **Suppression** : `Restrict` sur tout le catalogue (pas de cascade silencieuse), `SetNull` sur les admins, `Cascade` sur les données personnelles. Suppression de compte = anonymisation + `status DELETED`.
- **Sans publicité** : `AdFreeEntitlement.sourceTransactionId @unique` (une transaction = un droit maximum). L'activation exige une transaction vérifiée côté serveur (`verifiedAt`), alimentée par webhook signé (`PaymentWebhookEvent` dédoublonne). Historique des changements via `AuditLog`.
- **Publication programmée** : cible polymorphe sans clé étrangère (`targetType` + `targetId`) pour couvrir contenu, saison, épisode, version, affiche et bande-annonce avec une seule table. Contrepartie : l'intégrité de la cible est vérifiée par le service, pas par la base. Anti-doublon : `dedupeKey @unique` et prise en charge atomique `PENDING -> PROCESSING`.
- **Recherche** : `tsvector` maintenu par triggers (titre + titres alternatifs + description), config `simple` + `unaccent` car le catalogue est multilingue ; index GIN trigrammes sur les titres.
- **Admin** : un `Admin` est toujours un `User` ; le bot autorise via `Admin.telegramId` (BigInt), jamais le `@username`.

## Bot Telegram et fichiers jusqu'à 2 Go

Avec le serveur Bot API officiel, un bot ne peut télécharger que 20 Mo et envoyer 50 Mo. Pour atteindre 2000 Mo :

1. Un serveur `telegram-bot-api` en mode `--local` (service `telegram-bot-api` du `docker-compose.yml`, profil `bot`). Il exige un `api_id` / `api_hash` créés sur my.telegram.org.
2. Le bot pointe dessus via `TELEGRAM_API_BASE_URL` ; `loadBotEnv` refuse une limite > 20 Mo si le serveur est l'officiel.
3. Le fichier reçu est un fichier sur le disque du serveur local : le bot doit tourner sur la même machine (volume partagé).
4. Envoi vers R2 : le bot demande à l'API des URL signées d'upload multipart et envoie les morceaux lui-même ; il ne détient aucune clé R2 ni accès à la base.
5. Conséquence d'hébergement : un serveur (VPS) avec disque suffisant (prévoir au moins 2 fois la taille du plus gros fichier en transit). Ni serverless, ni Termux.

## Jetons, publicités et sans-pub

- Règles chiffrées : `docs/product-rules.md` ; logique pure et testée : `packages/shared/src/rewards.ts`.
- **Pub récompensée = vérification serveur AdMob (SSV).** L'URL de rappel SSV est configurée dans la console AdMob et pointe vers l'API, qui vérifie la signature avec les clés publiques de Google. Le crédit n'a lieu qu'après cette vérification. Protections en base : `RewardedAdView.admobTransactionId @unique` (rappel rejoué), `(userId, rewardDay, slot) @unique` (plafond quotidien), `TokenTransaction.idempotencyKey @unique`.
- **Grand livre** : `TokenWallet` (solde) + `TokenTransaction` (historique). Toute opération verrouille la ligne du portefeuille puis écrit solde et transaction dans la même transaction SQL ; `balance >= 0` imposé par CHECK.
- **Un seul plan par jetons actif** : appliqué par le service (annulation de l'ancien dans la même transaction que l'achat), pas par un index partiel (Prisma gère mal les index partiels). `AdFreeEntitlement.tokenTransactionId @unique` : une dépense = un droit.
- **Code promo** : `PromoCode` + `PromoRedemption` (`@@unique([promoCodeId, userId])`) ; le plafond d'utilisations se vérifie par mise à jour conditionnelle du compteur, avec CHECK `redemptionCount <= maxRedemptions`.
- **Son des pubs** : coupé par défaut, réglage utilisateur `adSoundEnabled`. Côté Android, via les réglages de volume/mute du SDK AdMob ; à vérifier contre la politique AdMob au moment de l'intégration (phase 8).

## API (apps/api)

- **Architecture** : routes -> services (`AuthService`, `UploadService`) -> ports (`src/ports.ts`) -> dépôts. Les services ne connaissent ni HTTP ni Prisma ; `src/infra/prisma-repos.ts` est la seule couche Prisma.
- **Mots de passe** : scrypt (module intégré, N=2^15, r=8, p=3), paramètres stockés avec le hash (`needsRehash` les durcit à la connexion). Choisi plutôt qu'Argon2id pour éviter une dépendance native à compiler sur l'hébergeur.
- **Jetons** : accès = JWT HS256 de 15 min (algorithme imposé, `none` refusé) ; rafraîchissement = jeton opaque de 384 bits, stocké haché (HMAC), rotation à chaque usage. Réutilisation d'un ancien jeton après 10 s = vol présumé : toutes les sessions de l'utilisateur sont révoquées. Dans les 10 s : réponse 409 sans révocation (le client doit sérialiser ses appels de rafraîchissement).
- **Anti-énumération et force brute** : message identique pour e-mail inconnu / mauvais mot de passe, vérification factice pour égaliser les temps, limites par IP et par e-mail (en mémoire : à remplacer par un stockage partagé si l'API tourne sur plusieurs instances).
- **Administrateurs** : droits relus en base à chaque requête. Dashboard : `Authorization: Bearer`. Bot : `Authorization: Bot <BOT_SERVICE_TOKEN>` + `X-Telegram-User-Id` (id numérique, comparé à `Admin.telegramId`).
- **Envois R2** : le serveur crée l'envoi multipart et signe les liens ; le client envoie directement à R2 (jamais d'octets de vidéo via l'API). La clé d'objet est générée par le serveur (le nom de fichier du client n'y figure pas), le type MIME est déduit de l'extension autorisée. Reprise après coupure via `GET /admin/uploads/:id`. À la fin, le serveur vérifie lui-même les morceaux (liste R2, tailles) puis la taille finale : il ne fait pas confiance au client. L'intégrité vérifiée est la taille ; aucune empreinte (SHA-256) n'est contrôlée.
- **Journal d'audit** : chaque opération d'envoi est tracée (source dashboard/bot, administrateur, résultat), sans URL signée ni secret.

## Catalogue (apps/api/src/catalog)

- Mêmes couches que le reste : routes -> `CatalogAdminService` / `CatalogReadService` -> port `CatalogRepo` (implémentation Prisma dans `src/infra/prisma-catalog-repo.ts`).
- **Doublons** : le slug est dérivé du titre et de l'année (casse, accents et ponctuation ignorés) ; une collision avec le même type est refusée (409, avec le contenu existant).
- **Personnaliser** : sans confirmation, le serveur renvoie seulement le résumé des changements ; il n'applique qu'avec `confirm: true`. Cette méthode ne touche jamais aux saisons, épisodes, versions ni fichiers (vérifié par un test).
- **Versions** : une langue = un `VideoAsset`, ajouté en brouillon, jamais en remplacement. Un épisode reste une seule ligne. Les pistes audio d'une version sont d'abord *déclarées* (index de flux = position dans la liste) ; la détection réelle par ffprobe viendra plus tard.
- **Affiches / bandes-annonces** : pointeur « principal » sur le contenu ou la saison ; changer d'affiche principale archive l'ancienne (restaurable), changer de bande-annonce principale ne supprime rien ; aucune suppression via l'API.
- **Visibilité publique** : contenu, saison, épisode et version doivent tous être PUBLISHED. Contenu retiré : réponse 410 avec le message prévu par le cahier des charges.
- **Fichiers R2** : un fichier ne peut servir qu'une fois dans le catalogue, et doit être `READY`.

## Bot Telegram (apps/bot)

- Client de l'API uniquement (jeton de service + id Telegram numérique). Parcours = étapes sérialisables (`wizard.ts`), état sur disque, traitements en arrière-plan avec progression mémorisée (`pipelines.ts`) : reprise après coupure ou redémarrage sans doublon. Détails : `docs/bot.md`.
- Pas de bibliothèque Telegram : client minimal sur `fetch` (`telegram/client.ts`), testé avec un faux `fetch`.
- Premier administrateur : créé au démarrage de l'API depuis `BOOTSTRAP_ADMIN_*`, seulement s'il n'existe aucun administrateur.

## Séparation des responsabilités

- Le bot n'accède pas à PostgreSQL (`loadBotEnv` n'exige ni `DATABASE_URL` ni clés R2). Son arrêt n'affecte ni l'API, ni les applications, ni les tâches planifiées.
- Les clés R2 ne vivent que dans l'API ; les clients reçoivent des URL signées temporaires.
- Les messages d'erreur de configuration ne contiennent jamais de valeur ; les erreurs inattendues ne divulguent pas leur message (`toErrorBody`).

## Points ouverts (à régler ou vérifier)

0e. **Côté utilisateur de l'API (favoris, suivi, historique, réglages, recherches récentes, téléchargements, accueil, tendances)** : testé avec des dépôts en mémoire (12 tests HTTP + 3 sur les tendances). Les couches PostgreSQL (`prisma-user-data-repo.ts`, `prisma-catalog-repo.ts`) n'ont jamais tourné ni été typechecked ici : la CI les exerce d'un coup avec `apps/api/src/infra/db-live.test.ts` (catalogue, recherche, données utilisateur, tendances sur un vrai PostgreSQL). Premier lancement = premiers vrais résultats. Non fait : accueil des « nouvelles saisons à venir » (seules les sorties de films futures sont listées dans « à venir »), croissance récente dans les tendances.
0d. **Recherche (`GET /search`)** : branchée et testée avec le dépôt mémoire (accents, fautes de frappe, titres alternatifs, filtres). La requête PostgreSQL (`searchContents` dans `prisma-catalog-repo.ts`, avec unaccent, pg_trgm et le tsvector) n'a jamais tourné : seules ses briques (similarité, normalisation, requête par préfixes) sont vérifiées dans le test de fumée SQL de la CI. Le classement PostgreSQL approxime celui des tests (mêmes règles, scores légèrement différents). Pas d'index sur l'expression normalisée : recherche par balayage, acceptable pour un catalogue de quelques milliers de titres. 
0c. **Bot : jamais lancé face à Telegram.** Testé de bout en bout avec un faux Telegram, la vraie API (HTTP local) et un serveur S3 local qui vérifie les signatures (26 tests : parcours complets, coupure/reprise, interruption, redémarrage, personnalisation). Non vérifiés : `src/main.ts`, le client Telegram face au vrai serveur Bot API (format des réponses, chemin absolu renvoyé par `getFile` en mode local), le partage du dossier de fichiers entre le serveur local et le bot.
0b. **Catalogue : non testé contre PostgreSQL.** Testé avec un dépôt en mémoire (34 tests dont un parcours complet par HTTP) ; `src/infra/prisma-catalog-repo.ts` n'a jamais tourné. Écarts connus avec l'implémentation de test : la recherche administrateur est sensible aux accents côté Prisma (la recherche SQL avec unaccent/pg_trgm viendra avec la phase « recherche ») et le tri par titre suit l'ordre de tri de la base.
   **Pas encore faits** : retrait annoncé d'un contenu (statut WITHDRAWN, avertissement, date d'effet), publication programmée, liens de téléchargement, recherche textuelle, favoris/suivi/historique, tendances.
0. **API : non exécutée contre une vraie base ni contre R2.** Testée ici avec des dépôts en mémoire, un faux R2, un vrai serveur HTTP local et un serveur S3 local qui vérifie les signatures ; non testés : `src/infra/prisma-repos.ts`, `src/main.ts`. **Test réel R2** prêt (`docs/r2-live-test.md`, workflow « R2 réel ») : il attend tes clés ; tant qu'il n'a pas tourné, le comportement face au vrai R2 reste à confirmer. Le typecheck de ces deux fichiers n'a lieu que dans la CI.
   **Pas encore faits côté API** : récupération de mot de passe et vérification d'e-mail (aucun fournisseur d'e-mail choisi), suppression de compte, suppression définitive d'un fichier R2 (doit être une opération séparée et confirmée), nettoyage des envois abandonnés (fichiers `PENDING`), catalogue, recherche, favoris, historique, jetons/pubs, notifications, paiements, publication programmée.

1. **Rien n'a été exécuté contre PostgreSQL ni Prisma** (pas de réseau dans l'environnement de création) : `prisma validate`, `migrate dev`, le SQL de `sql/search_and_constraints.sql` et le seed sont écrits mais non testés.
2. **Versions non confirmées** : `~6.19.0` (Prisma), `^4.19.0` (tsx), `^22` (@types/node) n'ont pas pu être vérifiées sur le registre.
3. **Triggers et CHECK hors migrations** : ils sont rejoués par `npm run db:search`. À terme, les intégrer comme migration versionnée une fois la migration `init` générée.
4. **Index sur `title` accent-sensible** : l'index trigramme sur le titre brut est insensible à la casse mais pas aux accents ; une recherche floue sans accent demandera un index sur expression (fonction `unaccent` immuable). À traiter avec la couche de recherche.
5. **Bot Telegram et fichiers de 2 Go** : décision prise (serveur Bot API local, voir plus haut), mais non testé : le serveur local, l'image Docker `aiogram/telegram-bot-api` et son option `TELEGRAM_LOCAL` restent à vérifier.
6. **Droits de diffusion** : le champ `VideoAsset.allowLocalShare` (défaut faux) permet de contrôler le partage local ; la question des droits sur les contenus hébergés reste à la charge du propriétaire du projet.
7. **Prestataires de paiement en Haïti** : non choisis ; `PaymentTransaction.provider` est volontairement une chaîne libre. À valider avant la phase 8.
8. **Publicités** : emplacements (`AdPlacement`), jetons et SSV sont modélisés ; l'intégration du SDK AdMob et le serveur de vérification SSV viendront en phase 8. Les identifiants d'unités AdMob ne sont pas encore renseignés.
11. **AdMob et droits de diffusion** : la politique AdMob impose de détenir les droits sur les contenus affichés à côté des publicités ; une violation peut entraîner la suspension du compte (et donc des revenus). À prendre en compte avant la mise en ligne.
12. **Fuseau du plafond quotidien** : `America/Port-au-Prince` par défaut, à confirmer.
13. **Remplacement d'un plan par jetons** : l'ancien est annulé sans remboursement (décision du propriétaire). Une confirmation côté application est prévue pour éviter les pertes involontaires.
14. **Écarts maquettes / cahier des charges** : voir `docs/product-rules.md` (note, durée, acteurs, images de catégories, qualités sur la bande-annonce).
9. **Commentaires** : non modélisés (fonctionnalité non validée dans le cahier des charges).
10. **Contraintes inter-tables non imposées par la base** : un épisode/saison n'existe que pour une série ou un animé ; l'épisode d'une version appartient bien au contenu visé. Vérifié par le service applicatif.
