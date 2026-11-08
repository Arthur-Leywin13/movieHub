import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkSchema } from './check-schema.mjs';

const wrap = (body) => `
enum Color { RED GREEN }
${body}`;

const has = (errors, text) => assert.ok(errors.some((e) => e.includes(text)), `attendu « ${text} » dans:\n${errors.join('\n')}`);

test('le schéma réel passe le contrôle structurel', () => {
  const src = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
  assert.deepEqual(checkSchema(src), []);
});

test('un schéma sans modèle est refusé (pas de faux positif)', () => {
  has(checkSchema('rien ici'), 'Aucun modèle trouvé');
});

test('schéma minimal valide', () => {
  const errs = checkSchema(wrap(`
model A { id String @id @db.Uuid
  bs B[] }
model B { id String @id @db.Uuid
  aId String @db.Uuid
  a A @relation(fields: [aId], references: [id]) }`));
  assert.deepEqual(errs, []);
});

test('détecte un côté opposé manquant', () => {
  const errs = checkSchema(wrap(`
model A { id String @id }
model B { id String @id
  aId String
  a A @relation(fields: [aId], references: [id]) }`));
  has(errs, 'côté opposé introuvable');
});

test('détecte SetNull sur FK obligatoire', () => {
  const errs = checkSchema(wrap(`
model A { id String @id
  bs B[] }
model B { id String @id
  aId String
  a A @relation(fields: [aId], references: [id], onDelete: SetNull) }`));
  has(errs, 'SetNull sur FK obligatoire');
});

test('détecte un type de FK différent de la cible (@db.Uuid manquant)', () => {
  const errs = checkSchema(wrap(`
model A { id String @id @db.Uuid
  bs B[] }
model B { id String @id
  aId String
  a A @relation(fields: [aId], references: [id]) }`));
  has(errs, 'type de aId');
});

test('détecte une valeur par défaut d’enum inexistante', () => {
  const errs = checkSchema(wrap(`model A { id String @id
  c Color @default(BLUE) }`));
  has(errs, 'BLUE');
});

test('détecte deux relations non nommées vers le même modèle', () => {
  const errs = checkSchema(wrap(`
model A { id String @id
  x B[]
  y B[] }
model B { id String @id
  a1Id String
  a2Id String
  a1 A @relation(fields: [a1Id], references: [id])
  a2 A @relation(fields: [a2Id], references: [id]) }`));
  has(errs, 'nom de relation est obligatoire');
});

test('détecte une 1:1 sans @unique sur la FK', () => {
  const errs = checkSchema(wrap(`
model A { id String @id
  b B? }
model B { id String @id
  aId String
  a A @relation(fields: [aId], references: [id]) }`));
  has(errs, "n'est pas @unique");
});

test('détecte un champ inconnu dans un index', () => {
  const errs = checkSchema(wrap(`model A { id String @id
  @@index([nope]) }`));
  has(errs, 'champ inconnu « nope »');
});

test('détecte un modèle sans clé primaire', () => {
  const errs = checkSchema(wrap(`model A { name String }`));
  has(errs, 'aucune clé primaire');
});

test('détecte une relation optionnelle avec FK obligatoire', () => {
  const errs = checkSchema(wrap(`
model A { id String @id
  bs B[] }
model B { id String @id
  aId String
  a A? @relation(fields: [aId], references: [id]) }`));
  has(errs, 'relation optionnelle mais FK obligatoire');
});

test('accepte des relations nommées multiples', () => {
  const errs = checkSchema(wrap(`
model A { id String @id
  x B[] @relation("X")
  y B[] @relation("Y") }
model B { id String @id
  a1Id String
  a2Id String
  a1 A @relation("X", fields: [a1Id], references: [id])
  a2 A @relation("Y", fields: [a2Id], references: [id]) }`));
  assert.deepEqual(errs, []);
});
