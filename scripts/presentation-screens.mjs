// Скриншоты для презентации платформы: снимает кадры, описанные в
// server/presentation-deck.js, с работающего портала и кладёт в assets/presentation.
//
//   npm run screens                    — все кадры
//   npm run screens -- ideas-board     — только перечисленные
//
// Нужны запущенный портал (адрес — SOCIAL1_URL, по умолчанию http://127.0.0.1:3000)
// и установленный Google Chrome. Chrome управляется по DevTools Protocol через
// встроенный в Node.js WebSocket, поэтому зависимостей у скрипта нет.
//
// Снимайте на свежих демонстрационных данных (npm run seed): в кадр попадают
// реальные записи базы, и подписи к кадрам рассчитаны на демо-набор.
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SCREENS } from '../server/presentation-deck.js';

const BASE = (process.env.SOCIAL1_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = new URL('../assets/presentation/', import.meta.url);
const DIRECTOR = 'director@social1.mos.ru';
const only = process.argv.slice(2);
const shots = SCREENS.filter((s) => !only.length || only.includes(s.file));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Помощники, доступные сценарию подготовки кадра (поле shot.run)
const HELPERS = `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const byText = (t, sel = 'button,a,.tab,[role=tab],summary,h3,h4,b,span,div') =>
  [...document.querySelectorAll(sel)].find((e) => e.textContent.trim() === t);
const scrollTo = (el, off = 70) => {
  el = typeof el === 'string' ? document.querySelector(el) : el;
  if (!el) throw new Error('нет элемента для прокрутки');
  window.scrollTo(0, el.getBoundingClientRect().top + scrollY - off);
};`;

const port = 9400 + Math.floor(Math.random() * 400);
const profile = mkdtempSync(join(tmpdir(), 'social1-screens-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
// Профиль удаляется после выхода Chrome: пока браузер жив, он дописывает файлы
const cleanup = async () => {
  const exited = new Promise((r) => { chrome.once('exit', r); setTimeout(r, 3000); });
  try { chrome.kill(); } catch {}
  await exited;
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
};

try {
  let targets = [];
  for (let i = 0; i < 60 && !targets.length; i++) {
    try { targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t) => t.type === 'page'); }
    catch { await sleep(250); }
  }
  if (!targets.length) throw new Error(`Chrome не запустился (${CHROME})`);

  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (!pending.has(m.id)) return;
    const { res, rej } = pending.get(m.id); pending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result);
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  };

  await send('Page.enable');
  await send('Network.enable');
  // Светлая тема и без приглашения к обучению при первом входе
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await send('Page.addScriptToEvaluateOnNewDocument', { source:
    `try{localStorage.setItem('s1-theme','light');localStorage.setItem('s1-tours-seen','true');`
    + `localStorage.setItem('s1-tours-done','["intro"]');}catch(e){}` });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1.2, mobile: false });

  const sessions = {};
  const loginAs = async (email) => {
    if (!sessions[email]) {
      const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'social1' }) });
      const token = /s1=([^;]+)/.exec(r.headers.get('set-cookie') || '')?.[1];
      if (!token) throw new Error(`Не удалось войти как ${email}: ${r.status}`);
      sessions[email] = token;
    }
    await send('Network.clearBrowserCookies');
    await send('Network.setCookie', { name: 's1', value: sessions[email], url: BASE, httpOnly: true });
  };

  for (const s of shots) {
    const { path, user = DIRECTOR, run, clip, wait = 900, after = 900 } = s.shot;
    await loginAs(user);
    await send('Page.navigate', { url: BASE + path });
    await sleep(600);
    for (let i = 0; i < 40; i++) {
      if (await evaluate(`document.readyState==='complete' && !document.querySelector('.boot, .skeleton')`)) break;
      await sleep(150);
    }
    await sleep(wait);
    if (run) { await evaluate(`(async () => { ${HELPERS}\n${run} })()`); await sleep(after); }
    // Координаты кадра — в системе документа, поэтому к ним добавляется прокрутка
    const scrollY = (await evaluate('scrollY')) || 0;
    const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 80,
      clip: { ...clip, y: clip.y + scrollY, scale: 1 } });
    const buf = Buffer.from(shot.data, 'base64');
    writeFileSync(new URL(`${s.file}.jpg`, OUT), buf);
    console.log(`  ${s.file}.jpg  ${Math.round(buf.length / 1024)} КБ`);
  }
  ws.close();
  console.log(`Готово: ${shots.length} кадров в assets/presentation`);
} finally {
  await cleanup();
}
