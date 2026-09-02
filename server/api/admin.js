// Администрирование: настройка Stage-Gate без изменения кода, пользователи,
// журнал аудита с проверкой целостности, состояние SLA.
import { route, readJson, HttpError } from '../http.js';
import { q } from '../db.js';
import { can, ROLES, hashPassword } from '../auth.js';
import { logAction, verifyChain } from '../audit.js';
import { stages, sweepSla, DECISIONS } from '../workflow.js';

function requireAdmin(user) {
  if (!can(user, 'admin')) throw new HttpError(403, 'Раздел доступен центральному аппарату ДТСЗН');
}

// ── Конфигурация процесса ────────────────────────────────────
route.get('/api/admin/workflow', async ({ user, sendJson }) => {
  requireAdmin(user);
  sendJson(200, { stages: stages(), decisions: DECISIONS, roles: ROLES });
});

route.patch('/api/admin/workflow/:stage', async ({ req, user, params, ip, sendJson }) => {
  if (!can(user, 'workflow.configure')) throw new HttpError(403, 'Недостаточно прав');
  const b = await readJson(req);
  const stageNo = Number(params.stage);
  const cur = q.get('SELECT * FROM workflow_config WHERE stage_no=?', stageNo);
  if (!cur) throw new HttpError(404, 'Этап не найден');

  const sets = [], args = [];
  for (const f of ['stage_name', 'description', 'trigger_text', 'gate_name', 'role_required', 'sla_value', 'sla_unit', 'sla_text']) {
    if (b[f] !== undefined) { sets.push(`${f}=?`); args.push(b[f]); }
  }
  if (b.criteria) { sets.push('criteria=?'); args.push(JSON.stringify(b.criteria)); }
  if (b.decisions) { sets.push('decisions=?'); args.push(JSON.stringify(b.decisions)); }
  if (b.participants) { sets.push('participants=?'); args.push(JSON.stringify(b.participants)); }
  if (!sets.length) throw new HttpError(400, 'Нет полей для обновления');

  q.run(`UPDATE workflow_config SET ${sets.join(', ')}, updated_at=datetime('now') WHERE stage_no=?`, ...args, stageNo);
  logAction(user.id, 'workflow.configure', 'workflow_config', stageNo, b, ip);
  sendJson(200, stages().find((s) => s.stage_no === stageNo));
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
  if (!ROLES[b.role]) throw new HttpError(400, 'Неизвестная роль');
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
