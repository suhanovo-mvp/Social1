// Тесты быстрого ревью предложений: правила оценки, антифрод, полезность,
// топ предложений и разделение оценок и начисления очков.
import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DIR = mkdtempSync(join(tmpdir(), 'social1-review-'));
process.env.SOCIAL1_DB = join(DIR, 'review.db');

const { q } = await import('../server/db.js');
const { hashPassword } = await import('../server/auth.js');
const hub = await import('../server/ideahub.js');

process.on('exit', () => rmSync(DIR, { recursive: true, force: true }));

let institution, author, advisor, idea, proposal;
let seq = 0;

function makeUser(role = 'employee') {
  const { hash, salt } = hashPassword('test');
  seq += 1;
  const id = q.insert(
    `INSERT INTO users (email, full_name, password_hash, password_salt, role, institution_id)
     VALUES (?,?,?,?,?,?)`,
    `u${seq}@test`, `Участник ${seq}`, hash, salt, role, institution);
  return { id, role };
}

function makeIdea(authorId, status = 'accepted') {
  const id = q.insert(
    `INSERT INTO ideas (number, title, problem, desired_result, author_id, institution_id, status)
     VALUES (?,?,?,?,?,?,?)`,
    hub.nextIdeaNumber(), 'Идея для ревью', 'Описание проблемы для проверки ревью.',
    'Желаемый результат.', authorId, institution, status);
  return q.get('SELECT * FROM ideas WHERE id=?', id);
}

function makeProposal(ideaId, authorId, summary = 'Решение для проверки ревью') {
  return q.insert('INSERT INTO proposals (idea_id, author_id, summary) VALUES (?,?,?)',
    ideaId, authorId, summary);
}

/** Оценка в обход HTTP-слоя — те же записи, что делает обработчик маршрута. */
function review(proposalId, userId, verdict, { reason = null, dwell = 4000, device = null } = {}) {
  q.run(`INSERT INTO proposal_reviews (proposal_id, user_id, verdict, reason, dwell_ms, device)
         VALUES (?,?,?,?,?,?)`, proposalId, userId, verdict, reason, dwell, device);
}

before(() => {
  hub.ensureIdeaHub();
  institution = q.insert(`INSERT INTO institutions (name, short_name) VALUES ('Учреждение','У')`);
  author = makeUser();
  advisor = makeUser();
  idea = makeIdea(author.id);
  proposal = makeProposal(idea.id, advisor.id);
});

// ── Счётчики и полезность ────────────────────────────────────
describe('Оценки и полезность', () => {
  test('счётчики обновляются сразу после оценки', () => {
    const p = makeProposal(idea.id, advisor.id, 'Решение для подсчёта оценок');
    assert.deepEqual(hub.reviewCounts(p), { likes: 0, favorites: 0, skips: 0 });
    review(p, makeUser().id, 'like');
    review(p, makeUser().id, 'like');
    review(p, makeUser().id, 'favorite');
    review(p, makeUser().id, 'skip', { reason: 'costly' });
    assert.deepEqual(hub.reviewCounts(p), { likes: 2, favorites: 1, skips: 1 });
  });

  test('избранное весит вдвое больше лайка', () => {
    const p = makeProposal(idea.id, advisor.id, 'Решение для проверки веса избранного');
    review(p, makeUser().id, 'like');
    review(p, makeUser().id, 'favorite');
    const usefulness = q.get(
      `SELECT ${hub.usefulnessSql('p')} AS u FROM proposals p WHERE p.id=?`, p).u;
    assert.equal(usefulness, 3, 'лайк даёт 1, избранное — 2');
  });

  test('пропуски не уменьшают полезность', () => {
    const p = makeProposal(idea.id, advisor.id, 'Решение, которое многие пропустили');
    review(p, makeUser().id, 'like');
    for (let i = 0; i < 5; i++) review(p, makeUser().id, 'skip', { reason: 'unclear' });
    const usefulness = q.get(
      `SELECT ${hub.usefulnessSql('p')} AS u FROM proposals p WHERE p.id=?`, p).u;
    assert.equal(usefulness, 1);
  });

  test('повторная оценка одного предложения невозможна', () => {
    const p = makeProposal(idea.id, advisor.id, 'Решение для проверки повторной оценки');
    const user = makeUser();
    review(p, user.id, 'like');
    assert.throws(() => review(p, user.id, 'skip'), /UNIQUE|constraint/i);
  });

  test('причины пропуска ограничены закрытым списком', () => {
    assert.ok(hub.SKIP_REASONS.unclear);
    assert.ok(hub.SKIP_REASONS.against_rules);
    assert.equal(hub.SKIP_REASONS.whatever, undefined);
    assert.equal(Object.keys(hub.SKIP_REASONS).length, 6);
  });
});

// ── Оценки и очки разделены ──────────────────────────────────
describe('Оценки не начисляют очки', () => {
  test('лайки не создают записей в журнале начислений', () => {
    const p = makeProposal(idea.id, advisor.id, 'Решение, которое лайкнут много раз');
    const before = q.get('SELECT COUNT(*) AS c FROM points_ledger').c;
    for (let i = 0; i < 12; i++) review(p, makeUser().id, 'like');
    assert.equal(q.get('SELECT COUNT(*) AS c FROM points_ledger').c, before,
      'массовое пролистывание не превращается в очки');
  });

  test('очки идут только за подтверждение вклада', () => {
    const p = makeProposal(idea.id, advisor.id, 'Решение, признанное полезным автором идеи');
    review(p, makeUser().id, 'like');
    const r = hub.awardPoints({
      userId: advisor.id, code: 'proposal.useful', ideaId: idea.id, proposalId: p,
      sourceUserId: author.id,
    });
    assert.equal(r.awarded, true);
    assert.equal(r.points, 5);
  });
});

// ── Антифрод ─────────────────────────────────────────────────
describe('Антифрод', () => {
  beforeEach(() => {
    q.run("UPDATE review_flags SET status='reviewed'");
  });

  test('серия слишком быстрых оценок поднимает сигнал', () => {
    const user = makeUser();
    const limit = Number(hub.settings().review_burst_limit);
    let flagged = null;
    for (let i = 0; i < limit; i++) {
      const p = makeProposal(idea.id, advisor.id, `Решение для серии номер ${i}`);
      review(p, user.id, 'like', { dwell: 100, device: `fast-${user.id}` });
      flagged = hub.detectReviewAbuse(user.id, `fast-${user.id}`);
    }
    assert.equal(flagged, 'burst');
    const flag = q.get(`SELECT * FROM review_flags WHERE user_id=? AND kind='burst' AND status='open'`, user.id);
    assert.ok(flag, 'сигнал попал в очередь модератора');
  });

  test('вдумчивые оценки сигнал не поднимают', () => {
    const user = makeUser();
    const limit = Number(hub.settings().review_burst_limit);
    let flagged = null;
    for (let i = 0; i < limit; i++) {
      const p = makeProposal(idea.id, advisor.id, `Решение прочитанное номер ${i}`);
      review(p, user.id, 'like', { dwell: 6000, device: `slow-${user.id}` });
      flagged = hub.detectReviewAbuse(user.id, `slow-${user.id}`);
    }
    assert.equal(flagged, null);
  });

  test('оценки нескольких учётных записей с одного устройства', () => {
    const a = makeUser(), b = makeUser();
    const p1 = makeProposal(idea.id, advisor.id, 'Первое решение для проверки устройства');
    const p2 = makeProposal(idea.id, advisor.id, 'Второе решение для проверки устройства');
    review(p1, a.id, 'like', { device: 'shared-1' });
    assert.equal(hub.detectReviewAbuse(a.id, 'shared-1'), null);
    review(p2, b.id, 'like', { device: 'shared-1' });
    assert.equal(hub.detectReviewAbuse(b.id, 'shared-1'), 'shared_device');
  });

  test('повторный сигнал не создаёт вторую запись', () => {
    const user = makeUser();
    hub.raiseReviewFlag(user.id, 'burst', { count: 5 });
    hub.raiseReviewFlag(user.id, 'burst', { count: 9 });
    const rows = q.all(`SELECT * FROM review_flags WHERE user_id=? AND kind='burst'`, user.id);
    assert.equal(rows.length, 1);
    assert.equal(JSON.parse(rows[0].details).count, 9, 'сигнал обновляется свежими данными');
  });

  test('частота оценок ограничена настройкой', () => {
    const user = makeUser();
    hub.setSetting('review_per_minute', '3');
    for (let i = 0; i < 3; i++) {
      const p = makeProposal(idea.id, advisor.id, `Решение для проверки частоты ${i}`);
      review(p, user.id, 'like');
    }
    const check = hub.checkReviewRate(user.id);
    assert.equal(check.ok, false);
    assert.equal(check.limit, 3);
    hub.setSetting('review_per_minute', '30');
    // Другого участника предел не касается
    assert.equal(hub.checkReviewRate(makeUser().id).ok, true);
  });
});

// ── Топ предложений ──────────────────────────────────────────
describe('Топ предложений', () => {
  test('порог попадания в топ задаётся настройкой', () => {
    hub.setSetting('review_top_threshold', '3');
    const p = makeProposal(idea.id, advisor.id, 'Решение на границе порога топа');
    review(p, makeUser().id, 'like');
    review(p, makeUser().id, 'like');
    assert.ok(hub.reviewCounts(p).likes < Number(hub.settings().review_top_threshold));
    review(p, makeUser().id, 'like');
    assert.equal(hub.reviewCounts(p).likes, Number(hub.settings().review_top_threshold));
    hub.setSetting('review_top_threshold', '5');
  });

  test('порядок топа определяется полезностью', () => {
    const strong = makeProposal(idea.id, advisor.id, 'Сильное решение с избранным');
    const weak = makeProposal(idea.id, advisor.id, 'Слабое решение с парой лайков');
    for (let i = 0; i < 2; i++) review(strong, makeUser().id, 'favorite');
    for (let i = 0; i < 3; i++) review(weak, makeUser().id, 'like');
    const rows = q.all(
      `SELECT p.id, ${hub.usefulnessSql('p')} AS u FROM proposals p
       WHERE p.id IN (?,?) ORDER BY u DESC`, strong, weak);
    assert.equal(rows[0].id, strong, 'избранное поднимает предложение выше');
  });
});

// ── Видимость очереди ────────────────────────────────────────
describe('Очередь ревью', () => {
  test('предложения к неопубликованной идее в ревью не участвуют', () => {
    assert.equal(hub.OPEN_FOR_PROPOSALS.includes('new'), false);
    assert.equal(hub.OPEN_FOR_PROPOSALS.includes('rejected'), false);
    assert.equal(hub.OPEN_FOR_PROPOSALS.includes('archived'), false);
    assert.ok(hub.OPEN_FOR_PROPOSALS.includes('accepted'));
  });

  test('очередь исключает свои и уже оценённые предложения', () => {
    const reviewer = makeUser();
    const own = makeProposal(idea.id, reviewer.id, 'Собственное решение ревьюера');
    const seen = makeProposal(idea.id, advisor.id, 'Уже оценённое решение');
    const fresh = makeProposal(idea.id, advisor.id, 'Ещё не оценённое решение');
    review(seen, reviewer.id, 'like');

    const queue = q.all(`
      SELECT p.id FROM proposals p JOIN ideas i ON i.id = p.idea_id
      WHERE p.status != 'rejected' AND i.status IN ('review','accepted','in_progress')
        AND p.author_id != ?
        AND NOT EXISTS (SELECT 1 FROM proposal_reviews rv WHERE rv.proposal_id=p.id AND rv.user_id=?)`,
      reviewer.id, reviewer.id).map((r) => r.id);

    assert.equal(queue.includes(own), false, 'своё предложение не показывается');
    assert.equal(queue.includes(seen), false, 'оценённое повторно не показывается');
    assert.ok(queue.includes(fresh));
  });
});
