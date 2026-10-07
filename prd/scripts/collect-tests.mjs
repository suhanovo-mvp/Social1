#!/usr/bin/env node
// Collect test results into prd/test-results.json, keyed by acceptance criterion.
//
//   node prd/scripts/collect-tests.mjs [report files…] [--run "<test command>"]… [--out prd/test-results.json] [--prd prd/prd.js]
//
// A test is linked to a criterion by a tag in its name (or in a describe/suite name):
//   it('suggests after two characters [US-LIB-001/AC4]', …)
// Several tags per test are fine. Reports understood: JUnit XML (Vitest, Jest with
// jest-junit, Playwright, node:test --test-reporter=junit, pytest --junitxml, most CI
// tools), Jest/Vitest JSON (--json / --reporter=json), Playwright JSON, TAP.
// With no files given, every prd/.reports/*.{xml,json,tap} is read.
//
// --run executes the test command first and collects even when it exits non-zero:
// failing tests are exactly what the 🔴 marker is for.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, extname, relative } from 'node:path';
import { execSync } from 'node:child_process';
import { parseArgs, loadExport, libModule } from './load.mjs';

const args = parseArgs();
const out = args.out ?? 'prd/test-results.json';
const TAG = /\[(US-[A-Z0-9]+-\d{3,}\/AC\d+)\]/g;

// Папку отчётов создаём заранее: node --test и часть репортёров не создают её сами.
// Перед новым прогоном старые отчёты удаляем — иначе результаты прошлых запусков
// смешались бы с новыми, и исправленный тест остался бы «падающим».
if (args.run) {
  mkdirSync('prd/.reports', { recursive: true });
  for (const f of readdirSync('prd/.reports')) if (/\.(xml|json|tap)$/.test(f)) rmSync(join('prd/.reports', f));
}
for (const cmd of [].concat(args.run ?? [])) {
  console.log(`$ ${cmd}`);
  try { execSync(cmd, { stdio: 'inherit', shell: true }); } catch { console.log('(команда завершилась с ошибкой — собираем результаты всё равно)'); }
}

let files = args._;
if (!files.length) {
  const d = 'prd/.reports';
  files = existsSync(d) ? readdirSync(d).filter((f) => /\.(xml|json|tap)$/.test(f)).map((f) => join(d, f)) : [];
}
if (!files.length) {
  console.error('Нет отчётов тестов. Укажите файлы или --run "<команда, пишущая отчёт в prd/.reports/>". См. references/test-linkage.md');
  process.exit(2);
}

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`)); return m ? decode(m[1]) : ''; };

function fromJunit(text, file) {
  // Идём по тегам по порядку и помним вложенные <testsuite>: node:test и Vitest пишут
  // describe как testsuite, а не в имя теста, и метка на describe иначе теряется.
  const cases = [];
  const suites = [];
  const rx = /<testsuite\b([^>]*?)(\/?)>|<\/testsuite>|<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const m of text.matchAll(rx)) {
    if (m[0].startsWith('</testsuite')) { suites.pop(); continue; }
    if (m[0].startsWith('<testsuite')) { if (!m[2]) suites.push(attr(m[1], 'name')); continue; }
    const head = m[3];
    const body = m[5] ?? '';
    const status = /<(failure|error)\b/.test(body) ? 'failed' : /<skipped\b/.test(body) ? 'skipped' : 'passed';
    // classname="test" у node:test — служебное слово, а не имя набора.
    const cls = attr(head, 'classname');
    const trail = [...suites, ...(cls && cls !== 'test' && !suites.includes(cls) ? [cls] : [])];
    cases.push({ name: [...trail, attr(head, 'name')].filter(Boolean).join(' › '), file: attr(head, 'file') || file, status });
  }
  return cases;
}

function fromJestJson(data, file) {
  const cases = [];
  for (const suite of data.testResults ?? []) {
    for (const t of suite.assertionResults ?? suite.testResults ?? []) {
      const status = t.status === 'passed' ? 'passed' : t.status === 'failed' ? 'failed' : 'skipped';
      cases.push({ name: t.fullName ?? [...(t.ancestorTitles ?? []), t.title].join(' '), file: relative(process.cwd(), suite.name ?? suite.testFilePath ?? file), status });
    }
  }
  return cases;
}

function fromPlaywright(data) {
  const cases = [];
  const walk = (suite, trail) => {
    const titles = suite.title ? [...trail, suite.title] : trail;
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const last = t.results?.at(-1)?.status;
        const status = t.status === 'skipped' || last === 'skipped' ? 'skipped' : (t.status === 'expected' || t.status === 'flaky' || last === 'passed') ? 'passed' : 'failed';
        cases.push({ name: [...titles, spec.title].join(' '), file: spec.file ?? suite.file ?? '', status });
      }
    }
    for (const s of suite.suites ?? []) walk(s, titles);
  };
  for (const s of data.suites ?? []) walk(s, []);
  return cases;
}

function fromTap(text, file) {
  const cases = [];
  for (const m of text.matchAll(/^\s*(not ok|ok)\s+\d+\s*(?:-\s*)?(.*?)(\s+#\s*(SKIP|TODO)\b.*)?$/gim)) {
    cases.push({ name: m[2], file, status: m[4] ? 'skipped' : m[1].toLowerCase() === 'ok' ? 'passed' : 'failed' });
  }
  return cases;
}

const all = [];
const sources = new Set();
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  const ext = extname(f);
  if (ext === '.xml' || /^\s*<\?xml|<testsuites?\b/.test(text)) { all.push(...fromJunit(text, f)); sources.add('junit'); continue; }
  if (ext === '.tap' || /^TAP version/m.test(text)) { all.push(...fromTap(text, f)); sources.add('tap'); continue; }
  try {
    const data = JSON.parse(text);
    if (data.testResults) { all.push(...fromJestJson(data, f)); sources.add('jest-json'); }
    else if (data.suites && data.config) { all.push(...fromPlaywright(data)); sources.add('playwright-json'); }
    else console.warn(`${f}: непонятный формат JSON — пропущен`);
  } catch { console.warn(`${f}: не XML, не TAP и не JSON — пропущен`); }
}

const results = {};
let tagged = 0;
for (const c of all) {
  const keys = [...new Set([...c.name.matchAll(TAG)].map((m) => m[1]))];
  if (!keys.length) continue;
  tagged += 1;
  for (const key of keys) {
    const r = results[key] ?? (results[key] = { passed: 0, failed: 0, skipped: 0, tests: [] });
    r[c.status] += 1;
    if (r.tests.length < 20) r.tests.push({ name: c.name.replace(TAG, '').replace(/\s+/g, ' ').replace(/\s›\s*$/, '').trim(), status: c.status, file: c.file });
  }
}

const unknown = [];
const modelFile = args.prd ?? ['prd/prd.js', 'prd/prd.mjs', 'prd/prd.json'].find(existsSync);
if (modelFile) {
  try {
    const core = await libModule('prd-core.js');
    const index = core.indexPrd(await loadExport(modelFile, ['PRD', 'prd']));
    for (const key of Object.keys(results)) if (!index.criteria.has(key)) unknown.push(key);
  } catch (e) { console.warn(`Модель не загружена (${e.message}) — проверка меток пропущена`); }
}

const payload = { generatedAt: new Date().toISOString(), source: [...sources], totals: { tests: all.length, tagged }, results, unknown };
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(payload, null, 1)}\n`);
const failed = Object.entries(results).filter(([, r]) => r.failed).map(([k]) => k);
console.log(`Тестов ${all.length}, с метками ${tagged}, критериев с тестами ${Object.keys(results).length}${failed.length ? `, падают: ${failed.join(', ')}` : ''} → ${out}`);
if (unknown.length) console.warn(`Метки без критерия в PRD: ${unknown.join(', ')}`);
