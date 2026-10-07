#!/usr/bin/env node
// Screenshots for the decks, taken from the running app with headless Chrome.
//
//   node prd/scripts/capture-screens.mjs [--config prd/screens.json] [--base http://127.0.0.1:3000] [file …]
//
// Two typical configs: prd/screens.json for the status deck (shots named by epic,
// module or story id → prd/screens/) and prd/screens-pitch.json for the pitch deck
// (shots named as `file` in prd/pitch.js → prd/screens/pitch/). Extra arguments
// re-take only the listed shots.
//
//   { "out": "prd/screens/pitch", "width": 1440, "height": 900, "colorScheme": "light",
//     "base": "http://127.0.0.1:3000",                    // a running app, or instead:
//     "server": { "args": ["server/index.mjs"], "ready": "/", "dataDirEnv": "DATA_DIR",
//                 "env": { "SERVE_STATIC": "1" } },       // a throwaway instance on a temp data dir
//     "setup": "prd/screens-setup.mjs",                   // export default async ({ base, page }) => { seed, sign in }
//     "shots": [
//       { "file": "c1-main", "path": "/catalog", "wait": "main h1" },
//       { "file": "c2-main", "path": "/plan", "wait": "main h1",
//         "act": [{ "click": "План эксперта" }, { "scroll": "[data-tour=board]" }], "settle": 600 },
//       { "id": "EP-01", "path": "/app/library?q=дуб", "before": "localStorage.setItem('demo','1')", "reload": true }
//     ] }
//
// act steps: { "click": "button text" } · { "scroll": "selector" } · { "type": ["selector", "value"] }
// · { "eval": "js" } · { "wait": "selector" } · { "sleep": ms }. confirm()/alert() are answered
// automatically — a modal dialog would freeze the page and the run.
// Take shots on realistic demo data, never on production data; re-take them when a
// screen changes (a stale screenshot in a pitch is worse than none).
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, libModule } from './load.mjs';

const { launchBrowser, freePort, startServer } = await libModule('browser.js');

const args = parseArgs();
const configFile = args.config ?? 'prd/screens.json';
if (!existsSync(configFile)) { console.error(`Нет ${configFile} — опишите снимки (см. комментарий в начале скрипта)`); process.exit(2); }
const cfg = JSON.parse(readFileSync(configFile, 'utf8'));
const out = cfg.out ?? 'prd/screens';
const only = args._ ?? [];

const q = JSON.stringify;
const step = (a) => {
  if (typeof a === 'string') return a;
  if (a.click) return `(() => { const el = [...document.querySelectorAll('button, a, [role=tab], [role=button]')].find((e) => e.innerText.trim().includes(${q(a.click)})); if (!el) throw new Error('нет кнопки «' + ${q(a.click)} + '»'); el.click() })()`;
  if (a.scroll) return `(() => { const el = document.querySelector(${q(a.scroll)}); if (!el) throw new Error('нет ' + ${q(a.scroll)}); el.scrollIntoView({ block: 'start' }); window.scrollBy(0, -16) })()`;
  if (a.type) return `(() => { const el = document.querySelector(${q(a.type[0])}); const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${q(a.type[1])}); el.dispatchEvent(new Event('input', { bubbles: true })) })()`;
  if (a.eval) return a.eval;
  return null;
};

let app = null, dataDir = null;
let base = String(args.base ?? cfg.base ?? '').replace(/\/$/, '');
if (!base && cfg.server) {
  dataDir = mkdtempSync(join(tmpdir(), 'prd-screens-'));
  const env = { ...(cfg.server.env ?? {}), ...(cfg.server.dataDirEnv ? { [cfg.server.dataDirEnv]: dataDir } : {}) };
  app = await startServer(cfg.server.args, { port: await freePort(), ready: cfg.server.ready ?? '/', env });
  base = app.url;
}
if (!base) { console.error('Укажите адрес приложения (--base) или server в конфиге'); process.exit(2); }

const page = await launchBrowser({ width: cfg.width ?? 1440, height: cfg.height ?? 900 });
if (!page) { console.error('Chrome не найден — укажите путь в CHROME_PATH'); process.exit(2); }
// Снимки в одной теме: иначе тема системы снимающего попадает в презентацию
if (cfg.colorScheme !== 'auto') await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: cfg.colorScheme ?? 'light' }] });
mkdirSync(out, { recursive: true });
let ok = 0, total = 0;
try {
  if (cfg.setup) {
    const setup = (await import(pathToFileURL(resolve(cfg.setup)).href)).default;
    await setup({ base, page });
  }
  for (const shot of cfg.shots ?? []) {
    const name = shot.file ?? shot.id;
    if (only.length && !only.includes(name)) continue;
    total += 1;
    try {
      await page.goto(base + shot.path);
      if (shot.before) { await page.eval(shot.before); if (shot.reload) await page.reload(); }
      if (shot.wait) await page.waitFor(shot.wait, shot.timeout ?? 10000);
      await page.eval('window.confirm = () => true; window.alert = () => {}');
      for (const a of shot.act ?? []) {
        if (a.wait) await page.waitFor(a.wait, shot.timeout ?? 10000);
        else if (a.sleep) await new Promise((r) => setTimeout(r, a.sleep));
        else await page.eval(step(a));
        await new Promise((r) => setTimeout(r, 250));
      }
      if (shot.eval) await page.eval(shot.eval);
      await new Promise((r) => setTimeout(r, shot.settle ?? 400));
      await page.screenshot(`${out}/${name}.jpg`, { fullPage: Boolean(shot.fullPage), quality: shot.quality ?? 86 });
      ok += 1;
      console.log(`✓ ${name}  ${shot.path}`);
    } catch (e) {
      console.error(`✗ ${name}  ${shot.path}: ${e.message}`);
    }
  }
} finally {
  await page.close();
  if (app) await app.stop();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
}
console.log(`Снимков: ${ok} из ${total} → ${out}/`);
process.exit(ok === total ? 0 : 1);
