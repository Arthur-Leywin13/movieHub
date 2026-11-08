-- MoviesHub — éléments PostgreSQL que Prisma ne sait pas décrire :
--   1. recherche plein texte (tsvector maintenu par triggers, titres alternatifs inclus)
--   2. contraintes CHECK
-- Idempotent : peut être rejoué sans erreur. À exécuter APRÈS les migrations :
--   npm run db:search
-- Config de recherche 'simple' + unaccent : le catalogue est multilingue (fr/en/ja...),
-- une config linguistique avec stemming serait fausse pour la majorité des titres.

-- ---------------------------------------------------------------------------
-- 1. Recherche
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION movieshub_build_search_vector(
  p_content_id uuid,
  p_title text,
  p_description text
) RETURNS tsvector
LANGUAGE plpgsql
STABLE
AS $fn$
DECLARE
  v_alt text;
BEGIN
  SELECT string_agg(a."title", ' ') INTO v_alt
  FROM "ContentAltTitle" a
  WHERE a."contentId" = p_content_id;

  RETURN
    setweight(to_tsvector('simple', unaccent(coalesce(p_title, ''))), 'A') ||
    setweight(to_tsvector('simple', unaccent(coalesce(v_alt, ''))), 'B') ||
    setweight(to_tsvector('simple', unaccent(coalesce(p_description, ''))), 'C');
END
$fn$;

CREATE OR REPLACE FUNCTION movieshub_content_search_trigger() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  NEW."searchVector" := movieshub_build_search_vector(NEW."id", NEW."title", NEW."description");
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS movieshub_content_search ON "Content";
CREATE TRIGGER movieshub_content_search
  BEFORE INSERT OR UPDATE OF "title", "description" ON "Content"
  FOR EACH ROW EXECUTE FUNCTION movieshub_content_search_trigger();

CREATE OR REPLACE FUNCTION movieshub_alt_title_search_trigger() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_content_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_content_id := OLD."contentId";
  ELSE
    v_content_id := NEW."contentId";
  END IF;

  UPDATE "Content" c
  SET "searchVector" = movieshub_build_search_vector(c."id", c."title", c."description")
  WHERE c."id" = v_content_id;

  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS movieshub_alt_title_search ON "ContentAltTitle";
CREATE TRIGGER movieshub_alt_title_search
  AFTER INSERT OR UPDATE OR DELETE ON "ContentAltTitle"
  FOR EACH ROW EXECUTE FUNCTION movieshub_alt_title_search_trigger();

-- Rattrapage des lignes existantes.
UPDATE "Content" c
SET "searchVector" = movieshub_build_search_vector(c."id", c."title", c."description");

-- ---------------------------------------------------------------------------
-- 2. Contraintes CHECK (ajoutées une seule fois, repérées par leur nom)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION movieshub_add_check(p_table text, p_name text, p_expr text)
RETURNS void
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = p_name) THEN
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%s)', p_table, p_name, p_expr);
  END IF;
END
$fn$;

-- Film XOR épisode
SELECT movieshub_add_check('VideoAsset', 'VideoAsset_target_xor',
  '(("contentId" IS NOT NULL)::int + ("episodeId" IS NOT NULL)::int) = 1');
SELECT movieshub_add_check('WatchHistory', 'WatchHistory_target_xor',
  '(("contentId" IS NOT NULL)::int + ("episodeId" IS NOT NULL)::int) = 1');

-- Bande-annonce : fichier R2 ou lien externe
SELECT movieshub_add_check('Trailer', 'Trailer_source_present',
  '"mediaFileId" IS NOT NULL OR "externalUrl" IS NOT NULL');

-- Sous-titres : intégré = streamIndex ; externe = fichier
SELECT movieshub_add_check('SubtitleTrack', 'SubtitleTrack_source_consistent',
  '("source" = ''EMBEDDED'' AND "streamIndex" IS NOT NULL AND "mediaFileId" IS NULL) OR ("source" = ''EXTERNAL'' AND "mediaFileId" IS NOT NULL AND "streamIndex" IS NULL)');

-- Numérotation et valeurs
SELECT movieshub_add_check('Season', 'Season_number_nonneg', '"number" >= 0');
SELECT movieshub_add_check('Episode', 'Episode_number_positive', '"number" >= 1');
SELECT movieshub_add_check('WatchHistory', 'WatchHistory_position_nonneg', '"positionSeconds" >= 0');
SELECT movieshub_add_check('Donation', 'Donation_amount_positive', '"amountMinor" > 0');
SELECT movieshub_add_check('PaymentTransaction', 'PaymentTransaction_amount_positive', '"amountMinor" > 0');
SELECT movieshub_add_check('PaymentTransaction', 'PaymentTransaction_refund_range',
  '"refundedAmountMinor" >= 0 AND "refundedAmountMinor" <= "amountMinor"');

-- Notification ciblée : destinataire obligatoire
SELECT movieshub_add_check('Notification', 'Notification_user_audience_target',
  '"audience" <> ''USER'' OR "targetUserId" IS NOT NULL');

-- Retrait : la date d'effet ne précède pas l'avertissement
SELECT movieshub_add_check('ContentWithdrawal', 'ContentWithdrawal_dates_ordered',
  '"effectiveAt" >= "noticeStartsAt"');

-- Planification
SELECT movieshub_add_check('ScheduledPublication', 'ScheduledPublication_attempts_range',
  '"attempts" >= 0 AND "attempts" <= "maxAttempts"');

-- Jetons, plans, codes promo
SELECT movieshub_add_check('TokenWallet', 'TokenWallet_balance_nonneg', '"balance" >= 0');
SELECT movieshub_add_check('TokenTransaction', 'TokenTransaction_delta_nonzero', '"delta" <> 0');
SELECT movieshub_add_check('TokenTransaction', 'TokenTransaction_balance_after_nonneg', '"balanceAfter" >= 0');
SELECT movieshub_add_check('RewardedAdView', 'RewardedAdView_slot_positive', '"slot" >= 1');
SELECT movieshub_add_check('RewardedAdView', 'RewardedAdView_reward_positive', '"rewardAmount" > 0');
SELECT movieshub_add_check('AdFreePlan', 'AdFreePlan_values_positive', '"tokenCost" > 0 AND "durationDays" > 0');
SELECT movieshub_add_check('PromoCode', 'PromoCode_amount_positive', '"tokenAmount" > 0');
SELECT movieshub_add_check('PromoCode', 'PromoCode_redemptions_range',
  '"redemptionCount" >= 0 AND ("maxRedemptions" IS NULL OR ("maxRedemptions" >= 1 AND "redemptionCount" <= "maxRedemptions"))');
SELECT movieshub_add_check('PromoCode', 'PromoCode_dates_ordered',
  '"startsAt" IS NULL OR "expiresAt" IS NULL OR "expiresAt" > "startsAt"');

-- Droit sans pub : champs obligatoires selon la source
SELECT movieshub_add_check('AdFreeEntitlement', 'AdFreeEntitlement_token_plan_fields',
  '"source" <> ''TOKEN_PLAN'' OR ("planId" IS NOT NULL AND "tokenTransactionId" IS NOT NULL)');
SELECT movieshub_add_check('AdFreeEntitlement', 'AdFreeEntitlement_payment_fields',
  '"source" <> ''PAYMENT'' OR "sourceTransactionId" IS NOT NULL');

DROP FUNCTION movieshub_add_check(text, text, text);
