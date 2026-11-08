-- Extensions requises par la recherche (trigrammes + suppression des accents).
-- Migration écrite à la main, exécutée AVANT la migration "init" générée par Prisma
-- (ordre alphabétique des dossiers) pour que les index gin_trgm_ops existent à la création.
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "unaccent";
