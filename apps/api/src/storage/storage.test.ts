import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StorageError, R2Client, type FetchLike } from './r2-client.ts';
import { EMPTY_PAYLOAD_HASH, canonicalQuery, encodePath, presignUrl, rfc3986, signRequest } from './sigv4.ts';

// Exemples officiels de la documentation AWS SigV4 (S3) : preuve que l'algorithme est correct.
const AWS = {
  credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
  now: new Date('2013-05-24T00:00:00Z'),
  host: 'examplebucket.s3.amazonaws.com',
};

test('SigV4 : URL pré-signée identique à l’exemple officiel AWS', () => {
  const url = presignUrl({
    method: 'GET',
    host: AWS.host,
    path: '/test.txt',
    region: 'us-east-1',
    expiresSeconds: 86400,
    credentials: AWS.credentials,
    now: AWS.now,
  });
  assert.equal(
    url,
    'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
      '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
      '&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host' +
      '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
  );
});

test('SigV4 : en-têtes signés identiques à l’exemple officiel AWS (GET avec Range)', () => {
  const h = signRequest({
    method: 'GET',
    host: AWS.host,
    path: '/test.txt',
    headers: { Range: 'bytes=0-9' },
    payloadHash: EMPTY_PAYLOAD_HASH,
    region: 'us-east-1',
    credentials: AWS.credentials,
    now: AWS.now,
  });
  assert.match(h['authorization'] ?? '', /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,/);
  assert.match(h['authorization'] ?? '', /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
  assert.equal(h['host'], undefined);
});

test('SigV4 : encodage RFC 3986, chemins et requêtes triées', () => {
  assert.equal(rfc3986("a b!'()*é"), 'a%20b%21%27%28%29%2A%C3%A9');
  assert.equal(encodePath('/bucket/dir/fichier été.mkv'), '/bucket/dir/fichier%20%C3%A9t%C3%A9.mkv');
  assert.equal(canonicalQuery({ b: '2', a: '1 2', uploads: '' }), 'a=1%202&b=2&uploads=');
});

const CFG = { accountId: 'acc123', accessKeyId: 'AKID', secretAccessKey: 'SECRET-DO-NOT-LEAK', bucket: 'movieshub' };
const NOW = new Date('2026-11-01T12:00:00Z');

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function fakeFetch(responses: Array<{ status?: number; body?: string; headers?: Record<string, string> }>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, ...(init.body === undefined ? {} : { body: init.body }) });
    const r = responses.shift() ?? { status: 500, body: '' };
    const status = r.status ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => r.body ?? '',
      headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null },
    };
  };
  return { fetch: fetchFn, calls };
}

test('R2 : URL pré-signée de téléchargement (style chemin, région auto, durée, nom de fichier)', () => {
  const r2 = new R2Client(CFG, { now: () => NOW });
  const url = r2.presignGet('video/2026/11/a b.mkv', 900, { downloadName: 'Film "été".mkv' });
  assert.ok(url.startsWith('https://acc123.r2.cloudflarestorage.com/movieshub/video/2026/11/a%20b.mkv?'));
  assert.match(url, /X-Amz-Expires=900/);
  assert.match(url, /X-Amz-Credential=AKID%2F20261101%2Fauto%2Fs3%2Faws4_request/);
  assert.match(url, /response-content-disposition=attachment%3B%20filename%3D%22Film%20_t__\.mkv%22|response-content-disposition=attachment/);
  assert.match(url, /X-Amz-Signature=[0-9a-f]{64}$/);
  assert.ok(!url.includes('SECRET-DO-NOT-LEAK'));
});

test('R2 : URL d’envoi d’un morceau contient partNumber et uploadId', () => {
  const r2 = new R2Client(CFG, { now: () => NOW });
  const url = r2.presignUploadPart('video/x.mkv', 'UP/ID+1', 3, 21600);
  assert.match(url, /partNumber=3/);
  assert.match(url, /uploadId=UP%2FID%2B1/);
  assert.match(url, /X-Amz-Expires=21600/);
});

test('R2 : createMultipartUpload — requête signée et lecture de l’UploadId', async () => {
  const { fetch, calls } = fakeFetch([{ body: '<InitiateMultipartUploadResult><UploadId>abc-123</UploadId></InitiateMultipartUploadResult>' }]);
  const r2 = new R2Client(CFG, { fetch, now: () => NOW });
  assert.equal(await r2.createMultipartUpload('video/x.mkv', 'video/x-matroska'), 'abc-123');
  const c = calls[0] as Call;
  assert.equal(c.method, 'POST');
  assert.equal(c.url, 'https://acc123.r2.cloudflarestorage.com/movieshub/video/x.mkv?uploads=');
  assert.match(c.headers['authorization'] ?? '', /^AWS4-HMAC-SHA256 Credential=AKID\/20261101\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.equal(c.headers['x-amz-content-sha256'], EMPTY_PAYLOAD_HASH);
});

test('R2 : listParts suit la pagination et décode les ETag', async () => {
  const page1 =
    '<ListPartsResult><IsTruncated>true</IsTruncated><NextPartNumberMarker>2</NextPartNumberMarker>' +
    '<Part><PartNumber>1</PartNumber><ETag>&quot;e1&quot;</ETag><Size>100</Size></Part>' +
    '<Part><PartNumber>2</PartNumber><ETag>&quot;e2&quot;</ETag><Size>100</Size></Part></ListPartsResult>';
  const page2 =
    '<ListPartsResult><IsTruncated>false</IsTruncated><Part><PartNumber>3</PartNumber><ETag>&quot;e3&quot;</ETag><Size>40</Size></Part></ListPartsResult>';
  const { fetch, calls } = fakeFetch([{ body: page1 }, { body: page2 }]);
  const parts = await new R2Client(CFG, { fetch, now: () => NOW }).listParts('k', 'up');
  assert.deepEqual(parts, [
    { partNumber: 1, etag: '"e1"', sizeBytes: 100 },
    { partNumber: 2, etag: '"e2"', sizeBytes: 100 },
    { partNumber: 3, etag: '"e3"', sizeBytes: 40 },
  ]);
  assert.match(calls[1]?.url ?? '', /part-number-marker=2/);
});

test('R2 : completeMultipartUpload — XML trié, ETag échappés, erreur dans un 200 détectée', async () => {
  const ok = fakeFetch([{ body: '<CompleteMultipartUploadResult><ETag>"x"</ETag></CompleteMultipartUploadResult>' }]);
  await new R2Client(CFG, { fetch: ok.fetch, now: () => NOW }).completeMultipartUpload('k', 'up', [
    { partNumber: 2, etag: '"b"', sizeBytes: 1 },
    { partNumber: 1, etag: '"a"', sizeBytes: 1 },
  ]);
  assert.equal(
    ok.calls[0]?.body,
    '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>&quot;a&quot;</ETag></Part><Part><PartNumber>2</PartNumber><ETag>&quot;b&quot;</ETag></Part></CompleteMultipartUpload>',
  );

  const bad = fakeFetch([{ body: '<Error><Code>InvalidPart</Code><Message>secret détail</Message></Error>' }]);
  await assert.rejects(
    new R2Client(CFG, { fetch: bad.fetch, now: () => NOW }).completeMultipartUpload('k', 'up', []),
    (err: unknown) => {
      assert.ok(err instanceof StorageError);
      assert.deepEqual(err.details, { status: 200, code: 'InvalidPart' });
      return true;
    },
  );
});

test('R2 : headObject (existant, absent), abort idempotent, erreurs sans fuite de secrets', async () => {
  const f = fakeFetch([
    { headers: { 'content-length': '1234', etag: '"abc"', 'content-type': 'video/mp4' } },
    { status: 404 },
    { status: 404 },
    { status: 403, body: '<Error><Code>AccessDenied</Code></Error>' },
  ]);
  const r2 = new R2Client(CFG, { fetch: f.fetch, now: () => NOW });
  assert.deepEqual(await r2.headObject('k'), { sizeBytes: 1234, etag: '"abc"', contentType: 'video/mp4' });
  assert.equal(await r2.headObject('k'), null);
  await r2.abortMultipartUpload('k', 'up');
  await assert.rejects(r2.deleteObject('k'), (err: unknown) => {
    assert.ok(err instanceof StorageError);
    assert.ok(!JSON.stringify(err).includes('SECRET-DO-NOT-LEAK'));
    assert.ok(!err.message.includes('acc123'));
    return true;
  });
});

test('R2 : réseau coupé → StorageError générique', async () => {
  const fetch: FetchLike = async () => {
    throw new Error('ECONNREFUSED acc123.r2.cloudflarestorage.com');
  };
  await assert.rejects(new R2Client(CFG, { fetch, now: () => NOW }).headObject('k'), (err: unknown) => {
    assert.ok(err instanceof StorageError);
    assert.ok(!err.message.includes('ECONNREFUSED'));
    return true;
  });
});
