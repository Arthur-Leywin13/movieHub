import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramClient, TelegramError } from './client.ts';

const TOKEN = '123456:SECRET-TOKEN-VALUE';
interface Call { url: string; body: any }

function fakeFetch(responses: Array<{ status?: number; json?: unknown; text?: string } | Error>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const r = responses.shift() ?? { status: 500 };
    if (r instanceof Error) throw r;
    return new Response(r.text ?? JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { fetch: f, calls };
}
const client = (f: typeof fetch) => new TelegramClient({ token: TOKEN, baseUrl: 'http://localhost:8081/', fetch: f });

test('sendMessage : URL du serveur local, clavier en boutons inline, texte tronqué à 4000', async () => {
  const { fetch: f, calls } = fakeFetch([{ json: { ok: true, result: { message_id: 42 } } }]);
  const r = await client(f).sendMessage(7, 'x'.repeat(5000), [[{ text: 'Oui', data: 'c:oui' }]]);
  assert.equal(r.messageId, 42);
  assert.equal(calls[0]?.url, `http://localhost:8081/bot${TOKEN}/sendMessage`);
  assert.equal(calls[0]?.body.chat_id, 7);
  assert.equal(calls[0]?.body.text.length, 4000);
  assert.deepEqual(calls[0]?.body.reply_markup, { inline_keyboard: [[{ text: 'Oui', callback_data: 'c:oui' }]] });
});

test('getUpdates : offset, délai et types de mises à jour demandés', async () => {
  const { fetch: f, calls } = fakeFetch([{ json: { ok: true, result: [{ update_id: 9 }] } }]);
  assert.deepEqual(await client(f).getUpdates(9, 30), [{ update_id: 9 }]);
  assert.deepEqual(calls[0]?.body, { offset: 9, timeout: 30, allowed_updates: ['message', 'callback_query'] });
});

test('getFile : chemin absolu du serveur local ; fichier indisponible → erreur', async () => {
  const { fetch: f } = fakeFetch([
    { json: { ok: true, result: { file_path: '/var/lib/telegram-bot-api/tok/documents/file_1.mkv', file_size: 123 } } },
    { json: { ok: true, result: {} } },
  ]);
  const c = client(f);
  assert.deepEqual(await c.getFile('abc'), { filePath: '/var/lib/telegram-bot-api/tok/documents/file_1.mkv', size: 123 });
  await assert.rejects(c.getFile('abc'), TelegramError);
});

test('editMessage : « message is not modified » ignoré, autres erreurs remontées', async () => {
  const { fetch: f } = fakeFetch([
    { status: 400, json: { ok: false, error_code: 400, description: 'Bad Request: message is not modified' } },
    { status: 400, json: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } },
  ]);
  const c = client(f);
  await c.editMessage(1, 2, 'texte');
  await assert.rejects(c.editMessage(1, 2, 'texte'), /chat not found/);
});

test('erreurs : le jeton n’apparaît jamais, ni réseau coupé ni réponse invalide', async () => {
  const { fetch: f } = fakeFetch([new Error(`connect ECONNREFUSED /bot${TOKEN}/sendMessage`), { text: '<html>pas du json</html>', status: 502 }, { status: 401, json: { ok: false, error_code: 401, description: 'Unauthorized' } }]);
  const c = client(f);
  for (const call of [() => c.sendMessage(1, 'a'), () => c.sendMessage(1, 'a'), () => c.sendMessage(1, 'a')]) {
    await assert.rejects(call(), (err: unknown) => {
      assert.ok(err instanceof TelegramError);
      assert.ok(!err.message.includes('SECRET-TOKEN-VALUE'));
      assert.ok(!JSON.stringify(err).includes('SECRET-TOKEN-VALUE'));
      return true;
    });
  }
});

test('downloadFile : adresse /file/bot<jeton>/<chemin> ; refus → erreur sans jeton', async () => {
  const calls: string[] = [];
  const f = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return calls.length === 1 ? new Response(Buffer.from('abc')) : new Response('nope', { status: 404 });
  }) as typeof fetch;
  const c = client(f);
  assert.equal((await c.downloadFile('photos/file_1.jpg')).toString(), 'abc');
  assert.equal(calls[0], `http://localhost:8081/file/bot${TOKEN}/photos/file_1.jpg`);
  await assert.rejects(c.downloadFile('x'), (err: unknown) => err instanceof TelegramError && !err.message.includes('SECRET'));
});
