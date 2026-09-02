// Личный кабинет: задачи, уведомления. Модуль разработки: проекты, спринты, доски, документы.
import { route, readJson, HttpError } from '../http.js';
import { q } from '../db.js';
import { can } from '../auth.js';
import { logAction } from '../audit.js';
import { slaState, notify } from '../workflow.js';

// ── Задачи ───────────────────────────────────────────────────
route.get('/api/tasks', async ({ user, url, sendJson }) => {
  const status = url.searchParams.get('status') || 'open';
  const clause = status === 'all' ? '1=1' : (status === 'open' ? "t.status IN ('open','escalated')" : 't.status = ?');
  const args = status === 'all' || status === 'open' ? [] : [status];
  const rows = q.all(`
    SELECT t.*, i.number, i.title AS initiative_title, i.stage, i.status AS initiative_status
    FROM tasks t LEFT JOIN initiatives i ON i.id = t.initiative_id
    WHERE ${clause} AND (t.user_id = ? OR (t.role_target = ? AND (t.institution_id IS NULL OR t.institution_id = ?)))
    ORDER BY CASE t.status WHEN 'escalated' THEN 0 ELSE 1 END, t.due_at ASC NULLS LAST, t.created_at DESC`,
    ...args, user.id, user.role, user.institution_id);
  sendJson(200, rows.map((t) => ({
    ...t,
    overdue: t.due_at ? new Date(t.due_at.replace(' ', 'T') + 'Z') < new Date() : false,
  })));
});

route.post('/api/tasks/:id/done', async ({ user, params, ip, sendJson }) => {
  const t = q.get('SELECT * FROM tasks WHERE id = ?', Number(params.id));
  if (!t) throw new HttpError(404, 'Задача не найдена');
  const mine = t.user_id === user.id || (t.role_target === user.role && (!t.institution_id || t.institution_id === user.institution_id));
  if (!mine) throw new HttpError(403, 'Это не ваша задача');
  q.run("UPDATE tasks SET status='done', completed_at=datetime('now') WHERE id=?", t.id);
  logAction(user.id, 'task.done', 'task', t.id, null, ip);
  sendJson(200, { ok: true });
});

// ── Уведомления ──────────────────────────────────────────────
route.get('/api/notifications', async ({ user, sendJson }) => {
  sendJson(200, q.all(`SELECT n.*, i.number FROM notifications n
                       LEFT JOIN initiatives i ON i.id = n.initiative_id
                       WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT 60`, user.id));
});

route.post('/api/notifications/read', async ({ req, user, sendJson }) => {
  const { id } = await readJson(req);
  if (id) q.run('UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?', Number(id), user.id);
  else q.run('UPDATE notifications SET is_read=1 WHERE user_id=?', user.id);
  sendJson(200, { ok: true });
});

// ── Проекты разработки ───────────────────────────────────────
route.get('/api/projects', async ({ user, sendJson }) => {
  sendJson(200, q.all(`
    SELECT p.*, i.number, i.title AS initiative_title, i.stage, i.status AS initiative_status,
           po.full_name AS product_owner_name, tl.full_name AS team_lead_name,
           (SELECT COUNT(*) FROM board_items b WHERE b.project_id = p.id) AS items_total,
           (SELECT COUNT(*) FROM board_items b WHERE b.project_id = p.id AND b.status='done') AS items_done
    FROM projects p JOIN initiatives i ON i.id = p.initiative_id
    LEFT JOIN users po ON po.id = p.product_owner_id
    LEFT JOIN users tl ON tl.id = p.team_lead_id
    ORDER BY p.created_at DESC`));
});

route.post('/api/projects', async ({ req, user, ip, sendJson }) => {
  if (!can(user, 'project.manage')) throw new HttpError(403, 'Проекты создаёт команда разработки');
  const b = await readJson(req);
  const init = q.get('SELECT * FROM initiatives WHERE id=?', Number(b.initiative_id));
  if (!init) throw new HttpError(404, 'Инициатива не найдена');
  if (q.get('SELECT id FROM projects WHERE initiative_id=?', init.id)) throw new HttpError(409, 'Проект для этой инициативы уже существует');
  const id = q.insert(`INSERT INTO projects (initiative_id, name, product_owner_id, team_lead_id) VALUES (?,?,?,?)`,
    init.id, b.name || init.title, b.product_owner_id || null, user.id);
  logAction(user.id, 'project.create', 'project', id, { initiative: init.number }, ip);
  sendJson(201, q.get('SELECT * FROM projects WHERE id=?', id));
});

route.get('/api/projects/:id', async ({ params, sendJson }) => {
  const p = q.get(`SELECT p.*, i.number, i.title AS initiative_title, i.stage, i.expected_effect,
                          po.full_name AS product_owner_name, tl.full_name AS team_lead_name
                   FROM projects p JOIN initiatives i ON i.id = p.initiative_id
                   LEFT JOIN users po ON po.id = p.product_owner_id
                   LEFT JOIN users tl ON tl.id = p.team_lead_id WHERE p.id = ?`, Number(params.id));
  if (!p) throw new HttpError(404, 'Проект не найден');
  const sprints = q.all('SELECT * FROM sprints WHERE project_id=? ORDER BY number', p.id);
  const items = q.all(`SELECT b.*, u.full_name AS assignee_name FROM board_items b
                       LEFT JOIN users u ON u.id = b.assignee_id
                       WHERE b.project_id=? ORDER BY b.order_idx, b.id`, p.id);
  const docs = q.all(`SELECT d.*, u.full_name AS author_name FROM documents d
                      JOIN users u ON u.id = d.created_by WHERE d.project_id=? ORDER BY d.created_at DESC`, p.id);
  sendJson(200, { ...p, sprints, items, documents: docs });
});

route.post('/api/projects/:id/sprints', async ({ req, user, params, ip, sendJson }) => {
  if (!can(user, 'board.manage')) throw new HttpError(403, 'Недостаточно прав');
  const b = await readJson(req);
  const n = (q.get('SELECT COALESCE(MAX(number),0) AS m FROM sprints WHERE project_id=?', Number(params.id)).m) + 1;
  const id = q.insert(`INSERT INTO sprints (project_id, number, name, goal, starts_at, ends_at, status)
                       VALUES (?,?,?,?,?,?,?)`,
    Number(params.id), n, b.name || `Спринт ${n}`, b.goal || null, b.starts_at || null, b.ends_at || null, b.status || 'planned');
  logAction(user.id, 'sprint.create', 'sprint', id, null, ip);
  sendJson(201, q.get('SELECT * FROM sprints WHERE id=?', id));
});

route.post('/api/projects/:id/items', async ({ req, user, params, ip, sendJson }) => {
  if (!can(user, 'board.manage')) throw new HttpError(403, 'Задачи доски ведёт команда разработки');
  const b = await readJson(req);
  if (!b.title) throw new HttpError(400, 'Укажите название задачи');
  const order = (q.get('SELECT COALESCE(MAX(order_idx),0) AS m FROM board_items WHERE project_id=?', Number(params.id)).m) + 1;
  const id = q.insert(`INSERT INTO board_items (project_id, sprint_id, title, description, type, status, priority, estimate, assignee_id, order_idx)
                       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    Number(params.id), b.sprint_id || null, b.title, b.description || null, b.type || 'task',
    b.status || 'backlog', b.priority || 'normal', Number(b.estimate) || 0, b.assignee_id || null, order);
  logAction(user.id, 'board.item.create', 'board_item', id, null, ip);
  sendJson(201, q.get('SELECT * FROM board_items WHERE id=?', id));
});

route.patch('/api/board-items/:id', async ({ req, user, params, ip, sendJson }) => {
  if (!can(user, 'board.manage')) throw new HttpError(403, 'Недостаточно прав');
  const b = await readJson(req);
  const fields = ['title', 'description', 'type', 'status', 'priority', 'estimate', 'assignee_id', 'sprint_id', 'order_idx'];
  const sets = [], args = [];
  for (const f of fields) if (b[f] !== undefined) { sets.push(`${f}=?`); args.push(b[f]); }
  if (!sets.length) throw new HttpError(400, 'Нет полей для обновления');
  q.run(`UPDATE board_items SET ${sets.join(', ')}, updated_at=datetime('now') WHERE id=?`, ...args, Number(params.id));
  logAction(user.id, 'board.item.update', 'board_item', Number(params.id), b, ip);
  sendJson(200, q.get('SELECT * FROM board_items WHERE id=?', Number(params.id)));
});

route.delete('/api/board-items/:id', async ({ user, params, ip, sendJson }) => {
  if (!can(user, 'board.manage')) throw new HttpError(403, 'Недостаточно прав');
  q.run('DELETE FROM board_items WHERE id=?', Number(params.id));
  logAction(user.id, 'board.item.delete', 'board_item', Number(params.id), null, ip);
  sendJson(200, { ok: true });
});

// ── Хранилище документов ─────────────────────────────────────
route.post('/api/projects/:id/documents', async ({ req, user, params, ip, sendJson }) => {
  if (!can(user, 'docs.manage')) throw new HttpError(403, 'Недостаточно прав');
  const b = await readJson(req);
  if (!b.title) throw new HttpError(400, 'Укажите название документа');
  const proj = q.get('SELECT * FROM projects WHERE id=?', Number(params.id));
  const id = q.insert(`INSERT INTO documents (initiative_id, project_id, title, kind, body, created_by)
                       VALUES (?,?,?,?,?,?)`, proj?.initiative_id || null, Number(params.id), b.title, b.kind || 'doc', b.body || '', user.id);
  logAction(user.id, 'document.create', 'document', id, null, ip);
  sendJson(201, q.get('SELECT * FROM documents WHERE id=?', id));
});
