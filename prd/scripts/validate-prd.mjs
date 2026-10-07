#!/usr/bin/env node
// Validate the PRD model and everything that points at it.
//
//   node prd/scripts/validate-prd.mjs prd/prd.js [--write-lock] [--strict]
//        [--lock prd/prd.lock.json] [--tests prd/test-results.json] [--releases prd/releases.js]
//        [--package package.json] [--inventory prd/inventory.json] [--src src,app]
//        [--processes src/content/processes.js] [--tours src/tours.js] [--pitch prd/pitch.js]
//
// Files next to the model (prd.lock.json, test-results.json, releases.js, inventory.json)
// and ./package.json are picked up automatically. TypeScript model: run through `npx tsx`.
//
// What it catches, and why each matters:
//  - model structure (ids, modules, epics, priorities, statuses) — prd-core validatePrd();
//  - ids that disappeared or got renumbered — reviews and test tags would point at
//    nothing or at a different requirement (prd.lock.json);
//  - test tags for criteria that do not exist; "done" with no proof;
//  - inventory items no criterion covers — the reverse-engineered PRD forgot a screen;
//  - data-ac anchors with unknown ids — "Показать в прототипе" would highlight nothing;
//  - process/tour references (guided-process-docs) to criteria that do not exist;
//  - releases: order, semver, refs, package.json version;
//  - pitch model (prd/pitch.js, picked up automatically): references, lanes, screenshots.
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, extname, relative, sep } from 'node:path';
import { libModule, loadExport, readJson, parseArgs, report } from './load.mjs';

const args = parseArgs();
const modelFile = args._[0] ?? (existsSync('prd/prd.js') ? 'prd/prd.js' : existsSync('prd/prd.ts') ? 'prd/prd.ts' : null);
if (!modelFile) { console.error('usage: validate-prd.mjs <prd.js|prd.ts|prd.json> [--write-lock] …'); process.exit(2); }
const dir = dirname(resolve(modelFile));
const pick = (flag, def) => (args[flag] === undefined ? (existsSync(join(dir, def)) ? join(dir, def) : null) : args[flag]);

const core = await libModule('prd-core.js');
const prd = await loadExport(modelFile, ['PRD', 'prd']);
const lockFile = args.lock ?? join(dir, 'prd.lock.json');
const testsFile = pick('tests', 'test-results.json');
const releasesFile = pick('releases', 'releases.js');
const inventoryFile = pick('inventory', 'inventory.json');
const tests = testsFile ? readJson(testsFile) : null;
const problems = [];

// 1. Структура модели
problems.push(...core.validatePrd(prd, { tests }));
const index = core.indexPrd(prd);
const statusOf = core.statusMap(index, tests);

// 2. Замок номеров
const prevLock = readJson(lockFile);
const { lock, problems: lockProblems, changes } = core.updateLock(index, prevLock);
problems.push(...lockProblems);
const newIds = changes.filter((c) => c.change === 'new');
const reworded = changes.filter((c) => c.change === 'reworded');
if (!prevLock) {
  problems.push({ level: args['write-lock'] ? 'info' : 'warn', id: 'prd.lock.json', msg: args['write-lock'] ? `создан, записано ${Object.keys(lock.items).length} id` : 'замка нет — запустите с --write-lock и закоммитьте prd.lock.json' });
} else if (changes.length && !args['write-lock']) {
  problems.push({ level: args.strict ? 'error' : 'warn', id: 'prd.lock.json', msg: `не актуален: новых id ${newIds.length}, изменённых формулировок ${reworded.length}. Запустите с --write-lock` });
}
for (const c of reworded) problems.push({ level: 'info', id: c.id, msg: `формулировка изменена (ред. ${c.rev}) — оценки к прежней станут «устарело»` });
if (args['write-lock'] && !lockProblems.some((p) => p.level === 'error')) {
  writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`Замок записан: ${relative(process.cwd(), lockFile)} (${changes.length} изменений)`);
}

// 3. Релизы
if (releasesFile) {
  try {
    const { validateReleases } = await libModule('changelog.js');
    const releases = await loadExport(releasesFile, ['RELEASES', 'releases']);
    const pkgFile = args.package ?? (existsSync('package.json') ? 'package.json' : null);
    const packageVersion = pkgFile ? readJson(pkgFile)?.version ?? null : null;
    problems.push(...validateReleases(releases, { index, packageVersion }));
  } catch (e) { problems.push({ level: 'error', id: 'releases', msg: e.message }); }
}

// 4. Покрытие описи: каждый экран и метод API — в критерии или в исключениях
if (inventoryFile) {
  const inv = readJson(inventoryFile, {});
  const norm = (p) => String(p ?? '').split('?')[0].replace(/\/:[^/]+/g, '/:p').replace(/\/\*[^/]*/g, '/:p').replace(/\/+$/, '') || '/';
  const exclusions = prd.exclusions ?? [];
  const excluded = (kind, value, file) => exclusions.some((x) => (x[kind] && norm(x[kind]) === norm(value)) || (x.file && file && file.startsWith(x.file)));
  // Ссылка «файл:строка» покрывает только то, что рядом с этой строкой; ссылка на файл
  // без строки — весь файл. Иначе одна ссылка на роутер «покрывала» бы все его методы.
  const NEAR = 40;
  const routes = new Set(), apis = new Set(), files = new Map();
  const addFile = (ref) => {
    const [f, line] = String(ref).split(':');
    const list = files.get(f) ?? [];
    list.push(line ? Number(line) : null);
    files.set(f, list);
  };
  const covers = (file, line) => (files.get(file) ?? []).some((l) => l === null || !line || Math.abs(l - line) <= NEAR);
  for (const m of index.modules.values()) if (m.route) routes.add(norm(m.route));
  for (const s of index.stories.values()) {
    if (s.route) routes.add(norm(s.route));
    for (const ac of s.criteria ?? []) {
      if (ac.links?.route) routes.add(norm(ac.links.route));
      for (const a of [].concat(ac.links?.api ?? [])) apis.add(a.replace(/^(\w+)\s+/, (m0, m1) => `${m1.toUpperCase()} `).replace(/\s+(\S+)$/, (m0, p) => ` ${norm(p)}`));
      for (const c of ac.code ?? []) addFile(c);
    }
  }
  const uncoveredRoutes = (inv.routes ?? []).filter((r) => !routes.has(norm(r.path)) && !covers(r.file, r.line) && !excluded('path', r.path, r.file));
  const uncoveredApi = (inv.api ?? []).filter((a) => !apis.has(`${a.method} ${norm(a.path)}`) && !covers(a.file, a.line) && !excluded('api', `${a.method} ${a.path}`, a.file) && !excluded('path', a.path, a.file));
  const level = args.strict ? 'error' : 'warn';
  for (const r of uncoveredRoutes) problems.push({ level, id: `экран ${r.path}`, msg: `не покрыт ни одним критерием (${r.file}). Добавьте links.route / code или exclusions с причиной` });
  for (const a of uncoveredApi.slice(0, 200)) problems.push({ level, id: `API ${a.method} ${a.path}`, msg: `не покрыт (${a.file}:${a.line})` });
  if (uncoveredApi.length > 200) problems.push({ level, id: 'API', msg: `и ещё ${uncoveredApi.length - 200} методов без покрытия` });
  const totalItems = (inv.routes?.length ?? 0) + (inv.api?.length ?? 0);
  if (totalItems) console.log(`Покрытие описи: экраны ${(inv.routes.length - uncoveredRoutes.length)}/${inv.routes.length}, API ${(inv.api.length - uncoveredApi.length)}/${inv.api.length}`);
}

// 5. Метки data-ac в коде интерфейса
if (args.src) {
  const roots = String(args.src).split(',').map((s) => s.trim()).filter(Boolean);
  const anchors = new Map();
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (['node_modules', '.git', '.next', 'dist', 'build', 'prd'].includes(name)) continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(jsx?|tsx?|vue|svelte|html|mjs)$/.test(name)) {
        const text = readFileSync(p, 'utf8');
        for (const m of text.matchAll(/data-ac\s*=\s*\{?\s*["'`]([^"'`]+)["'`]/g)) {
          for (const key of m[1].split(/\s+/).filter(Boolean)) {
            if (key.includes('${')) continue;
            const list = anchors.get(key) ?? [];
            list.push(`${relative(process.cwd(), p).split(sep).join('/')}:${text.slice(0, m.index).split('\n').length}`);
            anchors.set(key, list);
          }
        }
      }
    }
  };
  for (const r of roots) if (existsSync(r)) walk(r);
  for (const [key, where] of anchors) if (!index.criteria.has(key)) problems.push({ level: 'error', id: key, msg: `data-ac указывает на несуществующий критерий (${where[0]})` });
  const active = [...index.criteria.values()].filter((c) => !c.retired);
  const anchored = active.filter((c) => anchors.has(c.key)).length;
  console.log(`Метки data-ac: ${anchored}/${active.length} критериев размечены в интерфейсе`);
}

// 6. Связи со схемами процессов и турами (guided-process-docs)
const refsIn = (obj) => [].concat(obj?.ac ?? []).filter(Boolean);
if (args.processes) {
  const [file, name] = String(args.processes).split(':');
  try {
    const processes = await loadExport(file, [name, 'PROCESSES', 'processes'].filter(Boolean));
    const ids = new Set(processes.map((p) => p.id));
    for (const p of processes) {
      for (const n of [...(p.nodes ?? []), ...(p.walkthrough ?? [])]) for (const k of refsIn(n)) if (!index.criteria.has(k)) problems.push({ level: 'error', id: `процесс ${p.id}`, msg: `шаг ссылается на несуществующий ${k}` });
      if (p.epic && !index.epics.has(p.epic)) problems.push({ level: 'error', id: `процесс ${p.id}`, msg: `epic «${p.epic}» нет в PRD` });
    }
    for (const e of index.epics.values()) if (e.process && !ids.has(e.process)) problems.push({ level: 'error', id: e.id, msg: `process «${e.process}» не найден в схемах` });
  } catch (e) { problems.push({ level: 'error', id: 'processes', msg: e.message }); }
}
if (args.tours) {
  const [file, name] = String(args.tours).split(':');
  try {
    const tours = await loadExport(file, [name, 'TOURS', 'tours', 'SCENARIOS'].filter(Boolean));
    let referenced = new Set();
    for (const t of tours) for (const s of t.steps ?? []) for (const k of refsIn(s)) {
      if (!index.criteria.has(k)) problems.push({ level: 'error', id: `тур ${t.id}`, msg: `шаг «${s.title}» ссылается на несуществующий ${k}` });
      else {
        referenced.add(k);
        // Тур, который показывает нереализованное, ведёт пользователя к кнопке, которой нет.
        if (!core.STATUS[statusOf.get(k)].implemented && statusOf.get(k) !== 'unverified') {
          problems.push({ level: 'warn', id: `тур ${t.id}`, msg: `шаг «${s.title}» показывает ${k}, а он ${core.STATUS[statusOf.get(k)].label.toLowerCase()}` });
        }
      }
    }
    console.log(`Туры объясняют ${referenced.size} критериев`);
  } catch (e) { problems.push({ level: 'error', id: 'tours', msg: e.message }); }
}

const pitchFile = pick('pitch', 'pitch.js');
if (pitchFile) {
  try {
    const { validatePitch } = await libModule('pitch-deck.js');
    const { loadScreens } = await libModule('deck.js');
    const pitch = await loadExport(pitchFile, ['PITCH', 'pitch']);
    problems.push(...validatePitch(pitch, { screens: loadScreens(args['pitch-screens'] ?? join(dir, 'screens', 'pitch')) }));
    console.log(`Питч: компонентов ${pitch.components?.length ?? 0}`);
  } catch (e) { problems.push({ level: 'error', id: 'pitch', msg: e.message }); }
}

const sum = core.summarize([...index.criteria.values()].filter((c) => !c.retired).map((c) => c.key), statusOf);
console.log(`PRD: ${index.stories.size} историй, ${sum.total} критериев, реализовано ${sum.implemented} (${sum.percent} %) · ${core.STATUS_ORDER.map((s) => `${core.STATUS[s].mark} ${sum.byStatus[s]}`).join('  ')}`);
const errors = report(problems, { title: 'validate-prd' });
process.exit(errors ? 1 : 0);
