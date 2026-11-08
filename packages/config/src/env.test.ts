import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EnvError, loadApiEnv, loadBotEnv, type EnvSource } from './env.ts';

const S1 = 'a'.repeat(40);
const S2 = 'b'.repeat(40);
const S3 = 'c'.repeat(40);

const apiSource = (): EnvSource => ({
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_ACCESS_SECRET: S1,
  JWT_REFRESH_SECRET: S2,
  BOT_SERVICE_TOKEN: S3,
  R2_ACCOUNT_ID: 'acc',
  R2_ACCESS_KEY_ID: 'key',
  R2_SECRET_ACCESS_KEY: 'secret-r2-value',
  R2_BUCKET: 'movieshub',
});

const botSource = (): EnvSource => ({
  TELEGRAM_BOT_TOKEN: '123456:telegram-token',
  TELEGRAM_API_BASE_URL: 'http://localhost:8081',
  API_BASE_URL: 'http://localhost:3000',
  BOT_SERVICE_TOKEN: S3,
  TELEGRAM_ADMIN_IDS: '1234567890, 9876543210',
});

test('API : configuration valide avec valeurs par défaut', () => {
  const env = loadApiEnv(apiSource());
  assert.equal(env.nodeEnv, 'development');
  assert.equal(env.port, 3000);
  assert.equal(env.r2.signedUrlTtlSeconds, 900);
  assert.equal(env.r2.bucket, 'movieshub');
});

test('API : collecte toutes les erreurs d’un coup', () => {
  assert.throws(
    () => loadApiEnv({}),
    (err: unknown) => {
      assert.ok(err instanceof EnvError);
      const names = ['DATABASE_URL', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'BOT_SERVICE_TOKEN', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
      for (const n of names) assert.ok(err.issues.some((i) => i.startsWith(n)), `manque ${n}`);
      return true;
    },
  );
});

test('API : les messages d’erreur ne contiennent jamais les valeurs', () => {
  const source = { ...apiSource(), JWT_ACCESS_SECRET: 'court-secret-123', DATABASE_URL: 'http://pas-postgres:motdepasse@x' };
  assert.throws(
    () => loadApiEnv(source),
    (err: unknown) => {
      assert.ok(err instanceof EnvError);
      assert.ok(!err.message.includes('court-secret-123'));
      assert.ok(!err.message.includes('motdepasse'));
      assert.ok(err.issues.some((i) => i.startsWith('JWT_ACCESS_SECRET') && i.includes('trop court')));
      assert.ok(err.issues.some((i) => i.startsWith('DATABASE_URL') && i.includes('protocole')));
      return true;
    },
  );
});

test('API : secrets d’accès et de rafraîchissement doivent différer', () => {
  assert.throws(() => loadApiEnv({ ...apiSource(), JWT_REFRESH_SECRET: S1 }), /doivent être différents/);
});

test('API : refuse un port ou un NODE_ENV invalide', () => {
  assert.throws(() => loadApiEnv({ ...apiSource(), API_PORT: '70000' }), /API_PORT/);
  assert.throws(() => loadApiEnv({ ...apiSource(), API_PORT: 'abc' }), /entier attendu/);
  assert.throws(() => loadApiEnv({ ...apiSource(), NODE_ENV: 'staging' }), /NODE_ENV/);
});

test('API : ignore les variables vides', () => {
  assert.throws(() => loadApiEnv({ ...apiSource(), R2_BUCKET: '   ' }), /R2_BUCKET/);
});

test('Bot : configuration valide, ids Telegram en bigint', () => {
  const env = loadBotEnv(botSource());
  assert.deepEqual(env.adminTelegramIds, [1234567890n, 9876543210n]);
});

test('Bot : aucune variable de base de données ni de R2 requise ou exposée', () => {
  const env = loadBotEnv(botSource());
  const keys = Object.keys(env).join(',');
  assert.ok(!/database|r2/i.test(keys));
});

test('Bot : refuse les @username à la place des ids numériques', () => {
  assert.throws(() => loadBotEnv({ ...botSource(), TELEGRAM_ADMIN_IDS: '@moi' }), /numériques/);
  assert.throws(() => loadBotEnv({ ...botSource(), TELEGRAM_ADMIN_IDS: '' }), /TELEGRAM_ADMIN_IDS/);
});

test('Bot : serveur local → limite par défaut de 2 Go (2000 Mo)', () => {
  const env = loadBotEnv(botSource());
  assert.equal(env.maxFileBytes, 2_097_152_000);
  assert.equal(env.telegramApiBaseUrl, 'http://localhost:8081');
});

test('Bot : serveur officiel + limite par défaut (2 Go) est refusé', () => {
  const source = botSource();
  delete source['TELEGRAM_API_BASE_URL'];
  assert.throws(() => loadBotEnv(source), /serveur Bot API local/);
});

test('Bot : serveur officiel accepté jusqu’à 20 Mo seulement', () => {
  const source = { ...botSource() };
  delete source['TELEGRAM_API_BASE_URL'];
  assert.equal(loadBotEnv({ ...source, BOT_MAX_FILE_BYTES: '20971520' }).maxFileBytes, 20_971_520);
  assert.throws(() => loadBotEnv({ ...source, BOT_MAX_FILE_BYTES: '20971521' }), /serveur Bot API local/);
});

test('Bot : refuse plus de 2000 Mo, même avec un serveur local', () => {
  assert.throws(() => loadBotEnv({ ...botSource(), BOT_MAX_FILE_BYTES: '2097152001' }), /BOT_MAX_FILE_BYTES/);
  assert.throws(() => loadBotEnv({ ...botSource(), BOT_MAX_FILE_BYTES: '0' }), /BOT_MAX_FILE_BYTES/);
});

test('Bot : l’URL du serveur Bot API doit être http(s)', () => {
  assert.throws(() => loadBotEnv({ ...botSource(), TELEGRAM_API_BASE_URL: 'ftp://x' }), /TELEGRAM_API_BASE_URL/);
});

test('API : trustProxy faux et aucune origine CORS par défaut', () => {
  const env = loadApiEnv(apiSource());
  assert.equal(env.trustProxy, false);
  assert.deepEqual(env.corsOrigins, []);
});

test('API : lit trustProxy et les origines CORS', () => {
  const env = loadApiEnv({
    ...apiSource(),
    API_TRUST_PROXY: 'true',
    API_CORS_ORIGINS: 'https://admin.exemple.com, http://localhost:5173',
  });
  assert.equal(env.trustProxy, true);
  assert.deepEqual(env.corsOrigins, ['https://admin.exemple.com', 'http://localhost:5173']);
});

test('API : refuse une origine CORS avec chemin ou slash final, et un booléen invalide', () => {
  assert.throws(() => loadApiEnv({ ...apiSource(), API_CORS_ORIGINS: 'https://a.com/' }), /API_CORS_ORIGINS/);
  assert.throws(() => loadApiEnv({ ...apiSource(), API_CORS_ORIGINS: 'https://a.com/x' }), /API_CORS_ORIGINS/);
  assert.throws(() => loadApiEnv({ ...apiSource(), API_CORS_ORIGINS: 'a.com' }), /API_CORS_ORIGINS/);
  assert.throws(() => loadApiEnv({ ...apiSource(), API_TRUST_PROXY: 'oui' }), /API_TRUST_PROXY/);
});

test('API : administrateur initial absent par défaut, lu s’il est complet', () => {
  assert.equal(loadApiEnv(apiSource()).bootstrapAdmin, null);
  const env = loadApiEnv({ ...apiSource(), BOOTSTRAP_ADMIN_EMAIL: 'Admin@Exemple.com', BOOTSTRAP_ADMIN_PASSWORD: 'un-mot-de-passe-long', BOOTSTRAP_ADMIN_TELEGRAM_ID: '123456789' });
  assert.deepEqual(env.bootstrapAdmin, { email: 'admin@exemple.com', password: 'un-mot-de-passe-long', telegramId: 123456789n });
});

test('API : administrateur initial incomplet, faible ou avec @username refusé (sans afficher le mot de passe)', () => {
  assert.throws(() => loadApiEnv({ ...apiSource(), BOOTSTRAP_ADMIN_EMAIL: 'a@exemple.com' }), /ensemble/);
  assert.throws(() => loadApiEnv({ ...apiSource(), BOOTSTRAP_ADMIN_EMAIL: 'a@exemple.com', BOOTSTRAP_ADMIN_PASSWORD: 'court', BOOTSTRAP_ADMIN_TELEGRAM_ID: '1' }), /trop court/);
  assert.throws(() => loadApiEnv({ ...apiSource(), BOOTSTRAP_ADMIN_EMAIL: 'a@exemple.com', BOOTSTRAP_ADMIN_PASSWORD: 'un-mot-de-passe-long', BOOTSTRAP_ADMIN_TELEGRAM_ID: '@moi' }), /numérique/);
  assert.throws(() => loadApiEnv({ ...apiSource(), BOOTSTRAP_ADMIN_EMAIL: 'pas-un-email', BOOTSTRAP_ADMIN_PASSWORD: 'un-mot-de-passe-long', BOOTSTRAP_ADMIN_TELEGRAM_ID: '1' }), /e-mail invalide/);
  try {
    loadApiEnv({ ...apiSource(), BOOTSTRAP_ADMIN_EMAIL: 'a@exemple.com', BOOTSTRAP_ADMIN_PASSWORD: 'court-secret', BOOTSTRAP_ADMIN_TELEGRAM_ID: '1' });
  } catch (e) {
    assert.ok(!String(e).includes('court-secret'));
  }
});
