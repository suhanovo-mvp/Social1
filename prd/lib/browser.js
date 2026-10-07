// Headless Chrome over the DevTools Protocol, no dependencies (Node ≥ 22: global
// WebSocket and fetch). Two jobs in this skill:
//  - browser tests for criteria about screens, when the project has no Playwright —
//    tag them [US-…/ACn] and they turn ⚠️ into ✅ (references/test-linkage.md);
//  - screenshots for the pitch deck (scripts/capture-screens.mjs).
//
//   const page = await launchBrowser({ width: 1440, height: 900 });
//   await page.goto('http://127.0.0.1:4470/app/library');
//   await page.waitFor('[data-ac~="US-LIB-001/AC3"]');
//   await page.type('input[type=search]', 'дуб');
//   assert.equal(await page.count('.product-card'), 5);
//   await page.close();
//
// Chrome is looked up in CHROME_PATH, then the usual macOS / Linux / Windows places.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

export const findChrome = () => CANDIDATES.find((p) => existsSync(p)) ?? null;

export async function launchBrowser({ width = 1440, height = 900, timeoutMs = 20000 } = {}) {
  const bin = findChrome();
  if (!bin) return null;
  const dir = mkdtempSync(join(tmpdir(), 'prd-chrome-'));
  const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run',
    '--no-default-browser-check', '--disable-gpu', `--window-size=${width},${height}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`Chrome не запустился за ${timeoutMs / 1000} с`)), timeoutMs);
    proc.stderr.on('data', (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.on('exit', () => { clearTimeout(timer); reject(new Error('Chrome завершился при запуске')); });
  });
  const port = new URL(wsUrl).port;
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

  let seq = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    } else for (const fn of listeners) fn(msg);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const waitEvent = (method) => new Promise((resolve) => {
    const fn = (m) => { if (m.method === method) { listeners.delete(fn); resolve(m.params); } };
    listeners.add(fn);
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

  const q = (s) => JSON.stringify(s);
  const page = {
    send,
    /** Open a URL and wait for the load event. */
    async goto(url) { const loaded = waitEvent('Page.loadEventFired'); await send('Page.navigate', { url }); await loaded; },
    async reload() { const loaded = waitEvent('Page.loadEventFired'); await send('Page.reload'); await loaded; },
    /** Evaluate an expression in the page; promises are awaited, the value is returned. */
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    /** Wait until a selector matches (SPAs render after load). */
    async waitFor(selector, timeout = 5000) {
      const until = Date.now() + timeout;
      while (Date.now() < until) {
        if (await page.eval(`!!document.querySelector(${q(selector)})`)) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`Не дождались ${selector}`);
    },
    count: (selector) => page.eval(`document.querySelectorAll(${q(selector)}).length`),
    text: (selector) => page.eval(`document.querySelector(${q(selector)})?.textContent.trim() ?? null`),
    click: (selector) => page.eval(`document.querySelector(${q(selector)}).click()`),
    /** Type like a person: focus, select, insert — so input events and minlength checks fire. */
    async type(selector, value) {
      await page.eval(`(() => { const el = document.querySelector(${q(selector)}); el.focus(); el.select?.(); })()`);
      await send('Input.insertText', { text: value });
    },
    async screenshot(file, { format = 'jpeg', quality = 82, fullPage = false } = {}) {
      let clip;
      if (fullPage) {
        const { cssContentSize } = await send('Page.getLayoutMetrics');
        clip = { x: 0, y: 0, width: cssContentSize.width, height: Math.min(cssContentSize.height, 6000), scale: 1 };
      }
      const r = await send('Page.captureScreenshot', { format, quality: format === 'jpeg' ? quality : undefined, clip, captureBeyondViewport: fullPage });
      writeFileSync(file, Buffer.from(r.data, 'base64'));
    },
    async close() {
      try { ws.close(); } catch { /* уже закрыт */ }
      await new Promise((resolve) => { proc.once('exit', resolve); proc.kill(); setTimeout(resolve, 3000); });
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* временная папка */ }
    },
  };
  return page;
}

// A port is free only if nothing listens on it on IPv4 AND IPv6: a server bound to
// 127.0.0.1 does not stop another from binding "::", and the test then talks to the
// wrong server — exactly what happened when two runs shared a machine.
const isFree = (port, host) => new Promise((resolve) => {
  const s = createServer();
  s.once('error', (e) => resolve(e.code !== 'EADDRINUSE' && e.code !== 'EACCES'));
  s.once('listening', () => s.close(() => resolve(true)));
  s.listen(port, host);
});
export async function freePort(from = 4470, to = 4499) {
  for (let p = from; p <= to; p++) if (await isFree(p, '127.0.0.1') && await isFree(p, '::')) return p;
  throw new Error(`Нет свободного порта в диапазоне ${from}–${to}`);
}

/**
 * Start the app's server for tests and wait until it answers.
 *   const app = await startServer(['prd/serve.mjs'], { port, ready: '/' });
 */
export async function startServer(args, { port, ready = '/', env = {}, timeoutMs = 20000 } = {}) {
  const proc = spawn(process.execPath, args, { env: { ...process.env, PORT: String(port), ...env }, stdio: ['ignore', 'ignore', 'inherit'] });
  const url = `http://127.0.0.1:${port}`;
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (proc.exitCode !== null) throw new Error(`Сервер завершился с кодом ${proc.exitCode}`);
    try { const r = await fetch(url + ready); if (r.status < 500) break; } catch { /* ещё не слушает */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { url, stop: () => new Promise((resolve) => { proc.once('exit', resolve); proc.kill(); setTimeout(resolve, 3000); }) };
}
