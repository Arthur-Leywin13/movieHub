import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseStorageClient } from './supabase-client.ts';

test('Supabase : demande un lien de téléchargement signé sans exposer la service role key', async () => {
  const requests: Array<{ url: string; init: { method: string; headers: Record<string, string>; body?: string } }> = [];
  const client = new SupabaseStorageClient({
    projectUrl: 'https://demo.supabase.co',
    serviceRoleKey: 'service-role-secret-that-must-stay-server-side',
    bucket: 'private-test',
  }, {
    fetch: async (url, init) => {
      requests.push({ url, init });
      return {
        status: 200, ok: true,
        text: async () => JSON.stringify({ signedURL: '/object/sign/private-test/video/demo.mp4?token=short-lived' }),
        headers: { get: () => null },
      };
    },
  });

  const url = await client.presignGet('video/demo.mp4', 300);
  assert.equal(url, 'https://demo.supabase.co/storage/v1/object/sign/private-test/video/demo.mp4?token=short-lived');
  assert.ok(!url.includes('service-role-secret'));
  assert.equal(requests[0]?.init.method, 'POST');
  assert.equal(requests[0]?.init.headers['apikey'], 'service-role-secret-that-must-stay-server-side');
  assert.ok(requests[0]?.url.includes('/storage/v1/object/sign/private-test/video/demo.mp4'));
});

test('Supabase : obtient une URL signée pour un upload unique', async () => {
  const client = new SupabaseStorageClient({
    projectUrl: 'https://demo.supabase.co',
    serviceRoleKey: 'service-role-secret-that-must-stay-server-side',
    bucket: 'private-test',
  }, {
    fetch: async () => ({
      status: 200, ok: true,
      text: async () => JSON.stringify({ signedUrl: '/object/upload/sign/private-test/image/test.png?token=upload-token' }),
      headers: { get: () => null },
    }),
  });
  assert.equal(
    await client.presignPut('image/test.png', 600),
    'https://demo.supabase.co/storage/v1/object/upload/sign/private-test/image/test.png?token=upload-token',
  );
});

test('Supabase : multipart est explicitement refusé (R2 reste nécessaire pour reprise)', async () => {
  const client = new SupabaseStorageClient({
    projectUrl: 'https://demo.supabase.co',
    serviceRoleKey: 'service-role-secret-that-must-stay-server-side',
    bucket: 'private-test',
  });
  await assert.rejects(client.createMultipartUpload('video/large.mkv'), /multipart\/reprise non pris en charge/);
});
