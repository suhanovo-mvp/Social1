// Каталог разработчиков ИИ-решений: карточки, портфолио, каталог решений, доступ.
import { route, readJson, HttpError } from '../http.js';
import { can } from '../auth.js';
import * as pr from '../providers.js';
import { guidePdf, guideByFile } from '../guide-pdf.js';

const need = (user, permission, message) => {
  if (!can(user, permission)) throw new HttpError(403, message);
};
const READ = 'Каталог разработчиков доступен по отдельному допуску — обратитесь к администратору каталога';
const EDIT = 'Вносить сведения в каталог могут модераторы каталога разработчиков';
const ADMIN = 'Действие доступно администратору каталога разработчиков';

/**
 * Уровень доступа к одной карточке: модератор правит всё, пользователь каталога
 * читает всё, представитель разработчика — только свою карточку и только профиль.
 */
function cardAccess(user, id) {
  if (can(user, 'provider.edit')) return 'edit';
  if (can(user, 'provider.self') && pr.isMember(user, id)) return 'rep';
  if (can(user, 'provider.read')) return 'read';
  return null;
}
const REP = 'Сведения о компании вносит её представитель или модератор каталога';

/** Правка портфолио и решений: модератору всегда, представителю — своей компании. */
function needContent(user, id) {
  const a = cardAccess(user, id);
  if (a !== 'edit' && a !== 'rep') throw new HttpError(403, REP);
  return a;
}

const listFilters = (p) => ({
  kind: p.get('kind') || null,
  status: p.get('status') || null,
  includeArchived: p.get('archived') === '1',
  q: p.get('q') || null,
  competencies: p.get('competencies')?.split(',').filter(Boolean) ?? [],
  compliance: p.get('compliance')?.split(',').filter(Boolean) ?? [],
  domain: p.get('domain') || null,
  availability: p.get('availability') || null,
  tag: p.get('tag') || null,
  publicSector: p.get('public_sector') === '1',
  stale: p.get('stale') === '1',
  pending: p.get('pending') === '1',
  sort: p.get('sort') || 'updated',
  dir: p.get('dir') || null,
});

// ─────────────────────────────────────────────────────────────
// Каталог
// ─────────────────────────────────────────────────────────────
route.get('/api/providers', async ({ user, url, sendJson }) => {
  need(user, 'provider.read', READ);
  sendJson(200, {
    ...pr.listProviders(listFilters(url.searchParams)),
    dict: pr.dictionaries(),
    summary: pr.summary(),
  });
});

route.get('/api/providers/export.csv', async ({ user, url, res }) => {
  need(user, 'provider.read', READ);
  const body = pr.exportCsv(listFilters(url.searchParams));
  const name = `providers-${new Date().toISOString().slice(0, 10)}.csv`;
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${name}"`,
    'Cache-Control': 'no-store',
  });
  res.end(body);
});

route.get('/api/providers/dictionaries', async ({ user, sendJson }) => {
  if (!can(user, 'provider.read') && !can(user, 'provider.self')) throw new HttpError(403, READ);
  sendJson(200, { dict: pr.dictionaries(), tags: pr.knownTags() });
});

/** Проверка дублей по мере ввода: ИНН или то же название без организационной формы. */
route.post('/api/providers/duplicates', async ({ req, user, sendJson }) => {
  need(user, 'provider.edit', EDIT);
  const b = await readJson(req);
  sendJson(200, pr.findDuplicates({ name: b.name, inn: b.inn, excludeId: b.exclude_id ?? null }));
});

route.get('/api/providers/solutions', async ({ user, url, sendJson }) => {
  need(user, 'provider.read', READ);
  const p = url.searchParams;
  sendJson(200, {
    solutions: pr.listSolutions({
      q: p.get('q') || null,
      competency: p.get('competency') || null,
      kind: p.get('kind') || null,
      maturity: p.get('maturity') || null,
      providerKind: p.get('provider_kind') || null,
      registry: p.get('registry') === '1',
      tag: p.get('tag') || null,
    }),
    dict: pr.dictionaries(),
  });
});

route.post('/api/providers', async ({ req, user, ip, sendJson }) => {
  need(user, 'provider.edit', EDIT);
  sendJson(201, pr.createProvider(await readJson(req), user, ip));
});

/**
 * Инструкции в PDF: пользователя, модератора и представителя разработчика.
 * Инструкция доступна тем, кому доступен описанный ею раздел.
 */
route.get('/api/providers/guide/:file', async ({ user, params, res }) => {
  const file = params.file.replace(/\.pdf$/, '');
  const guide = guideByFile(file);
  if (!guide) throw new HttpError(404, 'Инструкция не найдена');
  if (!can(user, guide.perm) && !can(user, 'provider.read')) throw new HttpError(403, READ);
  const buf = guidePdf(file);
  const name = `Каталог_разработчиков_ИИ_${guide.title.replace(/\s+/g, '_')}.pdf`;
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': buf.length,
    'Content-Disposition': `attachment; filename="guide.pdf"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
});

/** Карточки, которые ведёт представитель разработчика. */
route.get('/api/providers/mine', async ({ user, sendJson }) => {
  sendJson(200, can(user, 'provider.self') ? pr.membershipsOf(user) : []);
});

route.get('/api/providers/members/candidates', async ({ user, url, sendJson }) => {
  need(user, 'provider.edit', EDIT);
  sendJson(200, pr.accessCandidates(url.searchParams.get('q')));
});

// ─────────────────────────────────────────────────────────────
// Доступ. Маршруты объявлены до /:id, иначе «access» был бы принят за номер карточки
// ─────────────────────────────────────────────────────────────
route.get('/api/providers/access', async ({ user, sendJson }) => {
  need(user, 'provider.admin', ADMIN);
  sendJson(200, pr.accessList());
});

route.get('/api/providers/access/candidates', async ({ user, url, sendJson }) => {
  need(user, 'provider.admin', ADMIN);
  sendJson(200, pr.accessCandidates(url.searchParams.get('q')));
});

route.post('/api/providers/access', async ({ req, user, ip, sendJson }) => {
  need(user, 'provider.admin', ADMIN);
  const b = await readJson(req);
  sendJson(200, pr.grantAccess(b.user_id, b.role_code, user, ip));
});

route.delete('/api/providers/access/:userId', async ({ user, params, ip, sendJson }) => {
  need(user, 'provider.admin', ADMIN);
  sendJson(200, pr.revokeAccess(params.userId, user, ip));
});

// ─────────────────────────────────────────────────────────────
// Карточка
// ─────────────────────────────────────────────────────────────
route.get('/api/providers/:id', async ({ user, params, sendJson }) => {
  const access = cardAccess(user, params.id);
  if (!access) throw new HttpError(403, READ);
  const p = pr.getProvider(params.id);
  if (!p) throw new HttpError(404, 'Разработчик не найден');
  sendJson(200, {
    provider: access === 'rep' ? pr.representativeView(p) : p,
    access, dict: pr.dictionaries(), tags: pr.knownTags(),
  });
});

// Модератор правит карточку целиком, представитель — только технологический профиль
route.put('/api/providers/:id', async ({ req, user, params, ip, sendJson }) => {
  const access = cardAccess(user, params.id);
  const b = await readJson(req);
  if (access === 'edit') return sendJson(200, pr.updateProvider(params.id, b, user, ip));
  if (access === 'rep') return sendJson(200, pr.representativeView(pr.updateProfile(params.id, b, user, ip)));
  throw new HttpError(403, EDIT);
});

route.post('/api/providers/:id/confirm', async ({ user, params, ip, sendJson }) => {
  need(user, 'provider.edit', 'Подтвердить сведения может модератор каталога');
  sendJson(200, pr.confirmProfile(params.id, user, ip));
});

// Представители разработчика
route.get('/api/providers/:id/members', async ({ user, params, sendJson }) => {
  need(user, 'provider.edit', EDIT);
  sendJson(200, pr.listMembers(params.id));
});
route.post('/api/providers/:id/members', async ({ req, user, params, ip, sendJson }) => {
  need(user, 'provider.edit', 'Привязать представителя может модератор каталога');
  const b = await readJson(req);
  sendJson(200, pr.addMember(params.id, b.user_id, user, ip));
});
route.delete('/api/providers/:id/members/:userId', async ({ user, params, ip, sendJson }) => {
  need(user, 'provider.edit', 'Отвязать представителя может модератор каталога');
  sendJson(200, pr.removeMember(params.id, params.userId, user, ip));
});

route.post('/api/providers/:id/status', async ({ req, user, params, ip, sendJson }) => {
  need(user, 'provider.edit', EDIT);
  const b = await readJson(req);
  sendJson(200, pr.setStatus(params.id, b.status, user, ip));
});

route.delete('/api/providers/:id', async ({ user, params, ip, sendJson }) => {
  need(user, 'provider.admin', 'Удалить карточку может администратор каталога; модератор переводит её в архив');
  pr.deleteProvider(params.id, user, ip);
  sendJson(200, { ok: true });
});

// Портфолио
// Правка представителя ставит карточку на проверку модератору
const byRep = (access, id, user, what) => { if (access === 'rep') pr.markProfileChanged(id, user, what); };

route.post('/api/providers/:id/cases', async ({ req, user, params, ip, sendJson }) => {
  const access = needContent(user, params.id);
  const c = pr.saveCase(params.id, null, await readJson(req), user, ip);
  byRep(access, params.id, user, `добавлен проект «${c.title}»`);
  sendJson(201, c);
});
route.put('/api/providers/:id/cases/:caseId', async ({ req, user, params, ip, sendJson }) => {
  const access = needContent(user, params.id);
  const c = pr.saveCase(params.id, params.caseId, await readJson(req), user, ip);
  byRep(access, params.id, user, `изменён проект «${c.title}»`);
  sendJson(200, c);
});
route.delete('/api/providers/:id/cases/:caseId', async ({ user, params, ip, sendJson }) => {
  const access = needContent(user, params.id);
  pr.deleteCase(params.id, params.caseId, user, ip);
  byRep(access, params.id, user, 'удалён проект из портфолио');
  sendJson(200, { ok: true });
});

// Каталог решений
route.post('/api/providers/:id/solutions', async ({ req, user, params, ip, sendJson }) => {
  const access = needContent(user, params.id);
  const sol = pr.saveSolution(params.id, null, await readJson(req), user, ip);
  byRep(access, params.id, user, `добавлено решение «${sol.name}»`);
  sendJson(201, sol);
});
route.put('/api/providers/:id/solutions/:solutionId', async ({ req, user, params, ip, sendJson }) => {
  const access = needContent(user, params.id);
  const sol = pr.saveSolution(params.id, params.solutionId, await readJson(req), user, ip);
  byRep(access, params.id, user, `изменено решение «${sol.name}»`);
  sendJson(200, sol);
});
route.delete('/api/providers/:id/solutions/:solutionId', async ({ user, params, ip, sendJson }) => {
  const access = needContent(user, params.id);
  pr.deleteSolution(params.id, params.solutionId, user, ip);
  byRep(access, params.id, user, 'удалено решение из каталога');
  sendJson(200, { ok: true });
});

// Оценка по итогам работы — одна от участника
route.put('/api/providers/:id/review', async ({ req, user, params, ip, sendJson }) => {
  need(user, 'provider.edit', 'Оценивать разработчиков могут модераторы каталога');
  sendJson(200, pr.saveReview(params.id, await readJson(req), user, ip));
});
route.delete('/api/providers/:id/review', async ({ user, params, ip, sendJson }) => {
  need(user, 'provider.edit', EDIT);
  pr.deleteReview(params.id, user, ip);
  sendJson(200, { ok: true });
});

// Журнал взаимодействий
route.post('/api/providers/:id/notes', async ({ req, user, params, ip, sendJson }) => {
  need(user, 'provider.edit', EDIT);
  sendJson(201, pr.addNote(params.id, await readJson(req), user, ip));
});
route.delete('/api/providers/:id/notes/:noteId', async ({ user, params, ip, sendJson }) => {
  need(user, 'provider.edit', EDIT);
  pr.deleteNote(params.id, params.noteId, user, can(user, 'provider.admin'), ip);
  sendJson(200, { ok: true });
});
