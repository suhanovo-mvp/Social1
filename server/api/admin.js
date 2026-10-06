// Администрирование: настройка Stage-Gate без изменения кода, пользователи,
// журнал аудита с проверкой целостности, состояние SLA.
import { route, readJson, HttpError } from '../http.js';
import { q } from '../db.js';
import { can, roleMap, hashPassword, permissionsOf, upsertRole, setRolePermissions,
         grantRole, revokeRole, extraRolesOf } from '../auth.js';
import { logAction, verifyChain } from '../audit.js';
import { stages, sweepSla, DECISIONS } from '../workflow.js';
import * as repo from '../process-repo.js';
import { presentationPdf } from '../presentation-pdf.js';

function requireAdmin(user) {
  if (!can(user, 'admin')) throw new HttpError(403, 'Раздел доступен центральному аппарату ДТСЗН');
}

// ── Презентация платформы ────────────────────────────────────
// Собирается в момент скачивания: цифры из базы, состав модулей и разделов — из
// описания в presentation-deck.js. Первый слайд — всегда executive one-page.
route.get('/api/admin/presentation.pdf', async ({ user, ip, res }) => {
  requireAdmin(user);
  const buf = presentationPdf();
  logAction(user.id, 'platform.presentation', 'system', null, { bytes: buf.length }, ip);
  const name = `Social1_презентация_платформы_${new Date().toISOString().slice(0, 10)}.pdf`;
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': buf.length,
    'Content-Disposition': `attachment; filename="social1-presentation.pdf"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
});

// ── Конфигурация процесса ────────────────────────────────────
route.get('/api/admin/workflow', async ({ user, sendJson }) => {
  requireAdmin(user);
  sendJson(200, { stages: stages(), decisions: DECISIONS, roles: roleMap() });
});

/**
 * Правка этапа конвейера.
 *
 * Запись идёт не в workflow_config, а в модель процесса: создаётся версия схемы,
 * публикуется и пересобирает проекцию. У конфигурации остаётся единственный источник
 * и полная история — независимо от того, пришла правка из этой панели или из
 * согласованного сообществом предложения об изменении процесса.
 */
route.patch('/api/admin/workflow/:stage', async ({ req, user, params, ip, sendJson }) => {
  if (!can(user, 'workflow.configure')) throw new HttpError(403, 'Недостаточно прав');
  const b = await readJson(req);
  const stageNo = Number(params.stage);
  if (!q.get('SELECT stage_no FROM workflow_config WHERE stage_no=?', stageNo)) {
    throw new HttpError(404, 'Этап не найден');
  }

  const patch = {};
  for (const f of ['stage_name', 'description', 'trigger_text', 'gate_name', 'role_required',
                   'sla_value', 'sla_unit', 'sla_text']) {
    if (b[f] !== undefined) patch[f] = b[f];
  }
  for (const f of ['criteria', 'decisions', 'participants']) {
    if (b[f] !== undefined) patch[f] = b[f];
  }
  if (!Object.keys(patch).length) throw new HttpError(400, 'Нет полей для обновления');

  repo.patchStage({ stageNo, patch, user, ip });
  logAction(user.id, 'workflow.configure', 'workflow_config', stageNo, b, ip);
  sendJson(200, stages().find((s) => s.stage_no === stageNo));
});

// ── Роли и права ─────────────────────────────────────────────
// Ролевая модель — данные, а не код: администратор заводит роль, передаёт право
// и назначает участнику дополнительные роли без правки исходников.
function requireRoleAdmin(user) {
  if (!can(user, 'process.admin') && !can(user, 'admin')) {
    throw new HttpError(403, 'Управление ролями доступно центральному аппарату ДТСЗН');
  }
}

route.get('/api/admin/roles', async ({ user, sendJson }) => {
  requireRoleAdmin(user);
  const roles = Object.values(roleMap()).map((r) => ({
    ...r,
    permissions: permissionsOf(r.code),
    users: q.get('SELECT COUNT(*) AS c FROM users WHERE role = ? AND is_active = 1', r.code).c,
    extra_users: q.get('SELECT COUNT(*) AS c FROM user_roles WHERE role_code = ?', r.code).c,
  }));
  sendJson(200, {
    roles,
    catalog: q.all('SELECT * FROM permissions_catalog ORDER BY order_idx'),
  });
});

route.post('/api/admin/roles', async ({ req, user, ip, sendJson }) => {
  requireRoleAdmin(user);
  const b = await readJson(req);
  if (!/^[a-z][a-z0-9_]{1,30}$/.test(b.code || '')) {
    throw new HttpError(400, 'Код роли — латиница в нижнем регистре, цифры и подчёркивание');
  }
  if (!b.title?.trim()) throw new HttpError(400, 'Укажите название роли');
  if (roleMap()[b.code]) throw new HttpError(409, 'Роль с таким кодом уже существует');
  const role = upsertRole({ code: b.code, title: b.title.trim(), short: b.short?.trim() || null,
                            description: b.description ?? null });
  logAction(user.id, 'role.create', 'role', null, { code: b.code }, ip);
  sendJson(201, role);
});

route.patch('/api/admin/roles/:code', async ({ req, user, params, ip, sendJson }) => {
  requireRoleAdmin(user);
  if (!roleMap()[params.code]) throw new HttpError(404, 'Роль не найдена');
  const b = await readJson(req);
  const role = upsertRole({ code: params.code, title: b.title, short: b.short,
                            description: b.description, is_active: b.is_active, order_idx: b.order_idx });
  logAction(user.id, 'role.update', 'role', null, { code: params.code, ...b }, ip);
  sendJson(200, role);
});

route.put('/api/admin/roles/:code/permissions', async ({ req, user, params, ip, sendJson }) => {
  requireRoleAdmin(user);
  if (!roleMap()[params.code]) throw new HttpError(404, 'Роль не найдена');
  const b = await readJson(req);
  if (!Array.isArray(b.permissions)) throw new HttpError(400, 'Ожидается перечень прав');

  // Право администрирования нельзя снять с самого себя: иначе можно запереть
  // платформу без единой учётной записи, способной вернуть доступ
  if (params.code === user.role && !b.permissions.includes('admin') && can(user, 'admin')) {
    throw new HttpError(400, 'Нельзя снять администрирование со своей роли — доступ будет потерян');
  }
  const known = new Set(q.all('SELECT code FROM permissions_catalog').map((r) => r.code));
  const unknown = b.permissions.filter((p) => !known.has(p));
  if (unknown.length) throw new HttpError(400, `Неизвестные права: ${unknown.join(', ')}`);

  setRolePermissions(params.code, b.permissions);
  logAction(user.id, 'role.permissions', 'role', null, { code: params.code, permissions: b.permissions }, ip);
  sendJson(200, { code: params.code, permissions: permissionsOf(params.code) });
});

/** Дополнительные роли участника сверх основной. */
route.get('/api/admin/users/:id/roles', async ({ user, params, sendJson }) => {
  requireRoleAdmin(user);
  sendJson(200, extraRolesOf(Number(params.id)));
});

route.post('/api/admin/users/:id/roles', async ({ req, user, params, ip, sendJson }) => {
  requireRoleAdmin(user);
  const b = await readJson(req);
  if (!roleMap()[b.role_code]) throw new HttpError(400, 'Неизвестная роль');
  const target = q.get('SELECT id, role FROM users WHERE id = ?', Number(params.id));
  if (!target) throw new HttpError(404, 'Участник не найден');
  if (target.role === b.role_code) throw new HttpError(400, 'Это основная роль участника');
  grantRole(target.id, b.role_code, { institutionId: b.institution_id ?? null, grantedBy: user.id });
  logAction(user.id, 'role.grant', 'user', target.id, { role: b.role_code }, ip);
  sendJson(201, extraRolesOf(target.id));
});

route.delete('/api/admin/users/:id/roles/:code', async ({ user, params, ip, sendJson }) => {
  requireRoleAdmin(user);
  revokeRole(Number(params.id), params.code);
  logAction(user.id, 'role.revoke', 'user', Number(params.id), { role: params.code }, ip);
  sendJson(200, extraRolesOf(Number(params.id)));
});

// ── Пользователи и учреждения ────────────────────────────────
route.get('/api/admin/users', async ({ user, sendJson }) => {
  requireAdmin(user);
  sendJson(200, q.all(`SELECT u.id, u.email, u.full_name, u.role, u.position, u.is_active, u.last_login_at,
                              inst.short_name AS institution
                       FROM users u LEFT JOIN institutions inst ON inst.id=u.institution_id
                       ORDER BY u.role, u.full_name`));
});

route.post('/api/admin/users', async ({ req, user, ip, sendJson }) => {
  requireAdmin(user);
  const b = await readJson(req);
  if (!b.email || !b.full_name || !b.role) throw new HttpError(400, 'Укажите e-mail, ФИО и роль');
  if (!roleMap()[b.role]) throw new HttpError(400, 'Неизвестная роль');
  if (q.get('SELECT id FROM users WHERE lower(email)=lower(?)', b.email)) throw new HttpError(409, 'Пользователь с таким e-mail уже существует');
  const { hash, salt } = hashPassword(b.password || 'social1');
  const id = q.insert(`INSERT INTO users (email, full_name, password_hash, password_salt, role, institution_id, position, expertise)
                       VALUES (?,?,?,?,?,?,?,?)`,
    b.email.trim(), b.full_name.trim(), hash, salt, b.role, b.institution_id || null, b.position || null, b.expertise || null);
  logAction(user.id, 'user.create', 'user', id, { email: b.email, role: b.role }, ip);
  sendJson(201, { id });
});

route.patch('/api/admin/users/:id', async ({ req, user, params, ip, sendJson }) => {
  requireAdmin(user);
  const b = await readJson(req);
  const sets = [], args = [];
  for (const f of ['full_name', 'role', 'institution_id', 'position', 'expertise', 'is_active']) {
    if (b[f] !== undefined) { sets.push(`${f}=?`); args.push(b[f]); }
  }
  if (!sets.length) throw new HttpError(400, 'Нет полей для обновления');
  q.run(`UPDATE users SET ${sets.join(', ')} WHERE id=?`, ...args, Number(params.id));
  logAction(user.id, 'user.update', 'user', Number(params.id), b, ip);
  sendJson(200, { ok: true });
});

route.post('/api/admin/institutions', async ({ req, user, ip, sendJson }) => {
  requireAdmin(user);
  const b = await readJson(req);
  if (!b.name || !b.short_name) throw new HttpError(400, 'Укажите полное и краткое наименование');
  const id = q.insert(`INSERT INTO institutions (name, short_name, kind, district, address, staff_count, is_pilot_site)
                       VALUES (?,?,?,?,?,?,?)`,
    b.name, b.short_name, b.kind || 'institution', b.district || null, b.address || null,
    Number(b.staff_count) || 0, b.is_pilot_site ? 1 : 0);
  logAction(user.id, 'institution.create', 'institution', id, b, ip);
  sendJson(201, { id });
});

// ── Журнал аудита ────────────────────────────────────────────
route.get('/api/admin/audit', async ({ user, url, sendJson }) => {
  if (!can(user, 'audit.read')) throw new HttpError(403, 'Журнал доступен центральному аппарату ДТСЗН');
  const limit = Math.min(300, Number(url.searchParams.get('limit')) || 100);
  const entity = url.searchParams.get('entity');
  const action = url.searchParams.get('action');
  const where = [], args = [];
  if (entity) { where.push('a.entity = ?'); args.push(entity); }
  if (action) { where.push('a.action LIKE ?'); args.push(`${action}%`); }
  const rows = q.all(`SELECT a.*, u.full_name AS user_name, u.role AS user_role
                      FROM audit_log a LEFT JOIN users u ON u.id=a.user_id
                      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                      ORDER BY a.id DESC LIMIT ?`, ...args, limit);
  sendJson(200, {
    entries: rows.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null })),
    total: q.get('SELECT COUNT(*) AS c FROM audit_log').c,
  });
});

route.get('/api/admin/audit/verify', async ({ user, sendJson }) => {
  if (!can(user, 'audit.read')) throw new HttpError(403, 'Недостаточно прав');
  sendJson(200, verifyChain());
});

// ── Контроль SLA ─────────────────────────────────────────────
route.get('/api/admin/sla', async ({ user, sendJson }) => {
  if (!can(user, 'analytics.all') && !can(user, 'analytics.institution')) throw new HttpError(403, 'Недостаточно прав');
  const overdue = q.all(`
    SELECT i.id, i.number, i.title, i.stage, i.sla_due_at, i.stage_entered_at,
           inst.short_name AS institution, w.stage_name, w.gate_name, w.role_required,
           (julianday('now') - julianday(i.sla_due_at)) AS days_overdue
    FROM initiatives i JOIN institutions inst ON inst.id=i.institution_id
    LEFT JOIN workflow_config w ON w.stage_no = i.stage
    WHERE i.status='active' AND i.sla_due_at IS NOT NULL AND i.sla_due_at < datetime('now')
    ORDER BY days_overdue DESC`);
  const atRisk = q.all(`
    SELECT i.id, i.number, i.title, i.stage, i.sla_due_at, inst.short_name AS institution,
           w.stage_name, w.gate_name,
           (julianday(i.sla_due_at) - julianday('now')) * 24 AS hours_left
    FROM initiatives i JOIN institutions inst ON inst.id=i.institution_id
    LEFT JOIN workflow_config w ON w.stage_no = i.stage
    WHERE i.status='active' AND i.sla_due_at IS NOT NULL
      AND i.sla_due_at >= datetime('now') AND i.sla_due_at < datetime('now', '+1 day')
    ORDER BY hours_left ASC`);
  sendJson(200, {
    overdue: overdue.map((r) => ({ ...r, days_overdue: Math.round(r.days_overdue * 10) / 10 })),
    at_risk: atRisk.map((r) => ({ ...r, hours_left: Math.round(r.hours_left) })),
  });
});

route.post('/api/admin/sla/sweep', async ({ user, ip, sendJson }) => {
  requireAdmin(user);
  const result = sweepSla();
  logAction(user.id, 'sla.sweep', 'system', null, result, ip);
  sendJson(200, result);
});

// ── Системная сводка ─────────────────────────────────────────
route.get('/api/admin/system', async ({ user, sendJson }) => {
  requireAdmin(user);
  const tables = ['initiatives', 'users', 'institutions', 'gate_decisions', 'pilots', 'surveys',
                  'survey_responses', 'projects', 'board_items', 'forum_topics', 'rollouts', 'audit_log'];
  const counts = Object.fromEntries(tables.map((t) => [t, q.get(`SELECT COUNT(*) AS c FROM ${t}`).c]));
  sendJson(200, {
    counts,
    audit: verifyChain(),
    node: process.version,
    uptime_seconds: Math.round(process.uptime()),
    memory_mb: Math.round(process.memoryUsage().rss / 1048576),
  });
});
