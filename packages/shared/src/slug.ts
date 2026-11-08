/**
 * Slug d'URL : minuscules, sans accents latins, lettres/chiffres Unicode conservés
 * (les titres japonais restent lisibles), séparateur « - ».
 */
export function slugify(input: string, maxLength = 80): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, maxLength).replace(/-+$/g, '');
}

/** Slug d'un contenu : titre + année si connue ; « contenu » si le titre ne donne rien. */
export function buildContentSlug(title: string, year?: number | null): string {
  const base = slugify(title) || 'contenu';
  return year ? `${base}-${year}` : base;
}
