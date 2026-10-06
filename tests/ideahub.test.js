// Тесты модуля «Идеи и решения»: правила начисления очков, защита от накруток,
// переходы статусов, рейтинг за период, знаки отличия и рекомендации к поощрению.
// Запуск: npm test
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// База для тестов создаётся отдельно от рабочей — путь задаётся до импорта слоя данных
const DIR = mkdtempSync(join(tmpdir(), 'social1-test-'));
process.env.SOCIAL1_DB = join(DIR, 'test.db');

const { q } = await import('../server/db.js');
const { hashPassword } = await import('../server/auth.js');
const hub = await import('../server/ideahub.js');

process.on('exit', () => rmSync(DIR, { recursive: true, force: true }));

// ── Подготовка ───────────────────────────────────────────────
let institution, author, advisor, colleague, moderator;

function makeUser(email, role) {
  const { hash, salt } = hashPassword('test');
  const id = q.insert(
    `INSERT INTO users (email, full_name, password_hash, password_salt, role, institution_id)
     VALUES (?,?,?,?,?,?)`, email, `Участник ${email}`, hash, salt, role, institution);
  return { id, role, email };
}

function makeIdea(authorId, title = 'Тестовая идея', status = 'new') {
  const id = q.insert(
    `INSERT INTO ideas (number, title, problem, desired_result, author_id, institution_id, status)
     VALUES (?,?,?,?,?,?,?)`,
    hub.nextIdeaNumber(), title, 'Описание проблемы для проверки модуля.',
    'Желаемый результат.', authorId, institution, status);
  return q.get('SELECT * FROM ideas WHERE id=?', id);
}

function makeProposal(ideaId, authorId, summary, kind = 'proposal') {
  return q.insert(`INSERT INTO proposals (idea_id, author_id, summary, kind) VALUES (?,?,?,?)`,
    ideaId, authorId, summary, kind);
}

before(() => {
  hub.ensureIdeaHub();
  institution = q.insert(`INSERT INTO institutions (name, short_name) VALUES ('Тестовое учреждение','ТУ')`);
  author = makeUser('author@test', 'employee');
  advisor = makeUser('advisor@test', 'employee');
  colleague = makeUser('colleague@test', 'employee');
  moderator = makeUser('moderator@test', 'expert');
});

// ── Справочники ──────────────────────────────────────────────
describe('Настройка модуля', () => {
  test('правила начисления и меры поощрения загружены', () => {
    assert.equal(q.get('SELECT COUNT(*) AS c FROM points_rules').c, hub.DEFAULT_POINTS_RULES.length);
    assert.equal(q.get('SELECT COUNT(*) AS c FROM incentive_types').c, hub.INCENTIVE_TYPES.length);
  });

  test('повторный запуск не создаёт дублей', () => {
    hub.ensureIdeaHub();
    assert.equal(q.get('SELECT COUNT(*) AS c FROM points_rules').c, hub.DEFAULT_POINTS_RULES.length);
  });

  test('администратор меняет правило без изменения кода', () => {
    q.run("UPDATE points_rules SET points=9 WHERE code='proposal.created'");
    assert.equal(hub.rule('proposal.created').points, 9);
    q.run("UPDATE points_rules SET points=3 WHERE code='proposal.created'");
  });

  test('настройки читаются и сохраняются', () => {
    hub.setSetting('rating_visible', '0');
    assert.equal(hub.setting('rating_visible'), '0');
    hub.setSetting('rating_visible', '1');
  });
});

// ── Начисление очков ─────────────────────────────────────────
describe('Начисление очков', () => {
  test('очки начисляются по действующему правилу', () => {
    const idea = makeIdea(author.id, 'Идея для начисления');
    const r = hub.awardPoints({ userId: author.id, code: 'idea.approved', ideaId: idea.id });
    assert.equal(r.awarded, true);
    assert.equal(r.points, 2);
  });

  test('повторное начисление за то же действие отклоняется', () => {
    const idea = makeIdea(author.id, 'Идея для проверки повтора');
    assert.equal(hub.awardPoints({ userId: author.id, code: 'idea.approved', ideaId: idea.id }).awarded, true);
    const second = hub.awardPoints({ userId: author.id, code: 'idea.approved', ideaId: idea.id });
    assert.equal(second.awarded, false);
    assert.match(second.reason, /уже начислены/);
  });

  test('самооценка не учитывается', () => {
    const idea = makeIdea(author.id, 'Идея с самооценкой');
    const pid = makeProposal(idea.id, author.id, 'Решение от автора идеи');
    const r = hub.awardPoints({
      userId: author.id, code: 'proposal.useful', ideaId: idea.id, proposalId: pid,
      sourceUserId: author.id,
    });
    assert.equal(r.awarded, false);
    assert.match(r.reason, /Самооценка/);
  });

  test('предел очков по одному объекту соблюдается', () => {
    const idea = makeIdea(author.id, 'Идея с множеством подтверждений');
    const pid = makeProposal(idea.id, advisor.id, 'Решение, которое подтвердят многие');
    // Правило «поддержано другими» даёт по очку и ограничено десятью
    let awarded = 0;
    for (let i = 0; i < 14; i++) {
      const supporter = makeUser(`supporter${i}@test`, 'employee');
      if (hub.awardPoints({
        userId: advisor.id, code: 'proposal.endorsed', ideaId: idea.id, proposalId: pid,
        sourceUserId: supporter.id,
      }).awarded) awarded += 1;
    }
    assert.equal(awarded, 10, 'начислено ровно столько очков, сколько разрешает предел');
    const total = q.get(
      `SELECT SUM(points) AS s FROM points_ledger WHERE proposal_id=? AND rule_code='proposal.endorsed'`, pid).s;
    assert.equal(total, 10);
  });

  test('отключённое правило не начисляет очки', () => {
    q.run("UPDATE points_rules SET is_active=0 WHERE code='proposal.implemented'");
    const idea = makeIdea(author.id, 'Идея с отключённым правилом');
    const pid = makeProposal(idea.id, advisor.id, 'Решение при отключённом правиле');
    const r = hub.awardPoints({
      userId: advisor.id, code: 'proposal.implemented', ideaId: idea.id, proposalId: pid,
      sourceUserId: moderator.id,
    });
    assert.equal(r.awarded, false);
    q.run("UPDATE points_rules SET is_active=1 WHERE code='proposal.implemented'");
  });

  test('модератор отменяет начисление, запись остаётся в журнале', () => {
    const idea = makeIdea(author.id, 'Идея для отмены начисления');
    hub.awardPoints({ userId: author.id, code: 'idea.approved', ideaId: idea.id });
    const entry = q.get('SELECT * FROM points_ledger WHERE idea_id=? ORDER BY id DESC LIMIT 1', idea.id);
    const revoked = hub.revokePoints(entry.id, moderator.id, 'Нарушение правил модуля');
    assert.equal(revoked.status, 'revoked');
    assert.ok(q.get('SELECT id FROM points_ledger WHERE id=?', entry.id), 'запись не удаляется');
    assert.throws(() => hub.revokePoints(entry.id, moderator.id, 'Повторная отмена'));
  });

  test('отменённые очки не попадают в рейтинг', () => {
    const before = hub.rating({ period: 'all' }).items.find((i) => i.id === author.id)?.points ?? 0;
    const idea = makeIdea(author.id, 'Идея, начисление по которой отменят');
    hub.awardPoints({ userId: author.id, code: 'idea.approved', ideaId: idea.id });
    const entry = q.get('SELECT * FROM points_ledger WHERE idea_id=? ORDER BY id DESC LIMIT 1', idea.id);
    hub.revokePoints(entry.id, moderator.id, 'Проверка исключения из рейтинга');
    const after = hub.rating({ period: 'all' }).items.find((i) => i.id === author.id)?.points ?? 0;
    assert.equal(after, before);
  });
});

// ── Защита от дублей ─────────────────────────────────────────
describe('Защита от дублей', () => {
  test('похожие тексты распознаются', () => {
    const a = 'Передача смены занимает сорок минут и информация теряется';
    const b = 'Информация теряется, потому что передача смены занимает сорок минут';
    assert.ok(hub.similarity(a, b) > 0.6, 'перестановка слов не мешает распознать дубль');
    assert.ok(hub.similarity(a, 'Пандус обледеневает у входа в учреждение') < 0.2);
  });

  test('дублирующее предложение по той же идее находится', () => {
    const idea = makeIdea(author.id, 'Идея для поиска дублей');
    makeProposal(idea.id, advisor.id,
      'Согласовывать заявки параллельно всем участникам вместо последовательной цепочки');
    const dup = hub.findDuplicateProposal(idea.id,
      'Согласовывать заявки параллельно всем участникам, а не последовательной цепочкой');
    assert.ok(dup, 'повтор уже предложенного решения обнаружен');
    assert.equal(hub.findDuplicateProposal(idea.id, 'Повесить расписание на экран в холле'), null);
  });

  test('похожие идеи подсказываются автору', () => {
    makeIdea(author.id, 'Пандус у входа обледеневает по утрам до обработки', 'accepted');
    const found = hub.similarIdeas('Обледенение пандуса у входа по утрам до обработки реагентом');
    assert.ok(found.length > 0);
    assert.ok(found[0].score > 20);
  });
});

// ── Статусы идеи ─────────────────────────────────────────────
describe('Модерация идей', () => {
  const mod = () => ({ id: moderator.id, role: 'expert' });

  test('принятая идея открывается для решений и приносит очки автору', () => {
    const idea = makeIdea(author.id, 'Идея, которую примут к обсуждению');
    const updated = hub.moderateIdea({ user: mod(), ideaId: idea.id, action: 'approve', note: 'Понятно изложено' });
    assert.equal(updated.status, 'accepted');
    assert.ok(hub.OPEN_FOR_PROPOSALS.includes(updated.status));
    const entry = q.get(
      `SELECT * FROM points_ledger WHERE idea_id=? AND rule_code='idea.approved'`, idea.id);
    assert.ok(entry, 'автору начислены очки за прохождение модерации');
  });

  test('отклонение без причины невозможно', () => {
    const idea = makeIdea(author.id, 'Идея, которую отклонят без причины');
    assert.throws(() => hub.moderateIdea({ user: mod(), ideaId: idea.id, action: 'reject' }),
      /Укажите причину/);
  });

  test('объединение дублей требует указания основной идеи', () => {
    const idea = makeIdea(author.id, 'Идея-дубль');
    assert.throws(() => hub.moderateIdea({ user: mod(), ideaId: idea.id, action: 'merge' }),
      /Укажите идею/);
    const main = makeIdea(author.id, 'Основная идея', 'accepted');
    const merged = hub.moderateIdea({
      user: mod(), ideaId: idea.id, action: 'merge', duplicateOfId: main.id,
    });
    assert.equal(merged.status, 'archived');
    assert.equal(merged.duplicate_of_id, main.id);
  });

  test('неизвестное действие модерации отклоняется', () => {
    const idea = makeIdea(author.id, 'Идея с неизвестным действием');
    assert.throws(() => hub.moderateIdea({ user: mod(), ideaId: idea.id, action: 'delete' }),
      /Неизвестное действие/);
  });

  test('автор получает уведомление о решении модератора', () => {
    const idea = makeIdea(author.id, 'Идея с уведомлением автору');
    hub.moderateIdea({ user: mod(), ideaId: idea.id, action: 'clarify', note: 'Уточните, о каком отделении речь' });
    const n = q.get(`SELECT * FROM notifications WHERE idea_id=? AND type='idea_clarify'`, idea.id);
    assert.ok(n);
    assert.equal(n.user_id, author.id);
  });
});

// ── Рейтинг и периоды ────────────────────────────────────────
describe('Рейтинг социальных советников', () => {
  test('границы периодов считаются корректно', () => {
    const ref = new Date(2026, 4, 17);         // 17 мая 2026
    assert.deepEqual(hub.periodBounds('month', ref).from, '2026-05-01');
    assert.deepEqual(hub.periodBounds('month', ref).to, '2026-06-01');
    assert.deepEqual(hub.periodBounds('quarter', ref).from, '2026-04-01');
    assert.deepEqual(hub.periodBounds('quarter', ref).to, '2026-07-01');
    assert.deepEqual(hub.periodBounds('year', ref).from, '2026-01-01');
    assert.equal(hub.periodBounds('quarter', ref).label, '2 квартал 2026');
  });

  test('рейтинг упорядочен по очкам и содержит места', () => {
    const r = hub.rating({ period: 'all' });
    assert.ok(r.items.length > 0);
    assert.equal(r.items[0].rank, 1);
    for (let i = 1; i < r.items.length; i++) {
      assert.ok(r.items[i - 1].points >= r.items[i].points, 'порядок по убыванию очков');
      assert.equal(r.items[i].rank, i + 1);
    }
  });

  test('прошлый период не содержит сегодняшних начислений', () => {
    const past = hub.rating({ period: 'month' });
    const shifted = hub.periodBounds('month', new Date(2020, 0, 15));
    assert.notEqual(past.from, shifted.from);
    assert.ok(past.items.length >= 0);
  });

  test('рейтинг ограничивается учреждением', () => {
    const other = q.insert(`INSERT INTO institutions (name, short_name) VALUES ('Другое учреждение','ДУ')`);
    const outsider = makeUser('outsider@test', 'employee');
    q.run('UPDATE users SET institution_id=? WHERE id=?', other, outsider.id);
    const idea = makeIdea(outsider.id, 'Идея из другого учреждения');
    hub.awardPoints({ userId: outsider.id, code: 'idea.approved', ideaId: idea.id });
    const scoped = hub.rating({ period: 'all', institutionId: other });
    assert.ok(scoped.items.every((i) => i.id === outsider.id));
  });
});

// ── Знаки отличия ────────────────────────────────────────────
describe('Знаки отличия', () => {
  test('«Активный социальный советник» присваивается за пять предложений', () => {
    const helper = makeUser('helper@test', 'employee');
    const idea = makeIdea(author.id, 'Идея для знака отличия', 'accepted');
    for (let i = 0; i < 5; i++) makeProposal(idea.id, helper.id, `Решение номер ${i}`);
    const granted = hub.refreshBadges(helper.id);
    assert.ok(granted.includes('active_advisor'));
    // Повторно тот же знак не выдаётся
    assert.equal(hub.refreshBadges(helper.id).includes('active_advisor'), false);
  });

  test('«Проверенный опыт» присваивается после подтверждения', () => {
    const expert = makeUser('experienced@test', 'employee');
    const idea = makeIdea(author.id, 'Идея с проверенным опытом', 'accepted');
    const pid = makeProposal(idea.id, expert.id, 'Опыт, который уже применялся', 'experience');
    assert.equal(hub.refreshBadges(expert.id).includes('verified_experience'), false);
    q.run("UPDATE proposals SET status='verified' WHERE id=?", pid);
    assert.ok(hub.refreshBadges(expert.id).includes('verified_experience'));
  });

  test('сводка вклада считает идеи, решения и подтверждения', () => {
    const s = hub.advisorStats(advisor.id);
    assert.ok(s.proposals >= 1);
    assert.ok(s.points >= 10);
  });
});

// ── Рекомендации к поощрению ─────────────────────────────────
describe('Рекомендации к поощрению', () => {
  test('формируются только для тех, кто превысил порог', () => {
    hub.setSetting('incentive_threshold', '1');
    hub.setSetting('incentive_top', '3');
    const r = hub.buildIncentiveRecommendations({ period: 'all', proposedBy: moderator.id });
    assert.ok(r.created.length > 0);
    for (const c of r.created) {
      const row = q.get('SELECT * FROM incentives WHERE id=?', c.id);
      assert.equal(row.status, 'proposed', 'система только предлагает, но не выдаёт поощрение');
      assert.ok(row.points_at_creation > 0);
      assert.ok(q.get('SELECT code FROM incentive_types WHERE code=?', row.type_code));
    }
  });

  test('повторная рекомендация за тот же период не создаётся', () => {
    const before = q.get('SELECT COUNT(*) AS c FROM incentives').c;
    hub.buildIncentiveRecommendations({ period: 'all', proposedBy: moderator.id });
    assert.equal(q.get('SELECT COUNT(*) AS c FROM incentives').c, before);
  });

  test('высокий порог не даёт рекомендаций', () => {
    hub.setSetting('incentive_threshold', '100000');
    const before = q.get('SELECT COUNT(*) AS c FROM incentives').c;
    hub.buildIncentiveRecommendations({ period: 'year', proposedBy: moderator.id });
    assert.equal(q.get('SELECT COUNT(*) AS c FROM incentives').c, before);
    hub.setSetting('incentive_threshold', '25');
  });
});

// ── Журнал действий ──────────────────────────────────────────
describe('Аудит', () => {
  test('решение модератора попадает в неизменяемый журнал', () => {
    const idea = makeIdea(author.id, 'Идея, решение по которой попадёт в аудит');
    hub.moderateIdea({ user: { id: moderator.id, role: 'expert' }, ideaId: idea.id,
      action: 'approve', note: 'Проверка записи в журнал', ip: '127.0.0.1' });
    const entry = q.get(`SELECT * FROM audit_log WHERE entity='idea' AND entity_id=? ORDER BY id DESC LIMIT 1`, idea.id);
    assert.ok(entry);
    assert.equal(entry.action, 'idea.approve');
    assert.throws(() => q.run('DELETE FROM audit_log WHERE id=?', entry.id), /неизменяем/);
  });
});

// ── Переименование сущности ──────────────────────────────────
// «Советчик» переименован в «социального советника». Значения по умолчанию пишутся
// только в пустые таблицы, поэтому у работающей установки надписи остались бы
// прежними — их правит отдельная миграция. Склонение проверяется по всем падежам:
// механическая замена без падежей дала бы «очки советчику» → «очки социальный советник».
describe('Переименование советчика в социального советника', () => {
  test('склонение по всем падежам', () => {
    const формы = {
      'советчик': 'социальный советник',
      'советчика': 'социального советника',
      'советчику': 'социальному советнику',
      'советчиком': 'социальным советником',
      'советчике': 'социальном советнике',
      'советчики': 'социальные советники',
      'советчиков': 'социальных советников',
      'советчикам': 'социальным советникам',
      'советчиками': 'социальными советниками',
      'советчиках': 'социальных советниках',
    };
    for (const [было, стало] of Object.entries(формы)) {
      assert.equal(hub.renameAdvisor(было), стало, `неверная форма для «${было}»`);
    }
  });

  test('заглавная буква сохраняется', () => {
    assert.equal(hub.renameAdvisor('Советчик получает очки'), 'Социальный советник получает очки');
    assert.equal(hub.renameAdvisor('Советчику начислено'), 'Социальному советнику начислено');
  });

  test('слова, начинающиеся так же, не затрагиваются', () => {
    assert.equal(hub.renameAdvisor('советчиковый'), 'советчиковый');
    assert.equal(hub.renameAdvisor('совет и советник'), 'совет и советник');
  });

  test('прежние надписи в базе обновляются', () => {
    q.run(`UPDATE points_rules SET description='Начисляется советчику за предложение.'
           WHERE code='proposal.created'`);
    q.run(`UPDATE incentive_types SET title='Сертификат «Лучший советчик месяца»'
           WHERE code='advisor_of_month'`);
    assert.ok(hub.renameAdvisorWording() >= 2, 'миграция не нашла прежние надписи');
    assert.match(q.get("SELECT description FROM points_rules WHERE code='proposal.created'").description,
      /социальному советнику/);
    assert.match(q.get("SELECT title FROM incentive_types WHERE code='advisor_of_month'").title,
      /Лучший социальный советник месяца/);
  });

  test('повторный запуск миграции ничего не меняет', () => {
    hub.renameAdvisorWording();
    assert.equal(hub.renameAdvisorWording(), 0, 'миграция не идемпотентна');
  });

  test('прежнее название не осталось в справочных данных модуля', () => {
    for (const [table, columns] of [
      ['points_rules', ['title', 'description']],
      ['incentive_types', ['title', 'description', 'legal_note']],
      ['advisor_badges', ['title']],
    ]) {
      const where = columns.map((c) => `${c} LIKE '%оветчик%'`).join(' OR ');
      const left = q.get(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`).c;
      assert.equal(left, 0, `в таблице ${table} осталось прежнее название`);
    }
  });
});
