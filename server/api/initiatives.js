import { route, readJson, HttpError } from '../http.js';
import { q, tx } from '../db.js';
import { can } from '../auth.js';
import { logAction } from '../audit.js';
import {
  stages, stageConfig, slaState, submitInitiative, decideGate, canDecide, notify,
} from '../workflow.js';
import { classify, findSimilar, predictSuccess } from '../ai.js';

function nextNumber() {
  const year = new Date().getFullYear();
  const last = q.get("SELECT number FROM initiatives WHERE number LIKE ? ORDER BY id DESC LIMIT 1", `SOC-${year}-%`);
  const seq = last ? Number(last.number.split('-')[2]) + 1 : 1;
  return `SOC-${year}-${String(seq).padStart(4, '0')}`;
}

const SELECT_LIST = `
  SELECT i.*, u.full_name AS author_name, inst.short_name AS institution_short, inst.name AS institution_name,
         (SELECT COUNT(*) FROM comments c WHERE c.initiative_id = i.id) AS comments_count,
         (SELECT COALESCE(SUM(v.value), 0) FROM votes v WHERE v.initiative_id = i.id) AS votes_score,
         (SELECT COUNT(*) FROM votes v WHERE v.initiative_id = i.id AND v.value = 1) AS votes_up,
         (SELECT COUNT(*) FROM votes v WHERE v.initiative_id = i.id AND v.value = -1) AS votes_down,
         (SELECT COUNT(*) FROM follows f WHERE f.initiative_id = i.id) AS followers
  FROM initiatives i
  JOIN users u ON u.id = i.author_id
  JOIN institutions inst ON inst.id = i.institution_id`;

/**
 * Публичный статус для доски идей — понятная формулировка вместо номера этапа.
 * Внутренняя механика Stage-Gate остаётся в карточке инициативы.
 */
export function publicStatus(row) {
  if (row.status === 'scaled') return { key: 'scaled', title: 'Внедрено', tone: 'ok' };
  if (row.status === 'killed') return { key: 'killed', title: 'Отклонено', tone: 'muted' };
  if (row.status === 'hold') return { key: 'hold', title: 'Приостановлено', tone: 'warn' };
  if (row.stage <= 3) return { key: 'review', title: 'На рассмотрении', tone: 'info' };
  if (row.stage === 4) return { key: 'development', title: 'В разработке', tone: 'accent' };
  if (row.stage === 5) return { key: 'pilot', title: 'Пилотируется', tone: 'purple' };
  return { key: 'scaling', title: 'Готовится к тиражированию', tone: 'ok' };
}

/** Голоса текущего пользователя по списку инициатив — одним запросом. */
function myVotes(userId, ids) {
  if (!ids.length) return {};
  const rows = q.all(
    `SELECT initiative_id, value FROM votes WHERE user_id = ? AND initiative_id IN (${ids.map(() => '?').join(',')})`,
    userId, ...ids);
  return Object.fromEntries(rows.map((r) => [r.initiative_id, r.value]));
}

function decorate(row) {
  const cfg = stageConfig(row.stage);
  return {
    ...row,
    tags: JSON.parse(row.tags || '[]'),
    stage_name: cfg?.stage_name,
    tz_stage: cfg?.tz_stage,
    tz_stage_name: cfg?.tz_stage_name,
    gate_no: cfg?.gate_no,
    gate_name: cfg?.gate_name,
    sla: slaState(row),
    public_status: publicStatus(row),
  };
}

// ── Справочник этапов ────────────────────────────────────────
route.get('/api/workflow/stages', async ({ sendJson }) => sendJson(200, stages()));

// ── Список инициатив с фильтрами и поиском ───────────────────
route.get('/api/initiatives', async ({ user, url, sendJson }) => {
  const p = url.searchParams;
  const where = [];
  const args = [];
  if (p.get('stage')) { where.push('i.stage = ?'); args.push(Number(p.get('stage'))); }
  if (p.get('status')) { where.push('i.status = ?'); args.push(p.get('status')); }
  if (p.get('category')) { where.push('i.category = ?'); args.push(p.get('category')); }
  if (p.get('institution')) { where.push('i.institution_id = ?'); args.push(Number(p.get('institution'))); }
  if (p.get('author')) { where.push('i.author_id = ?'); args.push(Number(p.get('author'))); }
  if (p.get('mine') === '1') { where.push('i.author_id = ?'); args.push(user.id); }
  if (p.get('q')) {
    where.push('(i.title LIKE ? OR i.problem LIKE ? OR i.solution LIKE ? OR i.number LIKE ?)');
    const like = `%${p.get('q')}%`;
    args.push(like, like, like, like);
  }
  // Поставщик видит только инициативы, дошедшие до разработки
  if (user.role === 'supplier') where.push('i.stage >= 4');

  const sort = {
    new: 'i.created_at DESC', old: 'i.created_at ASC',
    stage: 'i.stage DESC, i.created_at DESC', sla: 'i.sla_due_at ASC',
    votes: 'votes_score DESC, i.created_at DESC',
    discussed: 'comments_count DESC, votes_score DESC',
    // «Набирают поддержку» — голоса, взвешенные по свежести инициативы
    trending: "(votes_score * 1.0) / (1 + (julianday('now') - julianday(i.created_at)) / 14.0) DESC",
  }[p.get('sort') || 'new'] || 'i.created_at DESC';
  const limit = Math.min(200, Number(p.get('limit')) || 50);
  const offset = Number(p.get('offset')) || 0;

  const sql = `${SELECT_LIST} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${sort} LIMIT ? OFFSET ?`;
  const rows = q.all(sql, ...args, limit, offset).map(decorate);
  const mine = myVotes(user.id, rows.map((r) => r.id));
  for (const r of rows) r.my_vote = mine[r.id] || 0;
  const total = q.get(`SELECT COUNT(*) AS c FROM initiatives i ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`, ...args).c;
  sendJson(200, { items: rows, total, limit, offset });
});

// ── Создание инициативы ──────────────────────────────────────
route.post('/api/initiatives', async ({ req, user, ip, sendJson }) => {
  if (!can(user, 'initiative.create')) throw new HttpError(403, 'Роль не может подавать инициативы');
  const b = await readJson(req);
  const required = { title: 'Название', problem: 'Описание проблемы', solution: 'Предлагаемое решение', expected_effect: 'Прогнозируемый эффект' };
  for (const [k, label] of Object.entries(required)) {
    if (!b[k] || String(b[k]).trim().length < 5) throw new HttpError(400, `Заполните поле «${label}»`);
  }

  const ai = classify(`${b.title} ${b.problem} ${b.solution}`);
  const category = b.category || ai.category;

  const id = tx(() => {
    const number = nextNumber();
    const newId = q.insert(`INSERT INTO initiatives
      (number, title, problem, solution, expected_effect, effect_type, effect_value, effect_unit,
       category, tags, author_id, institution_id, stage, ai_category, ai_score, ai_rationale)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`,
      number, b.title.trim(), b.problem.trim(), b.solution.trim(), b.expected_effect.trim(),
      b.effect_type || null, b.effect_value ? Number(b.effect_value) : null, b.effect_unit || null,
      category, JSON.stringify(b.tags || []), user.id, user.institution_id,
      ai.category, ai.confidence, ai.rationale);

    for (const link of (b.links || []).filter(Boolean)) {
      q.run(`INSERT INTO attachments (initiative_id, filename, kind, url, uploaded_by) VALUES (?,?,'link',?,?)`,
        newId, link.slice(0, 200), link, user.id);
    }
    return newId;
  });

  logAction(user.id, 'initiative.create', 'initiative', id, { number: q.get('SELECT number FROM initiatives WHERE id=?', id).number }, ip);
  submitInitiative(id, user.id);
  const row = q.get(`${SELECT_LIST} WHERE i.id = ?`, id);
  sendJson(201, decorate(row));
});

// ── Карточка инициативы: полный жизненный цикл ───────────────
route.get('/api/initiatives/:id', async ({ user, params, sendJson }) => {
  const row = q.get(`${SELECT_LIST} WHERE i.id = ?`, Number(params.id));
  if (!row) throw new HttpError(404, 'Инициатива не найдена');

  const decisions = q.all(`SELECT g.*, u.full_name AS decided_by_name, u.role AS decided_by_role
                           FROM gate_decisions g JOIN users u ON u.id = g.decided_by
                           WHERE g.initiative_id = ? ORDER BY g.decided_at ASC`, row.id)
    .map((d) => ({ ...d, criteria_scores: JSON.parse(d.criteria_scores || '{}') }));

  const transitions = q.all(`SELECT t.*, u.full_name AS by_name FROM stage_transitions t
                             LEFT JOIN users u ON u.id = t.by_user
                             WHERE t.initiative_id = ? ORDER BY t.at ASC`, row.id);

  const comments = q.all(`SELECT c.*, u.full_name AS author_name, u.role AS author_role
                          FROM comments c JOIN users u ON u.id = c.author_id
                          WHERE c.initiative_id = ? ORDER BY c.created_at ASC`, row.id);

  const attachments = q.all(`SELECT id, filename, mime, size, kind, url, created_at FROM attachments
                             WHERE initiative_id = ?`, row.id);

  const project = q.get(`SELECT p.*, po.full_name AS product_owner_name, tl.full_name AS team_lead_name
                         FROM projects p LEFT JOIN users po ON po.id = p.product_owner_id
                         LEFT JOIN users tl ON tl.id = p.team_lead_id WHERE p.initiative_id = ?`, row.id);

  const pilots = q.all(`SELECT p.*, i.short_name AS institution_short, i.name AS institution_name
                        FROM pilots p JOIN institutions i ON i.id = p.institution_id
                        WHERE p.initiative_id = ?`, row.id);

  const rollouts = q.all(`SELECT r.*, i.short_name AS institution_short FROM rollouts r
                          JOIN institutions i ON i.id = r.institution_id WHERE r.initiative_id = ?`, row.id);

  const gate = canDecide(user, row);
  const cfg = stageConfig(row.stage);
  const myVote = q.get('SELECT value FROM votes WHERE initiative_id=? AND user_id=?', row.id, user.id);
  const following = !!q.get('SELECT id FROM follows WHERE initiative_id=? AND user_id=?', row.id, user.id);
  const voters = q.all(`SELECT u.id, u.full_name, u.role, v.value, inst.short_name AS institution
                        FROM votes v JOIN users u ON u.id = v.user_id
                        LEFT JOIN institutions inst ON inst.id = u.institution_id
                        WHERE v.initiative_id = ? ORDER BY v.created_at DESC LIMIT 40`, row.id);

  sendJson(200, {
    ...decorate(row),
    decisions, transitions, comments, attachments, project, pilots, rollouts,
    stage_config: cfg,
    can_decide: gate.ok,
    decide_reason: gate.reason || null,
    is_author: row.author_id === user.id,
    my_vote: myVote?.value || 0,
    following,
    voters,
  });
});

// ── Редактирование (автором до выхода из оценки) ─────────────
route.patch('/api/initiatives/:id', async ({ req, user, params, ip, sendJson }) => {
  const row = q.get('SELECT * FROM initiatives WHERE id = ?', Number(params.id));
  if (!row) throw new HttpError(404, 'Инициатива не найдена');
  const isOwner = row.author_id === user.id;
  if (!isOwner && user.role !== 'dtszn') throw new HttpError(403, 'Редактировать может автор или координатор ДТСЗН');
  if (isOwner && row.stage > 3) throw new HttpError(403, 'После перехода в разработку правки вносит команда проекта');

  const b = await readJson(req);
  const fields = ['title', 'problem', 'solution', 'expected_effect', 'effect_type', 'effect_value', 'effect_unit', 'category', 'priority'];
  const sets = [], args = [];
  for (const f of fields) if (b[f] !== undefined) { sets.push(`${f} = ?`); args.push(b[f]); }
  if (b.tags) { sets.push('tags = ?'); args.push(JSON.stringify(b.tags)); }
  if (!sets.length) throw new HttpError(400, 'Нет полей для обновления');
  q.run(`UPDATE initiatives SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...args, row.id);
  logAction(user.id, 'initiative.update', 'initiative', row.id, b, ip);
  sendJson(200, decorate(q.get(`${SELECT_LIST} WHERE i.id = ?`, row.id)));
});

// ── Решение на Gate ──────────────────────────────────────────
route.post('/api/initiatives/:id/gate', async ({ req, user, params, ip, sendJson }) => {
  const b = await readJson(req);
  const updated = decideGate({
    user, initiativeId: Number(params.id), decision: b.decision,
    rationale: b.rationale, criteriaScores: b.criteria_scores, redirectTo: b.redirect_to, ip,
  });
  sendJson(200, decorate(q.get(`${SELECT_LIST} WHERE i.id = ?`, updated.id)));
});

// ── Возврат из Hold ──────────────────────────────────────────
route.post('/api/initiatives/:id/resume', async ({ req, user, params, ip, sendJson }) => {
  const row = q.get('SELECT * FROM initiatives WHERE id = ?', Number(params.id));
  if (!row) throw new HttpError(404, 'Инициатива не найдена');
  if (row.status !== 'hold') throw new HttpError(400, 'Инициатива не находится в статусе «приостановлена»');
  const cfg = stageConfig(row.stage);
  if (user.role !== cfg.role_required && user.role !== 'dtszn' && row.author_id !== user.id) {
    throw new HttpError(403, 'Возобновить может автор, ответственный за Gate или координатор ДТСЗН');
  }
  const b = await readJson(req);
  const { dueDate } = await import('../workflow.js');
  q.run(`UPDATE initiatives SET status='active', stage_entered_at=datetime('now'), sla_due_at=?,
         updated_at=datetime('now') WHERE id=?`,
    dueDate(new Date().toISOString().slice(0, 19).replace('T', ' '), cfg.sla_value, cfg.sla_unit), row.id);
  q.run(`INSERT INTO stage_transitions (initiative_id, from_stage, to_stage, by_user, reason)
         VALUES (?,?,?,?,?)`, row.id, row.stage, row.stage, user.id, `Возобновлена: ${b.comment || 'предоставлена запрошенная информация'}`);
  logAction(user.id, 'initiative.resume', 'initiative', row.id, { comment: b.comment }, ip);
  notify(row.author_id, row.id, 'resumed', `Инициатива ${row.number} возобновлена`, b.comment || null);
  sendJson(200, decorate(q.get(`${SELECT_LIST} WHERE i.id = ?`, row.id)));
});

// ── Комментарии ──────────────────────────────────────────────
route.post('/api/initiatives/:id/comments', async ({ req, user, params, ip, sendJson }) => {
  if (!can(user, 'initiative.comment')) throw new HttpError(403, 'Недостаточно прав');
  const row = q.get('SELECT * FROM initiatives WHERE id = ?', Number(params.id));
  if (!row) throw new HttpError(404, 'Инициатива не найдена');
  const { body } = await readJson(req);
  if (!body || body.trim().length < 2) throw new HttpError(400, 'Пустой комментарий');
  const id = q.insert('INSERT INTO comments (initiative_id, author_id, body) VALUES (?,?,?)', row.id, user.id, body.trim());
  logAction(user.id, 'initiative.comment', 'initiative', row.id, null, ip);
  if (row.author_id !== user.id) {
    notify(row.author_id, row.id, 'comment', `Новый комментарий к ${row.number}`, `${user.full_name}: ${body.trim().slice(0, 120)}`);
  }
  sendJson(201, q.get(`SELECT c.*, u.full_name AS author_name, u.role AS author_role
                       FROM comments c JOIN users u ON u.id = c.author_id WHERE c.id = ?`, id));
});

// ── Голосование ──────────────────────────────────────────────
// Поддержка коллег — сигнал приоритета для экспертов, но не замена решению на Gate.
route.post('/api/initiatives/:id/vote', async ({ req, user, params, ip, sendJson }) => {
  const row = q.get('SELECT * FROM initiatives WHERE id=?', Number(params.id));
  if (!row) throw new HttpError(404, 'Инициатива не найдена');
  if (row.status === 'killed' || row.status === 'scaled') {
    throw new HttpError(400, 'Голосование по завершённой инициативе закрыто');
  }
  const { value } = await readJson(req);
  const v = Number(value);
  if (![1, -1, 0].includes(v)) throw new HttpError(400, 'Допустимые значения голоса: 1, -1 или 0 для отмены');

  const existing = q.get('SELECT * FROM votes WHERE initiative_id=? AND user_id=?', row.id, user.id);
  if (v === 0 || (existing && existing.value === v)) {
    // Повторный клик по своему голосу снимает его
    q.run('DELETE FROM votes WHERE initiative_id=? AND user_id=?', row.id, user.id);
    logAction(user.id, 'vote.remove', 'initiative', row.id, null, ip);
  } else if (existing) {
    q.run('UPDATE votes SET value=?, created_at=datetime(\'now\') WHERE id=?', v, existing.id);
    logAction(user.id, 'vote.change', 'initiative', row.id, { value: v }, ip);
  } else {
    q.run('INSERT INTO votes (initiative_id, user_id, value) VALUES (?,?,?)', row.id, user.id, v);
    logAction(user.id, 'vote.add', 'initiative', row.id, { value: v }, ip);
    // Автор узнаёт о первой поддержке от каждого коллеги
    if (v === 1 && row.author_id !== user.id) {
      const score = q.get('SELECT COALESCE(SUM(value),0) AS s FROM votes WHERE initiative_id=?', row.id).s;
      if ([1, 5, 10, 25, 50].includes(score)) {
        notify(row.author_id, row.id, 'vote',
          `Инициативу ${row.number} поддержали: ${score} ${score === 1 ? 'голос' : 'голосов'}`,
          'Поддержка коллег учитывается экспертами при оценке приоритета.');
      }
    }
  }

  const fresh = q.get(`SELECT
      (SELECT COALESCE(SUM(value),0) FROM votes WHERE initiative_id=?) AS votes_score,
      (SELECT COUNT(*) FROM votes WHERE initiative_id=? AND value=1) AS votes_up,
      (SELECT COUNT(*) FROM votes WHERE initiative_id=? AND value=-1) AS votes_down,
      COALESCE((SELECT value FROM votes WHERE initiative_id=? AND user_id=?), 0) AS my_vote`,
    row.id, row.id, row.id, row.id, user.id);
  sendJson(200, fresh);
});

// ── Подписка на обновления ───────────────────────────────────
route.post('/api/initiatives/:id/follow', async ({ user, params, ip, sendJson }) => {
  const row = q.get('SELECT id FROM initiatives WHERE id=?', Number(params.id));
  if (!row) throw new HttpError(404, 'Инициатива не найдена');
  const existing = q.get('SELECT id FROM follows WHERE initiative_id=? AND user_id=?', row.id, user.id);
  if (existing) {
    q.run('DELETE FROM follows WHERE id=?', existing.id);
    logAction(user.id, 'follow.remove', 'initiative', row.id, null, ip);
  } else {
    q.run('INSERT INTO follows (initiative_id, user_id) VALUES (?,?)', row.id, user.id);
    logAction(user.id, 'follow.add', 'initiative', row.id, null, ip);
  }
  sendJson(200, {
    following: !existing,
    followers: q.get('SELECT COUNT(*) AS c FROM follows WHERE initiative_id=?', row.id).c,
  });
});

// ── ИИ-помощник ──────────────────────────────────────────────
route.post('/api/ai/classify', async ({ req, sendJson }) => {
  const { text } = await readJson(req);
  sendJson(200, classify(text || ''));
});

route.post('/api/ai/similar', async ({ req, sendJson }) => {
  const { text, exclude } = await readJson(req);
  sendJson(200, findSimilar(text || '', exclude ? Number(exclude) : null));
});

route.get('/api/initiatives/:id/prediction', async ({ params, sendJson }) => {
  const row = q.get('SELECT * FROM initiatives WHERE id = ?', Number(params.id));
  if (!row) throw new HttpError(404, 'Инициатива не найдена');
  sendJson(200, predictSuccess(row));
});

// ── Категории (для фильтров) ─────────────────────────────────
route.get('/api/categories', async ({ sendJson }) => {
  sendJson(200, q.all(`SELECT category AS name, COUNT(*) AS count FROM initiatives
                       WHERE category IS NOT NULL GROUP BY category ORDER BY count DESC`));
});
