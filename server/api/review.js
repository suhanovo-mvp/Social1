// Быстрое ревью предложений: очередь карточек, оценка одним движением,
// топ предложений для модератора и сигналы антифрода.
//
// Лайк здесь — это триаж, а не признание вклада: он влияет на полезность
// предложения и порядок показа, но не начисляет очки автору. Очки начисляются
// только после модерации, отметки автором идеи или внедрения — так массовое
// пролистывание невозможно превратить в накрутку рейтинга.
import { route, readJson, HttpError } from '../http.js';
import { q } from '../db.js';
import { can } from '../auth.js';
import { logAction } from '../audit.js';
import {
  REVIEW_VERDICTS, SKIP_REASONS, OPEN_FOR_PROPOSALS, PROPOSAL_STATUS,
  checkReviewRate, detectReviewAbuse, reviewCounts, usefulnessSql,
  settings, notifyIdea,
} from '../ideahub.js';

const PERIODS = { '7': '7 дней', '30': '30 дней', '90': 'квартал', all: 'весь период' };

function requireReviewer(user) {
  if (!can(user, 'idea.review')) throw new HttpError(403, 'Роль не участвует в ревью предложений');
}
function requireModerator(user) {
  if (!can(user, 'idea.moderate')) throw new HttpError(403, 'Раздел доступен модератору модуля');
}

// Предложение показывается, только если и оно, и его идея опубликованы
const VISIBLE = `
  p.status != 'rejected'
  AND i.status IN (${OPEN_FOR_PROPOSALS.map(() => '?').join(',')})`;

const CARD_FIELDS = `
  p.id, p.summary, p.how_to_apply, p.expected_effect, p.risks, p.needs_approval,
  p.kind, p.status, p.created_at,
  i.id AS idea_id, i.number AS idea_number, i.title AS idea_title, i.problem AS idea_problem,
  i.category, i.priority, i.status AS idea_status,
  u.id AS author_id, u.full_name AS author_name, u.position AS author_position,
  inst.short_name AS author_institution,
  (SELECT COUNT(*) FROM proposal_reviews rv WHERE rv.proposal_id=p.id AND rv.verdict='like')     AS likes,
  (SELECT COUNT(*) FROM proposal_reviews rv WHERE rv.proposal_id=p.id AND rv.verdict='favorite') AS favorites,
  (SELECT COUNT(*) FROM proposal_endorsements e WHERE e.proposal_id=p.id)                        AS endorsements,
  ${usefulnessSql('p')} AS usefulness`;

// ── Справочники очереди ──────────────────────────────────────
// Регистрируются до /api/review/:id — иначе шаблон пути перехватит эти адреса.
route.get('/api/review/filters', async ({ user, sendJson }) => {
  requireReviewer(user);
  const args = [...OPEN_FOR_PROPOSALS];
  sendJson(200, {
    ideas: q.all(`SELECT i.id, i.number, i.title, COUNT(p.id) AS proposals
                  FROM ideas i JOIN proposals p ON p.idea_id = i.id
                  WHERE ${VISIBLE} GROUP BY i.id ORDER BY proposals DESC, i.created_at DESC`, ...args),
    categories: q.all(`SELECT i.category AS name, COUNT(p.id) AS count
                       FROM ideas i JOIN proposals p ON p.idea_id = i.id
                       WHERE ${VISIBLE} AND i.category IS NOT NULL
                       GROUP BY i.category ORDER BY count DESC`, ...args),
    kinds: { proposal: 'Идея решения', experience: 'Проверенный опыт' },
    statuses: PROPOSAL_STATUS,
    priorities: { high: 'Мешает каждый день', normal: 'Обычная ситуация', low: 'Можно не спешить' },
    periods: PERIODS,
    reasons: SKIP_REASONS,
    verdicts: REVIEW_VERDICTS,
    undo_enabled: settings().review_undo === '1',
  });
});

// ── Очередь карточек ─────────────────────────────────────────
route.get('/api/review/queue', async ({ user, url, sendJson }) => {
  requireReviewer(user);
  const p = url.searchParams;
  const where = [VISIBLE];
  const args = [...OPEN_FOR_PROPOSALS];

  // Своё предложение в собственную очередь не попадает
  where.push('p.author_id != ?'); args.push(user.id);
  // Уже оценённое повторно не показывается
  where.push('NOT EXISTS (SELECT 1 FROM proposal_reviews rv WHERE rv.proposal_id=p.id AND rv.user_id=?)');
  args.push(user.id);

  if (p.get('idea')) { where.push('i.id = ?'); args.push(Number(p.get('idea'))); }
  if (p.get('category')) { where.push('i.category = ?'); args.push(p.get('category')); }
  if (p.get('kind')) { where.push('p.kind = ?'); args.push(p.get('kind')); }
  if (p.get('status')) { where.push('p.status = ?'); args.push(p.get('status')); }
  if (p.get('priority')) { where.push('i.priority = ?'); args.push(p.get('priority')); }
  const period = p.get('period');
  if (period && period !== 'all' && PERIODS[period]) {
    where.push(`p.created_at >= datetime('now', ?)`); args.push(`-${Number(period)} days`);
  }

  const limit = Math.min(50, Number(p.get('limit')) || 12);
  // Сначала то, что видели меньше всего: так внимание распределяется равномерно
  // и ни одно предложение не остаётся неоценённым.
  const items = q.all(`
    SELECT ${CARD_FIELDS},
      (SELECT COUNT(*) FROM proposal_reviews rv WHERE rv.proposal_id=p.id) AS seen
    FROM proposals p
    JOIN ideas i ON i.id = p.idea_id
    JOIN users u ON u.id = p.author_id
    LEFT JOIN institutions inst ON inst.id = u.institution_id
    WHERE ${where.join(' AND ')}
    ORDER BY seen ASC, p.created_at DESC
    LIMIT ?`, ...args, limit);

  const total = q.get(`SELECT COUNT(*) AS c FROM proposals p JOIN ideas i ON i.id = p.idea_id
                       WHERE ${where.join(' AND ')}`, ...args).c;
  const reviewed = q.get(
    `SELECT COUNT(*) AS c FROM proposal_reviews WHERE user_id=? AND date(created_at)=date('now')`, user.id).c;

  sendJson(200, {
    items: items.map((c) => ({
      ...c,
      kind_title: c.kind === 'experience' ? 'Проверенный опыт' : 'Идея решения',
      status_title: PROPOSAL_STATUS[c.status]?.title,
      status_tone: PROPOSAL_STATUS[c.status]?.tone,
    })),
    remaining: total,
    reviewed_today: reviewed,
    undo_enabled: settings().review_undo === '1',
  });
});

// ── Топ предложений (модератор) ──────────────────────────────
route.get('/api/review/top', async ({ user, url, sendJson }) => {
  requireModerator(user);
  const threshold = Number(settings().review_top_threshold) || 5;
  const args = [...OPEN_FOR_PROPOSALS];
  const items = q.all(`
    SELECT ${CARD_FIELDS},
      (SELECT COUNT(*) FROM proposal_reviews rv WHERE rv.proposal_id=p.id AND rv.verdict='skip') AS skips
    FROM proposals p
    JOIN ideas i ON i.id = p.idea_id
    JOIN users u ON u.id = p.author_id
    LEFT JOIN institutions inst ON inst.id = u.institution_id
    WHERE ${VISIBLE}
    ORDER BY usefulness DESC, likes DESC, p.created_at DESC
    LIMIT ?`, ...args, Math.min(100, Number(url.searchParams.get('limit')) || 30));

  // Причины пропуска — сигнал о том, что именно смущает коллег в предложении
  const reasons = {};
  for (const r of q.all(`SELECT proposal_id, reason, COUNT(*) AS c FROM proposal_reviews
                         WHERE verdict='skip' AND reason IS NOT NULL GROUP BY proposal_id, reason`)) {
    (reasons[r.proposal_id] ||= []).push({ reason: r.reason, title: SKIP_REASONS[r.reason] || r.reason, count: r.c });
  }

  sendJson(200, {
    threshold,
    items: items.map((c) => ({
      ...c,
      in_top: c.likes >= threshold,
      kind_title: c.kind === 'experience' ? 'Проверенный опыт' : 'Идея решения',
      status_title: PROPOSAL_STATUS[c.status]?.title,
      status_tone: PROPOSAL_STATUS[c.status]?.tone,
      skip_reasons: reasons[c.id] || [],
    })),
  });
});

// ── Сигналы антифрода (модератор) ────────────────────────────
route.get('/api/review/flags', async ({ user, sendJson }) => {
  requireModerator(user);
  const KINDS = {
    burst: 'Серия слишком быстрых оценок',
    rate_limit: 'Превышена частота оценок',
    shared_device: 'Оценки нескольких учётных записей с одного устройства',
  };
  sendJson(200, q.all(`
    SELECT f.*, u.full_name AS user_name, inst.short_name AS institution,
      (SELECT COUNT(*) FROM proposal_reviews r WHERE r.user_id = f.user_id) AS total_reviews
    FROM review_flags f JOIN users u ON u.id = f.user_id
    LEFT JOIN institutions inst ON inst.id = u.institution_id
    WHERE f.status='open' ORDER BY f.created_at DESC`)
    .map((f) => ({ ...f, kind_title: KINDS[f.kind] || f.kind, details: JSON.parse(f.details || 'null') })));
});

route.post('/api/review/flags/:id/resolve', async ({ req, user, params, ip, sendJson }) => {
  requireModerator(user);
  const { status } = await readJson(req);
  if (!['reviewed', 'dismissed'].includes(status)) throw new HttpError(400, 'Недопустимый исход проверки');
  q.run(`UPDATE review_flags SET status=?, resolved_by=?, resolved_at=datetime('now') WHERE id=?`,
    status, user.id, Number(params.id));
  logAction(user.id, 'review.flag.resolve', 'review_flag', Number(params.id), { status }, ip);
  sendJson(200, { ok: true });
});

// ── Оценка предложения ───────────────────────────────────────
route.post('/api/review/:id', async ({ req, user, params, ip, sendJson }) => {
  requireReviewer(user);
  const b = await readJson(req);
  if (!REVIEW_VERDICTS[b.verdict]) throw new HttpError(400, 'Неизвестная оценка');
  if (b.verdict === 'skip' && b.reason && !SKIP_REASONS[b.reason]) {
    throw new HttpError(400, 'Неизвестная причина пропуска');
  }

  const rate = checkReviewRate(user.id);
  if (!rate.ok) {
    throw new HttpError(429,
      `Слишком много оценок подряд: не более ${rate.limit} за ${rate.window}. Сделайте паузу и продолжите.`);
  }

  const p = q.get(`SELECT p.*, i.status AS idea_status, i.number AS idea_number, i.title AS idea_title
                   FROM proposals p JOIN ideas i ON i.id = p.idea_id WHERE p.id=?`, Number(params.id));
  if (!p) throw new HttpError(404, 'Предложение не найдено');
  if (p.author_id === user.id) throw new HttpError(400, 'Нельзя оценивать собственное предложение');
  if (p.status === 'rejected' || !OPEN_FOR_PROPOSALS.includes(p.idea_status)) {
    throw new HttpError(400, 'Предложение больше не участвует в ревью');
  }
  if (q.get('SELECT id FROM proposal_reviews WHERE proposal_id=? AND user_id=?', p.id, user.id)) {
    throw new HttpError(409, 'Вы уже оценили это предложение');
  }

  const dwell = Number.isFinite(Number(b.dwell_ms)) ? Math.max(0, Math.round(Number(b.dwell_ms))) : null;
  const device = typeof b.device === 'string' ? b.device.slice(0, 64) : null;
  q.run(`INSERT INTO proposal_reviews (proposal_id, user_id, verdict, reason, dwell_ms, device)
         VALUES (?,?,?,?,?,?)`,
    p.id, user.id, b.verdict, b.verdict === 'skip' ? (b.reason || null) : null, dwell, device);

  logAction(user.id, `review.${b.verdict}`, 'proposal', p.id,
    { idea: p.idea_number, reason: b.reason || null, dwell_ms: dwell }, ip);

  const abuse = detectReviewAbuse(user.id, device);
  const counts = reviewCounts(p.id);
  const threshold = Number(settings().review_top_threshold) || 5;

  // Предложение, набравшее порог лайков, попадает в «Топ» — автор узнаёт об этом,
  // а модератор видит его в своей подборке. Очки при этом не начисляются.
  if (b.verdict === 'like' && counts.likes === threshold) {
    notifyIdea(p.author_id, p.idea_id, 'review_top',
      'Ваше решение вошло в топ предложений',
      `Идея ${p.idea_number}: коллеги отметили решение ${counts.likes} раз. Модератор рассмотрит его в первую очередь.`);
  }
  if (b.verdict === 'favorite') {
    logAction(user.id, 'review.favorite.priority', 'proposal', p.id, { idea: p.idea_number }, ip);
  }

  sendJson(201, { ...counts, verdict: b.verdict, flagged: abuse, undo_enabled: settings().review_undo === '1' });
});

// ── Возврат к предыдущей карточке ────────────────────────────
route.delete('/api/review/:id', async ({ user, params, ip, sendJson }) => {
  requireReviewer(user);
  if (settings().review_undo !== '1') throw new HttpError(403, 'Возврат к предыдущей карточке отключён');
  const r = q.get('SELECT * FROM proposal_reviews WHERE proposal_id=? AND user_id=?',
    Number(params.id), user.id);
  if (!r) throw new HttpError(404, 'Оценка не найдена');
  // Отменяется только последняя оценка и только сразу — иначе это уже пересмотр,
  // а не исправление промаха пальцем.
  const last = q.get('SELECT id FROM proposal_reviews WHERE user_id=? ORDER BY id DESC LIMIT 1', user.id);
  if (last.id !== r.id) throw new HttpError(400, 'Вернуться можно только к последней карточке');
  if (q.get(`SELECT 1 AS old FROM proposal_reviews
             WHERE id=? AND created_at < datetime('now','-10 minutes')`, r.id)) {
    throw new HttpError(400, 'Оценка уже зафиксирована — прошло больше десяти минут');
  }
  q.run('DELETE FROM proposal_reviews WHERE id=?', r.id);
  logAction(user.id, 'review.undo', 'proposal', r.proposal_id, { verdict: r.verdict }, ip);
  sendJson(200, { ...reviewCounts(r.proposal_id), restored: true });
});
