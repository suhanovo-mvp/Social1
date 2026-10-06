// Social1 — точка входа. Управленческая платформа системных инноваций ДТСЗН.
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchRoute, sendJson, serveStatic, parseCookies, HttpError } from './http.js';
import { userFromToken, ensureRoles } from './auth.js';
import { ensureWorkflow, sweepSla, ensureStageEvents } from './workflow.js';
import { ensureIdeaHub, sweepIdeaHub } from './ideahub.js';
import { ensureProcesses } from './process-repo.js';
import { ensureKnowledge } from './knowledge.js';
import { ensureSampleForms } from './seed-forms.js';
import './knowledge-flow.js';   // подписки: документ → задача → документ
import { ensureSearchIndex } from './search.js';
import { sweepApprovals } from './process-changes.js';
import { logAction } from './audit.js';
import { q } from './db.js';

// Регистрация маршрутов
import './api/auth.js';
import './api/initiatives.js';
import './api/ideas.js';
import './api/review.js';
import './api/rating.js';
import './api/work.js';
import './api/pilots.js';
import './api/analytics.js';
import './api/community.js';
import './api/admin.js';
import './api/processes.js';
import './api/process-changes.js';
import './api/knowledge.js';
import './api/forms.js';
import './api/providers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const SHARED = join(ROOT, 'shared');  // модули, общие для браузера и сервера
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

ensureRoles();
ensureWorkflow();
ensureIdeaHub();
// Репозиторий процессов заполняется после конвейера: он же его и переопределяет,
// собирая workflow_config из опубликованной модели
ensureProcesses();
ensureKnowledge();
// Образец формы-опросника заводится один раз и дальше живёт как обычная форма:
// его правят в конструкторе, и перезапуск правки не отменяет
ensureSampleForms();
ensureSearchIndex();
// История переходов старше событийного слоя — восстанавливаем её один раз
ensureStageEvents();

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
};

const server = createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  const ip = (req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || '').trim();
  const send = (status, data) => sendJson(res, status, data);

  try {
    // Общие модели (раскладка, схема, сравнение версий) грузятся браузером как ES-модули
    if (pathname.startsWith('/shared/')) {
      return await serveStatic(res, SHARED, pathname.slice('/shared'.length), { spaFallback: false });
    }
    if (!pathname.startsWith('/api/')) return await serveStatic(res, WEB, pathname);

    const matched = matchRoute(req.method, pathname);
    if (!matched) throw new HttpError(404, `Метод ${req.method} ${pathname} не поддерживается`);

    const cookies = parseCookies(req.headers.cookie);
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const token = cookies.s1 || bearer || null;
    const user = userFromToken(token);

    if (!matched.public && !user) throw new HttpError(401, 'Требуется вход в систему');

    await matched.handler({
      req, res, url, params: matched.params, user, token, ip,
      sendJson: send,
    });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) {
      console.error(`[${new Date().toISOString()}] ${req.method} ${pathname}`, err);
      try { logAction(null, 'system.error', 'http', null, { path: pathname, message: err.message }, ip); } catch {}
    }
    if (!res.headersSent) send(status, { error: err.message || 'Внутренняя ошибка сервера', details: err.details });
    else res.end();
  }
});

// Фоновый контроль SLA: эскалация просроченных решений каждые 15 минут
const slaTimer = setInterval(() => {
  try {
    const r = sweepSla();
    if (r.escalated) console.log(`SLA: эскалировано задач — ${r.escalated}`);
  } catch (e) { console.error('Ошибка проверки SLA:', e.message); }
  try {
    // Согласование изменений процессов живёт по тем же правилам, что и точки
    // принятия решений: просроченный ответ эскалируется координатору
    const a = sweepApprovals();
    if (a.escalated) console.log(`Согласование процессов: эскалировано — ${a.escalated}`);
  } catch (e) { console.error('Ошибка проверки согласований:', e.message); }
}, 15 * 60 * 1000);
slaTimer.unref();

// Обслуживание модуля «Идеи и решения»: знаки отличия и рекомендации к поощрению.
// Рейтинг считается запросом на лету, поэтому здесь пересчитываются только
// накопительные признаки — раз в час этого достаточно.
const ideaTimer = setInterval(() => {
  try {
    const r = sweepIdeaHub();
    if (r.badges || r.incentives) {
      console.log(`Идеи и решения: знаков отличия — ${r.badges}, рекомендаций к поощрению — ${r.incentives}`);
    }
  } catch (e) { console.error('Ошибка обслуживания модуля идей:', e.message); }
}, 60 * 60 * 1000);
ideaTimer.unref();

server.listen(PORT, HOST, () => {
  const users = q.get('SELECT COUNT(*) AS c FROM users').c;
  console.log('');
  console.log('  Social1 — управленческая платформа системных инноваций ДТСЗН');
  console.log('  ─────────────────────────────────────────────────────────────');
  console.log(`  Портал:        http://${HOST}:${PORT}`);
  console.log(`  Пользователей: ${users}`);
  console.log(`  Инициатив:     ${q.get('SELECT COUNT(*) AS c FROM initiatives').c}`);
  console.log(`  Идей:          ${q.get('SELECT COUNT(*) AS c FROM ideas').c}`);
  if (!users) console.log('\n  Данных нет. Заполните демо-данными: npm run seed');
  console.log('');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { console.log('\nОстановка сервера…'); server.close(() => process.exit(0)); });
}
