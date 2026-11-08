/** Mêmes tests que le test réel, mais contre un serveur S3 local qui vérifie les signatures. */
import { after } from 'node:test';
import { R2Client } from './r2-client.ts';
import { registerR2Suite } from '../testing/r2-suite.ts';
import { startMockS3 } from '../testing/mock-s3-server.ts';

const credentials = { accessKeyId: 'LOCALKEY', secretAccessKey: 'local-secret-key-for-tests' };
const bucket = 'movieshub-test';
const mock = await startMockS3({ bucket, credentials });
const endpoint = { host: mock.host, scheme: 'http' as const };
const make = (secret: string): R2Client => new R2Client({ accountId: 'local', bucket, ...credentials, secretAccessKey: secret }, { endpoint });

registerR2Suite({
  r2: make(credentials.secretAccessKey),
  withSecret: make,
  bucket,
  unsignedUrl: (key) => `http://${mock.host}/${bucket}/${key}`,
});

after(() => mock.close());
