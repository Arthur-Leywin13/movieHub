/**
 * Traitements exécutés après confirmation (envois R2 + appels API). Chaque sous-étape est mémorisée dans
 * session.progress : après une coupure, /resume reprend sans recréer ce qui existe déjà et sans renvoyer
 * les morceaux déjà reçus.
 */
import type { ApiClient, J } from './api-client.ts';
import type { FileRef, FileResolver } from './files.ts';
import type { Session } from './session.ts';
import { removeTemp, type UploadKind, type Uploader } from './uploader.ts';
import { UserError } from './errors.ts';
import { UploadAborted } from './uploader.ts';

export interface PipelineDeps {
  api: ApiClient;
  uploader: Uploader;
  files: FileResolver;
  signal: AbortSignal;
  save: () => Promise<void>;
  progress: (label: string, done: number, total: number) => void;
}

export interface PipelineResult {
  message: string;
  contentId?: string;
  warnings: string[];
}

class Run {
  readonly s: Session;
  readonly deps: PipelineDeps;
  readonly warnings: string[] = [];
  constructor(s: Session, deps: PipelineDeps) {
    this.s = s;
    this.deps = deps;
  }
  get uid(): number {
    return this.s.userId;
  }
  call<T = J>(method: string, path: string, body?: unknown): Promise<T> {
    return this.deps.api.call<T>(this.uid, method, path, body);
  }
  /** Exécute `fn` une seule fois, même après une reprise. */
  async once(key: string, fn: () => Promise<void>): Promise<void> {
    if (this.s.progress[`done:${key}`]) return;
    if (this.deps.signal.aborted) throw new UploadAborted();
    await fn();
    this.s.progress[`done:${key}`] = true;
    await this.deps.save();
  }
  async upload(key: string, kind: UploadKind, ref: FileRef): Promise<string> {
    const ready = this.s.progress[`media:${key}`] as string | undefined;
    if (ready) return ready;
    const file = await this.deps.files.resolve(ref);
    try {
      const id = await this.deps.uploader.upload(this.uid, kind, file, {
        resume: (this.s.progress[`up:${key}`] as string | undefined) ?? null,
        onStarted: async (mediaId) => {
          this.s.progress[`up:${key}`] = mediaId;
          await this.deps.save();
        },
        onProgress: (d, t) => this.deps.progress(ref.name, d, t),
        signal: this.deps.signal,
      });
      this.s.progress[`media:${key}`] = id;
      await this.deps.save();
      return id;
    } finally {
      await removeTemp(file);
    }
  }
  /** Crée une version (film ou épisode) puis ses sous-titres externes ; renvoie l'identifiant de version. */
  async version(key: string, target: { kind: 'movie' | 'episode'; id: string }, v: { file: FileRef; audio: string[]; subs: { file: FileRef; language: string }[] }): Promise<string> {
    await this.once(`${key}:version`, async () => {
      const mediaFileId = await this.upload(`${key}:video`, 'VIDEO', v.file);
      const path = target.kind === 'movie' ? `/admin/contents/${target.id}/versions` : `/admin/episodes/${target.id}/versions`;
      const r = await this.call(('POST'), path, { mediaFileId, audioLanguages: v.audio });
      this.s.progress[`${key}:versionId`] = r['version']['id'];
      for (const w of (r['warnings'] ?? []) as string[]) this.warnings.push(w);
    });
    const versionId = this.s.progress[`${key}:versionId`] as string;
    for (const [i, sub] of v.subs.entries()) {
      await this.once(`${key}:sub${i}`, async () => {
        const mediaFileId = await this.upload(`${key}:sub${i}`, 'SUBTITLE', sub.file);
        await this.call('POST', `/admin/versions/${versionId}/subtitles`, { mediaFileId, language: sub.language });
      });
    }
    return versionId;
  }
  async publish(path: string, key: string): Promise<void> {
    await this.once(`pub:${key}`, async () => void (await this.call('POST', path, { status: 'PUBLISHED' })));
  }
}

async function trailer(run: Run, contentId: string, t: FileRef & { url?: string }, makePrimary?: boolean): Promise<void> {
  await run.once('trailer', async () => {
    const body = t.url ? { externalUrl: t.url } : { mediaFileId: await run.upload('trailer', 'TRAILER_VIDEO', t) };
    await run.call('POST', `/admin/contents/${contentId}/trailers`, { ...body, ...(makePrimary !== undefined ? { makePrimary } : {}) });
  });
}

/** Épisodes saisis (parcours d'ajout ou « Ajouter des épisodes ») : crée épisodes, versions et sous-titres. */
async function episodes(run: Run, seasonId: string, list: J[], publish: boolean): Promise<string[]> {
  const versionIds: string[] = [];
  const episodeIds: string[] = [];
  for (const [i, ep] of list.entries()) {
    await run.once(`ep${i}`, async () => {
      const r = await run.call('POST', `/admin/seasons/${seasonId}/episodes`, { number: ep['number'] });
      run.s.progress[`ep${i}:id`] = r['episode']['id'];
    });
    const episodeId = run.s.progress[`ep${i}:id`] as string;
    episodeIds.push(episodeId);
    for (const [j, v] of (ep['versions'] as J[]).entries()) {
      versionIds.push(await run.version(`ep${i}v${j}`, { kind: 'episode', id: episodeId }, v as never));
    }
  }
  if (publish) {
    for (const id of versionIds) await run.publish(`/admin/versions/${id}/status`, `ver:${id}`);
    for (const id of episodeIds) await run.publish(`/admin/episodes/${id}/status`, `ep:${id}`);
  }
  return versionIds;
}

export async function runPipeline(s: Session, deps: PipelineDeps): Promise<PipelineResult> {
  const run = new Run(s, deps);
  const d = s.data;
  const flow = s.flow as string;
  const done = (message: string, contentId?: string): PipelineResult => ({ message, ...(contentId ? { contentId } : {}), warnings: run.warnings });

  if (flow.startsWith('add:')) {
    const publish = d['confirm'] === 'publish';
    await run.once('content', async () => {
      const r = await run.call('POST', '/admin/contents', {
        type: d['type'], title: d['title'], year: d['year'], genres: d['genres'], audioLanguages: d['audio'], subtitleLanguages: d['subs'],
        ...(d['altTitles']?.length ? { altTitles: d['altTitles'] } : {}),
        ...(d['description'] ? { description: d['description'] } : {}),
        ...(d['type'] === 'MOVIE' && d['releaseDate'] ? { releaseDate: d['releaseDate'] } : {}),
      });
      s.progress['contentId'] = r['content']['id'];
    });
    const contentId = s.progress['contentId'] as string;
    if (d['poster']) {
      await run.once('poster', async () => {
        await run.call('POST', `/admin/contents/${contentId}/posters`, { mediaFileId: await run.upload('poster', 'IMAGE', d['poster']) });
      });
    }
    if (d['trailer']) await trailer(run, contentId, d['trailer']);

    if (d['type'] === 'MOVIE') {
      if (d['video']) {
        const versionId = await run.version('movie', { kind: 'movie', id: contentId }, d['video']);
        if (publish) await run.publish(`/admin/versions/${versionId}/status`, 'movieVersion');
      }
    } else {
      await run.once('season', async () => {
        const r = await run.call('POST', `/admin/contents/${contentId}/seasons`, { number: d['seasonNumber'], releaseDate: d['seasonDate'] });
        s.progress['seasonId'] = r['season']['id'];
      });
      const seasonId = s.progress['seasonId'] as string;
      await episodes(run, seasonId, d['episodes'], publish);
      if (publish) await run.publish(`/admin/seasons/${seasonId}/status`, 'season');
    }
    if (publish) await run.publish(`/admin/contents/${contentId}/status`, 'content');
    return done(`${publish ? 'Publié' : 'Enregistré en brouillon'} : « ${d['title']} » (${d['year']}).`, contentId);
  }

  const contentId = d['contentId'] as string;
  switch (flow) {
    case 'edit:desc':
    case 'edit:lang': {
      const changes = flow === 'edit:desc' ? { description: d['description'] } : d['langKind'] === 'audio' ? { audioLanguages: { add: [d['langCode']] } } : { subtitleLanguages: { add: [d['langCode']] } };
      await run.once('apply', async () => void (await run.call('PATCH', `/admin/contents/${contentId}`, { ...changes, confirm: true })));
      return done('Modification appliquée.', contentId);
    }
    case 'edit:poster': {
      if (!d['confirmed']) throw new UserError('Remplacement non confirmé.');
      await run.once('poster', async () => {
        await run.call('POST', `/admin/contents/${contentId}/posters`, { mediaFileId: await run.upload('poster', 'IMAGE', d['poster']), makePrimary: true });
      });
      return done('Nouvelle affiche principale en place. L’ancienne est archivée (restaurable depuis « Médias »).', contentId);
    }
    case 'edit:trailer':
      await trailer(run, contentId, d['trailer'], d['makePrimary']);
      return done('Bande-annonce ajoutée.', contentId);
    case 'edit:version':
    case 'edit:epversion': {
      let target: { kind: 'movie' | 'episode'; id: string } = { kind: 'movie', id: contentId };
      if (flow === 'edit:epversion') {
        if (d['episodeId'] === 'new') {
          await run.once('episode', async () => {
            const r = await run.call('POST', `/admin/seasons/${d['seasonId']}/episodes`, { number: d['newEpisodeNumber'] });
            s.progress['episodeId'] = r['episode']['id'];
          });
        } else s.progress['episodeId'] = d['episodeId'];
        target = { kind: 'episode', id: s.progress['episodeId'] as string };
      }
      const versionId = await run.version('v', target, d['video']);
      if (d['publishVersion']) await run.publish(`/admin/versions/${versionId}/status`, 'v');
      const warn = run.warnings.length ? `\n⚠️ ${run.warnings.join('\n⚠️ ')}\nAjoutez la langue via « Langues » pour l’annoncer sur la fiche.` : '';
      return done(`Version ajoutée${d['publishVersion'] ? ' et publiée' : ' (brouillon)'}. Les versions existantes sont conservées.${warn}`, contentId);
    }
    case 'edit:season':
      await run.once('season', async () => void (await run.call('POST', `/admin/contents/${contentId}/seasons`, { number: d['seasonNumber'], releaseDate: d['seasonDate'] })));
      return done(`Saison ${d['seasonNumber']} créée (brouillon).`, contentId);
    case 'edit:episodes': {
      if (!d['confirmed']) throw new UserError('Création non confirmée.');
      await episodes(run, d['seasonId'], d['episodes'], false);
      return done(`${d['episodes'].length} épisode(s) créé(s) en brouillon.`, contentId);
    }
    case 'edit:status': {
      await run.once('status', async () => void (await run.call('POST', `/admin/contents/${contentId}/status`, { status: d['newStatus'] })));
      return done(`Statut mis à jour : ${d['newStatus']}.`, contentId);
    }
    default:
      throw new UserError(`Traitement inconnu : ${flow}`);
  }
}
