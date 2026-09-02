// Минималистичный слой HTTP: роутер с параметрами пути, разбор тела, ответы.
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

export class HttpError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}

export const routes = [];

function add(method, pattern, handler, opts = {}) {
  const keys = [];
  const rx = new RegExp('^' + pattern.replace(/:[a-zA-Z_]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
  routes.push({ method, rx, keys, handler, ...opts });
}

export const route = {
  get:    (p, h, o) => add('GET', p, h, o),
  post:   (p, h, o) => add('POST', p, h, o),
  put:    (p, h, o) => add('PUT', p, h, o),
  patch:  (p, h, o) => add('PATCH', p, h, o),
  delete: (p, h, o) => add('DELETE', p, h, o),
};

export function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = pathname.match(r.rx);
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { ...r, params };
    }
  }
  return null;
}

export async function readBody(req, limit = 12 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Размер запроса превышает допустимый лимит');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch { throw new HttpError(400, 'Некорректный JSON в теле запроса'); }
}

export function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};

export async function serveStatic(res, webRoot, urlPath) {
  const clean = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  let file = join(webRoot, clean === '/' ? 'index.html' : clean);
  if (!file.startsWith(webRoot)) throw new HttpError(403, 'Доступ запрещён');
  let data;
  try {
    data = await readFile(file);
  } catch {
    // SPA: неизвестные пути отдаём в index.html для клиентского роутера
    file = join(webRoot, 'index.html');
    try { data = await readFile(file); } catch { throw new HttpError(404, 'Не найдено'); }
  }
  const ext = extname(file);
  const type = MIME[ext] || 'application/octet-stream';
  // Разметка, скрипты и стили всегда сверяются с сервером — иначе после обновления
  // портала у пользователя останется старая версия интерфейса. Статика кэшируется.
  const revalidate = ['.html', '.js', '.css', '.json', '.webmanifest'].includes(ext);
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': data.length,
    'Cache-Control': revalidate ? 'no-cache' : 'public, max-age=86400',
  });
  res.end(data);
}

export function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
