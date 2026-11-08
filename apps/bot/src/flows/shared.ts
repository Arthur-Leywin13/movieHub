import { choiceStep, dateStep, fileStep, multiStep, numberStep, type Option } from '../steps.ts';
import type { Data } from '../session.ts';
import type { StepCtx, StepDef } from '../wizard.ts';

/** Langues proposées : celles annoncées dans `d[key]` si renseignées, sinon toutes. */
export function langOptions(ctx: StepCtx, key?: string): Option[] {
  const announced = key ? ((ctx.data[key] as string[] | undefined) ?? []) : [];
  const all = ctx.env.languages;
  return (announced.length ? all.filter((l) => announced.includes(l.code)) : all).map((l) => ({ label: `${l.name} (${l.code})`, value: l.code }));
}

export const nextNumber = (d: Data): number => ((d['episodes'] as { number: number }[] | undefined) ?? []).reduce((m, e) => Math.max(m, e.number), 0) + 1;

/** Étapes d'ajout d'épisodes (boucle) : d.episodes = [{ number, versions: [{ file, audio, subs }] }]. */
export function episodeSteps(): StepDef[] {
  return [
    choiceStep({
      id: 'epMore',
      prompt: (d) => (d['episodes'].length ? 'Épisode enregistré. Que faire ?' : 'Ajouter un épisode ?'),
      options: ({ data }) => [
        ...(data['episodes'].length ? [{ label: '🌐 Autre langue pour cet épisode', value: 'lang' }] : []),
        { label: data['episodes'].length ? '➡️ Épisode suivant' : '➕ Ajouter un épisode', value: 'add' },
        { label: '✅ Terminer', value: 'done' },
      ],
      apply: () => undefined,
      next: (v) => (v === 'add' ? ['epNumber', 'epVideo', 'epAudio', 'epSubs', 'epMore'] : v === 'lang' ? ['epVideo', 'epAudio', 'epSubs', 'epMore'] : []),
    }),
    numberStep({
      id: 'epNumber', prompt: "Numéro de l'épisode ?", min: 1, max: 9999, suggest: nextNumber,
      validate: (n, d) => (d['episodes'].some((e: { number: number }) => e.number === n) ? `L'épisode ${n} existe déjà dans cette saisie.` : null),
      apply: (d, v) => d['episodes'].push({ number: v, versions: [] }),
    }),
    fileStep({ id: 'epVideo', prompt: "Fichier vidéo de l'épisode.", kind: 'video', apply: (d, v) => (d['cur'] = { file: v, audio: [], subs: [] }) }),
    multiStep({ id: 'epAudio', prompt: 'Langue(s) audio de ce fichier ?', min: 1, options: (ctx) => langOptions(ctx, 'audio'), apply: (d, v) => (d['cur'].audio = v) }),
    fileStep({
      id: 'epSubs', prompt: 'Sous-titres de ce fichier ?', kind: 'subtitle', optional: true,
      apply: (d, v) => {
        if (v) d['pendingSub'] = v;
        else {
          d['episodes'][d['episodes'].length - 1].versions.push(d['cur']);
          d['cur'] = undefined;
        }
      },
      next: (v) => (v ? ['epSubLang', 'epSubs'] : []),
    }),
    choiceStep({ id: 'epSubLang', prompt: 'Langue de ce fichier de sous-titres ?', columns: 2, options: (ctx) => langOptions(ctx, 'subs'), apply: (d, v) => d['cur'].subs.push({ file: d['pendingSub'], language: v }) }),
  ];
}

/** Étapes d'une version vidéo (film ou épisode) : d.video = { file, audio, subs }. */
export function versionSteps(o: { optionalFile: boolean; announcedKey?: string; subsKey?: string }): StepDef[] {
  return [
    fileStep({ id: 'vFile', prompt: 'Fichier vidéo.', kind: 'video', optional: o.optionalFile, apply: (d, v) => (d['video'] = v ? { file: v, audio: [], subs: [] } : undefined) }),
    multiStep({ id: 'vAudio', prompt: 'Langue(s) audio de ce fichier ?', min: 1, when: (d) => Boolean(d['video']), options: (ctx) => langOptions(ctx, o.announcedKey), apply: (d, v) => (d['video'].audio = v) }),
    fileStep({
      id: 'vSubs', prompt: 'Sous-titres de ce fichier ?', kind: 'subtitle', optional: true, when: (d) => Boolean(d['video']),
      apply: (d, v) => {
        if (v) d['pendingSub'] = v;
      },
      next: (v) => (v ? ['vSubLang', 'vSubs'] : []),
    }),
    choiceStep({ id: 'vSubLang', prompt: 'Langue de ce fichier de sous-titres ?', columns: 2, options: (ctx) => langOptions(ctx, o.subsKey), apply: (d, v) => d['video'].subs.push({ file: d['pendingSub'], language: v }) }),
  ];
}

export const seasonSteps = (): StepDef[] => [
  numberStep({ id: 'seasonNumber', prompt: 'Numéro de la saison ?', min: 0, max: 200, suggest: (d) => d['nextSeason'] ?? 1, apply: (d, v) => (d['seasonNumber'] = v) }),
  dateStep({ id: 'seasonDate', prompt: 'Date de sortie officielle de la saison ?', apply: (d, v) => (d['seasonDate'] = v) }),
];
