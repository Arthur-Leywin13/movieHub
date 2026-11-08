import type { J } from './api-client.ts';
import type { FileRef } from './files.ts';
import type { Data } from './session.ts';

export const TYPE_LABEL: Record<string, string> = { MOVIE: 'Film', SERIES: 'Série', ANIME: 'Animé' };
export const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Brouillon', IN_PREPARATION: 'En préparation', SCHEDULED: 'Programmé', PUBLISHED: 'Publié',
  UNPUBLISHED: 'Dépublié', WITHDRAWN: 'Retiré', ARCHIVED: 'Archivé',
};

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '?';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} Go`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} Mo`;
  return `${Math.max(1, Math.round(n / 1024))} Ko`;
}

const fileLine = (f: FileRef): string => `${f.name} (${fmtBytes(f.size)})`;
const list = (a: unknown): string => (Array.isArray(a) && a.length ? a.join(', ') : '—');
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function addSummary(d: Data): string {
  const L: string[] = ['📋 Vérification', `Type : ${TYPE_LABEL[d['type']] ?? d['type']}`, `Titre : ${d['title']}`];
  if (d['altTitles']?.length) L.push(`Titres alternatifs : ${list(d['altTitles'])}`);
  L.push(`Année : ${d['year']}`);
  if (d['type'] === 'MOVIE') L.push(`Date de sortie : ${d['releaseDate'] ?? '—'}`);
  L.push(`Genres : ${list(d['genres'])}`, `Audio annoncé : ${list(d['audio'])}`, `Sous-titres annoncés : ${list(d['subs'])}`);
  if (d['description']) L.push(`Description : ${cut(String(d['description']), 120)}`);
  L.push(`Affiche : ${d['poster'] ? fileLine(d['poster']) : 'aucune'}`);
  L.push(`Bande-annonce : ${d['trailer'] ? (d['trailer'].url ? `lien ${d['trailer'].url}` : fileLine(d['trailer'])) : 'aucune'}`);
  if (d['type'] === 'MOVIE') {
    const v = d['video'];
    L.push(v ? `Fichier vidéo : ${fileLine(v.file)} — audio ${list(v.audio)} — ${v.subs.length} sous-titre(s)` : 'Fichier vidéo : aucun (le contenu sera « à venir »)');
  } else {
    L.push(`Saison ${d['seasonNumber']} — sortie ${d['seasonDate']}`);
    for (const e of (d['episodes'] ?? []) as J[]) {
      L.push(`  • Épisode ${e['number']} : ${e['versions'].map((v: J) => `${list(v['audio'])} (${v['file'].name})`).join(' + ') || 'sans fichier'}`);
    }
    if (!d['episodes']?.length) L.push('  Aucun épisode pour l’instant');
  }
  return L.join('\n');
}

const FIELD: Record<string, string> = {
  title: 'Titre', description: 'Description', year: 'Année', releaseDate: 'Date de sortie', altTitles: 'Titres alternatifs',
  genres: 'Genres', audioLanguages: 'Langues audio', subtitleLanguages: 'Sous-titres',
};
const val = (v: unknown): string => (Array.isArray(v) ? (v.length ? v.join(', ') : '∅') : v === null || v === undefined || v === '' ? '∅' : cut(String(v), 80));
export const fmtChange = (l: J): string => `• ${FIELD[l['field']] ?? l['field']} : ${val(l['from'])} → ${val(l['to'])}`;

export function cardText(detail: J): string {
  const c = detail['content'] as J;
  const L = [
    `${TYPE_LABEL[c['type']] ?? c['type']} — ${c['title']}${c['year'] ? ` (${c['year']})` : ''}`,
    `Statut : ${STATUS_LABEL[c['status']] ?? c['status']}`,
    `Audio : ${list(c['audioLanguages'])} • Sous-titres : ${list(c['subtitleLanguages'])}`,
    `Genres : ${list((c['genres'] as J[]).map((g) => g['name']))}`,
    `Affiches : ${(detail['posters'] as J[]).filter((p) => !p['archivedAt']).length} (+${(detail['posters'] as J[]).filter((p) => p['archivedAt']).length} archivée(s)) • Bandes-annonces : ${(detail['trailers'] as J[]).filter((t) => !t['archivedAt']).length}`,
  ];
  if (c['type'] === 'MOVIE') {
    const vs = detail['versions'] as J[];
    L.push(`Versions : ${vs.length ? vs.map((v) => `${list(v['audioTracks'].map((t: J) => t['languageCode']))} [${STATUS_LABEL[v['status']] ?? v['status']}]`).join(' ; ') : 'aucune'}`);
  } else {
    for (const s of detail['seasons'] as J[]) {
      const eps = s['episodes'] as J[];
      L.push(`Saison ${s['season']['number']} [${STATUS_LABEL[s['season']['status']] ?? s['season']['status']}] : ${eps.length} épisode(s)`);
    }
    if (!(detail['seasons'] as J[]).length) L.push('Aucune saison');
  }
  return L.join('\n');
}

export const HELP = [
  '🎬 MoviesHub — administration du catalogue',
  '',
  '/addfilm — ajouter un film',
  '/addserie — ajouter une série',
  '/addanime — ajouter un animé',
  '/search [texte] — chercher un contenu, puis le personnaliser',
  '/customize [texte] — idem (alias : /edit)',
  '/delete [texte] — dépublier ou archiver un contenu',
  '/stats — chiffres du catalogue',
  '/resume — reprendre un traitement interrompu',
  '/cancel — annuler l’opération en cours',
  '',
  'Rien n’est jamais supprimé définitivement depuis le bot : « supprimer » = dépublier ou archiver.',
].join('\n');
