// Модуль пилотирования: заявки площадок, ход пилота, KPI, опросы и обратная связь.
import { route, readJson, HttpError } from '../http.js';
import { q } from '../db.js';
import { can } from '../auth.js';
import { logAction } from '../audit.js';
import { notify, notifyRole } from '../workflow.js';
import { analyzeFeedback } from '../ai.js';

route.get('/api/pilots', async ({ url, sendJson }) => {
  const where = [], args = [];
  if (url.searchParams.get('status')) { where.push('p.status = ?'); args.push(url.searchParams.get('status')); }
  if (url.searchParams.get('initiative')) { where.push('p.initiative_id = ?'); args.push(Number(url.searchParams.get('initiative'))); }
  sendJson(200, q.all(`
    SELECT p.*, i.number, i.title AS initiative_title, i.stage,
           inst.short_name AS institution_short, inst.name AS institution_name,
           u.full_name AS coordinator_name,
           (SELECT COUNT(*) FROM surveys s WHERE s.pilot_id = p.id) AS surveys_count,
           (SELECT COUNT(*) FROM survey_responses r JOIN surveys s ON s.id = r.survey_id WHERE s.pilot_id = p.id) AS responses_count
    FROM pilots p
    JOIN initiatives i ON i.id = p.initiative_id
    JOIN institutions inst ON inst.id = p.institution_id
    LEFT JOIN users u ON u.id = p.coordinator_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY p.created_at DESC`, ...args));
});

// Учреждение заявляет себя площадкой для конкретной инициативы
route.post('/api/pilot-applications', async ({ req, user, ip, sendJson }) => {
  if (!can(user, 'pilot.apply') && !can(user, 'pilot.manage')) throw new HttpError(403, 'Заявку подаёт руководитель учреждения');
  const b = await readJson(req);
  const init = q.get('SELECT * FROM initiatives WHERE id=?', Number(b.initiative_id));
  if (!init) throw new HttpError(404, 'Инициатива не найдена');
  const instId = Number(b.institution_id) || user.institution_id;
  if (q.get('SELECT id FROM pilot_applications WHERE initiative_id=? AND institution_id=?', init.id, instId)) {
    throw new HttpError(409, 'Заявка от этого учреждения уже подана');
  }
  const id = q.insert(`INSERT INTO pilot_applications (initiative_id, institution_id, applicant_id, message)
                       VALUES (?,?,?,?)`, init.id, instId, user.id, b.message || null);
  logAction(user.id, 'pilot.apply', 'initiative', init.id, { institution: instId }, ip);
  notifyRole('dtszn', null, init.id, 'pilot_application',
    `Заявка на пилотирование ${init.number}`, `${user.institution_name || 'Учреждение'} готово стать пилотной площадкой.`);
  sendJson(201, q.get('SELECT * FROM pilot_applications WHERE id=?', id));
});

route.get('/api/pilot-applications', async ({ url, sendJson }) => {
  const initiative = url.searchParams.get('initiative');
  sendJson(200, q.all(`
    SELECT a.*, inst.short_name AS institution_short, inst.name AS institution_name,
           u.full_name AS applicant_name, i.number, i.title AS initiative_title
    FROM pilot_applications a
    JOIN institutions inst ON inst.id = a.institution_id
    JOIN users u ON u.id = a.applicant_id
    JOIN initiatives i ON i.id = a.initiative_id
    ${initiative ? 'WHERE a.initiative_id = ?' : ''}
    ORDER BY a.created_at DESC`, ...(initiative ? [Number(initiative)] : [])));
});

route.post('/api/pilot-applications/:id/approve', async ({ req, user, params, ip, sendJson }) => {
  if (!can(user, 'pilot.manage')) throw new HttpError(403, 'Решение принимает координатор пилотов или ДТСЗН');
  const app = q.get('SELECT * FROM pilot_applications WHERE id=?', Number(params.id));
  if (!app) throw new HttpError(404, 'Заявка не найдена');
  const b = await readJson(req);
  q.run("UPDATE pilot_applications SET status='approved' WHERE id=?", app.id);
  const starts = b.starts_at || new Date().toISOString().slice(0, 10);
  const ends = b.ends_at || new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const pilotId = q.insert(`INSERT INTO pilots (initiative_id, institution_id, coordinator_id, plan, status, starts_at, ends_at)
                            VALUES (?,?,?,?,?,?,?)`,
    app.initiative_id, app.institution_id, user.id, b.plan || null, 'planned', starts, ends);
  logAction(user.id, 'pilot.approve', 'pilot', pilotId, { application: app.id }, ip);
  notify(app.applicant_id, app.initiative_id, 'pilot_approved', 'Заявка на пилотирование одобрена',
    `Пилот запланирован с ${starts} по ${ends}.`);
  sendJson(201, q.get('SELECT * FROM pilots WHERE id=?', pilotId));
});

route.get('/api/pilots/:id', async ({ params, sendJson }) => {
  const p = q.get(`SELECT p.*, i.number, i.title AS initiative_title, i.expected_effect, i.stage,
                          inst.short_name AS institution_short, inst.name AS institution_name,
                          u.full_name AS coordinator_name
                   FROM pilots p JOIN initiatives i ON i.id = p.initiative_id
                   JOIN institutions inst ON inst.id = p.institution_id
                   LEFT JOIN users u ON u.id = p.coordinator_id WHERE p.id = ?`, Number(params.id));
  if (!p) throw new HttpError(404, 'Пилот не найден');
  const kpis = q.all('SELECT * FROM pilot_kpis WHERE pilot_id=? ORDER BY id', p.id);
  const surveys = q.all(`SELECT s.*, (SELECT COUNT(*) FROM survey_responses r WHERE r.survey_id = s.id) AS responses
                         FROM surveys s WHERE s.pilot_id=? ORDER BY s.id`, p.id);
  // Свободные текстовые ответы → NLP-анализ
  const texts = q.all(`SELECT a.value_text FROM survey_answers a
                       JOIN survey_responses r ON r.id = a.response_id
                       JOIN surveys s ON s.id = r.survey_id
                       WHERE s.pilot_id = ? AND a.value_text IS NOT NULL AND a.value_text != ''`, p.id)
                 .map((r) => r.value_text);
  sendJson(200, { ...p, kpis, surveys, feedback_analysis: analyzeFeedback(texts) });
});

route.patch('/api/pilots/:id', async ({ req, user, params, ip, sendJson }) => {
  if (!can(user, 'pilot.manage')) throw new HttpError(403, 'Недостаточно прав');
  const b = await readJson(req);
  const fields = ['status', 'plan', 'starts_at', 'ends_at', 'participants_count'];
  const sets = [], args = [];
  for (const f of fields) if (b[f] !== undefined) { sets.push(`${f}=?`); args.push(b[f]); }
  if (!sets.length) throw new HttpError(400, 'Нет полей для обновления');
  q.run(`UPDATE pilots SET ${sets.join(', ')} WHERE id=?`, ...args, Number(params.id));
  logAction(user.id, 'pilot.update', 'pilot', Number(params.id), b, ip);
  sendJson(200, q.get('SELECT * FROM pilots WHERE id=?', Number(params.id)));
});

// ── KPI пилота ───────────────────────────────────────────────
route.post('/api/pilots/:id/kpis', async ({ req, user, params, ip, sendJson }) => {
  if (!can(user, 'pilot.manage')) throw new HttpError(403, 'Недостаточно прав');
  const b = await readJson(req);
  if (!b.name) throw new HttpError(400, 'Укажите название показателя');
  const id = q.insert(`INSERT INTO pilot_kpis (pilot_id, name, unit, baseline, target, actual, direction)
                       VALUES (?,?,?,?,?,?,?)`,
    Number(params.id), b.name, b.unit || null, b.baseline ?? null, b.target ?? null, b.actual ?? null, b.direction || 'up');
  logAction(user.id, 'pilot.kpi.create', 'pilot', Number(params.id), b, ip);
  sendJson(201, q.get('SELECT * FROM pilot_kpis WHERE id=?', id));
});

route.patch('/api/pilot-kpis/:id', async ({ req, user, params, ip, sendJson }) => {
  if (!can(user, 'pilot.manage')) throw new HttpError(403, 'Недостаточно прав');
  const b = await readJson(req);
  const sets = [], args = [];
  for (const f of ['name', 'unit', 'baseline', 'target', 'actual', 'direction']) {
    if (b[f] !== undefined) { sets.push(`${f}=?`); args.push(b[f]); }
  }
  if (!sets.length) throw new HttpError(400, 'Нет полей для обновления');
  q.run(`UPDATE pilot_kpis SET ${sets.join(', ')}, updated_at=datetime('now') WHERE id=?`, ...args, Number(params.id));
  logAction(user.id, 'pilot.kpi.update', 'pilot_kpi', Number(params.id), b, ip);
  sendJson(200, q.get('SELECT * FROM pilot_kpis WHERE id=?', Number(params.id)));
});

// ── Опросы и обратная связь ──────────────────────────────────
route.post('/api/surveys', async ({ req, user, ip, sendJson }) => {
  if (!can(user, 'survey.manage') && !can(user, 'pilot.manage')) throw new HttpError(403, 'Недостаточно прав');
  const b = await readJson(req);
  if (!b.title) throw new HttpError(400, 'Укажите название опроса');
  const id = q.insert(`INSERT INTO surveys (pilot_id, initiative_id, title, audience, created_by)
                       VALUES (?,?,?,?,?)`, b.pilot_id || null, b.initiative_id || null, b.title, b.audience || 'staff', user.id);
  for (const [i, qq] of (b.questions || []).entries()) {
    q.run(`INSERT INTO survey_questions (survey_id, text, type, options, order_idx) VALUES (?,?,?,?,?)`,
      id, qq.text, qq.type || 'scale', JSON.stringify(qq.options || []), i);
  }
  logAction(user.id, 'survey.create', 'survey', id, null, ip);
  sendJson(201, q.get('SELECT * FROM surveys WHERE id=?', id));
});

route.get('/api/surveys/:id', async ({ user, params, sendJson }) => {
  const s = q.get('SELECT * FROM surveys WHERE id=?', Number(params.id));
  if (!s) throw new HttpError(404, 'Опрос не найден');
  const questions = q.all('SELECT * FROM survey_questions WHERE survey_id=? ORDER BY order_idx', s.id)
    .map((x) => ({ ...x, options: JSON.parse(x.options || '[]') }));
  const answered = !!q.get('SELECT id FROM survey_responses WHERE survey_id=? AND respondent_id=?', s.id, user.id);
  const results = questions.map((qq) => {
    if (qq.type === 'scale') {
      const r = q.get(`SELECT AVG(value_num) AS avg, COUNT(*) AS n FROM survey_answers WHERE question_id=?`, qq.id);
      return { question_id: qq.id, type: 'scale', avg: r.avg ? Math.round(r.avg * 10) / 10 : null, n: r.n };
    }
    if (qq.type === 'choice') {
      return { question_id: qq.id, type: 'choice',
        distribution: q.all(`SELECT value_text AS option, COUNT(*) AS n FROM survey_answers
                             WHERE question_id=? GROUP BY value_text ORDER BY n DESC`, qq.id) };
    }
    const texts = q.all(`SELECT value_text FROM survey_answers WHERE question_id=? AND value_text IS NOT NULL`, qq.id).map((r) => r.value_text);
    return { question_id: qq.id, type: 'text', samples: texts.slice(0, 20), analysis: analyzeFeedback(texts) };
  });
  sendJson(200, { ...s, questions, answered, responses: q.get('SELECT COUNT(*) AS c FROM survey_responses WHERE survey_id=?', s.id).c, results });
});

route.post('/api/surveys/:id/respond', async ({ req, user, params, ip, sendJson }) => {
  const s = q.get('SELECT * FROM surveys WHERE id=?', Number(params.id));
  if (!s) throw new HttpError(404, 'Опрос не найден');
  if (!s.is_open) throw new HttpError(400, 'Опрос закрыт');
  if (q.get('SELECT id FROM survey_responses WHERE survey_id=? AND respondent_id=?', s.id, user.id)) {
    throw new HttpError(409, 'Вы уже отвечали на этот опрос');
  }
  const b = await readJson(req);
  const rid = q.insert('INSERT INTO survey_responses (survey_id, respondent_id) VALUES (?,?)', s.id, user.id);
  for (const a of b.answers || []) {
    q.run('INSERT INTO survey_answers (response_id, question_id, value_num, value_text) VALUES (?,?,?,?)',
      rid, Number(a.question_id), a.value_num ?? null, a.value_text ?? null);
  }
  logAction(user.id, 'survey.respond', 'survey', s.id, null, ip);
  sendJson(201, { ok: true });
});

route.get('/api/surveys', async ({ url, sendJson }) => {
  const pilot = url.searchParams.get('pilot');
  sendJson(200, q.all(`SELECT s.*, (SELECT COUNT(*) FROM survey_responses r WHERE r.survey_id=s.id) AS responses
                       FROM surveys s ${pilot ? 'WHERE s.pilot_id = ?' : ''} ORDER BY s.created_at DESC`,
    ...(pilot ? [Number(pilot)] : [])));
});
