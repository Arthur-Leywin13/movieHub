/**
 * Test RÉEL contre Cloudflare R2. Ignoré sauf si R2_LIVE_TEST=1 (voir docs/r2-live-test.md).
 * Lancé par la CI (workflow « R2 réel ») avec les secrets GitHub ; utiliser un bucket de test dédié.
 */
import { test } from 'node:test';
import { R2Client } from './r2-client.ts';
import { registerR2Suite } from '../testing/r2-suite.ts';

if (process.env['R2_LIVE_TEST'] !== '1') {
  test('R2 réel : ignoré (R2_LIVE_TEST=1 requis, voir docs/r2-live-test.md)', { skip: true }, () => undefined);
} else {
  const must = (name: string): string => {
    const v = process.env[name];
    if (!v) throw new Error(`Variable ${name} manquante pour le test R2 réel`);
    return v;
  };
  const accountId = must('R2_ACCOUNT_ID');
  const accessKeyId = must('R2_ACCESS_KEY_ID');
  const secretAccessKey = must('R2_SECRET_ACCESS_KEY');
  const bucket = must('R2_BUCKET');
  const make = (secret: string): R2Client => new R2Client({ accountId, accessKeyId, secretAccessKey: secret, bucket });

  registerR2Suite({
    r2: make(secretAccessKey),
    withSecret: make,
    bucket,
    unsignedUrl: (key) => `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${key}`,
  });
}
