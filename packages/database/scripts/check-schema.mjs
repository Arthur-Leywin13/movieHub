#!/usr/bin/env node
// Contrôle structurel du schéma Prisma, sans dépendance ni accès réseau.
//
// ATTENTION : ce n'est PAS `prisma validate`. Il vérifie seulement les erreurs que l'on
// fait le plus souvent à la main : relations sans côté opposé, clés étrangères de type
// différent de la cible, SetNull sur colonne obligatoire, 1:1 sans @unique, colonnes
// inconnues dans les index, valeurs par défaut d'enum inexistantes, relations ambiguës.
// `prisma validate` reste obligatoire dès que Prisma est installable (npm run validate).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCALARS = new Set(['String', 'Boolean', 'Int', 'BigInt', 'Float', 'Decimal', 'DateTime', 'Json', 'Bytes']);

function balanced(str, openIdx) {
  let depth = 0;
  let inStr = false;
  for (let i = openIdx; i < str.length; i++) {
    const ch = str[i];
    if (ch === '"') inStr = !inStr;
    if (inStr) continue;
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return str.slice(openIdx + 1, i);
    }
  }
  return null;
}

function splitTop(str) {
  const out = [];
  let depth = 0;
  let inStr = false;
  let cur = '';
  for (const ch of str) {
    if (ch === '"') inStr = !inStr;
    if (!inStr) {
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (ch === ',' && depth === 0) {
        out.push(cur.trim());
        cur = '';
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Retourne { args } si l'attribut est présent (args = contenu des parenthèses ou null). */
function getAttr(attrStr, name) {
  const m = new RegExp(`${name}(?![\\w])`).exec(attrStr);
  if (!m) return null;
  const after = m.index + name.length;
  return { args: attrStr[after] === '(' ? balanced(attrStr, after) : null };
}

function listItems(inner) {
  return splitTop(inner)
    .map((s) => s.replace(/\(.*\)\s*$/, '').trim())
    .filter(Boolean);
}

function keyedList(args, key) {
  const m = new RegExp(`${key}\\s*:\\s*\\[([^\\]]*)\\]`).exec(args ?? '');
  return m ? listItems(m[1]) : null;
}

function positionalList(args) {
  const m = /^\s*\[([^\]]*)\]/.exec(args ?? '');
  return m ? listItems(m[1]) : null;
}

export function parseSchema(src) {
  const errors = [];
  const text = src.replace(/\/\/.*$/gm, '');
  const models = new Map();
  const enums = new Map();
  const re = /(?:^|\n)\s*(model|enum|generator|datasource)\s+(\w+)\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, kind, name, body] = m;
    if (kind === 'generator' || kind === 'datasource') continue;
    if (models.has(name) || enums.has(name)) {
      errors.push(`Nom dupliqué : ${name}`);
      continue;
    }
    if (kind === 'enum') {
      const values = body
        .split('\n')
        .map((l) => l.trim().split(/\s+/)[0])
        .filter(Boolean);
      if (new Set(values).size !== values.length) errors.push(`enum ${name} : valeurs dupliquées`);
      enums.set(name, new Set(values));
      continue;
    }
    const fields = [];
    const blockAttrs = [];
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('@@')) {
        blockAttrs.push(line);
        continue;
      }
      const fm = /^(\w+)\s+(Unsupported\("[^"]*"\)|\w+)(\[\])?(\?)?\s*(.*)$/.exec(line);
      if (!fm) {
        errors.push(`${name} : ligne illisible « ${line} »`);
        continue;
      }
      fields.push({ name: fm[1], type: fm[2], isList: !!fm[3], optional: !!fm[4], attrs: fm[5] });
    }
    const seen = new Set();
    for (const f of fields) {
      if (seen.has(f.name)) errors.push(`${name}.${f.name} : champ dupliqué`);
      seen.add(f.name);
    }
    models.set(name, { name, fields, blockAttrs });
  }
  return { models, enums, errors };
}

function dbAttr(f) {
  const m = /@db\.(\w+(?:\([^)]*\))?)/.exec(f.attrs);
  return m ? m[1] : '';
}

function uniqueSets(model) {
  const sets = [];
  for (const f of model.fields) {
    if (getAttr(f.attrs, '@id') || getAttr(f.attrs, '@unique')) sets.push([f.name]);
  }
  for (const line of model.blockAttrs) {
    const kind = /^@@(\w+)/.exec(line)?.[1];
    if (kind === 'id' || kind === 'unique') {
      const args = balanced(line, line.indexOf('('));
      const list = positionalList(args);
      if (list) sets.push(list);
    }
  }
  return sets;
}

function relName(f) {
  const a = getAttr(f.attrs, '@relation')?.args ?? '';
  return /^\s*"([^"]*)"/.exec(a)?.[1] ?? /name\s*:\s*"([^"]*)"/.exec(a)?.[1] ?? null;
}

const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

export function checkSchema(src) {
  const { models, enums, errors } = parseSchema(src);
  if (models.size === 0) errors.push('Aucun modèle trouvé (schéma illisible ?)');
  const isRelation = (f) => models.has(f.type);

  for (const model of models.values()) {
    const where = (f) => `${model.name}.${f}`;

    // clé primaire
    const hasId = model.fields.some((f) => getAttr(f.attrs, '@id')) || model.blockAttrs.some((l) => l.startsWith('@@id'));
    if (!hasId) errors.push(`${model.name} : aucune clé primaire`);

    // types de champs + défauts d'enum
    for (const f of model.fields) {
      const known = SCALARS.has(f.type) || enums.has(f.type) || models.has(f.type) || f.type.startsWith('Unsupported(');
      if (!known) errors.push(`${where(f.name)} : type inconnu « ${f.type} »`);
      if (enums.has(f.type)) {
        const d = getAttr(f.attrs, '@default');
        const val = d?.args?.trim();
        if (val && /^\w+$/.test(val) && !enums.get(f.type).has(val)) {
          errors.push(`${where(f.name)} : valeur par défaut « ${val} » absente de l'enum ${f.type}`);
        }
      }
    }

    // index / unique / id : colonnes existantes
    const scalarNames = new Set(model.fields.filter((f) => !isRelation(f)).map((f) => f.name));
    for (const line of model.blockAttrs) {
      const kind = /^@@(\w+)/.exec(line)?.[1];
      if (!['id', 'unique', 'index'].includes(kind)) continue;
      const open = line.indexOf('(');
      const list = open >= 0 ? positionalList(balanced(line, open)) : null;
      if (!list) {
        errors.push(`${model.name} : @@${kind} sans liste de champs lisible`);
        continue;
      }
      for (const col of list) {
        if (!scalarNames.has(col)) errors.push(`${model.name} : @@${kind} référence le champ inconnu « ${col} »`);
      }
    }

    // relations côté clé étrangère
    for (const f of model.fields.filter(isRelation)) {
      const rel = getAttr(f.attrs, '@relation');
      const args = rel?.args ?? '';
      const fkFields = keyedList(args, 'fields');
      const refFields = keyedList(args, 'references');
      const target = models.get(f.type);

      if (fkFields || refFields) {
        if (!fkFields || !refFields || fkFields.length !== refFields.length) {
          errors.push(`${where(f.name)} : fields/references incohérents`);
          continue;
        }
        if (f.isList) errors.push(`${where(f.name)} : un champ liste ne peut pas porter la clé étrangère`);
        const fkDefs = fkFields.map((n) => model.fields.find((x) => x.name === n));
        const refDefs = refFields.map((n) => target.fields.find((x) => x.name === n));
        fkFields.forEach((n, i) => {
          if (!fkDefs[i]) errors.push(`${where(f.name)} : champ FK inconnu « ${n} »`);
        });
        refFields.forEach((n, i) => {
          if (!refDefs[i]) errors.push(`${where(f.name)} : champ référencé inconnu « ${f.type}.${n} »`);
        });
        if (fkDefs.some((x) => !x) || refDefs.some((x) => !x)) continue;

        fkDefs.forEach((fk, i) => {
          const ref = refDefs[i];
          if (fk.type !== ref.type || dbAttr(fk) !== dbAttr(ref)) {
            errors.push(
              `${where(f.name)} : type de ${fk.name} (${fk.type} ${dbAttr(fk)}) ≠ ${f.type}.${ref.name} (${ref.type} ${dbAttr(ref)})`,
            );
          }
        });
        if (!uniqueSets(target).some((s) => sameSet(s, refFields))) {
          errors.push(`${where(f.name)} : ${f.type}(${refFields.join(',')}) n'est ni @id ni @unique`);
        }
        const fkOptional = fkDefs.map((x) => x.optional);
        if (f.optional && fkOptional.some((o) => !o)) errors.push(`${where(f.name)} : relation optionnelle mais FK obligatoire`);
        if (!f.optional && fkOptional.some((o) => o)) errors.push(`${where(f.name)} : relation obligatoire mais FK optionnelle`);
        const onDelete = /onDelete:\s*(\w+)/.exec(args)?.[1];
        if (onDelete === 'SetNull' && fkOptional.some((o) => !o)) {
          errors.push(`${where(f.name)} : onDelete SetNull sur FK obligatoire`);
        }
      }
    }

    // appariement des deux côtés
    for (const f of model.fields.filter(isRelation)) {
      const rel = getAttr(f.attrs, '@relation');
      const args = rel?.args ?? '';
      const name = relName(f);
      const hasFk = !!keyedList(args, 'fields');
      const sameModel = f.type === model.name;
      const siblingsSameTarget = model.fields.filter((x) => x.type === f.type && x !== f);
      if ((siblingsSameTarget.length > 0 || sameModel) && !name) {
        errors.push(`${where(f.name)} : plusieurs relations vers ${f.type}, un nom de relation est obligatoire`);
        continue;
      }
      const target = models.get(f.type);
      const opposite = target.fields.filter((x) => x !== f && x.type === model.name && relName(x) === name);
      if (opposite.length !== 1) {
        errors.push(`${where(f.name)} : côté opposé introuvable ou multiple dans ${f.type} (${opposite.length})`);
        continue;
      }
      const o = opposite[0];
      const oArgs = getAttr(o.attrs, '@relation')?.args ?? '';
      const oHasFk = !!keyedList(oArgs, 'fields');
      if (hasFk && oHasFk) errors.push(`${where(f.name)} : les deux côtés portent fields/references`);
      if (!hasFk && !oHasFk) errors.push(`${where(f.name)} : aucun côté ne porte fields/references (m:n implicite non autorisé ici)`);

      // 1:1 : le côté FK doit être unique, l'opposé optionnel
      if (hasFk && !f.isList && !o.isList) {
        const fkFields = keyedList(args, 'fields');
        if (!uniqueSets(model).some((s) => sameSet(s, fkFields))) {
          errors.push(`${where(f.name)} : relation 1:1 mais ${fkFields.join(',')} n'est pas @unique`);
        }
        if (!o.optional) errors.push(`${target.name}.${o.name} : côté opposé d'une 1:1 doit être optionnel`);
      }
      if (hasFk && o.isList === false && f.isList) errors.push(`${where(f.name)} : liste côté FK`);
    }
  }
  return errors;
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage : node check-schema.mjs <schema.prisma>');
    process.exit(2);
  }
  const src = readFileSync(file, 'utf8');
  const { models, enums } = parseSchema(src);
  const errors = checkSchema(src);
  const relations = [...models.values()].reduce((n, mo) => n + mo.fields.filter((f) => models.has(f.type)).length, 0);
  console.log(`Schéma : ${models.size} modèles, ${enums.size} enums, ${relations} champs de relation.`);
  if (errors.length) {
    console.error(`\n${errors.length} problème(s) :`);
    for (const e of errors) console.error(` - ${e}`);
    process.exit(1);
  }
  console.log('Contrôle structurel : OK (ce n\'est pas prisma validate).');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
