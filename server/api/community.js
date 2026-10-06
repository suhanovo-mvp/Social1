// Сообщество: форумы, профили, лучшие практики, масштабирование, признание.
import { route, readJson, HttpError } from '../http.js';
import { q } from '../db.js';
import { can, roleTitle } from '../auth.js';
import { logAction } from '../audit.js';
import { grantAward, notifyRole } from '../workflow.js';

// ── Форум ────────────────────────────────────────────────────
route.get('/api/forum/topics', async ({ url, sendJson }) => {
  const cat = url.searchParams.get('category');
  sendJson(200, q.all(`
    SELECT t.*, u.full_name AS author_name, u.role AS author_role, inst.short_name AS institution,
           i.number AS initiative_number,
           (SELECT COUNT(*) FROM forum_posts p WHERE p.topic_id = t.id) AS replies,
           (SELECT MAX(p.created_at) FROM forum_posts p WHERE p.topic_id = t.id) AS last_activity
    FROM forum_topics t JOIN users u ON u.id = t.author_id
    LEFT JOIN institutions inst ON inst.id = u.institution_id
    LEFT JOIN initiatives i ON i.id = t.initiative_id
    ${cat ? 'WHERE t.category = ?' : ''}
    ORDER BY t.is_pinned DESC, COALESCE(last_activity, t.created_at) DESC`, ...(cat ? [cat] : [])));
});

route.post('/api/forum/topics', async ({ req, user, ip, sendJson }) => {
  if (!can(user, 'community')) throw new HttpError(403, 'Недостаточно прав');
  const b = await readJson(req);
  if (!b.title || !b.body) throw new HttpError(400, 'Укажите тему и текст сообщения');
  const id = q.insert(`INSERT INTO forum_topics (title, category, author_id, initiative_id) VALUES (?,?,?,?)`,
    b.title, b.category || 'general', user.id, b.initiative_id || null);
  q.run('INSERT INTO forum_posts (topic_id, author_id, body) VALUES (?,?,?)', id, user.id, b.body);
  logAction(user.id, 'forum.topic.create', 'forum_topic', id, null, ip);
  sendJson(201, q.get('SELECT * FROM forum_topics WHERE id=?', id));
});

route.get('/api/forum/topics/:id', async ({ params, sendJson }) => {
  const t = q.get(`SELECT t.*, u.full_name AS author_name, i.number AS initiative_number
                   FROM forum_topics t JOIN users u ON u.id=t.author_id
                   LEFT JOIN initiatives i ON i.id=t.initiative_id WHERE t.id=?`, Number(params.id));
  if (!t) throw new HttpError(404, 'Тема не найдена');
  const posts = q.all(`SELECT p.*, u.full_name AS author_name, u.role AS author_role, inst.short_name AS institution
                       FROM forum_posts p JOIN users u ON u.id=p.author_id
                       LEFT JOIN institutions inst ON inst.id=u.institution_id
                       WHERE p.topic_id=? ORDER BY p.created_at ASC`, t.id);
  sendJson(200, { ...t, posts });
});

route.post('/api/forum/topics/:id/posts', async ({ req, user, params, ip, sendJson }) => {
  if (!can(user, 'community')) throw new HttpError(403, 'Недостаточно прав');
  const { body } = await readJson(req);
  if (!body || body.trim().length < 2) throw new HttpError(400, 'Пустое сообщение');
  const id = q.insert('INSERT INTO forum_posts (topic_id, author_id, body) VALUES (?,?,?)', Number(params.id), user.id, body.trim());
  logAction(user.id, 'forum.post.create', 'forum_post', id, null, ip);
  sendJson(201, q.get(`SELECT p.*, u.full_name AS author_name, u.role AS author_role
                       FROM forum_posts p JOIN users u ON u.id=p.author_id WHERE p.id=?`, id));
});

// ── Профили участников ───────────────────────────────────────
route.get('/api/users/:id', async ({ params, sendJson }) => {
  const u = q.get(`SELECT u.id, u.full_name, u.role, u.position, u.expertise, u.created_at,
                          inst.name AS institution_name, inst.short_name AS institution_short
                   FROM users u LEFT JOIN institutions inst ON inst.id=u.institution_id WHERE u.id=?`, Number(params.id));
  if (!u) throw new HttpError(404, 'Пользователь не найден');
  const initiatives = q.all(`SELECT id, number, title, stage, status, created_at FROM initiatives
                             WHERE author_id=? ORDER BY created_at DESC LIMIT 20`, u.id);
  const awards = q.all(`SELECT a.*, i.number FROM awards a LEFT JOIN initiatives i ON i.id=a.initiative_id
                        WHERE a.user_id=? ORDER BY a.granted_at DESC`, u.id);
  const decisions = q.get('SELECT COUNT(*) AS c FROM gate_decisions WHERE decided_by=?', u.id).c;
  sendJson(200, { ...u, role_title: roleTitle(u.role), initiatives, awards, decisions_made: decisions });
});

route.get('/api/users', async ({ url, sendJson }) => {
  const role = url.searchParams.get('role');
  sendJson(200, q.all(`SELECT u.id, u.full_name, u.role, u.position, inst.short_name AS institution
                       FROM users u LEFT JOIN institutions inst ON inst.id=u.institution_id
                       WHERE u.is_active=1 ${role ? 'AND u.role = ?' : ''} ORDER BY u.full_name`,
    ...(role ? [role] : [])));
});

// ── Лучшие практики («внутренний рынок» решений) ─────────────
route.get('/api/best-practices', async ({ sendJson }) => {
  sendJson(200, q.all(`
    SELECT bp.*, i.number, i.category, i.effect_value, i.effect_unit, i.title AS initiative_title,
           u.full_name AS author_name, inst.short_name AS origin_institution,
           (SELECT COUNT(*) FROM rollouts r WHERE r.initiative_id = bp.initiative_id AND r.status='deployed') AS adoptions
    FROM best_practices bp
    JOIN initiatives i ON i.id = bp.initiative_id
    JOIN users u ON u.id = i.author_id
    JOIN institutions inst ON inst.id = i.institution_id
    ORDER BY bp.published_at DESC`));
});

route.post('/api/best-practices', async ({ req, user, ip, sendJson }) => {
  if (!can(user, 'bestpractice.publish')) throw new HttpError(403, 'Публикует эксперт ДТСЗН или координатор');
  const b = await readJson(req);
  const init = q.get('SELECT * FROM initiatives WHERE id=?', Number(b.initiative_id));
  if (!init) throw new HttpError(404, 'Инициатива не найдена');
  const id = q.insert(`INSERT INTO best_practices (initiative_id, title, summary, materials, effect_text, published_by)
                       VALUES (?,?,?,?,?,?)`,
    init.id, b.title || init.title, b.summary || init.expected_effect, b.materials || null, b.effect_text || null, user.id);
  logAction(user.id, 'bestpractice.publish', 'best_practice', id, { initiative: init.number }, ip);
  grantAward(init.author_id, init.id, 'author', 'Практика включена в библиотеку лучших решений', user.id);
  sendJson(201, q.get('SELECT * FROM best_practices WHERE id=?', id));
});

// ── Масштабирование: внедрение в других учреждениях ──────────
route.get('/api/rollouts', async ({ url, sendJson }) => {
  const initiative = url.searchParams.get('initiative');
  sendJson(200, q.all(`
    SELECT r.*, inst.short_name AS institution_short, inst.name AS institution_name,
           i.number, i.title AS initiative_title
    FROM rollouts r JOIN institutions inst ON inst.id=r.institution_id
    JOIN initiatives i ON i.id=r.initiative_id
    ${initiative ? 'WHERE r.initiative_id = ?' : ''}
    ORDER BY r.created_at DESC`, ...(initiative ? [Number(initiative)] : [])));
});

route.post('/api/rollouts', async ({ req, user, ip, sendJson }) => {
  if (!can(user, 'rollout.manage')) throw new HttpError(403, 'Внедрение оформляет руководитель учреждения или ДТСЗН');
  const b = await readJson(req);
  const init = q.get('SELECT * FROM initiatives WHERE id=?', Number(b.initiative_id));
  if (!init) throw new HttpError(404, 'Инициатива не найдена');
  const instId = Number(b.institution_id) || user.institution_id;
  if (q.get('SELECT id FROM rollouts WHERE initiative_id=? AND institution_id=?', init.id, instId)) {
    throw new HttpError(409, 'Внедрение в этом учреждении уже зарегистрировано');
  }
  // Инициатива, взятая учреждением самостоятельно, отмечается как bottom-up
  const bottomUp = user.role === 'head' ? 1 : (b.bottom_up ? 1 : 0);
  const id = q.insert(`INSERT INTO rollouts (initiative_id, institution_id, status, bottom_up, started_at)
                       VALUES (?,?,?,?,datetime('now'))`, init.id, instId, b.status || 'planned', bottomUp);
  logAction(user.id, 'rollout.create', 'rollout', id, { initiative: init.number, bottom_up: bottomUp }, ip);
  sendJson(201, q.get('SELECT * FROM rollouts WHERE id=?', id));
});

route.patch('/api/rollouts/:id', async ({ req, user, params, ip, sendJson }) => {
  if (!can(user, 'rollout.manage')) throw new HttpError(403, 'Недостаточно прав');
  const b = await readJson(req);
  if (!b.status) throw new HttpError(400, 'Укажите статус');
  q.run(`UPDATE rollouts SET status=?, completed_at = CASE WHEN ?='deployed' THEN datetime('now') ELSE completed_at END
         WHERE id=?`, b.status, b.status, Number(params.id));
  logAction(user.id, 'rollout.update', 'rollout', Number(params.id), b, ip);
  sendJson(200, q.get('SELECT * FROM rollouts WHERE id=?', Number(params.id)));
});

// ── Учреждения ───────────────────────────────────────────────
route.get('/api/institutions', async ({ sendJson }) => {
  sendJson(200, q.all(`SELECT * FROM institutions ORDER BY kind, name`));
});

// ── Признание ────────────────────────────────────────────────
route.post('/api/awards', async ({ req, user, ip, sendJson }) => {
  if (!can(user, 'awards.grant')) throw new HttpError(403, 'Награды присваивает ДТСЗН');
  const b = await readJson(req);
  if (!b.user_id || !b.title) throw new HttpError(400, 'Укажите получателя и формулировку');
  grantAward(Number(b.user_id), b.initiative_id ? Number(b.initiative_id) : null, b.type || 'author', b.title, user.id);
  logAction(user.id, 'award.grant', 'user', Number(b.user_id), b, ip);
  sendJson(201, { ok: true });
});
