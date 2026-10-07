// Shared loader for the prd scripts: finds prd-core.js next to the scripts (prd/lib in a
// project, assets/ inside the skill) and imports model modules in any supported format.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export async function libModule(name) {
  const candidates = [join(here, '../lib', name), join(here, '../assets', name), join(here, name)];
  const found = candidates.find(existsSync);
  if (!found) throw new Error(`Не найден ${name}: положите модули скилла в prd/lib/ (рядом с prd/scripts/)`);
  return import(pathToFileURL(found).href);
}

/** Import `file` and return export `name` (or default, or the first array/object export). */
export async function loadExport(file, names = []) {
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`Нет файла ${file}`);
  if (extname(path) === '.json') return JSON.parse(readFileSync(path, 'utf8'));
  let mod;
  try {
    mod = await import(pathToFileURL(path).href);
  } catch (e) {
    if (/\.(ts|mts|tsx)$/.test(path) && /Unknown file extension|ERR_UNKNOWN_FILE_EXTENSION|Unexpected token/.test(String(e))) {
      throw new Error(`${file} — TypeScript. Запустите скрипт через tsx: npx tsx ${process.argv[1]} ...`);
    }
    throw e;
  }
  for (const n of names) if (mod[n] !== undefined) return mod[n];
  if (mod.default !== undefined) return mod.default;
  const first = Object.values(mod).find((v) => v && typeof v === 'object');
  if (first) return first;
  throw new Error(`${file}: не найден экспорт ${names.join(' / ')}`);
}

export const readJson = (file, fallback = null) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
};

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      const value = next === undefined || next.startsWith('--') ? true : (i += 1, next);
      if (out[key] === undefined) out[key] = value;
      else out[key] = [].concat(out[key], value);
    } else out._.push(a);
  }
  return out;
}

/** Print problems grouped by level; returns the number of errors. */
export function report(problems, { title = 'Проверка' } = {}) {
  const errors = problems.filter((p) => p.level === 'error');
  const warns = problems.filter((p) => p.level === 'warn');
  const infos = problems.filter((p) => p.level === 'info');
  for (const p of errors) console.error(`  ✗ ${p.id}: ${p.msg}`);
  for (const p of warns) console.warn(`  ! ${p.id}: ${p.msg}`);
  for (const p of infos) console.log(`  · ${p.id}: ${p.msg}`);
  console.log(`${title}: ошибок ${errors.length}, предупреждений ${warns.length}`);
  return errors.length;
}
