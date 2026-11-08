import type { J } from '../api-client.ts';
import { UserError } from '../errors.ts';
import type { Data } from '../session.ts';
import { CANCEL, choiceStep, fileStep, numberStep, textStep } from '../steps.ts';
import { STATUS_LABEL, fmtChange } from '../texts.ts';
import type { Flow, StepDef } from '../wizard.ts';
import { episodeSteps, langOptions, nextNumber, seasonSteps, versionSteps } from './shared.ts';

const flow = (id: string, start: string[], steps: StepDef[], init: (a: Data) => Data = (a) => ({ ...a })): Flow => ({
  id, init, start, steps: Object.fromEntries(steps.map((s) => [s.id, s])),
});

/** Résumé « avant → après » calculé par l'API (PATCH sans confirmation), puis confirmation. */
function reviewStep(changes: (d: Data) => Record<string, unknown>): StepDef {
  return {
    id: 'review',
    prepare: async ({ data, tmp, env }) => {
      const r = await env.api.call(env.uid, 'PATCH', `/admin/contents/${data['contentId']}`, changes(data));
      tmp['summary'] = r['summary'];
    },
    ask: ({ tmp }) => {
      const lines = (tmp['summary'] as J[]).map(fmtChange);
      return lines.length
        ? { text: `Changements à appliquer :\n${lines.join('\n')}`, keyboard: [[{ text: '✅ Confirmer', data: 'c:ok' }], [CANCEL]] }
        : { text: 'Aucun changement à appliquer.', keyboard: [[CANCEL]] };
    },
    handle: (input, { tmp }) =>
      input.kind === 'callback' && input.data === 'c:ok' && (tmp['summary'] as J[]).length ? { status: 'done', value: 'ok' } : { status: 'invalid', error: 'Utilisez les boutons.' },
    apply: (d) => (d['confirmed'] = true),
  };
}

const ALLOWED: Record<string, string[]> = {
  DRAFT: ['PUBLISHED', 'IN_PREPARATION', 'ARCHIVED'], IN_PREPARATION: ['PUBLISHED', 'DRAFT', 'ARCHIVED'],
  SCHEDULED: ['PUBLISHED', 'DRAFT', 'ARCHIVED'], PUBLISHED: ['UNPUBLISHED', 'ARCHIVED'],
  UNPUBLISHED: ['PUBLISHED', 'IN_PREPARATION', 'ARCHIVED'], ARCHIVED: ['DRAFT'], WITHDRAWN: [],
};
const ACTION_LABEL: Record<string, string> = { PUBLISHED: '🚀 Publier', UNPUBLISHED: '🙈 Dépublier', ARCHIVED: '🗄 Archiver', DRAFT: '♻️ Remettre en brouillon', IN_PREPARATION: '🛠 Mettre en préparation' };

async function adminDetail(ctx: { data: Data; env: { api: { call: (uid: number, m: string, p: string) => Promise<J> }; uid: number } }): Promise<J> {
  return ctx.env.api.call(ctx.env.uid, 'GET', `/admin/contents/${ctx.data['contentId']}`);
}

const publishChoice = (): StepDef =>
  choiceStep({
    id: 'vPublish', prompt: 'Publier cette version maintenant ?',
    options: () => [{ label: '🚀 Publier la version', value: 'publish' }, { label: '💾 Garder en brouillon', value: 'draft' }],
    apply: (d, v) => (d['publishVersion'] = v === 'publish'),
  });

const pickSeason = (): StepDef =>
  choiceStep({
    id: 'pickSeason', prompt: 'Quelle saison ?',
    options: async (ctx) => {
      const seasons = ((await adminDetail(ctx))['seasons'] as J[]).map((s) => ({ label: `Saison ${s['season']['number']}`, value: s['season']['id'] as string }));
      if (!seasons.length) throw new UserError('Ce contenu n’a pas encore de saison : ajoutez-en une d’abord.');
      return seasons;
    },
    apply: (d, v) => (d['seasonId'] = v),
  });

export function customizeFlows(): Flow[] {
  return [
    flow('edit:desc', ['text', 'review'], [
      textStep({ id: 'text', prompt: 'Nouvelle description ?', max: 5000, apply: (d, v) => (d['description'] = v) }),
      reviewStep((d) => ({ description: d['description'] })),
    ]),

    flow('edit:lang', ['langKind', 'langCode', 'review'], [
      choiceStep({
        id: 'langKind', prompt: 'Ajouter une langue…',
        options: () => [{ label: '🔊 Audio', value: 'audio' }, { label: '💬 Sous-titres', value: 'subs' }], columns: 2,
        apply: (d, v) => (d['langKind'] = v),
      }),
      choiceStep({
        id: 'langCode', prompt: 'Quelle langue ?', columns: 2,
        options: ({ data, env }) => {
          const have = (data[data['langKind'] === 'audio' ? 'audioLanguages' : 'subtitleLanguages'] as string[]) ?? [];
          return env.languages.filter((l) => !have.includes(l.code)).map((l) => ({ label: `${l.name} (${l.code})`, value: l.code }));
        },
        apply: (d, v) => (d['langCode'] = v),
      }),
      reviewStep((d) => (d['langKind'] === 'audio' ? { audioLanguages: { add: [d['langCode']] } } : { subtitleLanguages: { add: [d['langCode']] } })),
    ]),

    flow('edit:poster', ['posterFile', 'posterConfirm'], [
      fileStep({ id: 'posterFile', prompt: '🖼 Nouvelle affiche principale.', kind: 'image', apply: (d, v) => (d['poster'] = v) }),
      choiceStep({
        id: 'posterConfirm', prompt: "Remplacer l'affiche principale ? L'ancienne sera archivée (conservée, restaurable).",
        options: () => [{ label: '✅ Remplacer', value: 'ok' }], apply: (d, v) => (d['confirmed'] = v === 'ok'),
      }),
    ]),

    flow('edit:trailer', ['trailerSource', 'trailerMain'], [
      fileStep({ id: 'trailerSource', prompt: '🎞 Bande-annonce à ajouter.', kind: 'video', allowUrl: true, apply: (d, v) => (d['trailer'] = v) }),
      choiceStep({
        id: 'trailerMain', prompt: 'La définir comme bande-annonce principale ?',
        options: () => [{ label: 'Oui, principale', value: 'main' }, { label: 'Non, secondaire', value: 'second' }], columns: 2,
        apply: (d, v) => (d['makePrimary'] = v === 'main'),
      }),
    ]),

    flow('edit:version', ['vFile', 'vAudio', 'vSubs', 'vPublish'], [
      ...versionSteps({ optionalFile: false }), publishChoice(),
    ]),

    flow('edit:epversion', ['pickSeason', 'pickEpisode', 'epNew', 'vFile', 'vAudio', 'vSubs', 'vPublish'], [
      pickSeason(),
      choiceStep({
        id: 'pickEpisode', prompt: 'Quel épisode ?', columns: 2,
        options: async (ctx) => {
          const season = ((await adminDetail(ctx))['seasons'] as J[]).find((s) => s['season']['id'] === ctx.data['seasonId']);
          const eps = ((season?.['episodes'] ?? []) as J[]).map((e) => ({ label: `Épisode ${e['episode']['number']}`, value: e['episode']['id'] as string }));
          ctx.data['episodes'] = ((season?.['episodes'] ?? []) as J[]).map((e) => ({ number: e['episode']['number'] }));
          return [...eps, { label: '➕ Nouvel épisode', value: 'new' }];
        },
        apply: (d, v) => (d['episodeId'] = v),
      }),
      numberStep({
        id: 'epNew', prompt: "Numéro du nouvel épisode ?", min: 1, max: 9999, suggest: nextNumber, when: (d) => d['episodeId'] === 'new',
        validate: (n, d) => (d['episodes'].some((e: { number: number }) => e.number === n) ? `L'épisode ${n} existe déjà.` : null),
        apply: (d, v) => (d['newEpisodeNumber'] = v),
      }),
      ...versionSteps({ optionalFile: false }), publishChoice(),
    ]),

    flow('edit:season', ['seasonNumber', 'seasonDate'], seasonSteps()),

    flow('edit:episodes', ['pickSeason', 'epMore', 'confirmEp'], [
      pickSeason(), ...episodeSteps(),
      choiceStep({ id: 'confirmEp', prompt: (d) => `Créer ${d['episodes'].length} épisode(s) ?`, options: () => [{ label: '✅ Créer', value: 'ok' }], apply: (d, v) => (d['confirmed'] = v === 'ok') }),
    ], (a) => ({ ...a, episodes: [] })),

    flow('edit:status', ['statusChoice'], [
      choiceStep({
        id: 'statusChoice', prompt: (d) => `Statut actuel : ${STATUS_LABEL[d['status']] ?? d['status']}. Que faire ?`,
        options: ({ data }) => (ALLOWED[data['status']] ?? []).map((s) => ({ label: ACTION_LABEL[s] ?? s, value: s })),
        apply: (d, v) => (d['newStatus'] = v),
      }),
    ]),

    flow('search', ['q'], [textStep({ id: 'q', prompt: '🔎 Titre à chercher ?', max: 100, apply: (d, v) => (d['q'] = v) })]),
  ];
}
