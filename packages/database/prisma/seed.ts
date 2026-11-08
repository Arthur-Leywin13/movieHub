// Données de référence : langues, plans sans pub, réglages de pubs récompensées,
// emplacements publicitaires (sans identifiant AdMob : à renseigner depuis le dashboard).
// Idempotent (upsert). Non exécuté dans l'environnement de création (pas de base).
import { PrismaClient } from '@prisma/client';
import { DEFAULT_AD_FREE_PLANS, REWARD_DEFAULTS } from '@movieshub/shared';

const prisma = new PrismaClient();

const LANGUAGES = [
  { code: 'fr', name: 'French', nativeName: 'Français' },
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語' },
  { code: 'es', name: 'Spanish', nativeName: 'Español' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português' },
];

const AD_PLACEMENTS = [
  { key: 'home_banner', format: 'BANNER' as const, minIntervalSeconds: null },
  // Délai minimal par défaut entre deux interstitielles (modifiable depuis le dashboard).
  { key: 'interstitial_default', format: 'INTERSTITIAL' as const, minIntervalSeconds: 180 },
  { key: 'rewarded_daily', format: 'REWARDED' as const, minIntervalSeconds: null },
  { key: 'app_open_launch', format: 'APP_OPEN' as const, minIntervalSeconds: null },
];

async function main(): Promise<void> {
  for (const lang of LANGUAGES) {
    await prisma.language.upsert({
      where: { code: lang.code },
      update: { name: lang.name, nativeName: lang.nativeName },
      create: lang,
    });
  }

  // Les plans existants ne sont pas écrasés : le dashboard peut les avoir modifiés.
  for (const plan of DEFAULT_AD_FREE_PLANS) {
    await prisma.adFreePlan.upsert({ where: { code: plan.code }, update: {}, create: { ...plan } });
  }

  await prisma.appSetting.upsert({
    where: { key: 'rewarded_ads' },
    update: {},
    create: { key: 'rewarded_ads', value: { ...REWARD_DEFAULTS } },
  });

  for (const placement of AD_PLACEMENTS) {
    await prisma.adPlacement.upsert({ where: { key: placement.key }, update: {}, create: placement });
  }

  console.log(
    `Seed OK : ${LANGUAGES.length} langues, ${DEFAULT_AD_FREE_PLANS.length} plans, ${AD_PLACEMENTS.length} emplacements pub.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
