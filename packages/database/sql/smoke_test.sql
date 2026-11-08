-- Test de fumée exécuté par la CI sur un vrai PostgreSQL, APRÈS migrations + search_and_constraints.sql + seed.
-- Tout est annulé (ROLLBACK) ; toute assertion qui échoue arrête psql avec un code d'erreur.
-- Les INSERT fournissent id et updatedAt : Prisma les génère côté client, la base n'a pas de défaut.
BEGIN;

DO $test$
DECLARE
  v_content uuid := gen_random_uuid();
  v_media_ok uuid := gen_random_uuid();
  v_media_bad uuid := gen_random_uuid();
  v_found boolean;
  v_tokens int;
  v_n int;
BEGIN
  -- 1. Recherche : titre principal retrouvé sans accent
  INSERT INTO "Content" ("id", "type", "slug", "title", "description", "updatedAt")
  VALUES (v_content, 'MOVIE', 'smoke-test', 'Les Misérables', 'Un classique', now());

  SELECT "searchVector" @@ websearch_to_tsquery('simple', unaccent('miserables')) INTO v_found
  FROM "Content" WHERE "id" = v_content;
  IF v_found IS NOT TRUE THEN RAISE EXCEPTION 'recherche : titre sans accent non trouvé'; END IF;

  -- 2. Titre alternatif : absent avant, présent après l'ajout, retiré après suppression
  SELECT "searchVector" @@ websearch_to_tsquery('simple', 'hunchback') INTO v_found
  FROM "Content" WHERE "id" = v_content;
  IF v_found IS TRUE THEN RAISE EXCEPTION 'recherche : faux positif avant ajout du titre alternatif'; END IF;

  INSERT INTO "ContentAltTitle" ("id", "contentId", "title")
  VALUES (gen_random_uuid(), v_content, 'Hunchback of Notre-Dame');

  SELECT "searchVector" @@ websearch_to_tsquery('simple', 'hunchback') INTO v_found
  FROM "Content" WHERE "id" = v_content;
  IF v_found IS NOT TRUE THEN RAISE EXCEPTION 'recherche : titre alternatif non indexé par le trigger'; END IF;

  DELETE FROM "ContentAltTitle" WHERE "contentId" = v_content;

  SELECT "searchVector" @@ websearch_to_tsquery('simple', 'hunchback') INTO v_found
  FROM "Content" WHERE "id" = v_content;
  IF v_found IS TRUE THEN RAISE EXCEPTION 'recherche : titre alternatif encore indexé après suppression'; END IF;

  -- 3. CHECK film XOR épisode : un film valide passe, une version sans cible est refusée
  INSERT INTO "MediaFile" ("id", "bucket", "objectKey", "kind", "updatedAt")
  VALUES (v_media_ok, 'b', 'smoke/ok', 'VIDEO', now()), (v_media_bad, 'b', 'smoke/bad', 'VIDEO', now());

  INSERT INTO "VideoAsset" ("id", "contentId", "mediaFileId", "updatedAt")
  VALUES (gen_random_uuid(), v_content, v_media_ok, now());

  BEGIN
    INSERT INTO "VideoAsset" ("id", "mediaFileId", "updatedAt")
    VALUES (gen_random_uuid(), v_media_bad, now());
    RAISE EXCEPTION 'CHECK VideoAsset_target_xor non appliquée';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- 4. CHECK notification ciblée sans destinataire
  BEGIN
    INSERT INTO "Notification" ("id", "type", "audience", "title", "body", "updatedAt")
    VALUES (gen_random_uuid(), 'ANNOUNCEMENT', 'USER', 't', 'b', now());
    RAISE EXCEPTION 'CHECK Notification_user_audience_target non appliquée';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- 5. Code promo : 15 jetons par défaut, montant nul refusé
  INSERT INTO "PromoCode" ("id", "code", "updatedAt") VALUES (gen_random_uuid(), 'SMOKE15', now());
  SELECT "tokenAmount" INTO v_tokens FROM "PromoCode" WHERE "code" = 'SMOKE15';
  IF v_tokens <> 15 THEN RAISE EXCEPTION 'code promo : valeur par défaut attendue 15, obtenue %', v_tokens; END IF;

  BEGIN
    INSERT INTO "PromoCode" ("id", "code", "tokenAmount", "updatedAt") VALUES (gen_random_uuid(), 'SMOKE0', 0, now());
    RAISE EXCEPTION 'CHECK PromoCode_amount_positive non appliquée';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- 6. Seed : plans 10/1, 30/7, 60/14, langues, réglage de pubs récompensées, 4 emplacements pub
  IF (SELECT count(*) FROM "AdFreePlan") <> 3 THEN RAISE EXCEPTION 'seed : 3 plans attendus'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "AdFreePlan" WHERE "code" = 'DAY_1' AND "tokenCost" = 10 AND "durationDays" = 1) THEN
    RAISE EXCEPTION 'seed : plan DAY_1 incorrect';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "AdFreePlan" WHERE "code" = 'DAYS_7' AND "tokenCost" = 30 AND "durationDays" = 7) THEN
    RAISE EXCEPTION 'seed : plan DAYS_7 incorrect';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "AdFreePlan" WHERE "code" = 'DAYS_14' AND "tokenCost" = 60 AND "durationDays" = 14) THEN
    RAISE EXCEPTION 'seed : plan DAYS_14 incorrect';
  END IF;
  IF (SELECT count(*) FROM "Language") < 5 THEN RAISE EXCEPTION 'seed : langues manquantes'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "AppSetting" WHERE "key" = 'rewarded_ads' AND ("value"->>'dailyAdLimit')::int = 3 AND ("value"->>'tokensPerAd')::int = 2) THEN
    RAISE EXCEPTION 'seed : réglage rewarded_ads incorrect';
  END IF;
  IF (SELECT count(*) FROM "AdPlacement") <> 4 THEN RAISE EXCEPTION 'seed : 4 emplacements pub attendus'; END IF;

  -- 7. Briques de la recherche publique (mêmes fonctions que la requête de l'API)
  IF similarity('les miserables', 'les miserbles') < 0.3 THEN RAISE EXCEPTION 'recherche : similarité trop faible pour une faute de frappe'; END IF;
  IF trim(regexp_replace(unaccent(lower('Dune : Deuxième partie')), '[^[:alnum:]]+', ' ', 'g')) <> 'dune deuxieme partie' THEN
    RAISE EXCEPTION 'recherche : normalisation SQL du titre incorrecte';
  END IF;
  IF NOT (to_tsvector('simple', 'dune deuxieme partie') @@ to_tsquery('simple', 'deux:* & par:*')) THEN
    RAISE EXCEPTION 'recherche : requête plein texte par préfixes incorrecte';
  END IF;
  SELECT count(*) INTO v_n FROM "Content" c
  WHERE c."id" = v_content
    AND similarity(trim(regexp_replace(unaccent(lower(c."title")), '[^[:alnum:]]+', ' ', 'g')), 'les miserbles') >= 0.3;
  IF v_n <> 1 THEN RAISE EXCEPTION 'recherche : le titre accentué n''est pas trouvé avec une faute de frappe'; END IF;
END
$test$;

ROLLBACK;
