// Событийный слой: доставка подписчикам, устойчивость к сбою обработчика и
// метрики времени в состоянии.
//
// Главное требование к слою — сбой отклика не отменяет исходное действие.
// Иначе упавшее начисление очков откатило бы публикацию решения, и платформа
// теряла бы работу людей из-за второстепенного механизма.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DIR = mkdtempSync(join(tmpdir(), 'social1-events-'));
process.env.SOCIAL1_DB = join(DIR, 'test.db');
process.on('exit', () => rmSync(DIR, { recursive: true, force: true }));

const { q } = await import('../server/db.js');
const auth = await import('../server/auth.js');
const wf = await import('../server/workflow.js');
const ev = await import('../server/events.js');

let institution, author;
before(() => {
  auth.ensureRoles();
  wf.ensureWorkflow();
  institution = q.insert("INSERT INTO institutions (name, short_name) VALUES ('ТЦСО','ТЦСО')");
  const { hash, salt } = auth.hashPassword('test');
  author = q.insert(`INSERT INTO users (email, full_name, password_hash, password_salt, role, institution_id)
                     VALUES (?,?,?,?,?,?)`, 'a@s.ru', 'Автор', hash, salt, 'employee', institution);
});
beforeEach(() => ev.reset());

describe('Доставка событий', () => {
  test('событие записывается даже без подписчиков', () => {
    const before = q.get('SELECT COUNT(*) AS c FROM events').c;
    ev.emit('test.happened', { subjectType: 'idea', subjectId: 1, actorId: author });
    assert.equal(q.get('SELECT COUNT(*) AS c FROM events').c, before + 1,
      'журнал событий — источник метрик, писать надо всегда');
  });

  test('подписчики получают событие с подробностями', () => {
    const seen = [];
    ev.on('test.delivered', 'первый', (e) => seen.push(['первый', e]));
    ev.on('test.delivered', 'второй', (e) => seen.push(['второй', e]));
    ev.emit('test.delivered', { subjectType: 'idea', subjectId: 7, number: 'IDEA-1' });

    assert.equal(seen.length, 2, 'событие получили не все подписчики');
    assert.deepEqual(seen.map((s) => s[0]), ['первый', 'второй'], 'нарушен порядок подписки');
    assert.equal(seen[0][1].subjectId, 7);
    assert.equal(seen[0][1].number, 'IDEA-1', 'произвольные поля не дошли до обработчика');
  });

  test('подписчик чужого типа события не вызывается', () => {
    let called = false;
    ev.on('test.other', 'чужой', () => { called = true; });
    ev.emit('test.mine', { subjectType: 'idea', subjectId: 1 });
    assert.equal(called, false);
  });
});

describe('Устойчивость к сбою обработчика', () => {
  test('сбой не роняет вызывающего и не мешает остальным подписчикам', () => {
    const seen = [];
    ev.on('test.failing', 'падающий', () => { throw new Error('обработчик сломался'); });
    ev.on('test.failing', 'исправный', () => seen.push('ok'));

    assert.doesNotThrow(() => ev.emit('test.failing', { subjectType: 'idea', subjectId: 3 }),
      'сбой отклика не должен отменять исходное действие');
    assert.deepEqual(seen, ['ok'], 'падение одного подписчика не должно мешать остальным');
  });

  test('сбой записывается с именем обработчика, а не теряется молча', () => {
    ev.on('test.logged', 'начисление очков', () => { throw new Error('правило отключено'); });
    ev.emit('test.logged', { subjectType: 'idea', subjectId: 4 });

    const f = q.get('SELECT * FROM event_failures ORDER BY id DESC LIMIT 1');
    assert.equal(f.handler, 'начисление очков');
    assert.match(f.message, /правило отключено/);
    assert.ok(ev.recentFailures().length > 0);
  });
});

describe('Время в состоянии', () => {
  const seedTransitions = (subjectId, steps) => {
    for (const [to, at] of steps) {
      q.run(`INSERT INTO events (type, subject_type, subject_id, to_state, at)
             VALUES ('x.status.changed','probe',?,?,?)`, subjectId, to, at);
    }
  };

  test('считает часы между переходами', () => {
    seedTransitions(101, [
      ['review', '2026-01-01 00:00:00'],
      ['work',   '2026-01-03 00:00:00'],   // в review провёл 48 часов
      ['done',   '2026-01-04 00:00:00'],   // в work провёл 24 часа
    ]);
    const spent = ev.timeInStates('probe', 101, { finished: ['done'] });
    assert.equal(Math.round(spent.review), 48);
    assert.equal(Math.round(spent.work), 24);
    assert.equal(spent.done, undefined, 'в конечном состоянии время не копится');
  });

  test('незавершённый предмет продолжает копить время в текущем состоянии', () => {
    seedTransitions(102, [['review', '2026-01-01 00:00:00']]);
    const spent = ev.timeInStates('probe', 102, { finished: ['done'] });
    assert.ok(spent.review > 0, 'открытое состояние должно учитываться до сих пор');
  });

  test('узкие места отсортированы по среднему времени', () => {
    seedTransitions(103, [
      ['review', '2026-01-01 00:00:00'],
      ['work',   '2026-01-11 00:00:00'],   // review: 240 часов
      ['done',   '2026-01-11 06:00:00'],   // work: 6 часов
    ]);
    const top = ev.bottlenecks('probe', { finished: ['done'] });
    assert.equal(top[0].state, 'review', 'самое долгое состояние должно быть первым');
    assert.ok(top[0].avg_hours > top[1].avg_hours);
  });
});

describe('Восстановление истории переходов', () => {
  test('события собираются из stage_transitions и повторно не дублируются', () => {
    const id = q.insert(`INSERT INTO initiatives (number, title, problem, solution, expected_effect,
                         author_id, institution_id, stage, status)
                         VALUES ('SOC-EV-0001','П','П','Р','Э',?,?,3,'active')`, author, institution);
    q.run(`INSERT INTO stage_transitions (initiative_id, from_stage, to_stage, at)
           VALUES (?,1,2,'2026-01-01 00:00:00'), (?,2,3,'2026-01-05 00:00:00')`, id, id);

    assert.equal(wf.ensureStageEvents(), 2, 'история переходов не восстановлена');
    assert.equal(wf.ensureStageEvents(), 0, 'повторный запуск не должен дублировать события');

    const spent = ev.timeInStates('initiative', id);
    assert.equal(Math.round(spent['2']), 96, 'на этапе 2 инициатива провела четверо суток');
  });
});
