// Модуль «Идеи и решения»: рейтинг советчиков, журнал начислений,
// рекомендации к поощрению и настройка правил модуля.
import { route, readJson, HttpError } from '../http.js';
import { q } from '../db.js';
import { can } from '../auth.js';
import { logAction } from '../audit.js';
import {
  rating, periodBounds, revokePoints, awardPoints, settings, setSetting,
  buildIncentiveRecommendations, INCENTIVE_STATUS, BADGES, refreshBadges, notifyIdea,
} from '../ideahub.js';

const PERIODS = ['month', 'quarter', 'year', 'all'];

/** Рейтинг можно скрыть от рядовых участников — этого требуют политики некоторых организаций. */
function requireRatingAccess(user) {
  if (settings().rating_visible === '1') return;
  if (can(user, 'idea.moderate') || can(user, 'idea.incentive') || can(user, 'idea.admin')) return;
  throw new HttpError(403, 'Рейтинг скрыт настройками организации');
}

function requireAdmin(user) {
  if (!can(user, 'idea.admin')) throw new HttpError(403, 'Раздел доступен администратору модуля');
}

// ── Рейтинг ──────────────────────────────────────────────────
route.get('/api/rating', async ({ user, url, sendJson }) => {
  requireRatingAccess(user);
  const period = PERIODS.includes(url.searchParams.get('period')) ? url.searchParams.get('period') : 'month';
  // Руководитель по умолчанию видит рейтинг своих сотрудников
  const scope = url.searchParams.get('scope');
  const institutionId = scope === 'institution' || (scope !== 'all' && user.role === 'head')
    ? user.institution_id : (url.searchParams.get('institution') || null);

  const data = rating({ period, institutionId, limit: Number(url.searchParams.get('limit')) || 100 });
  sendJson(200, {
    ...data,
    scope: institutionId ? 'institution' : 'all',
    institution_id: institutionId || null,
    periods: PERIODS.map((p) => ({ code: p, label: periodBounds(p).label })),
    badges: BADGES.map(({ code, title, hint }) => ({ code, title, hint })),
    can_export: can(user, 'idea.moderate') || can(user, 'idea.admin') || can(user, 'idea.incentive'),
  });
});

// ── Выгрузка рейтинга ────────────────────────────────────────
route.get('/api/rating/export', async ({ user, url, res }) => {
  if (!can(user, 'idea.moderate') && !can(user, 'idea.admin') && !can(user, 'idea.incentive')) {
    throw new HttpError(403, 'Выгрузка доступна модератору, руководителю или администратору');
  }
  const period = PERIODS.includes(url.searchParams.get('period')) ? url.searchParams.get('period') : 'month';
  const institutionId = user.role === 'head' && url.searchParams.get('scope') !== 'all'
    ? user.institution_id : null;
  const data = rating({ period, institutionId, limit: 1000 });
  const head = ['Место', 'Сотрудник', 'Должность', 'Учреждение', 'Очки', 'Предложений',
                'Подтверждённый опыт', 'Внедрено', 'Знаки отличия'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = data.items.map((r) => [
    r.rank, r.full_name, r.position || '', r.institution || '', r.points,
    r.proposals, r.verified, r.implemented, r.badges.map((b) => b.title).join(', '),
  ]);
  // BOM в начале файла — чтобы Excel открыл кириллицу без настройки кодировки
  const csv = '﻿' + [head.join(';'), ...rows.map((r) => r.map(esc).join(';'))].join('\n');
  logAction(user.id, 'rating.export', 'rating', null, { period, scope: institutionId ? 'institution' : 'all' }, '');
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="social1-rating-${period}-${new Date().toISOString().slice(0, 10)}.csv"`,
  });
  res.end(csv);
});

// ── Журнал начислений ────────────────────────────────────────
route.get('/api/points/ledger', async ({ user, url, sendJson }) => {
  const target = url.searchParams.get('user');
  // Свой журнал доступен каждому, чужой — модератору и администратору
  if (target && Number(target) !== user.id && !can(user, 'idea.moderate') && !can(user, 'idea.admin')) {
    throw new HttpError(403, 'Журнал другого участника доступен модератору');
  }
  if (!target && !can(user, 'idea.moderate') && !can(user, 'idea.admin')) {
    throw new HttpError(403, 'Полный журнал начислений доступен модератору');
  }
  const where = [], args = [];
  if (target) { where.push('l.user_id = ?'); args.push(Number(target)); }
  if (url.searchParams.get('status')) { where.push('l.status = ?'); args.push(url.searchParams.get('status')); }
  const limit = Math.min(300, Number(url.searchParams.get('limit')) || 100);
  const entries = q.all(`
    SELECT l.*, u.full_name AS user_name, u.role AS user_role, inst.short_name AS institution,
           r.title AS rule_title, i.number AS idea_number, i.title AS idea_title,
           s.full_name AS source_name, rv.full_name AS revoked_by_name
    FROM points_ledger l
    JOIN users u ON u.id = l.user_id
    LEFT JOIN institutions inst ON inst.id = u.institution_id
    LEFT JOIN points_rules r ON r.code = l.rule_code
    LEFT JOIN ideas i ON i.id = l.idea_id
    LEFT JOIN users s ON s.id = l.source_user_id
    LEFT JOIN users rv ON rv.id = l.revoked_by
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY l.created_at DESC, l.id DESC LIMIT ?`, ...args, limit);
  sendJson(200, {
    entries,
    total: q.get(`SELECT COUNT(*) AS c FROM points_ledger l ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`, ...args).c,
    can_revoke: can(user, 'idea.moderate'),
  });
});

route.post('/api/points/:id/revoke', async ({ req, user, params, ip, sendJson }) => {
  if (!can(user, 'idea.moderate')) throw new HttpError(403, 'Отменяет начисление модератор');
  const { reason } = await readJson(req);
  if (!reason || reason.trim().length < 5) throw new HttpError(400, 'Укажите причину отмены начисления');
  const entry = revokePoints(Number(params.id), user.id, reason.trim());
  logAction(user.id, 'points.revoke', 'points_ledger', entry.id,
    { user_id: entry.user_id, points: entry.points, reason: reason.trim() }, ip);
  sendJson(200, entry);
});

// ── Ручное начисление модератором ────────────────────────────
route.post('/api/points/grant', async ({ req, user, ip, sendJson }) => {
  if (!can(user, 'idea.moderate')) throw new HttpError(403, 'Начисляет очки модератор');
  const b = await readJson(req);
  if (!b.user_id || !b.rule_code) throw new HttpError(400, 'Укажите получателя и правило начисления');
  const result = awardPoints({
    userId: Number(b.user_id), code: b.rule_code, ideaId: b.idea_id ? Number(b.idea_id) : null,
    proposalId: b.proposal_id ? Number(b.proposal_id) : null, sourceUserId: user.id,
    reason: b.reason?.trim() || null, awardedBy: user.id,
  });
  if (!result.awarded) throw new HttpError(409, result.reason);
  logAction(user.id, 'points.grant', 'user', Number(b.user_id), { rule: b.rule_code, points: result.points }, ip);
  sendJson(201, result);
});

// ─────────────────────────────────────────────────────────────
// Рекомендации к поощрению
// ─────────────────────────────────────────────────────────────
route.get('/api/incentive-types', async ({ sendJson }) => {
  sendJson(200, q.all('SELECT * FROM incentive_types ORDER BY order_idx'));
});

route.get('/api/incentives', async ({ user, url, sendJson }) => {
  const own = url.searchParams.get('mine') === '1';
  if (!own && !can(user, 'idea.incentive') && !can(user, 'idea.admin')) {
    throw new HttpError(403, 'Рекомендации к поощрению доступны руководителю');
  }
  const where = [], args = [];
  if (own) { where.push('n.user_id = ?'); args.push(user.id); }
  else if (user.role === 'head') { where.push('u.institution_id = ?'); args.push(user.institution_id); }
  if (url.searchParams.get('status')) { where.push('n.status = ?'); args.push(url.searchParams.get('status')); }

  const items = q.all(`
    SELECT n.*, u.full_name, u.position, u.role, inst.short_name AS institution,
           t.title AS type_title, t.category AS type_category, t.legal_note,
           p.full_name AS proposed_by_name, d.full_name AS decided_by_name
    FROM incentives n
    JOIN users u ON u.id = n.user_id
    LEFT JOIN institutions inst ON inst.id = u.institution_id
    JOIN incentive_types t ON t.code = n.type_code
    LEFT JOIN users p ON p.id = n.proposed_by
    LEFT JOIN users d ON d.id = n.decided_by
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE n.status WHEN 'proposed' THEN 0 WHEN 'agreed' THEN 1 WHEN 'approved' THEN 2
                           WHEN 'implemented' THEN 3 ELSE 4 END, n.created_at DESC`, ...args);
  sendJson(200, {
    items, statuses: INCENTIVE_STATUS,
    can_decide: can(user, 'idea.incentive.decide'),
    can_propose: can(user, 'idea.incentive'),
  });
});

route.post('/api/incentives', async ({ req, user, ip, sendJson }) => {
  if (!can(user, 'idea.incentive')) throw new HttpError(403, 'Рекомендацию оформляет руководитель или модератор');
  const b = await readJson(req);
  if (!b.user_id || !b.type_code) throw new HttpError(400, 'Укажите сотрудника и меру поощрения');
  const type = q.get('SELECT * FROM incentive_types WHERE code=? AND is_active=1', b.type_code);
  if (!type) throw new HttpError(400, 'Мера поощрения не найдена или отключена');
  const period = PERIODS.includes(b.period) ? b.period : 'month';
  const bounds = periodBounds(period);
  const points = q.get(`SELECT COALESCE(SUM(points),0) AS s FROM points_ledger
                        WHERE user_id=? AND status='approved'
                          AND date(created_at) >= date(?) AND date(created_at) < date(?)`,
    Number(b.user_id), bounds.from, bounds.to).s;

  const id = q.insert(`INSERT INTO incentives
    (user_id, type_code, period, period_label, points_at_creation, note, proposed_by)
    VALUES (?,?,?,?,?,?,?)`,
    Number(b.user_id), type.code, period, bounds.label, points, b.note?.trim() || null, user.id);
  logAction(user.id, 'incentive.propose', 'incentive', id, { user_id: b.user_id, type: type.code }, ip);
  notifyIdea(Number(b.user_id), null, 'incentive_proposed', 'Ваш вклад направлен руководителю',
    `Сформирована рекомендация к поощрению: ${type.title}. Решение принимает руководитель.`);
  sendJson(201, { id });
});

route.post('/api/incentives/build', async ({ req, user, ip, sendJson }) => {
  if (!can(user, 'idea.incentive')) throw new HttpError(403, 'Формирует рекомендации руководитель или модератор');
  const b = await readJson(req);
  const period = PERIODS.includes(b.period) ? b.period : 'month';
  const result = buildIncentiveRecommendations({
    period, proposedBy: user.id,
    institutionId: user.role === 'head' ? user.institution_id : null,
  });
  logAction(user.id, 'incentive.build', 'incentive', null,
    { period, created: result.created.length }, ip);
  sendJson(200, result);
});

const DECISIONS = {
  agreed:      { title: 'согласована' },
  approved:    { title: 'утверждена' },
  rejected:    { title: 'отклонена' },
  implemented: { title: 'реализована' },
};

route.patch('/api/incentives/:id', async ({ req, user, params, ip, sendJson }) => {
  if (!can(user, 'idea.incentive.decide')) {
    throw new HttpError(403, 'Решение по поощрению принимает руководитель или уполномоченное лицо');
  }
  const b = await readJson(req);
  const step = DECISIONS[b.status];
  if (!step) throw new HttpError(400, 'Недопустимый статус решения');
  const row = q.get('SELECT * FROM incentives WHERE id=?', Number(params.id));
  if (!row) throw new HttpError(404, 'Рекомендация не найдена');
  if (b.status === 'rejected' && (!b.decision_note || b.decision_note.trim().length < 5)) {
    throw new HttpError(400, 'Укажите основание отказа');
  }

  q.run(`UPDATE incentives SET status=?, decision_note=?, decided_by=?, decided_at=datetime('now'),
         updated_at=datetime('now') WHERE id=?`,
    b.status, b.decision_note?.trim() || null, user.id, row.id);
  logAction(user.id, `incentive.${b.status}`, 'incentive', row.id,
    { user_id: row.user_id, note: b.decision_note?.trim() || null }, ip);
  const type = q.get('SELECT title FROM incentive_types WHERE code=?', row.type_code);
  notifyIdea(row.user_id, null, `incentive_${b.status}`,
    `Рекомендация к поощрению ${step.title}`,
    `${type?.title || ''}. ${b.decision_note?.trim() || ''}`.trim());
  sendJson(200, q.get('SELECT * FROM incentives WHERE id=?', row.id));
});

// ─────────────────────────────────────────────────────────────
// Администрирование модуля
// ─────────────────────────────────────────────────────────────
route.get('/api/admin/ideahub', async ({ user, sendJson }) => {
  requireAdmin(user);
  sendJson(200, {
    rules: q.all('SELECT * FROM points_rules ORDER BY order_idx'),
    settings: settings(),
    incentive_types: q.all('SELECT * FROM incentive_types ORDER BY order_idx'),
    badges: BADGES.map(({ code, title, hint }) => ({ code, title, hint })),
    stats: {
      ideas: q.get('SELECT COUNT(*) AS c FROM ideas').c,
      proposals: q.get('SELECT COUNT(*) AS c FROM proposals').c,
      points: q.get("SELECT COALESCE(SUM(points),0) AS s FROM points_ledger WHERE status='approved'").s,
      revoked: q.get("SELECT COUNT(*) AS c FROM points_ledger WHERE status='revoked'").c,
      incentives: q.get('SELECT COUNT(*) AS c FROM incentives').c,
      reviews: q.get('SELECT COUNT(*) AS c FROM proposal_reviews').c,
      flags: q.get("SELECT COUNT(*) AS c FROM review_flags WHERE status='open'").c,
    },
  });
});

route.patch('/api/admin/ideahub/rules/:code', async ({ req, user, params, ip, sendJson }) => {
  requireAdmin(user);
  const rule = q.get('SELECT * FROM points_rules WHERE code=?', params.code);
  if (!rule) throw new HttpError(404, 'Правило не найдено');
  const b = await readJson(req);
  const sets = [], args = [];
  if (b.points !== undefined) {
    const p = Number(b.points);
    if (!Number.isInteger(p) || p < 0 || p > 1000) throw new HttpError(400, 'Очки — целое число от 0 до 1000');
    sets.push('points=?'); args.push(p);
  }
  if (b.cap_per_target !== undefined) {
    sets.push('cap_per_target=?'); args.push(b.cap_per_target === null || b.cap_per_target === '' ? null : Number(b.cap_per_target));
  }
  if (b.is_active !== undefined) { sets.push('is_active=?'); args.push(b.is_active ? 1 : 0); }
  if (b.title !== undefined && b.title.trim()) { sets.push('title=?'); args.push(b.title.trim()); }
  if (b.description !== undefined) { sets.push('description=?'); args.push(b.description?.trim() || null); }
  if (!sets.length) throw new HttpError(400, 'Нет полей для обновления');

  q.run(`UPDATE points_rules SET ${sets.join(', ')}, updated_at=datetime('now') WHERE code=?`, ...args, rule.code);
  logAction(user.id, 'ideahub.rule.update', 'points_rule', null, { code: rule.code, ...b }, ip);
  sendJson(200, q.get('SELECT * FROM points_rules WHERE code=?', rule.code));
});

const EDITABLE_SETTINGS = [
  'moderation_required', 'rating_visible', 'incentive_threshold', 'incentive_top',
  'review_undo', 'review_top_threshold', 'review_min_ms', 'review_burst_limit',
  'review_per_minute', 'review_per_hour',
];

route.patch('/api/admin/ideahub/settings', async ({ req, user, ip, sendJson }) => {
  requireAdmin(user);
  const b = await readJson(req);
  const applied = {};
  for (const key of EDITABLE_SETTINGS) {
    if (b[key] === undefined) continue;
    const value = typeof b[key] === 'boolean' ? (b[key] ? '1' : '0') : String(b[key]);
    setSetting(key, value);
    applied[key] = value;
  }
  if (!Object.keys(applied).length) throw new HttpError(400, 'Нет полей для обновления');
  logAction(user.id, 'ideahub.settings.update', 'ideahub_settings', null, applied, ip);
  sendJson(200, settings());
});

route.patch('/api/admin/ideahub/incentive-types/:code', async ({ req, user, params, ip, sendJson }) => {
  requireAdmin(user);
  const type = q.get('SELECT * FROM incentive_types WHERE code=?', params.code);
  if (!type) throw new HttpError(404, 'Мера поощрения не найдена');
  const b = await readJson(req);
  const sets = [], args = [];
  if (b.is_active !== undefined) { sets.push('is_active=?'); args.push(b.is_active ? 1 : 0); }
  if (b.title !== undefined && b.title.trim()) { sets.push('title=?'); args.push(b.title.trim()); }
  if (b.legal_note !== undefined) { sets.push('legal_note=?'); args.push(b.legal_note?.trim() || null); }
  if (!sets.length) throw new HttpError(400, 'Нет полей для обновления');
  q.run(`UPDATE incentive_types SET ${sets.join(', ')} WHERE code=?`, ...args, type.code);
  logAction(user.id, 'ideahub.incentive_type.update', 'incentive_type', null, { code: type.code, ...b }, ip);
  sendJson(200, q.get('SELECT * FROM incentive_types WHERE code=?', type.code));
});

// Пересчёт знаков отличия — на случай изменения правил задним числом
route.post('/api/admin/ideahub/refresh-badges', async ({ user, ip, sendJson }) => {
  requireAdmin(user);
  const users = q.all("SELECT DISTINCT user_id FROM points_ledger WHERE status='approved'");
  let granted = 0;
  for (const u of users) granted += refreshBadges(u.user_id).length;
  logAction(user.id, 'ideahub.badges.refresh', 'system', null, { granted }, ip);
  sendJson(200, { checked: users.length, granted });
});
