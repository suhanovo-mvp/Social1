#!/usr/bin/env node
// Project inventory for reverse-engineering a PRD. No dependencies.
//
//   node scripts/inventory.mjs [root] [--out prd/inventory.json] [--md prd/inventory.md]
//        [--only /ideas,/api/ideas,/catalog]   — PRD only for part of the product
//
// Finds, by static heuristics across common stacks (Next.js app/pages router, React
// Router, Vue Router, regex route tables, Express/Koa/Fastify/Hono, key-table
// routers like 'POST /api/x', Django/Flask/FastAPI): UI routes, API endpoints,
// server actions, data models, enums and roles, form fields with validation rules,
// navigation labels, test names, unfinished-work markers and documents that may
// already be a PRD.
//
// It is a starting point, not the PRD: the inventory makes sure nothing is
// forgotten (validate-prd.mjs --inventory reports what no criterion covers), while
// the stories and criteria are written by reading the code each entry points at.
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, relative, extname, dirname, basename, sep } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, def = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const root = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--'))) ?? '.';
const outFile = flag('--out', join(root, 'prd/inventory.json'));
const mdFile = flag('--md', join(root, 'prd/inventory.md'));
// Частичный PRD (один модуль): опись и проверка покрытия только по этим префиксам путей.
const only = (flag('--only') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const inScope = (path) => !only.length || only.some((p) => path === p || path.startsWith(p.endsWith('/') ? p : `${p}/`) || path.startsWith(`${p}?`));

const SKIP = new Set(['node_modules', '.git', '.next', '.nuxt', 'dist', 'build', 'out', 'coverage', '.turbo', '.vercel', 'vendor',
  '__pycache__', '.venv', 'venv', 'generated', '.cache', '.svelte-kit', 'storybook-static', 'tmp', '.idea', '.vscode', 'prd']);
const CODE = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte', '.py', '.html', '.prisma', '.sql']);
const DOCS = new Set(['.md', '.txt', '.pdf', '.docx', '.rtf', '.odt']);

const files = [], docs = [];
(function walk(dir) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.github') { if (e.isDirectory()) continue; }
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p); continue; }
    const ext = extname(e.name).toLowerCase();
    let size = 0;
    try { size = statSync(p).size; } catch { continue; }
    if (CODE.has(ext) && size < 1_500_000 && !/\.min\.js$|\.d\.ts$|\.map$/.test(e.name)) files.push(p);
    else if (DOCS.has(ext)) docs.push({ file: p, size });
  }
})(root);

const rel = (p) => relative(root, p).split(sep).join('/');
const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;
const isTest = (f) => /(^|\/)(tests?|__tests__|e2e|spec)(\/|$)|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$/.test(rel(f));

const inv = {
  root: rel(root) || '.', generatedAt: new Date().toISOString(), framework: [], only,
  routes: [], api: [], actions: [], models: [], enums: [], roles: [], forms: [], validation: [],
  nav: [], headings: [], tests: [], gaps: [], docs: [], anchors: { dataAc: 0, dataTour: 0, dataTestid: 0 },
};

// ── Frameworks ──────────────────────────────────────────────
const pkgPath = join(root, 'package.json');
if (existsSync(pkgPath)) {
  try {
    const pkg = JSON.parse(read(pkgPath));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [dep, name] of [['next', 'Next.js'], ['react-router-dom', 'React Router'], ['react-router', 'React Router'], ['vue', 'Vue'], ['vue-router', 'Vue Router'],
      ['svelte', 'Svelte'], ['@sveltejs/kit', 'SvelteKit'], ['express', 'Express'], ['fastify', 'Fastify'], ['koa', 'Koa'], ['hono', 'Hono'], ['@nestjs/core', 'NestJS'],
      ['vite', 'Vite'], ['prisma', 'Prisma'], ['@prisma/client', 'Prisma'], ['drizzle-orm', 'Drizzle'], ['mongoose', 'Mongoose'], ['vitest', 'Vitest'], ['jest', 'Jest'],
      ['@playwright/test', 'Playwright'], ['cypress', 'Cypress']]) if (deps?.[dep] && !inv.framework.includes(name)) inv.framework.push(name);
    inv.package = { name: pkg.name, version: pkg.version, scripts: pkg.scripts ?? {} };
  } catch { /* битый package.json — не повод останавливаться */ }
}
for (const f of ['requirements.txt', 'pyproject.toml']) {
  const t = read(join(root, f));
  for (const [rx, name] of [[/django/i, 'Django'], [/flask/i, 'Flask'], [/fastapi/i, 'FastAPI'], [/pytest/i, 'pytest']]) if (rx.test(t) && !inv.framework.includes(name)) inv.framework.push(name);
}

// ── Helpers ─────────────────────────────────────────────────
function nextRoute(file, kind) {
  const r = rel(file);
  const m = r.match(/(?:^|\/)(?:src\/)?(app|pages)\/(.*)$/);
  if (!m) return null;
  let p = m[2].replace(/\/?(page|route|index)\.(t|j)sx?$/, '').replace(/\.(t|j)sx?$/, '');
  if (kind === 'pages' && (/^_(app|document|error)/.test(p) || p.startsWith('api/'))) return null;
  p = p.split('/').filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith('@')).map((s) => s.replace(/^\[\[?\.\.\.(.+?)\]?\]$/, '*$1').replace(/^\[(.+)\]$/, ':$1')).join('/');
  return `/${p}`.replace(/\/+$/, '') || '/';
}
const unescapeRegexPath = (src) => src.replace(/^\^/, '').replace(/\$$/, '').replace(/\\\//g, '/').replace(/\(\?:[^)]*\)\??/g, '')
  .replace(/\([^)]*\)/g, ':param').replace(/\\d\+|\\w\+|\[\^\/\]\+/g, ':param').replace(/\\(.)/g, '$1');

const ROUTE_PATTERNS = [
  // React Router JSX и объектные таблицы маршрутов
  { rx: /<Route\b[^>]*\bpath=["'`]([^"'`]+)["'`]/g, kind: 'react-router' },
  { rx: /\bpath\s*:\s*["'`](\/[^"'`]*)["'`]\s*,[^}]{0,200}?\b(element|component|Component|lazy|loader|view|page)\b/g, kind: 'route-object' },
  // Таблицы вида [/^\/ideas\/(\d+)$/, 'Идея', handler]
  { rx: /\[\s*\/(\^\\\/[^/\n]*?)\/[gimsuy]*\s*,\s*['"`]([^'"`]{1,80})['"`]/g, kind: 'regex-table', title: 2 },
];
const API_PATTERNS = [
  { rx: /\b(?:app|router|server|api|route|routes|r|fastify|hono)\.(get|post|put|patch|delete|all)\(\s*["'`](\/[^"'`]*)["'`]/g, method: 1, path: 2 },
  { rx: /["'`](GET|POST|PUT|PATCH|DELETE)\s+(\/[^"'`\s]*)["'`]\s*:/g, method: 1, path: 2 },
  { rx: /@(?:app|router|bp|api)\.(get|post|put|patch|delete|route)\(\s*["'](\/[^"']*)["']/g, method: 1, path: 2 },
  { rx: /\bpath\(\s*["']([^"']*)["']\s*,\s*([\w.]+)/g, method: null, path: 1, py: true },
];

const isNext = inv.framework.includes('Next.js');
const NOT_ROLES = new Set(['all', 'never', 'any', 'none', 'true', 'false', 'null', 'undefined', 'read', 'write']);
const seenRoute = new Set(), seenApi = new Set();
const addRoute = (r) => { const k = `${r.path}`; if (seenRoute.has(k) || !inScope(r.path)) return; seenRoute.add(k); inv.routes.push(r); };
const addApi = (a) => { const k = `${a.method} ${a.path}`; if (seenApi.has(k) || !inScope(a.path)) return; seenApi.add(k); inv.api.push(a); };

for (const file of files) {
  const r = rel(file);
  const text = read(file);
  const ext = extname(file);
  if (isTest(file)) {
    for (const m of text.matchAll(/\b(?:it|test|describe|suite)(?:\.(?:only|skip|todo|each\([^)]*\)))?\(\s*(["'`])((?:(?!\1).){2,200})\1/g)) inv.tests.push({ name: m[2], file: r, line: lineOf(text, m.index) });
    for (const m of text.matchAll(/^\s*(?:async\s+)?def\s+(test_\w+)/gm)) inv.tests.push({ name: m[1], file: r, line: lineOf(text, m.index) });
    continue;
  }

  // Next.js file routes
  if (/(^|\/)(src\/)?app\/.*\/?page\.(t|j)sx?$/.test(r)) addRoute({ path: nextRoute(file, 'app'), file: r, line: 1, kind: 'next-app' });
  if (/(^|\/)(src\/)?app\/.*\/?route\.(t|j)s$/.test(r)) {
    const path = nextRoute(file, 'app');
    const methods = [...text.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b|\bas\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1] ?? m[2]);
    for (const method of new Set(methods.length ? methods : ['GET'])) addApi({ method, path, file: r, line: 1, kind: 'next-route' });
  }
  if (isNext && /(^|\/)(src\/)?pages\/.+\.(t|j)sx?$/.test(r) && !/(^|\/)pages\/api\//.test(r)) { const p = nextRoute(file, 'pages'); if (p) addRoute({ path: p, file: r, line: 1, kind: 'next-pages' }); }
  if (isNext && /(^|\/)(src\/)?pages\/api\/.+\.(t|j)s$/.test(r)) addApi({ method: '*', path: `/api/${r.split('/pages/api/')[1].replace(/\.(t|j)s$/, '').replace(/\/index$/, '').replace(/\[(.+?)\]/g, ':$1')}`, file: r, line: 1, kind: 'next-pages-api' });
  if (/^\s*["']use server["']/m.test(text)) {
    for (const m of text.matchAll(/export\s+async\s+function\s+(\w+)/g)) inv.actions.push({ name: m[1], file: r, line: lineOf(text, m.index) });
  }
  // Отдельные HTML-страницы считаем экранами, только если это не слайды, отчёты и шаблоны.
  if (ext === '.html' && !/(^|\/)(presentation[^/]*|docs?|reports?|templates?|fixtures?|coverage|e2e)\//i.test(r) && !/\.dc\.html$/.test(r)) {
    const t = text.match(/<title>([^<]{1,120})<\/title>/i);
    addRoute({ path: `/${r.replace(/(^|\/)index\.html$/, '').replace(/\.html$/, '')}`, file: r, line: 1, kind: 'html', title: t?.[1] ?? null });
  }

  for (const p of ROUTE_PATTERNS) {
    for (const m of text.matchAll(p.rx)) {
      const path = p.kind === 'regex-table' ? `/${unescapeRegexPath(m[1]).replace(/^\/+/, '')}` : m[1];
      if (!path.startsWith('/') || path.startsWith('/api/')) continue;
      addRoute({ path, file: r, line: lineOf(text, m.index), kind: p.kind, title: p.title ? m[p.title] : null });
    }
  }
  for (const p of API_PATTERNS) {
    for (const m of text.matchAll(p.rx)) {
      const method = p.method ? m[p.method].toUpperCase() : '*';
      let path = m[p.path];
      if (p.py) path = `/${path}`;
      if (method === 'ROUTE') { addApi({ method: '*', path, file: r, line: lineOf(text, m.index), kind: 'py-route' }); continue; }
      // Пути без /api, найденные в серверных роутерах, — тоже API, а в SPA это экраны.
      const looksUi = !/\/api\//.test(path) && /(^|\/)(web|src\/(pages|views|routes|app))\//.test(r) && !/server|api/i.test(r);
      if (looksUi) continue;
      addApi({ method, path, file: r, line: lineOf(text, m.index), kind: 'handler' });
    }
  }

  // Модели данных
  if (ext === '.prisma') {
    for (const m of text.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
      const fields = m[2].split('\n').map((l) => l.trim()).filter((l) => /^\w+\s+\w/.test(l) && !l.startsWith('@@')).map((l) => l.split(/\s+/).slice(0, 2).join(' '));
      inv.models.push({ name: m[1], fields, file: r, line: lineOf(text, m.index), kind: 'prisma' });
    }
    for (const m of text.matchAll(/^enum\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
      // Комментарий у значения — готовое описание роли: «ADMIN // руководитель: все данные».
      const values = m[2].split('\n').map((l) => l.trim()).filter((l) => /^\w+\b/.test(l) && !l.startsWith('@@'))
        .map((l) => ({ value: l.split(/[\s/]/)[0], note: (l.match(/\/\/\s*(.+)$/) ?? [])[1] ?? null }));
      inv.enums.push({ name: m[1], values: values.map((v) => (v.note ? `${v.value} — ${v.note}` : v.value)), file: r });
      if (/role|permission|access/i.test(m[1])) inv.roles.push(...values.map((v) => ({ role: v.value, note: v.note, file: r })));
    }
  }
  for (const m of text.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?\s*\(([\s\S]*?)\)\s*;?\s*(?:["'`]|$)/gi)) {
    const cols = m[2].split(/,\s*\n|,(?![^(]*\))/).map((c) => c.trim().split(/\s+/)[0]).filter((c) => c && !/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)$/i.test(c)).slice(0, 30);
    if (!inv.models.some((x) => x.name === m[1])) inv.models.push({ name: m[1], fields: cols, file: r, line: lineOf(text, m.index), kind: 'sql' });
  }
  for (const m of text.matchAll(/class\s+(\w+)\((?:models\.Model|Base|db\.Model)\)/g)) inv.models.push({ name: m[1], fields: [], file: r, line: lineOf(text, m.index), kind: 'python' });
  for (const m of text.matchAll(/new\s+(?:mongoose\.)?Schema\(\s*\{([\s\S]{0,1500}?)\}\s*[,)]/g)) inv.models.push({ name: basename(file, ext), fields: [...m[1].matchAll(/^\s*(\w+)\s*:/gm)].map((x) => x[1]).slice(0, 30), file: r, line: lineOf(text, m.index), kind: 'mongoose' });

  // Роли
  for (const m of text.matchAll(/\brole\s*(?:===|==|!==)\s*["'`]([\w-]{2,40})["'`]|\b(?:hasRole|requireRole|can|roles?)\(\s*\[?\s*["'`]([\w-]{2,40})["'`]/g)) {
    const role = m[1] ?? m[2];
    if (NOT_ROLES.has(role.toLowerCase())) continue;
    if (!inv.roles.some((x) => x.role === role)) inv.roles.push({ role, file: r, line: lineOf(text, m.index) });
  }

  // Формы и правила проверки
  const fields = [...text.matchAll(/<(?:input|select|textarea)\b[^>]*\bname=["'{`]+([\w.[\]-]+)["'}`]+[^>]*>/g)].map((m) => {
    const tag = m[0];
    const rules = [];
    for (const [rx, label] of [[/\brequired\b/, 'обязательное'], [/\btype=["']email["']/, 'email'], [/\btype=["']tel["']/, 'телефон'], [/\btype=["']number["']/, 'число'],
      [/\bminLength=\{?["']?(\d+)/, 'мин. длина $1'], [/\bmaxLength=\{?["']?(\d+)/, 'макс. длина $1'], [/\bmin=\{?["']?(\d+)/, 'мин. $1'], [/\bmax=\{?["']?(\d+)/, 'макс. $1'], [/\bpattern=/, 'шаблон'], [/\baccept=["']([^"']+)/, 'файлы $1']]) {
      const mm = tag.match(rx);
      if (mm) rules.push(label.replace('$1', mm[1] ?? ''));
    }
    return { name: m[1], rules, line: lineOf(text, m.index) };
  });
  if (fields.length) inv.forms.push({ file: r, fields: fields.slice(0, 40) });
  for (const m of text.matchAll(/(\w+)\s*:\s*z\.(string|number|boolean|enum|array|date|coerce\.\w+|email)\(([^)]*)\)((?:\.\w+\([^()]*(?:\([^()]*\)[^()]*)*\))*)/g)) {
    const chain = m[4].match(/\.(\w+)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g) ?? [];
    const rules = chain.map((c) => c.replace(/^\./, '').replace(/\s+/g, ' ').slice(0, 80)).filter((c) => !/^(describe|openapi)\b/.test(c));
    inv.validation.push({ field: m[1], type: m[2], rules, file: r, line: lineOf(text, m.index) });
  }

  // Навигация и заголовки
  if (/nav|menu|sidebar|header|layout|shell|app\.(j|t)sx?$/i.test(r)) {
    for (const m of text.matchAll(/(?:href|to)=\{?["'`](\/[^"'`{}]*)["'`]\}?[^>]*>\s*([^<{]{2,60})</g)) inv.nav.push({ href: m[1], text: m[2].trim(), file: r });
    for (const m of text.matchAll(/\{\s*(?:href|to|path)\s*:\s*["'`](\/[^"'`]*)["'`]\s*,\s*(?:label|title|name|text)\s*:\s*["'`]([^"'`]{2,60})["'`]/g)) inv.nav.push({ href: m[1], text: m[2], file: r });
  }
  for (const m of text.matchAll(/<h([12])\b[^>]*>\s*([^<{]{3,100}?)\s*</g)) if (inv.headings.length < 400) inv.headings.push({ level: Number(m[1]), text: m[2].trim(), file: r });

  // Признаки недоделок
  for (const m of text.matchAll(/(?:\/\/|#|\/\*|<!--)\s*(TODO|FIXME|XXX|HACK)\b[:\s]*(.{0,120})/g)) inv.gaps.push({ kind: m[1], text: m[2].trim(), file: r, line: lineOf(text, m.index) });
  for (const m of text.matchAll(/(coming soon|not implemented|скоро появится|в разработке|заглушка|временно недоступно|stub)/gi)) inv.gaps.push({ kind: 'stub', text: m[1], file: r, line: lineOf(text, m.index) });

  inv.anchors.dataAc += (text.match(/data-ac=/g) ?? []).length;
  inv.anchors.dataTour += (text.match(/data-tour=/g) ?? []).length;
  inv.anchors.dataTestid += (text.match(/data-testid=/g) ?? []).length;
}

// Документы, которые могут оказаться PRD / ТЗ
for (const d of docs) {
  const r = rel(d.file);
  if (/node_modules|CHANGELOG|LICENSE/i.test(r)) continue;
  const name = r.toLowerCase();
  let score = /prd|тз|техническ|требован|requirement|spec|user.?stor|истори|критери|backlog|brief|концепц/.test(name) ? 2 : 0;
  if (/\.(md|txt)$/.test(name) && d.size < 2_000_000) {
    const t = read(d.file);
    if (/как\s+[^,.\n]{2,60},\s*я\s+хочу|as an?\s+\w+[^.\n]{0,60}i want|критери[ий]\s+приёмки|критери[ий]\s+приемки|acceptance criteria|user stor/i.test(t)) score += 3;
    if (/must have|should have|moscow/i.test(t)) score += 1;
  }
  if (score || /readme/i.test(name)) inv.docs.push({ file: r, size: d.size, score });
}
inv.docs.sort((a, b) => b.score - a.score);

// ── Кандидаты в модули: первый значимый сегмент пути ────────
const seg = (p) => p.split('/').filter(Boolean).filter((s) => !/^(api|app|v\d+|:)/.test(s) && !s.startsWith(':'))[0] ?? 'home';
const groups = new Map();
for (const r of inv.routes) { const g = groups.get(seg(r.path)) ?? { id: seg(r.path), routes: [], api: [], titles: new Set() }; g.routes.push(r.path); if (r.title) g.titles.add(r.title); groups.set(g.id, g); }
for (const a of inv.api) { const g = groups.get(seg(a.path)) ?? { id: seg(a.path), routes: [], api: [], titles: new Set() }; g.api.push(`${a.method} ${a.path}`); groups.set(g.id, g); }
for (const n of inv.nav) { const g = groups.get(seg(n.href)); if (g) g.titles.add(n.text); }
inv.modulesSuggested = [...groups.values()].map((g) => ({ id: g.id, titles: [...g.titles].slice(0, 5), routes: g.routes, api: g.api }))
  .sort((a, b) => (b.routes.length + b.api.length) - (a.routes.length + a.api.length));

inv.summary = {
  files: files.length, routes: inv.routes.length, api: inv.api.length, actions: inv.actions.length, models: inv.models.length,
  roles: inv.roles.length, forms: inv.forms.length, validation: inv.validation.length, tests: inv.tests.length, gaps: inv.gaps.length,
  docs: inv.docs.filter((d) => d.score >= 2).length,
};

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(inv, null, 1)}\n`);

const md = [
  `# Опись проекта для восстановления PRD`, '',
  `Сформировано ${inv.generatedAt.slice(0, 10)} · стек: ${inv.framework.join(', ') || 'не определён'}`, '',
  `| Что | Сколько |`, `|---|---|`,
  ...Object.entries(inv.summary).map(([k, v]) => `| ${{ files: 'Файлов кода', routes: 'Экраны (маршруты UI)', api: 'Методы API', actions: 'Server actions', models: 'Модели данных', roles: 'Роли', forms: 'Файлы с формами', validation: 'Правила валидации', tests: 'Тесты', gaps: 'Признаки недоделок', docs: 'Документы-кандидаты в PRD' }[k]} | ${v} |`),
  '', '## Документы, которые стоит прочитать первыми', '',
  ...(inv.docs.filter((d) => d.score >= 2).slice(0, 15).map((d) => `- ${d.file} (${Math.round(d.size / 1024)} КБ, совпадений ${d.score})`)),
  ...(inv.docs.some((d) => d.score >= 2) ? [] : ['- не найдены — PRD восстанавливается по коду']),
  '', '## Кандидаты в модули', '',
  ...inv.modulesSuggested.map((g) => `- **${g.id}**${g.titles.length ? ` — ${g.titles.join(' / ')}` : ''}: ${g.routes.length} экр., ${g.api.length} API`),
  '', '## Экраны', '', ...inv.routes.map((r) => `- \`${r.path}\`${r.title ? ` — ${r.title}` : ''} (${r.file}:${r.line})`),
  '', '## API', '', ...inv.api.map((a) => `- \`${a.method} ${a.path}\` (${a.file}:${a.line})`),
  '', '## Роли', '', ...[...new Set(inv.roles.map((r) => r.role))].map((r) => `- ${r}`),
  '', '## Признаки недоделок', '', ...inv.gaps.slice(0, 60).map((g) => `- ${g.kind}: ${g.text} (${g.file}:${g.line})`),
  '',
].join('\n');
mkdirSync(dirname(mdFile), { recursive: true });
writeFileSync(mdFile, md);

console.log(`Опись: ${rel(outFile) || outFile}`);
console.log(Object.entries(inv.summary).map(([k, v]) => `${k}: ${v}`).join(' · '));
