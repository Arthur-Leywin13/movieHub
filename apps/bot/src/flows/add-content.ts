import { choiceStep, dateStep, fileStep, listStep, multiStep, numberStep, textStep } from '../steps.ts';
import { addSummary } from '../texts.ts';
import type { Flow, StepDef } from '../wizard.ts';
import { episodeSteps, langOptions, seasonSteps, versionSteps } from './shared.ts';

const isMovie = (d: Record<string, any>): boolean => d['type'] === 'MOVIE';
const isSeries = (d: Record<string, any>): boolean => d['type'] !== 'MOVIE';

/** Parcours d'ajout (cahier des charges §9) : film, série ou animé. */
export function addContentFlow(type: 'MOVIE' | 'SERIES' | 'ANIME'): Flow {
  const steps: StepDef[] = [
    fileStep({ id: 'poster', prompt: "🖼 Affiche du contenu.", kind: 'image', optional: true, apply: (d, v) => (d['poster'] = v) }),
    textStep({ id: 'title', prompt: type === 'MOVIE' ? 'Titre du film ?' : 'Nom de la série ?', max: 200, apply: (d, v) => (d['title'] = v) }),
    listStep({ id: 'altTitles', prompt: 'Titres alternatifs ?', optional: true, max: 20, itemMax: 200, apply: (d, v) => (d['altTitles'] = v) }),
    textStep({ id: 'description', prompt: 'Description ?', optional: true, max: 5000, apply: (d, v) => (d['description'] = v) }),
    numberStep({ id: 'year', prompt: 'Année ?', min: 1888, max: 2100, apply: (d, v) => (d['year'] = v) }),
    listStep({ id: 'genres', prompt: 'Genres ? (ex. Action, Drame)', optional: true, max: 10, apply: (d, v) => (d['genres'] = v) }),
    dateStep({ id: 'releaseDate', prompt: 'Date de sortie officielle ?', optional: true, when: isMovie, apply: (d, v) => (d['releaseDate'] = v) }),
    multiStep({ id: 'audio', prompt: 'Langues audio disponibles ?', min: 1, options: (ctx) => langOptions(ctx), apply: (d, v) => (d['audio'] = v) }),
    multiStep({ id: 'subs', prompt: 'Langues de sous-titres disponibles ?', min: 0, options: (ctx) => langOptions(ctx), apply: (d, v) => (d['subs'] = v) }),
    fileStep({ id: 'trailer', prompt: '🎞 Bande-annonce.', kind: 'video', allowUrl: true, optional: true, apply: (d, v) => (d['trailer'] = v) }),
    // film
    ...versionSteps({ optionalFile: true, announcedKey: 'audio', subsKey: 'subs' }).map((s) => ({ ...s, ...(s.id === 'vFile' ? { when: isMovie } : { when: (d: Record<string, any>) => isMovie(d) && Boolean(d['video']) }) })),
    // série / animé
    ...seasonSteps().map((s) => ({ ...s, when: isSeries })),
    ...episodeSteps().map((s) => (s.id === 'epMore' ? { ...s, when: isSeries } : s)),
    choiceStep({
      id: 'confirm', prompt: (d) => addSummary(d),
      options: () => [{ label: '🚀 Publier maintenant', value: 'publish' }, { label: '💾 Enregistrer en brouillon', value: 'draft' }],
      apply: (d, v) => (d['confirm'] = v),
    }),
  ];
  return {
    id: `add:${type}`,
    init: () => ({ type, episodes: [], altTitles: [], genres: [], audio: [], subs: [] }),
    start: ['poster', 'title', 'altTitles', 'description', 'year', 'genres', 'releaseDate', 'audio', 'subs', 'trailer', 'vFile', 'vAudio', 'vSubs', 'seasonNumber', 'seasonDate', 'epMore', 'confirm'],
    steps: Object.fromEntries(steps.map((s) => [s.id, s])),
  };
}
