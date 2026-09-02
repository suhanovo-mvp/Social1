// Модуль «Идеи и решения»: подача идей, предложения решений, реакции,
// обсуждение, модерация и подъём идеи до инициативы Stage-Gate.
import { route, readJson, HttpError } from '../http.js';
import { q, tx } from '../db.js';
import { can } from '../auth.js';
import { logAction } from '../audit.js';
import {
  IDEA_STATUS, PROPOSAL_STATUS, OPEN_FOR_PROPOSALS, TEMPLATES, MODERATION_ACTIONS,
  nextIdeaNumber, notifyIdea, notifyModerators, awardPoints, moderateIdea,
  similarIdeas, findDuplicateProposal, settings, advisorStats,
} from '../ideahub.js';
import { submitInitiative } from '../workflow.js';
import { classify } from '../ai.js';

const MIN = { title: 5, problem: 10, desired_result: 5, summary: 10 };

function requireIdeaAuthor(user, idea) {
  if (idea.author_id !== user.id && !can(user, 'idea.moderate')) {
    throw new HttpError(403, 'Действие доступно автору идеи или модератору');
  }
}
function requireModerator(user) {
  if (!can(user, 'idea.moderate')) throw new HttpError(403, 'Действие доступно модератору модуля');
}

const SELECT_IDEA = `
  SELECT i.*, u.full_name AS author_name, u.role AS author_role,
         inst.short_name AS institution_short, inst.name AS institution_name,
         m.full_name AS moderator_name,
         init.number AS initiative_number,
         dup.number AS duplicate_number,
         (SELECT COUNT(*) FROM proposals p WHERE p.idea_id = i.id AND p.status != 'rejected') AS proposals_count,
         (SELECT COUNT(*) FROM proposals p WHERE p.idea_id = i.id AND p.kind='experience' AND p.status='verified') AS experience_count,
         (SELECT COUNT(*) FROM idea_comments c WHERE c.idea_id = i.id) AS comments_count,
         (SELECT COUNT(*) FROM idea_reactions r WHERE r.idea_id = i.id AND r.kind='useful')  AS r_useful,
         (SELECT COUNT(*) FROM idea_reactions r WHERE r.idea_id = i.id AND r.kind='support') AS r_support,
         (SELECT COUNT(*) FROM idea_reactions r WHERE r.idea_id = i.id AND r.kind='join')    AS r_join,
         (SELECT COUNT(*) FROM idea_reactions r WHERE r.idea_id = i.id)                      AS support_rank
  FROM ideas i
  JOIN users u ON u.id = i.author_id
  LEFT JOIN institutions inst ON inst.id = i.institution_id
  LEFT JOIN users m ON m.id = i.moderated_by
  LEFT JOIN initiatives init ON init.id = i.initiative_id
  LEFT JOIN ideas dup ON dup.id = i.duplicate_of_id`;

function decorateIdea(row) {
  const meta = IDEA_STATUS[row.status] || IDEA_STATUS.new;
  return {
    ...row,
    status_title: meta.title,
    status_tone: meta.tone,
    support_total: (row.r_useful || 0) + (row.r_support || 0) + (row.r_join || 0),
    open_for_proposals: OPEN_FOR_PROPOSALS.includes(row.status),
  };
}

/** Реакции текущего пользователя по списку идей — одним запросом. */
function myReactions(userId, ids) {
  if (!ids.length) return {};
  const rows = q.all(
    `SELECT idea_id, kind FROM idea_reactions WHERE user_id=? AND idea_id IN (${ids.map(() => '?').join(',')})`,
    userId, ...ids);
  const out = {};
  for (const r of rows) (out[r.idea_id] ||= []).push(r.kind);
  return out;
}

// ── Справочники модуля ───────────────────────────────────────
// Регистрируются до /api/ideas/:id — иначе шаблон пути перехватит эти адреса.
route.get('/api/ideas/templates', async ({ sendJson }) => {
  const s = settings();
  sendJson(200, {
    templates: TEMPLATES,
    statuses: IDEA_STATUS,
    proposal_statuses: PROPOSAL_STATUS,
    moderation_required: s.moderation_required === '1',
    rating_visible: s.rating_visible === '1',
  });
});

route.get('/api/ideas/categories', async ({ sendJson }) => {
  sendJson(200, q.all(`SELECT category AS name, COUNT(*) AS count FROM ideas
                       WHERE category IS NOT NULL AND status != 'archived'
                       GROUP BY category ORDER BY count DESC`));
});

route.post('/api/ideas/similar', async ({ req, sendJson }) => {
  const { text, exclude } = await readJson(req);
  sendJson(200, similarIdeas(text || '', exclude ? Number(exclude) : null));
});

// ── Черновик формы: автосохранение ───────────────────────────
route.get('/api/ideas/draft', async ({ user, sendJson }) => {
  const d = q.get('SELECT payload, updated_at FROM idea_drafts WHERE user_id=?', user.id);
  sendJson(200, d ? { payload: JSON.parse(d.payload), updated_at: d.updated_at } : null);
});

route.put('/api/ideas/draft', async ({ req, user, sendJson }) => {
  const body = await readJson(req);
  const payload = JSON.stringify(body?.payload ?? {});
  if (payload.length > 20000) throw new HttpError(413, 'Черновик слишком большой');
  q.run(`INSERT INTO idea_drafts (user_id, payload, updated_at) VALUES (?,?,datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET payload=excluded.payload, updated_at=datetime('now')`,
    user.id, payload);
  sendJson(200, { saved_at: new Date().toISOString() });
});

route.delete('/api/ideas/draft', async ({ user, sendJson }) => {
  q.run('DELETE FROM idea_drafts WHERE user_id=?', user.id);
  sendJson(200, { ok: true });
});

// ── Очередь модерации ────────────────────────────────────────
route.get('/api/ideas/moderation', async ({ user, sendJson }) => {
  requireModerator(user);
  const pending = q.all(`${SELECT_IDEA} WHERE i.status IN ('new','review') ORDER BY i.created_at ASC`)
    .map(decorateIdea);
  const experience = q.all(`
    SELECT p.*, u.full_name AS author_name, i.number AS idea_number, i.title AS idea_title, i.id AS idea_id
    FROM proposals p JOIN users u ON u.id=p.author_id JOIN ideas i ON i.id=p.idea_id
    WHERE p.kind='experience' AND p.status='published' ORDER BY p.created_at ASC`);
  const reports = q.all(`
    SELECT r.*, u.full_name AS reporter_name FROM idea_reports r
    JOIN users u ON u.id=r.user_id WHERE r.status='open' ORDER BY r.created_at ASC`)
    .map((r) => ({
      ...r,
      target: r.target_type === 'idea'
        ? q.get('SELECT id, number, title FROM ideas WHERE id=?', r.target_id)
        : q.get(`SELECT p.id, p.summary, i.number, i.id AS idea_id FROM proposals p
                 JOIN ideas i ON i.id=p.idea_id WHERE p.id=?`, r.target_id),
    }));
  sendJson(200, { pending, experience, reports, actions: MODERATION_ACTIONS });
});

// ── Список идей ──────────────────────────────────────────────
route.get('/api/ideas', async ({ user, url, sendJson }) => {
  const p = url.searchParams;
  const where = [];
  const args = [];
  if (p.get('status')) { where.push('i.status = ?'); args.push(p.get('status')); }
  else where.push("i.status != 'archived'");
  if (p.get('category')) { where.push('i.category = ?'); args.push(p.get('category')); }
  if (p.get('author')) { where.push('i.author_id = ?'); args.push(Number(p.get('author'))); }
  if (p.get('mine') === '1') { where.push('i.author_id = ?'); args.push(user.id); }
  if (p.get('institution')) { where.push('i.institution_id = ?'); args.push(Number(p.get('institution'))); }
  if (p.get('from')) { where.push('date(i.created_at) >= date(?)'); args.push(p.get('from')); }
  if (p.get('to')) { where.push('date(i.created_at) <= date(?)'); args.push(p.get('to')); }
  if (p.get('q')) {
    where.push('(i.title LIKE ? OR i.problem LIKE ? OR i.desired_result LIKE ? OR i.number LIKE ?)');
    const like = `%${p.get('q')}%`;
    args.push(like, like, like, like);
  }

  // ORDER BY опирается на псевдонимы вычисляемых колонок из SELECT_IDEA
  const sort = {
    new: 'i.created_at DESC',
    old: 'i.created_at ASC',
    support: 'support_rank DESC, i.created_at DESC',
    discussed: 'proposals_count DESC, comments_count DESC, i.created_at DESC',
    // «Набирают поддержку» — реакции, взвешенные по свежести идеи
    trending: "(support_rank * 1.0) / (1 + (julianday('now') - julianday(i.created_at)) / 10.0) DESC",
  }[p.get('sort') || 'new'] || 'i.created_at DESC';

  const limit = Math.min(200, Number(p.get('limit')) || 60);
  const offset = Number(p.get('offset')) || 0;
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const rows = q.all(`${SELECT_IDEA} ${clause} ORDER BY ${sort} LIMIT ? OFFSET ?`,
    ...args, limit, offset).map(decorateIdea);

  const mine = myReactions(user.id, rows.map((r) => r.id));
  for (const r of rows) r.my_reactions = mine[r.id] || [];

  const total = q.get(`SELECT COUNT(*) AS c FROM ideas i ${clause}`, ...args).c;
  const counts = Object.fromEntries(
    q.all("SELECT status, COUNT(*) AS c FROM ideas GROUP BY status").map((r) => [r.status, r.c]));
  sendJson(200, { items: rows, total, limit, offset, counts });
});

// ── Подача идеи ──────────────────────────────────────────────
route.post('/api/ideas', async ({ req, user, ip, sendJson }) => {
  if (!can(user, 'idea.create')) throw new HttpError(403, 'Роль не может подавать идеи');
  const b = await readJson(req);
  const labels = { title: 'Название идеи', problem: 'Описание проблемы', desired_result: 'Желаемый результат' };
  for (const [k, label] of Object.entries(labels)) {
    if (!b[k] || String(b[k]).trim().length < MIN[k]) {
      throw new HttpError(400, `Заполните поле «${label}» — не менее ${MIN[k]} символов`);
    }
  }

  // Модерация включается администратором: при выключенной идея сразу открыта к обсуждению
  const moderationRequired = settings().moderation_required === '1';
  const status = moderationRequired ? 'new' : 'accepted';
  const ai = classify(`${b.title} ${b.problem} ${b.desired_result}`);
  const category = b.category?.trim() || ai.category;

  const id = tx(() => {
    const number = nextIdeaNumber();
    const newId = q.insert(`INSERT INTO ideas
      (number, title, problem, desired_result, category, priority, template, source_link,
       author_id, institution_id, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      number, b.title.trim(), b.problem.trim(), b.desired_result.trim(), category,
      ['low', 'normal', 'high'].includes(b.priority) ? b.priority : 'normal',
      b.template || null, b.source_link?.trim() || null, user.id, user.institution_id, status);
    for (const link of (b.links || []).filter(Boolean).slice(0, 10)) {
      q.run(`INSERT INTO idea_attachments (idea_id, filename, kind, url, uploaded_by) VALUES (?,?,'link',?,?)`,
        newId, String(link).slice(0, 200), String(link), user.id);
    }
    q.run('DELETE FROM idea_drafts WHERE user_id=?', user.id);
    return newId;
  });

  const idea = q.get('SELECT * FROM ideas WHERE id=?', id);
  logAction(user.id, 'idea.create', 'idea', id, { number: idea.number, status }, ip);
  notifyIdea(user.id, id, 'idea_created', `Идея ${idea.number} опубликована`,
    moderationRequired
      ? 'Идея направлена модератору. После проверки она откроется для предложений коллег.'
      : 'Идея открыта для предложений решений от коллег.');
  if (moderationRequired) {
    notifyModerators(id, 'idea_pending', `Новая идея на проверке: ${idea.number}`, idea.title);
  } else {
    awardPoints({ userId: user.id, code: 'idea.approved', ideaId: id,
      reason: `Идея ${idea.number} опубликована` });
  }

  sendJson(201, decorateIdea(q.get(`${SELECT_IDEA} WHERE i.id=?`, id)));
});

// ── Карточка идеи ────────────────────────────────────────────
route.get('/api/ideas/:id', async ({ user, params, sendJson }) => {
  const row = q.get(`${SELECT_IDEA} WHERE i.id=?`, Number(params.id));
  if (!row) throw new HttpError(404, 'Идея не найдена');
  const idea = decorateIdea(row);

  const proposals = q.all(`
    SELECT p.*, u.full_name AS author_name, u.role AS author_role, u.position AS author_position,
           inst.short_name AS author_institution,
           v.full_name AS verified_by_name,
           (SELECT COUNT(*) FROM proposal_endorsements e WHERE e.proposal_id = p.id) AS endorsements,
           EXISTS(SELECT 1 FROM proposal_endorsements e WHERE e.proposal_id = p.id AND e.user_id = ?) AS my_endorsement,
           (SELECT COUNT(*) FROM proposal_reviews rv WHERE rv.proposal_id = p.id AND rv.verdict='like')     AS likes,
           (SELECT COUNT(*) FROM proposal_reviews rv WHERE rv.proposal_id = p.id AND rv.verdict='favorite') AS favorites
    FROM proposals p
    JOIN users u ON u.id = p.author_id
    LEFT JOIN institutions inst ON inst.id = u.institution_id
    LEFT JOIN users v ON v.id = p.verified_by
    WHERE p.idea_id = ?
    ORDER BY CASE p.status WHEN 'implemented' THEN 0 WHEN 'verified' THEN 1 WHEN 'useful' THEN 2
                           WHEN 'published' THEN 3 ELSE 4 END,
             endorsements DESC, p.created_at ASC`, user.id, idea.id)
    .map((p) => ({
      ...p,
      status_title: PROPOSAL_STATUS[p.status]?.title,
      status_tone: PROPOSAL_STATUS[p.status]?.tone,
      my_endorsement: !!p.my_endorsement,
      is_mine: p.author_id === user.id,
    }));

  const comments = q.all(`
    SELECT c.*, u.full_name AS author_name, u.role AS author_role FROM idea_comments c
    JOIN users u ON u.id = c.author_id WHERE c.idea_id = ? ORDER BY c.created_at ASC`, idea.id);

  const attachments = q.all(
    `SELECT id, proposal_id, filename, kind, url, mime, size, created_at
     FROM idea_attachments WHERE idea_id = ?`, idea.id);

  const my = q.all('SELECT kind FROM idea_reactions WHERE idea_id=? AND user_id=?', idea.id, user.id)
    .map((r) => r.kind);

  sendJson(200, {
    ...idea,
    proposals, comments, attachments,
    my_reactions: my,
    is_author: idea.author_id === user.id,
    can_moderate: can(user, 'idea.moderate'),
    can_propose: can(user, 'idea.propose') && idea.open_for_proposals,
    similar: similarIdeas(`${idea.title} ${idea.problem}`, idea.id),
  });
});

// ── Правка идеи автором ──────────────────────────────────────
route.patch('/api/ideas/:id', async ({ req, user, params, ip, sendJson }) => {
  const idea = q.get('SELECT * FROM ideas WHERE id=?', Number(params.id));
  if (!idea) throw new HttpError(404, 'Идея не найдена');
  requireIdeaAuthor(user, idea);
  if (idea.author_id === user.id && !['new', 'review'].includes(idea.status)) {
    throw new HttpError(403, 'После принятия идеи к обсуждению правки вносит модератор');
  }
  const b = await readJson(req);
  const sets = [], args = [];
  for (const f of ['title', 'problem', 'desired_result', 'category', 'priority', 'source_link']) {
    if (b[f] !== undefined) { sets.push(`${f}=?`); args.push(b[f] === '' ? null : b[f]); }
  }
  if (!sets.length) throw new HttpError(400, 'Нет полей для обновления');
  q.run(`UPDATE ideas SET ${sets.join(', ')}, updated_at=datetime('now') WHERE id=?`, ...args, idea.id);
  logAction(user.id, 'idea.update', 'idea', idea.id, b, ip);
  sendJson(200, decorateIdea(q.get(`${SELECT_IDEA} WHERE i.id=?`, idea.id)));
});

// ── Модерация идеи ───────────────────────────────────────────
route.post('/api/ideas/:id/moderate', async ({ req, user, params, ip, sendJson }) => {
  requireModerator(user);
  const b = await readJson(req);
  const updated = moderateIdea({
    user, ideaId: Number(params.id), action: b.action,
    note: b.note, duplicateOfId: b.duplicate_of_id, ip,
  });
  sendJson(200, decorateIdea(q.get(`${SELECT_IDEA} WHERE i.id=?`, updated.id)));
});

// ── Быстрая поддержка идеи ───────────────────────────────────
const REACTIONS = { useful: 'полезно', support: 'поддерживаю', join: 'готов участвовать' };

route.post('/api/ideas/:id/reactions', async ({ req, user, params, ip, sendJson }) => {
  const idea = q.get('SELECT * FROM ideas WHERE id=?', Number(params.id));
  if (!idea) throw new HttpError(404, 'Идея не найдена');
  if (['rejected', 'archived'].includes(idea.status)) {
    throw new HttpError(400, 'Идея закрыта — отметки больше не принимаются');
  }
  const { kind } = await readJson(req);
  if (!REACTIONS[kind]) throw new HttpError(400, 'Неизвестный вид отметки');

  const existing = q.get('SELECT id FROM idea_reactions WHERE idea_id=? AND user_id=? AND kind=?',
    idea.id, user.id, kind);
  if (existing) {
    q.run('DELETE FROM idea_reactions WHERE id=?', existing.id);
    logAction(user.id, 'idea.reaction.remove', 'idea', idea.id, { kind }, ip);
  } else {
    q.run('INSERT INTO idea_reactions (idea_id, user_id, kind) VALUES (?,?,?)', idea.id, user.id, kind);
    logAction(user.id, 'idea.reaction.add', 'idea', idea.id, { kind }, ip);
    if (idea.author_id !== user.id) {
      const total = q.get('SELECT COUNT(*) AS c FROM idea_reactions WHERE idea_id=?', idea.id).c;
      if ([1, 5, 10, 25].includes(total)) {
        notifyIdea(idea.author_id, idea.id, 'idea_support',
          `Идею ${idea.number} поддержали: ${total}`,
          'Поддержка коллег учитывается модератором при рассмотрении идеи.');
      }
    }
  }

  const fresh = q.get(`SELECT
      (SELECT COUNT(*) FROM idea_reactions WHERE idea_id=? AND kind='useful')  AS r_useful,
      (SELECT COUNT(*) FROM idea_reactions WHERE idea_id=? AND kind='support') AS r_support,
      (SELECT COUNT(*) FROM idea_reactions WHERE idea_id=? AND kind='join')    AS r_join`,
    idea.id, idea.id, idea.id);
  const mine = q.all('SELECT kind FROM idea_reactions WHERE idea_id=? AND user_id=?', idea.id, user.id)
    .map((r) => r.kind);
  sendJson(200, { ...fresh, my_reactions: mine });
});

// ── Обсуждение ───────────────────────────────────────────────
route.post('/api/ideas/:id/comments', async ({ req, user, params, ip, sendJson }) => {
  const idea = q.get('SELECT * FROM ideas WHERE id=?', Number(params.id));
  if (!idea) throw new HttpError(404, 'Идея не найдена');
  const { body, proposal_id } = await readJson(req);
  if (!body || body.trim().length < 2) throw new HttpError(400, 'Пустой комментарий');
  const id = q.insert('INSERT INTO idea_comments (idea_id, proposal_id, author_id, body) VALUES (?,?,?,?)',
    idea.id, proposal_id ? Number(proposal_id) : null, user.id, body.trim());
  logAction(user.id, 'idea.comment', 'idea', idea.id, null, ip);
  if (idea.author_id !== user.id) {
    notifyIdea(idea.author_id, idea.id, 'idea_comment', `Новый ответ по идее ${idea.number}`,
      `${user.full_name}: ${body.trim().slice(0, 120)}`);
  }
  sendJson(201, q.get(`SELECT c.*, u.full_name AS author_name, u.role AS author_role
                       FROM idea_comments c JOIN users u ON u.id=c.author_id WHERE c.id=?`, id));
});

// ── Жалоба на идею ───────────────────────────────────────────
async function report(targetType, targetId, user, req, ip) {
  const { reason } = await readJson(req);
  if (!reason || reason.trim().length < 5) throw new HttpError(400, 'Опишите причину обращения');
  if (q.get('SELECT id FROM idea_reports WHERE target_type=? AND target_id=? AND user_id=?',
    targetType, targetId, user.id)) {
    throw new HttpError(409, 'Вы уже сообщали об этом');
  }
  const id = q.insert('INSERT INTO idea_reports (target_type, target_id, user_id, reason) VALUES (?,?,?,?)',
    targetType, targetId, user.id, reason.trim());
  logAction(user.id, 'idea.report', targetType, targetId, { reason: reason.trim() }, ip);
  notifyModerators(targetType === 'idea' ? targetId : null, 'report',
    'Поступило обращение о нарушении', reason.trim().slice(0, 160));
  return id;
}

route.post('/api/ideas/:id/report', async ({ req, user, params, ip, sendJson }) => {
  sendJson(201, { id: await report('idea', Number(params.id), user, req, ip) });
});

route.post('/api/proposals/:id/report', async ({ req, user, params, ip, sendJson }) => {
  sendJson(201, { id: await report('proposal', Number(params.id), user, req, ip) });
});

route.post('/api/reports/:id/resolve', async ({ req, user, params, ip, sendJson }) => {
  requireModerator(user);
  const { status } = await readJson(req);
  if (!['resolved', 'dismissed'].includes(status)) throw new HttpError(400, 'Недопустимый исход обращения');
  q.run(`UPDATE idea_reports SET status=?, resolved_by=?, resolved_at=datetime('now') WHERE id=?`,
    status, user.id, Number(params.id));
  logAction(user.id, 'idea.report.resolve', 'idea_report', Number(params.id), { status }, ip);
  sendJson(200, { ok: true });
});

// ─────────────────────────────────────────────────────────────
// Предложения решений
// ─────────────────────────────────────────────────────────────
route.post('/api/ideas/:id/proposals', async ({ req, user, params, ip, sendJson }) => {
  if (!can(user, 'idea.propose')) throw new HttpError(403, 'Роль не может предлагать решения');
  const idea = q.get('SELECT * FROM ideas WHERE id=?', Number(params.id));
  if (!idea) throw new HttpError(404, 'Идея не найдена');
  if (!OPEN_FOR_PROPOSALS.includes(idea.status)) {
    throw new HttpError(400, `Идея в статусе «${IDEA_STATUS[idea.status]?.title}» — предложения не принимаются`);
  }
  const b = await readJson(req);
  if (!b.summary || b.summary.trim().length < MIN.summary) {
    throw new HttpError(400, `Опишите решение — не менее ${MIN.summary} символов`);
  }
  const kind = b.kind === 'experience' ? 'experience' : 'proposal';
  if (kind === 'experience' && (!b.expected_effect || b.expected_effect.trim().length < 5)) {
    throw new HttpError(400, 'Для проверенного опыта укажите, какой результат он дал');
  }

  const dup = findDuplicateProposal(idea.id, `${b.summary} ${b.how_to_apply || ''}`);
  if (dup) {
    throw new HttpError(409,
      'Такое решение уже предложено по этой идее. Поддержите существующее предложение — очки за дубли не начисляются.');
  }

  const id = tx(() => {
    const newId = q.insert(`INSERT INTO proposals
      (idea_id, author_id, summary, how_to_apply, expected_effect, risks, needs_approval, kind)
      VALUES (?,?,?,?,?,?,?,?)`,
      idea.id, user.id, b.summary.trim(), b.how_to_apply?.trim() || null,
      b.expected_effect?.trim() || null, b.risks?.trim() || null,
      b.needs_approval ? 1 : 0, kind);
    for (const link of (b.links || []).filter(Boolean).slice(0, 10)) {
      q.run(`INSERT INTO idea_attachments (idea_id, proposal_id, filename, kind, url, uploaded_by)
             VALUES (?,?,?,'link',?,?)`, idea.id, newId, String(link).slice(0, 200), String(link), user.id);
    }
    return newId;
  });

  logAction(user.id, 'proposal.create', 'proposal', id, { idea: idea.number, kind }, ip);

  // Очки за вклад в чужую идею. Проверенный опыт оплачивается после подтверждения.
  const award = awardPoints({
    userId: user.id, code: 'proposal.created', ideaId: idea.id, proposalId: id,
    sourceUserId: idea.author_id, reason: `Предложено решение по идее ${idea.number}`,
  });

  notifyIdea(idea.author_id, idea.id, 'proposal_new',
    `Новое ${kind === 'experience' ? 'описание проверенного опыта' : 'предложение'} по идее ${idea.number}`,
    `${user.full_name}: ${b.summary.trim().slice(0, 120)}`);
  if (kind === 'experience') {
    notifyModerators(idea.id, 'experience_pending', 'Проверенный опыт ожидает подтверждения',
      `Идея ${idea.number}. Автор: ${user.full_name}.`);
  }

  sendJson(201, { id, points: award });
});

route.patch('/api/proposals/:id', async ({ req, user, params, ip, sendJson }) => {
  const p = q.get('SELECT * FROM proposals WHERE id=?', Number(params.id));
  if (!p) throw new HttpError(404, 'Предложение не найдено');
  if (p.author_id !== user.id && !can(user, 'idea.moderate')) {
    throw new HttpError(403, 'Правки вносит автор предложения или модератор');
  }
  if (p.author_id === user.id && p.status !== 'published') {
    throw new HttpError(403, 'Оценённое предложение не редактируется');
  }
  const b = await readJson(req);
  const sets = [], args = [];
  for (const f of ['summary', 'how_to_apply', 'expected_effect', 'risks']) {
    if (b[f] !== undefined) { sets.push(`${f}=?`); args.push(b[f] === '' ? null : b[f]); }
  }
  if (b.needs_approval !== undefined) { sets.push('needs_approval=?'); args.push(b.needs_approval ? 1 : 0); }
  if (!sets.length) throw new HttpError(400, 'Нет полей для обновления');
  q.run(`UPDATE proposals SET ${sets.join(', ')}, updated_at=datetime('now') WHERE id=?`, ...args, p.id);
  logAction(user.id, 'proposal.update', 'proposal', p.id, b, ip);
  sendJson(200, q.get('SELECT * FROM proposals WHERE id=?', p.id));
});

// ── Автор идеи отмечает решение полезным ─────────────────────
route.post('/api/proposals/:id/useful', async ({ user, params, ip, sendJson }) => {
  const p = q.get('SELECT * FROM proposals WHERE id=?', Number(params.id));
  if (!p) throw new HttpError(404, 'Предложение не найдено');
  const idea = q.get('SELECT * FROM ideas WHERE id=?', p.idea_id);
  if (idea.author_id !== user.id) throw new HttpError(403, 'Отметить решение полезным может только автор идеи');
  if (p.author_id === user.id) throw new HttpError(400, 'Самооценка не учитывается');
  if (['useful', 'implemented'].includes(p.status)) throw new HttpError(400, 'Решение уже отмечено');

  q.run(`UPDATE proposals SET status = CASE WHEN status='verified' THEN 'verified' ELSE 'useful' END,
         useful_marked_at=datetime('now'), updated_at=datetime('now') WHERE id=?`, p.id);
  const award = awardPoints({
    userId: p.author_id, code: 'proposal.useful', ideaId: idea.id, proposalId: p.id,
    sourceUserId: user.id, reason: `Решение признано полезным автором идеи ${idea.number}`, awardedBy: user.id,
  });
  logAction(user.id, 'proposal.useful', 'proposal', p.id, { idea: idea.number }, ip);
  notifyIdea(p.author_id, idea.id, 'proposal_useful',
    'Ваше решение отмечено как полезное', `Идея ${idea.number}: «${idea.title}».`);
  sendJson(200, { status: 'useful', points: award });
});

// ── Подтверждение решения коллегами ──────────────────────────
route.post('/api/proposals/:id/endorse', async ({ user, params, ip, sendJson }) => {
  const p = q.get('SELECT * FROM proposals WHERE id=?', Number(params.id));
  if (!p) throw new HttpError(404, 'Предложение не найдено');
  if (p.author_id === user.id) throw new HttpError(400, 'Нельзя поддержать собственное предложение');

  const existing = q.get('SELECT id FROM proposal_endorsements WHERE proposal_id=? AND user_id=?', p.id, user.id);
  let award = null;
  if (existing) {
    q.run('DELETE FROM proposal_endorsements WHERE id=?', existing.id);
    logAction(user.id, 'proposal.endorse.remove', 'proposal', p.id, null, ip);
  } else {
    q.run('INSERT INTO proposal_endorsements (proposal_id, user_id) VALUES (?,?)', p.id, user.id);
    logAction(user.id, 'proposal.endorse', 'proposal', p.id, null, ip);
    award = awardPoints({
      userId: p.author_id, code: 'proposal.endorsed', ideaId: p.idea_id, proposalId: p.id,
      sourceUserId: user.id, reason: 'Решение поддержано коллегой',
    });
  }
  const count = q.get('SELECT COUNT(*) AS c FROM proposal_endorsements WHERE proposal_id=?', p.id).c;
  sendJson(200, { endorsements: count, my_endorsement: !existing, points: award });
});

// ── Решения модератора по предложению ────────────────────────
const PROPOSAL_ACTIONS = {
  verify:    { status: 'verified',    rule: 'experience.verified',   title: 'Проверенный опыт подтверждён' },
  accept:    { status: 'useful',      rule: 'proposal.accepted',     title: 'Предложение принято в работу' },
  implement: { status: 'implemented', rule: 'proposal.implemented',  title: 'Предложение внедрено' },
  reject:    { status: 'rejected',    rule: null,                    title: 'Предложение отклонено' },
};

route.post('/api/proposals/:id/decide', async ({ req, user, params, ip, sendJson }) => {
  requireModerator(user);
  const b = await readJson(req);
  const step = PROPOSAL_ACTIONS[b.action];
  if (!step) throw new HttpError(400, 'Неизвестное действие');
  const p = q.get('SELECT * FROM proposals WHERE id=?', Number(params.id));
  if (!p) throw new HttpError(404, 'Предложение не найдено');
  const idea = q.get('SELECT * FROM ideas WHERE id=?', p.idea_id);
  if (b.action === 'verify' && p.kind !== 'experience') {
    throw new HttpError(400, 'Подтверждается только проверенный опыт');
  }
  if (b.action === 'reject' && (!b.note || b.note.trim().length < 5)) {
    throw new HttpError(400, 'Укажите причину отклонения — она будет видна автору');
  }

  const result = tx(() => {
    q.run(`UPDATE proposals SET status=?, moderation_note=?, updated_at=datetime('now'),
           verified_by = CASE WHEN ?='verify' THEN ? ELSE verified_by END,
           verified_at = CASE WHEN ?='verify' THEN datetime('now') ELSE verified_at END
           WHERE id=?`,
      step.status, b.note?.trim() || null, b.action, user.id, b.action, p.id);

    // Принятое в работу предложение переводит идею в статус «В работе»,
    // внедрённое — в «Реализована». Идея и решение движутся вместе.
    if (b.action === 'accept') {
      q.run(`UPDATE ideas SET status='in_progress', accepted_proposal_id=?, updated_at=datetime('now')
             WHERE id=? AND status IN ('review','accepted')`, p.id, idea.id);
    }
    if (b.action === 'implement') {
      q.run(`UPDATE ideas SET status='done', accepted_proposal_id=COALESCE(accepted_proposal_id, ?),
             closed_at=datetime('now'), updated_at=datetime('now') WHERE id=?`, p.id, idea.id);
    }

    const award = step.rule
      ? awardPoints({
          userId: p.author_id, code: step.rule, ideaId: idea.id, proposalId: p.id,
          sourceUserId: user.id, reason: `${step.title} (идея ${idea.number})`, awardedBy: user.id,
        })
      : null;
    return award;
  });

  logAction(user.id, `proposal.${b.action}`, 'proposal', p.id,
    { idea: idea.number, note: b.note?.trim() || null }, ip);
  notifyIdea(p.author_id, idea.id, `proposal_${b.action}`, step.title,
    `Идея ${idea.number}: «${idea.title}».${b.note ? ' ' + b.note.trim() : ''}`);
  if (idea.author_id !== p.author_id) {
    notifyIdea(idea.author_id, idea.id, `proposal_${b.action}`, `${step.title} по вашей идее`, idea.title);
  }

  sendJson(200, { status: step.status, points: result });
});

// ── Подъём идеи до инициативы Stage-Gate ─────────────────────
// Идея, для которой найдено решение, входит в основной конвейер платформы:
// с этого момента ею занимается Stage-Gate со сроками, Gate и пилотами.
route.post('/api/ideas/:id/promote', async ({ req, user, params, ip, sendJson }) => {
  requireModerator(user);
  const idea = q.get('SELECT * FROM ideas WHERE id=?', Number(params.id));
  if (!idea) throw new HttpError(404, 'Идея не найдена');
  if (idea.initiative_id) throw new HttpError(409, 'Идея уже поднята до инициативы');
  if (!['accepted', 'in_progress', 'done'].includes(idea.status)) {
    throw new HttpError(400, 'До инициативы поднимается идея, принятая к обсуждению или взятая в работу');
  }
  const b = await readJson(req);
  const proposal = idea.accepted_proposal_id
    ? q.get('SELECT * FROM proposals WHERE id=?', idea.accepted_proposal_id)
    : q.get(`SELECT * FROM proposals WHERE idea_id=? AND status IN ('useful','verified','implemented')
             ORDER BY CASE status WHEN 'implemented' THEN 0 WHEN 'verified' THEN 1 ELSE 2 END LIMIT 1`, idea.id);
  if (!proposal) throw new HttpError(400, 'Сначала отметьте решение, которое ляжет в основу инициативы');

  const year = new Date().getFullYear();
  const last = q.get('SELECT number FROM initiatives WHERE number LIKE ? ORDER BY id DESC LIMIT 1', `SOC-${year}-%`);
  const number = `SOC-${year}-${String(last ? Number(last.number.split('-')[2]) + 1 : 1).padStart(4, '0')}`;

  const initiativeId = tx(() => {
    const id = q.insert(`INSERT INTO initiatives
      (number, title, problem, solution, expected_effect, category, tags, author_id, institution_id, stage)
      VALUES (?,?,?,?,?,?,?,?,?,1)`,
      number, b.title?.trim() || idea.title, idea.problem,
      [proposal.summary, proposal.how_to_apply].filter(Boolean).join('\n\n'),
      proposal.expected_effect || idea.desired_result, idea.category,
      JSON.stringify(['из доски идей', idea.number]),
      idea.author_id, idea.institution_id);
    q.run(`UPDATE ideas SET initiative_id=?, status='in_progress', updated_at=datetime('now') WHERE id=?`, id, idea.id);
    return id;
  });

  submitInitiative(initiativeId, user.id);
  logAction(user.id, 'idea.promote', 'idea', idea.id, { initiative: number }, ip);
  notifyIdea(idea.author_id, idea.id, 'idea_promoted',
    `Идея ${idea.number} стала инициативой ${number}`,
    'Дальнейшее движение — по конвейеру Stage-Gate со сроками и точками принятия решений.');
  notifyIdea(proposal.author_id, idea.id, 'idea_promoted',
    'Ваше решение легло в основу инициативы',
    `Идея ${idea.number} оформлена как инициатива ${number}.`);

  sendJson(201, { initiative_id: initiativeId, number });
});

// ── Вклад участника в модуле (для профиля) ───────────────────
route.get('/api/ideas/contribution/:userId', async ({ params, sendJson }) => {
  const userId = Number(params.userId);
  const stats = advisorStats(userId);
  const badges = q.all('SELECT code, title, granted_at FROM advisor_badges WHERE user_id=? ORDER BY granted_at', userId);
  const history = q.all(`
    SELECT l.*, r.title AS rule_title, i.number AS idea_number, i.title AS idea_title
    FROM points_ledger l
    LEFT JOIN points_rules r ON r.code = l.rule_code
    LEFT JOIN ideas i ON i.id = l.idea_id
    WHERE l.user_id=? ORDER BY l.created_at DESC LIMIT 50`, userId);
  const ideas = q.all(`SELECT id, number, title, status, created_at FROM ideas
                       WHERE author_id=? ORDER BY created_at DESC LIMIT 20`, userId);
  const proposals = q.all(`
    SELECT p.id, p.summary, p.status, p.kind, p.created_at, i.id AS idea_id, i.number AS idea_number, i.title AS idea_title
    FROM proposals p JOIN ideas i ON i.id=p.idea_id
    WHERE p.author_id=? ORDER BY p.created_at DESC LIMIT 20`, userId);
  sendJson(200, { stats, badges, history, ideas, proposals });
});
