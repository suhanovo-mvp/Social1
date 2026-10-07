// Ядро ТЗ: подача инициативы, маршрутизация Stage-Gate, решения на Gate, SLA и эскалация,
// задачи, пилоты, проекты, аналитика и журнал аудита.
//
// Тесты идут через те же обработчики API, что и браузер: маршрут ищется роутером,
// тело запроса подаётся потоком — так проверяются и права, и сообщения об ошибках.
// Метки [US-…/ACn] связывают тест с критерием приёмки PRD (prd/prd.js).
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';

const DIR = mkdtempSync(join(tmpdir(), 'social1-gate-'));
process.env.SOCIAL1_DB = join(DIR, 'test.db');
process.on('exit', () => rmSync(DIR, { recursive: true, force: true }));

const { q } = await import('../server/db.js');
const auth = await import('../server/auth.js');
const wf = await import('../server/workflow.js');
const sla = await import('../server/sla.js');
const audit = await import('../server/audit.js');
const { matchRoute } = await import('../server/http.js');
await import('../server/api/initiatives.js');
await import('../server/api/work.js');
await import('../server/api/pilots.js');
await import('../server/api/analytics.js');

/** Вызов обработчика API так, как его вызывает сервер. */
async function call(method, path, user, body) {
  const m = matchRoute(method, path.split('?')[0]);
  assert.ok(m, `маршрут ${method} ${path} не найден`);
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  const url = new URL(`http://test${path}`);
  let out = null;
  try {
    await m.handler({ req, res: null, url, params: m.params, user, token: null, ip: 'test',
      sendJson: (status, data) => { out = { status, data }; } });
  } catch (e) {
    return { status: e.status || 500, error: e.message };
  }
  return out;
}

const U = {};
let instA, instB;
function addUser(key, role, inst) {
  const { hash, salt } = auth.hashPassword('test');
  const id = q.insert(`INSERT INTO users (email, full_name, password_hash, password_salt, role, institution_id)
                       VALUES (?,?,?,?,?,?)`, `${key}@social1.test`, `Участник ${key}`, hash, salt, role, inst);
  U[key] = q.get('SELECT * FROM users WHERE id=?', id);
}

before(() => {
  auth.ensureRoles();
  wf.ensureWorkflow();
  instA = q.insert("INSERT INTO institutions (name, short_name, kind, staff_count) VALUES ('ТЦСО «Альфа»','Альфа','institution',100)");
  instB = q.insert("INSERT INTO institutions (name, short_name, kind, staff_count) VALUES ('ТЦСО «Бета»','Бета','institution',80)");
  addUser('author', 'employee', instA);
  addUser('colleague', 'employee', instA);
  addUser('head', 'head', instA);
  addUser('headB', 'head', instB);
  addUser('expert', 'expert', null);
  addUser('dev', 'developer', null);
  addUser('supplier', 'supplier', null);
  addUser('pilot', 'pilot_coordinator', null);
  addUser('dtszn', 'dtszn', null);
});

const FORM = {
  title: 'Электронная очередь на приём',
  problem: 'Граждане ждут в коридоре по часу без понимания очереди',
  solution: 'Талоны с QR-кодом и уведомление о приближении очереди',
  expected_effect: 'Сокращение ожидания вдвое',
};
const submit = (user = U.author, patch = {}) => call('POST', '/api/initiatives', user, { ...FORM, ...patch });
const decide = (id, user, decision, rationale = 'Решение обосновано данными заявки', extra = {}) =>
  call('POST', `/api/initiatives/${id}/gate`, user, { decision, rationale, ...extra });
const row = (id) => q.get('SELECT * FROM initiatives WHERE id=?', id);

describe('Подача инициативы', () => {
  test('обязательные поля проверяются, короткое значение не принимается [US-INI-001/AC1]', async () => {
    for (const field of ['title', 'problem', 'solution', 'expected_effect']) {
      const r = await submit(U.author, { [field]: 'abc' });
      assert.equal(r.status, 400, `поле ${field}`);
      assert.match(r.error, /Заполните поле «/);
    }
  });

  test('эффект сохраняется числом с типом и единицей [US-INI-001/AC2]', async () => {
    const r = await submit(U.author, { effect_type: 'time', effect_value: 30, effect_unit: 'мин' });
    assert.equal(r.status, 201);
    const i = row(r.data.id);
    assert.equal(i.effect_type, 'time');
    assert.equal(i.effect_value, 30);
    assert.equal(i.effect_unit, 'мин');
  });

  test('ссылки на материалы прикладываются к инициативе [US-INI-001/AC3]', async () => {
    const r = await submit(U.author, { links: ['https://example.ru/reglament.pdf'] });
    const att = q.all('SELECT * FROM attachments WHERE initiative_id=?', r.data.id);
    assert.equal(att.length, 1);
    assert.equal(att[0].kind, 'link');
  });

  test('роль без права подачи получает отказ [US-INI-001/AC5]', async () => {
    const r = await submit(U.supplier);
    assert.equal(r.status, 403);
  });

  test('номер вида SOC-<год>-NNNN, сквозной внутри года [US-INI-002/AC1]', async () => {
    const a = (await submit()).data.number;
    const b = (await submit()).data.number;
    const year = new Date().getFullYear();
    assert.match(a, new RegExp(`^SOC-${year}-\\d{4}$`));
    assert.equal(Number(b.split('-')[2]), Number(a.split('-')[2]) + 1);
  });
});

describe('Маршрутизация по этапам', () => {
  let id;
  before(async () => { id = (await submit()).data.id; });

  test('после подачи инициатива сама уходит на Gate 1 [US-SG-001/AC1]', () => {
    const i = row(id);
    assert.equal(i.stage, 2);
    const t = q.get('SELECT * FROM stage_transitions WHERE initiative_id=? AND to_stage=2', id);
    assert.match(t.reason, /Автоматический переход/);
  });

  test('шесть стадий с пятью Gate в порядке ТЗ [US-SG-001/AC2]', () => {
    const s = wf.stages();
    assert.equal(s.length, 6);
    assert.deepEqual(s.map((x) => x.gate_no), [null, 1, 2, 3, 4, 5]);
    assert.deepEqual(s.map((x) => x.role_required), [null, 'head', 'expert', 'developer', 'pilot_coordinator', 'dtszn']);
  });

  test('задача на Gate 1 создаётся руководителю учреждения автора со сроком [US-SG-001/AC3]', () => {
    const t = q.get("SELECT * FROM tasks WHERE initiative_id=? AND type='gate' AND status='open'", id);
    assert.equal(t.role_target, 'head');
    assert.equal(t.institution_id, instA);
    assert.ok(t.due_at);
  });

  test('автор узнаёт о подаче, руководитель — о нужном решении [US-SG-001/AC4]', () => {
    assert.ok(q.get("SELECT id FROM notifications WHERE user_id=? AND initiative_id=? AND type='submitted'", U.author.id, id));
    assert.ok(q.get("SELECT id FROM notifications WHERE user_id=? AND initiative_id=? AND type='gate_pending'", U.head.id, id));
    assert.equal(q.get("SELECT id FROM notifications WHERE user_id=? AND initiative_id=? AND type='gate_pending'", U.headB.id, id), undefined);
  });

  test('задачу видит руководитель своего учреждения, но не чужого [US-HOME-002/AC1]', async () => {
    const mine = await call('GET', '/api/tasks', U.head);
    const other = await call('GET', '/api/tasks', U.headB);
    assert.ok(mine.data.some((t) => t.initiative_id === id));
    assert.ok(!other.data.some((t) => t.initiative_id === id));
  });

  test('чужую задачу нельзя отметить выполненной [US-HOME-002/AC3]', async () => {
    const t = q.get("SELECT id FROM tasks WHERE initiative_id=? AND type='gate'", id);
    const r = await call('POST', `/api/tasks/${t.id}/done`, U.headB);
    assert.equal(r.status, 403);
  });
});

describe('Решения на Gate', () => {
  test('решение без аргументации не принимается [US-SG-002/AC1]', async () => {
    const { id } = (await submit()).data;
    const r = await decide(id, U.head, 'go', 'коротко');
    assert.equal(r.status, 400);
    assert.match(r.error, /Аргументация обязательна/);
    assert.equal(row(id).stage, 2);
  });

  test('решает только ответственная роль, Gate 1 — руководитель своего учреждения, ДТСЗН — на любом [US-SG-002/AC3]', async () => {
    const { id } = (await submit()).data;
    assert.equal((await decide(id, U.headB, 'go')).status, 403);
    assert.equal((await decide(id, U.expert, 'go')).status, 403);
    assert.equal((await decide(id, U.dtszn, 'go')).status, 200);
    assert.equal(row(id).stage, 3);
  });

  test('на каждом Gate доступны только его решения [US-SG-002/AC2]', () => {
    const byGate = Object.fromEntries(wf.stages().filter((s) => s.gate_no).map((s) => [s.gate_no, s.decisions]));
    assert.deepEqual(byGate[1], ['go', 'kill', 'hold', 'redirect']);
    assert.deepEqual(byGate[2], ['go', 'kill', 'hold', 'redirect']);
    assert.deepEqual(byGate[3], ['go', 'kill', 'redirect']);
    assert.deepEqual(byGate[4], ['go', 'kill', 'redirect']);
    assert.deepEqual(byGate[5], ['go', 'kill']);
  });

  test('недопустимое для Gate решение отклоняется [US-SG-002/AC2]', async () => {
    const { id } = (await submit()).data;
    await decide(id, U.head, 'go');
    await decide(id, U.expert, 'go');
    assert.equal(row(id).stage, 4);
    const r = await decide(id, U.dev, 'hold');
    assert.equal(r.status, 400);
  });

  test('Go ведёт по всем стадиям, на последней — «Масштабирована» и награда автору [US-SG-002/AC4]', async () => {
    const { id } = (await submit()).data;
    for (const u of [U.head, U.expert, U.dev, U.pilot]) assert.equal((await decide(id, u, 'go')).status, 200);
    assert.equal(row(id).stage, 6);
    await decide(id, U.dtszn, 'go');
    assert.equal(row(id).status, 'scaled');
    assert.ok(q.get("SELECT id FROM awards WHERE user_id=? AND initiative_id=? AND type='scaled'", U.author.id, id));
  });

  test('Kill останавливает, Hold приостанавливает, Redirect возвращает на выбранную стадию [US-SG-002/AC5]', async () => {
    const a = (await submit()).data.id;
    await decide(a, U.head, 'kill');
    assert.equal(row(a).status, 'killed');

    const b = (await submit()).data.id;
    await decide(b, U.head, 'hold');
    assert.equal(row(b).status, 'hold');

    const c = (await submit()).data.id;
    await decide(c, U.head, 'go');
    await decide(c, U.expert, 'redirect', 'Вернуть руководителю для уточнения бюджета', { redirect_to: 2 });
    assert.equal(row(c).stage, 2);
    assert.equal(row(c).status, 'active');
  });

  test('по остановленной или приостановленной решение не принимается [US-SG-002/AC9]', async () => {
    const a = (await submit()).data.id;
    await decide(a, U.head, 'kill');
    const r1 = await decide(a, U.dtszn, 'go');
    assert.equal(r1.status, 403);
    assert.match(r1.error, /остановлена/);

    const b = (await submit()).data.id;
    await decide(b, U.head, 'hold');
    const r2 = await decide(b, U.head, 'go');
    assert.equal(r2.status, 403);
    assert.match(r2.error, /приостановлена/);
  });

  test('возобновить может автор, срок отсчитывается заново [US-SG-002/AC7]', async () => {
    const id = (await submit()).data.id;
    await decide(id, U.head, 'hold');
    q.run("UPDATE initiatives SET sla_due_at = datetime('now','-1 day') WHERE id=?", id);
    assert.equal((await call('POST', `/api/initiatives/${id}/resume`, U.colleague, {})).status, 403);
    const r = await call('POST', `/api/initiatives/${id}/resume`, U.author, { comment: 'Добавил расчёт' });
    assert.equal(r.status, 200);
    assert.equal(row(id).status, 'active');
    assert.ok(sla.parseSql(row(id).sla_due_at) > new Date());
  });

  test('решение фиксирует оценки по критериям, длительность и соблюдение срока [US-SG-002/AC8]', async () => {
    const id = (await submit()).data.id;
    await decide(id, U.head, 'go', 'Потенциал подтверждён руководителем', { criteria_scores: { 'Потенциал': 5 } });
    const d = q.get('SELECT * FROM gate_decisions WHERE initiative_id=?', id);
    assert.equal(d.gate_no, 1);
    assert.deepEqual(JSON.parse(d.criteria_scores), { 'Потенциал': 5 });
    assert.equal(d.sla_met, 1);
    assert.ok(d.duration_hours >= 0);
  });
});

describe('Сроки и эскалация', () => {
  test('сроки этапов по ТЗ [US-SG-003/AC1]', () => {
    const s = Object.fromEntries(wf.stages().filter((x) => x.gate_no).map((x) => [x.gate_no, [x.sla_value, x.sla_unit]]));
    assert.deepEqual(s[1], [3, 'workdays']);
    assert.deepEqual(s[2], [5, 'workdays']);
    assert.deepEqual(s[3], [56, 'calendardays']);
    assert.deepEqual(s[4], [37, 'calendardays']);
    assert.deepEqual(s[5], [14, 'calendardays']);
  });

  test('рабочие дни пропускают субботу и воскресенье [US-SG-003/AC2]', () => {
    const friday = new Date('2026-10-02T09:00:00Z');
    assert.equal(sla.addWorkdays(friday, 1).getUTCDay(), 1);              // понедельник
    assert.equal(sla.addWorkdays(friday, 3).toISOString().slice(0, 10), '2026-10-07');
  });

  test('три уровня состояния срока [US-SG-003/AC3]', () => {
    const at = (h) => sla.iso(new Date(Date.now() + h * 36e5));
    assert.equal(sla.slaStateOf(at(48)).label, 'В рамках SLA');
    assert.equal(sla.slaStateOf(at(5)).label, 'Риск нарушения SLA');
    assert.equal(sla.slaStateOf(at(-1)).label, 'SLA нарушен');
  });

  test('остановленное дело срок не нарушает [US-SG-003/AC6]', () => {
    const past = sla.iso(new Date(Date.now() - 864e5));
    assert.equal(wf.slaState({ sla_due_at: past, status: 'hold' }).code, 'none');
    assert.equal(wf.slaState({ sla_due_at: past, status: 'killed' }).code, 'none');
  });

  test('просрочка эскалируется координатору ДТСЗН с записью в аудит [US-SG-003/AC4]', async () => {
    const id = (await submit()).data.id;
    q.run("UPDATE initiatives SET sla_due_at = datetime('now','-1 hour') WHERE id=?", id);
    const r = wf.sweepSla();
    assert.ok(r.escalated >= 1);
    assert.equal(q.get("SELECT status FROM tasks WHERE initiative_id=? AND type='gate'", id).status, 'escalated');
    assert.ok(q.get("SELECT id FROM notifications WHERE user_id=? AND initiative_id=? AND type='sla_breach'", U.dtszn.id, id));
    assert.ok(q.get("SELECT id FROM audit_log WHERE action='sla.escalated' AND entity_id=?", id));
    // эскалированная задача идёт в списке первой
    const tasks = (await call('GET', '/api/tasks', U.head)).data;
    assert.equal(tasks[0].status, 'escalated');
  });
});

describe('Реестр: поиск, фильтры, голоса', () => {
  test('фильтр по этапу, статусу и учреждению; поиск по номеру и тексту [US-INI-003/AC1] [US-INI-003/AC2]', async () => {
    const id = (await submit(U.author, { title: 'Уникальная инициатива про пандусы' })).data.id;
    const byText = await call('GET', '/api/initiatives?q=пандусы', U.colleague);
    assert.deepEqual(byText.data.items.map((i) => i.id), [id]);
    const num = row(id).number;
    assert.equal((await call('GET', `/api/initiatives?q=${num}`, U.colleague)).data.items[0].id, id);
    const st = await call('GET', '/api/initiatives?stage=2&status=active', U.colleague);
    assert.ok(st.data.items.every((i) => i.stage === 2 && i.status === 'active'));
    const inst = await call('GET', `/api/initiatives?institution=${instB}`, U.colleague);
    assert.equal(inst.data.total, 0);
  });

  test('поставщик видит только дошедшие до разработки [US-INI-003/AC6]', async () => {
    const r = await call('GET', '/api/initiatives?limit=200', U.supplier);
    assert.ok(r.data.items.length > 0);
    assert.ok(r.data.items.every((i) => i.stage >= 4));
  });

  test('повторный голос снимает свой, по завершённой голосовать нельзя [US-INI-004/AC2] [US-INI-004/AC3]', async () => {
    const id = (await submit()).data.id;
    assert.equal((await call('POST', `/api/initiatives/${id}/vote`, U.colleague, { value: 1 })).data.votes_score, 1);
    assert.equal((await call('POST', `/api/initiatives/${id}/vote`, U.colleague, { value: 1 })).data.votes_score, 0);
    await decide(id, U.head, 'kill');
    assert.equal((await call('POST', `/api/initiatives/${id}/vote`, U.colleague, { value: 1 })).status, 400);
  });

  test('короткий комментарий не публикуется, автор узнаёт о новом [US-INI-004/AC1]', async () => {
    const id = (await submit()).data.id;
    assert.equal((await call('POST', `/api/initiatives/${id}/comments`, U.colleague, { body: 'a' })).status, 400);
    assert.equal((await call('POST', `/api/initiatives/${id}/comments`, U.colleague, { body: 'Поддерживаю, у нас то же' })).status, 201);
    assert.ok(q.get("SELECT id FROM notifications WHERE user_id=? AND initiative_id=? AND type='comment'", U.author.id, id));
  });
});

describe('Разработка и пилот', () => {
  let id;
  before(async () => {
    id = (await submit()).data.id;
    await decide(id, U.head, 'go');
    await decide(id, U.expert, 'go');
  });

  test('проект создаёт команда разработки, второй на ту же инициативу не создаётся [US-DEV-001/AC1]', async () => {
    assert.equal((await call('POST', '/api/projects', U.author, { initiative_id: id })).status, 403);
    assert.equal((await call('POST', '/api/projects', U.dev, { initiative_id: id })).status, 201);
    assert.equal((await call('POST', '/api/projects', U.dev, { initiative_id: id })).status, 409);
  });

  test('заявка площадки: повторная от того же учреждения не принимается [US-PIL-001/AC1]', async () => {
    assert.equal((await call('POST', '/api/pilot-applications', U.author, { initiative_id: id })).status, 403);
    assert.equal((await call('POST', '/api/pilot-applications', U.headB, { initiative_id: id, message: 'Готовы' })).status, 201);
    assert.equal((await call('POST', '/api/pilot-applications', U.headB, { initiative_id: id })).status, 409);
  });

  test('одобрение создаёт пилот на 30 дней и уведомляет заявителя [US-PIL-001/AC3]', async () => {
    const app = q.get('SELECT id FROM pilot_applications WHERE initiative_id=?', id);
    const r = await call('POST', `/api/pilot-applications/${app.id}/approve`, U.pilot, {});
    assert.equal(r.status, 201);
    const days = (new Date(r.data.ends_at) - new Date(r.data.starts_at)) / 864e5;
    assert.equal(days, 30);
    assert.ok(q.get("SELECT id FROM notifications WHERE user_id=? AND type='pilot_approved'", U.headB.id));
  });

  test('на опрос пилота отвечают один раз, закрытый ответов не принимает [US-PIL-003/AC2]', async () => {
    const pilot = q.get('SELECT id FROM pilots WHERE initiative_id=?', id);
    const s = await call('POST', '/api/surveys', U.pilot, { pilot_id: pilot.id, title: 'Удобство', questions: [{ text: 'Оценка', type: 'scale' }] });
    const qid = q.get('SELECT id FROM survey_questions WHERE survey_id=?', s.data.id).id;
    const answer = { answers: [{ question_id: qid, value_num: 4 }] };
    assert.equal((await call('POST', `/api/surveys/${s.data.id}/respond`, U.colleague, answer)).status, 201);
    assert.equal((await call('POST', `/api/surveys/${s.data.id}/respond`, U.colleague, answer)).status, 409);
    q.run('UPDATE surveys SET is_open=0 WHERE id=?', s.data.id);
    assert.equal((await call('POST', `/api/surveys/${s.data.id}/respond`, U.author, answer)).status, 400);
  });
});

describe('Аналитика', () => {
  test('масштаб определяется правами: ДТСЗН — всё, руководитель — учреждение, сотрудник — свои [US-ANL-004/AC1]', async () => {
    const all = await call('GET', '/api/analytics/overview?scope=all', U.dtszn);
    const head = await call('GET', '/api/analytics/overview?scope=all', U.headB);
    const mine = await call('GET', '/api/analytics/overview?scope=all', U.colleague);
    assert.ok(all.data.group1.total_initiatives > 0);
    assert.equal(head.data.group1.total_initiatives, 0);   // от учреждения «Бета» инициатив нет
    assert.equal(mine.data.group1.total_initiatives, 0);   // коллега сам не подавал
  });

  test('прохождение Gate разложено по решениям [US-ANL-001/AC2]', async () => {
    const r = await call('GET', '/api/analytics/overview?scope=all', U.dtszn);
    const g1 = r.data.group1.gate_passage.find((g) => g.gate_no === 1);
    const db = q.get(`SELECT SUM(decision='go') AS go, SUM(decision='kill') AS kill, SUM(decision='hold') AS hold
                      FROM gate_decisions WHERE gate_no = 1`);
    assert.equal(g1.go, db.go);
    assert.equal(g1.kill, db.kill);
    assert.equal(g1.hold, db.hold);
  });

  test('успешность пилотирования = Go на Gate 4 / прошедшие Gate 3 [US-ANL-002/AC3]', async () => {
    const r = await call('GET', '/api/analytics/overview?scope=all', U.dtszn);
    const { pilot_passed_g3: g3, pilot_go_g4: g4, pilot_success_rate: rate } = r.data.group2;
    assert.ok(g3 > 0);
    assert.equal(rate, Math.round((g4 / g3) * 1000) / 10);
  });

  test('риск «заморозки» считает активные с просроченным сроком [US-ANL-003/AC2]', async () => {
    const r = await call('GET', '/api/analytics/overview?scope=all', U.dtszn);
    const frozen = q.get("SELECT COUNT(*) AS c FROM initiatives WHERE status='active' AND sla_due_at < datetime('now')").c;
    assert.ok(frozen >= 1);
    assert.equal(r.data.group3.frozen_count, frozen);
  });

  test('выгрузка недоступна сотруднику [US-ANL-004/AC4]', async () => {
    const r = await call('GET', '/api/analytics/export', U.colleague);
    assert.equal(r.status, 403);
  });
});

describe('Журнал аудита и пароли', () => {
  test('цепочка хэшей цела и проверяется [US-SEC-002/AC1] [US-SEC-002/AC2]', () => {
    const v = audit.verifyChain();
    assert.equal(v.valid, true);
    assert.ok(v.checked > 0);
  });

  test('изменить или удалить запись журнала не даёт база данных [US-SEC-002/AC3]', () => {
    assert.throws(() => q.run("UPDATE audit_log SET action='x' WHERE id=1"));
    assert.throws(() => q.run('DELETE FROM audit_log WHERE id=1'));
  });

  test('пароль хранится scrypt-хэшем с индивидуальной солью [US-SEC-001/AC1]', () => {
    const a = auth.hashPassword('social1');
    const b = auth.hashPassword('social1');
    assert.notEqual(a.salt, b.salt);
    assert.notEqual(a.hash, b.hash);
    assert.ok(auth.verifyPassword('social1', a.hash, a.salt));
    assert.ok(!auth.verifyPassword('wrong', a.hash, a.salt));
  });
});
