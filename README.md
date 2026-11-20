# MoviesHub

Plateforme de films, séries et animés : application Android, web, API commune, bot Telegram d'administration, dashboard, PostgreSQL et Cloudflare R2.

**État : fondation, API et première version du dashboard web d’administration.** Monorepo, schéma PostgreSQL/Prisma, API (authentification, rôles admin, catalogue, médias R2, lecture, téléchargements, favoris, historique, programmation, retraits et notifications), bot Telegram d’administration et dashboard web. L’application Android est développée séparément. Les modules publicitaires, paiements, push FCM, gestion avancée des administrateurs et audit consultable restent à terminer. Voir `docs/architecture.md` pour les décisions et les points ouverts.

## Structure

```
apps/        api (auth, envois R2, catalogue), bot (Telegram), admin (dashboard web statique), android (Kotlin, hors npm)
packages/
  database/  schéma Prisma, SQL de recherche/contraintes, seed, contrôle de schéma
  shared/    erreurs applicatives, slugs
  config/    validation des variables d'environnement (API, bot)
docs/        architecture.md, api.md, bot.md, database.md, product-rules.md, design/ (logo, maquettes)
```

## Sans aucune commande locale (CI)

Le workflow `.github/workflows/ci.yml` (GitHub Actions) fait le travail à ta place à chaque envoi sur `main` : tests, typecheck, `prisma validate`, création de la migration `init` si elle manque (commitée automatiquement dans `packages/database/prisma/migrations`), puis migrations + SQL de recherche + seed + test de fumée sur un vrai PostgreSQL 16. Il n'a pas encore été exécuté : son premier lancement est son premier test. Si une étape échoue, le journal de l'étape indique la cause ; envoie-le-moi.

Pense à commiter aussi `package-lock.json` (généré par `npm install`).

## Prérequis (uniquement pour travailler en local)

- Node.js >= 22.18 (type stripping natif utilisé par les tests)
- PostgreSQL 16 avec les extensions `pg_trgm` et `unaccent` (incluses dans l'image officielle)
- Docker (optionnel, pour la base locale)

## Installation et lancement

```bash
cp .env.example .env                 # puis renseigner DATABASE_URL (et les secrets plus tard)
docker compose up -d db              # PostgreSQL local (ou utiliser votre propre instance)
npm install
npm run db:generate                  # génère le client Prisma

# Première fois : crée la migration "init" à partir du schéma
npm run migrate:dev -w @movieshub/database -- --name init

npm run db:search                    # triggers de recherche + contraintes CHECK (rejouable)
npm run db:seed                      # langues, plans sans pub, réglages et emplacements de pubs
npm run start -w @movieshub/api      # démarre l'API (nécessite .env complet : base, secrets JWT, clés R2)
```

Bot avec fichiers jusqu'à 2 Go : `docker compose --profile bot up -d` (voir `docs/architecture.md`).

Environnement existant (CI, production) : `npm run db:deploy && npm run db:search`.
Après `prisma migrate reset`, relancer `npm run db:search` (les triggers et CHECK ne sont pas dans les migrations Prisma).

## Commandes

| Commande | Rôle |
|---|---|
| `npm test` | tests de tous les packages (node:test) |
| `npm run db:check` | contrôle structurel du schéma (sans réseau) |
| `npm run validate -w @movieshub/database` | `prisma validate` (nécessite `.env` et `npm install`) |
| `npm run typecheck` | TypeScript (le package database exige `db:generate` avant) |

## Test réel de R2

Voir `docs/r2-live-test.md` : créer le bucket et les clés, ajouter 4 secrets GitHub, lancer le workflow « R2 réel ». Aucune commande locale.

## Variables d'environnement

Voir `.env.example` (aucune valeur secrète). Le bot n'a besoin ni de `DATABASE_URL` ni des clés R2 : il passe uniquement par l'API.

## Ce qui n'est pas encore vérifié

Voir la section « Points ouverts » de `docs/architecture.md`.
