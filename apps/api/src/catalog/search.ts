/**
 * Recherche : normalisation (accents, casse, ponctuation), similarité par trigrammes (même principe que
 * pg_trgm) et score. La version PostgreSQL (infra/prisma-catalog-repo.ts) applique les mêmes règles ;
 * les scores peuvent différer légèrement, l'ordre général est le même.
 */
export function normalizeText(s: string): string {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').trim();
}

export const tokens = (s: string): string[] => normalizeText(s).split(' ').filter(Boolean);

function trigrams(s: string): Set<string> {
  const set = new Set<string>();
  for (const w of tokens(s)) {
    const p = `  ${w} `;
    for (let i = 0; i + 3 <= p.length; i++) set.add(p.slice(i, i + 3));
  }
  return set;
}

/** Similarité de trigrammes entre 0 et 1 (comme pg_trgm). */
export function similarity(a: string, b: string): number {
  const A = trigrams(a);
  const B = trigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Requête plein texte « préfixes » pour to_tsquery : `mis:* & les:*`. Jetons alphanumériques uniquement. */
export function tsPrefixQuery(q: string): string | null {
  const t = tokens(q).slice(0, 8);
  return t.length ? t.map((x) => `${x}:*`).join(' & ') : null;
}

export const MIN_SIMILARITY = 0.3;

/** Score d'un contenu pour une requête (0 = ne correspond pas). */
export function scoreMatch(query: string, titles: string[], description: string | null): number {
  const qn = normalizeText(query);
  const qt = tokens(query);
  if (!qn) return 0;
  let best = 0;
  for (const t of titles) {
    const tn = normalizeText(t);
    const tt = tokens(t);
    if (tn === qn) best = Math.max(best, 1);
    else if (tn.startsWith(qn)) best = Math.max(best, 0.95);
    else if (qt.every((q) => tt.some((x) => x.startsWith(q)))) best = Math.max(best, 0.8);
    best = Math.max(best, similarity(tn, qn));
  }
  const pool = [...titles.flatMap(tokens), ...(description ? tokens(description) : [])];
  if (qt.every((q) => pool.some((x) => x.startsWith(q)))) best = Math.max(best, 0.6);
  return best >= MIN_SIMILARITY ? best : 0;
}
