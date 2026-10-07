// Совместная работа над процессами: замечания на шагах схемы, предложения об
// изменении, поддержка коллег, согласование и вступление изменения в силу.
//
// Главная проверка — сквозная: сотрудник предлагает убрать шаг, коллеги
// поддерживают, затронутые роли согласовывают, версия публикуется, и конвейер
// начинает работать по-новому. Если этот цикл не замыкается, весь модуль
// бессмыслен: обсуждение схем без последствий — это рисование.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DIR = mkdtempSync(join(tmpdir(), 'social1-chg-'));
process.env.SOCIAL1_DB = join(DIR, 'test.db');
process.on('exit', () => rmSync(DIR, { recursive: true, force: true }));

const { q } = await import('../server/db.js');
const auth = await import('../server/auth.js');
const wf = await import('../server/workflow.js');
const hub = await import('../server/ideahub.js');
const repo = await import('../server/process-repo.js');
const ch = await import('../server/process-changes.js');

let institution, employee, head, expert, developer, coordinator, director;

const makeUser = (email, role) => {
  const { hash, salt } = auth.hashPassword('test');
  const id = q.insert(`INSERT INTO users (email, full_name, password_hash, password_salt, role, institution_id)
                       VALUES (?,?,?,?,?,?)`, email, `Участник ${role}`, hash, salt, role, institution);
  return { id, role, institution_id: institution, extra_roles: null };
};

before(() => {
  auth.ensureRoles();
  wf.ensureWorkflow();
  hub.ensureIdeaHub();
  repo.ensureProcesses();
  institution = q.insert("INSERT INTO institutions (name, short_name) VALUES ('ТЦСО «Проверка»','ТЦСО')");
  employee = makeUser('emp@social1.mos.ru', 'employee');
  head = makeUser('head@social1.mos.ru', 'head');
  expert = makeUser('exp@social1.mos.ru', 'expert');
  developer = makeUser('dev@social1.mos.ru', 'developer');
  coordinator = makeUser('pil@social1.mos.ru', 'pilot_coordinator');
  director = makeUser('dir@social1.mos.ru', 'dtszn');
});

describe('Замечания на шагах схемы', () => {
  let comment;

  test('замечание привязывается к конкретному шагу [US-CHG-001/AC1]', () => {
    comment = ch.addComment({
      defKey: 'emp-submit', nodeId: 'search', user: employee,
      body: 'На этом шаге теряется время: доску приходится смотреть в другом разделе.',
    });
    assert.equal(comment.node_id, 'search');
    assert.equal(comment.status, 'open');
    assert.equal(comment.author_name, 'Участник employee');
  });

  test('замечание к несуществующему шагу отклоняется [US-CHG-001/AC1]', () => {
    assert.throws(() => ch.addComment({
      defKey: 'emp-submit', nodeId: 'нет-такого', user: employee, body: 'Текст',
    }), /отсутствует в схеме/);
  });

  test('счётчик замечаний по шагам собирается для меток на схеме [US-CHG-001/AC2]', () => {
    const counts = ch.commentCountsByNode('emp-submit');
    assert.equal(counts.search, 1);
  });

  test('отметка полезности начисляет очки автору замечания [US-CHG-001/AC3]', () => {
    const before = hub.advisorStats(employee.id).points;
    ch.markCommentUseful({ commentId: comment.id, user: head });
    assert.equal(ch.commentById(comment.id).useful, 1);
    assert.ok(hub.advisorStats(employee.id).points > before, 'очки за полезное замечание не начислены');
  });

  test('своё замечание отметить нельзя [US-CHG-001/AC3]', () => {
    assert.throws(() => ch.markCommentUseful({ commentId: comment.id, user: employee }), /Своё замечание/);
  });

  test('закрытое замечание уходит из счётчика [US-CHG-001/AC2]', () => {
    ch.resolveComment({ commentId: comment.id, user: employee });
    assert.equal(ch.commentCountsByNode('emp-submit').search, undefined);
  });
});

describe('Предложение об изменении', () => {
  let change;

  test('обоснование обязательно [US-CHG-002/AC1]', () => {
    assert.throws(() => ch.createChange({
      defKey: 'emp-submit', title: 'Убрать шаг', rationale: 'надо', user: employee,
    }), /Обоснование обязательно/);
  });

  test('создаётся с черновой копией действующей схемы [US-CHG-002/AC1]', () => {
    change = ch.createChange({
      defKey: 'emp-submit', title: 'Убрать отдельный шаг проверки дублей',
      rationale: 'Поиск похожих идей уже встроен в форму подачи, отдельный шаг только удлиняет путь.',
      expectedEffect: 'Путь подачи короче на один экран',
      user: employee,
    });
    assert.equal(change.status, 'draft');
    assert.match(change.number, /^PRC-\d{4}-\d{4}$/);
    const draft = repo.getVersion(change.draft_version_id);
    assert.deepEqual(draft.model, repo.getVersion(change.base_version_id).model);
  });

  test('пустое изменение на обсуждение не выносится [US-CHG-002/AC3]', () => {
    assert.throws(() => ch.submitForDiscussion({ changeId: change.id, user: employee }),
      /нет содержательных изменений/);
  });

  test('правка схемы даёт понятную сводку [US-CHG-002/AC3]', () => {
    const draft = repo.getVersion(change.draft_version_id);
    const model = structuredClone(draft.model);
    // Убираем шаг проверки дублей и перекидываем поток напрямую
    model.nodes = model.nodes.filter((n) => !['search', 'gdup', 'support', 'endsup'].includes(n.id));
    model.flows = model.flows.filter((f) => !['search', 'gdup', 'support', 'endsup'].includes(f.from)
                                         && !['search', 'gdup', 'support', 'endsup'].includes(f.to));
    model.flows.push({ from: 'st', to: 'fill', label: null, kind: null, condition: null });
    model.walkthrough = model.walkthrough.filter((w) => !['search', 'gdup'].includes(w.node));

    const result = ch.saveChangeModel({ changeId: change.id, model, user: employee });
    assert.equal(result.diff.counts.nodesRemoved, 4);
    assert.deepEqual(result.issues, [], `схема после правки не проходит проверку: ${JSON.stringify(result.issues)}`);
    assert.ok(result.summary.some((l) => l.startsWith('Убрано')), `в сводке нет удаления: ${result.summary}`);
    assert.ok(result.summary.some((l) => l.startsWith('Затронуты дорожки')), 'в сводке нет затронутых дорожек');
  });

  test('чужое предложение править нельзя [US-CHG-002/AC4]', () => {
    const draft = repo.getVersion(change.draft_version_id);
    assert.throws(() => ch.saveChangeModel({ changeId: change.id, model: draft.model, user: head }),
      /только его автор/);
  });

  test('вынесение на обсуждение начисляет очки и зовёт затронутые роли [US-CHG-002/AC5]', () => {
    const before = hub.advisorStats(employee.id).points;
    ch.submitForDiscussion({ changeId: change.id, user: employee });
    assert.equal(ch.getChange(change.id).status, 'discussion');
    assert.ok(hub.advisorStats(employee.id).points > before, 'очки за предложение не начислены');
  });

  test('коллеги поддерживают предложение [US-CHG-002/AC5]', () => {
    ch.vote({ changeId: change.id, user: head, value: 1 });
    ch.vote({ changeId: change.id, user: expert, value: 1 });
    ch.vote({ changeId: change.id, user: developer, value: -1 });
    const s = ch.voteSummary(change.id, head.id);
    assert.equal(s.support, 2);
    assert.equal(s.against, 1);
    assert.equal(s.my, 1);
  });

  test('повторный голос заменяет прежний, а не добавляется [US-CHG-002/AC5]', () => {
    ch.vote({ changeId: change.id, user: developer, value: 1 });
    const s = ch.voteSummary(change.id);
    assert.equal(s.support, 3);
    assert.equal(s.against, 0);
  });
});

describe('Согласование', () => {
  let change;

  before(() => {
    change = ch.createChange({
      defKey: 'emp-pilot', title: 'Сократить пилотный период',
      rationale: 'Месяц избыточен для простых решений: данные набираются за две недели.',
      user: employee,
    });
    const model = structuredClone(repo.getVersion(change.draft_version_id).model);
    model.nodes.find((n) => n.id === 'timer').label = 'Пилотный период — 2 недели';
    ch.saveChangeModel({ changeId: change.id, model, user: employee });
    ch.submitForDiscussion({ changeId: change.id, user: employee });
  });

  test('маршрут выводится из затронутых дорожек [US-CHG-003/AC1]', () => {
    const route = ch.buildApprovalRoute(change.id);
    // Шаг лежит в дорожке сотрудника — согласует его руководитель? Нет: дорожка
    // сотрудника, значит роль employee. Автор себя не согласует, поэтому роль выпадает.
    assert.ok(Array.isArray(route.roles));
    assert.ok(!route.roles.includes('employee'), 'автор не должен согласовывать сам себя');
  });

  test('лист согласования создаётся с задачами и сроком [US-CHG-003/AC2]', () => {
    // Правим схему так, чтобы затронуть чужую дорожку — координатора пилотов
    const c2 = ch.createChange({
      defKey: 'emp-pilot', title: 'Уточнить анализ откликов',
      rationale: 'Сопоставление откликов с KPI надо делать до окончания пилота, а не после.',
      user: employee,
    });
    const model = structuredClone(repo.getVersion(c2.draft_version_id).model);
    model.nodes.find((n) => n.id === 'analyse').label = 'Сверять отклики с KPI еженедельно';
    ch.saveChangeModel({ changeId: c2.id, model, user: employee });
    ch.submitForDiscussion({ changeId: c2.id, user: employee });

    const sheet = ch.submitForApproval({ changeId: c2.id, user: employee });
    assert.ok(sheet.length > 0, 'лист согласования пуст');
    assert.ok(sheet.every((s) => s.due_at), 'у согласования нет срока');
    assert.equal(ch.getChange(c2.id).status, 'approval');

    const tasks = q.all("SELECT * FROM tasks WHERE process_change_id = ? AND status = 'open'", c2.id);
    assert.equal(tasks.length, sheet.length, 'задачи согласующим не созданы');
    change = c2;
  });

  test('автор не согласует собственное предложение [US-CHG-003/AC2]', () => {
    const check = ch.canApprove(employee, change.id);
    assert.equal(check.ok, false);
    assert.match(check.reason, /Автор не согласует/);
  });

  test('отказ требует пояснения [US-CHG-003/AC3]', () => {
    const role = ch.approvalSheet(change.id)[0].role_code;
    const approver = { employee, head, expert, developer, pilot_coordinator: coordinator, dtszn: director }[role];
    assert.throws(() => ch.decideApproval({ changeId: change.id, user: approver, verdict: 'reject', comment: 'нет' }),
      /Укажите причину/);
  });

  test('согласование всеми ролями переводит предложение в согласованные [US-CHG-003/AC4]', () => {
    const byRole = { employee, head, expert, developer, pilot_coordinator: coordinator, dtszn: director };
    let last;
    for (const row of ch.approvalSheet(change.id)) {
      last = ch.decideApproval({ changeId: change.id, user: byRole[row.role_code], verdict: 'agree' });
    }
    assert.equal(last.status, 'accepted');
    assert.equal(ch.getChange(change.id).status, 'accepted');
    assert.equal(q.get("SELECT COUNT(*) AS c FROM tasks WHERE process_change_id = ? AND status = 'open'", change.id).c, 0,
      'задачи согласующим не закрыты');
  });

  test('публикация делает изменение действующим [US-CHG-003/AC4]', () => {
    const before = hub.advisorStats(employee.id).points;
    ch.publishChange({ changeId: change.id, user: director });
    assert.equal(ch.getChange(change.id).status, 'published');
    assert.equal(repo.diagram('emp-pilot').nodes.find((n) => n.id === 'analyse').label,
      'Сверять отклики с KPI еженедельно', 'действующая схема не обновилась');
    assert.ok(hub.advisorStats(employee.id).points > before, 'очки за вступившее в силу изменение не начислены');
  });

  test('отказ закрывает предложение с указанием причины [US-CHG-003/AC3]', () => {
    const c3 = ch.createChange({
      defKey: 'head-gate1', title: 'Убрать проверку регламентов',
      rationale: 'Проверка регламентов дублирует последующую экспертизу ДТСЗН на Gate 2.',
      user: employee,
    });
    const model = structuredClone(repo.getVersion(c3.draft_version_id).model);
    model.nodes[2].label = 'Проверить только бюджет';
    ch.saveChangeModel({ changeId: c3.id, model, user: employee });
    ch.submitForDiscussion({ changeId: c3.id, user: employee });
    ch.submitForApproval({ changeId: c3.id, user: employee });

    const byRole = { head, expert, developer, pilot_coordinator: coordinator, dtszn: director };
    const first = ch.approvalSheet(c3.id)[0];
    const res = ch.decideApproval({
      changeId: c3.id, user: byRole[first.role_code], verdict: 'reject',
      comment: 'Проверка регламентов — обязанность учреждения, снимать её нельзя.',
    });
    assert.equal(res.status, 'rejected');
    assert.match(ch.getChange(c3.id).decision_note, /обязанность учреждения/);
    assert.equal(repo.currentVersion(repo.defByKey('head-gate1').id).version, 1,
      'отклонённое предложение не должно менять действующую схему');
  });
});

describe('Изменение конвейера сообществом', () => {
  let change;

  test('сокращение срока Gate 2 проходит полный цикл и меняет конвейер [US-CHG-003/AC6] [US-SG-004/AC2]', () => {
    assert.equal(wf.stageConfig(3).sla_value, 5, 'исходный срок Gate 2 — 5 рабочих дней');

    change = ch.createChange({
      defKey: 'e2e', title: 'Сократить экспертизу ДТСЗН до трёх дней',
      rationale: 'Пять рабочих дней на Gate 2 — половина времени всего пути инициативы до пилота. ' +
                 'Практика показывает, что вердикт готов за три дня.',
      expectedEffect: 'Цикл до пилота короче на два рабочих дня',
      user: employee,
    });

    const model = structuredClone(repo.getVersion(change.draft_version_id).model);
    const gate = model.nodes.find((n) => n.stage?.stage_no === 3);
    gate.stage.sla_value = 3;
    gate.stage.sla_text = 'Эксперты ДТСЗН выносят вердикт в течение 3 рабочих дней.';
    gate.label = 'Gate 2 — 3 рабочих дня';

    const saved = ch.saveChangeModel({ changeId: change.id, model, user: employee });
    assert.deepEqual(saved.issues, []);
    assert.ok(saved.summary.some((l) => l.includes('срок сокращён с 5 до 3')),
      `в сводке нет сокращения срока: ${JSON.stringify(saved.summary)}`);

    ch.submitForDiscussion({ changeId: change.id, user: employee });

    // Изменение конвейера всегда идёт через центральный аппарат
    const route = ch.buildApprovalRoute(change.id);
    assert.ok(route.roles.includes('dtszn'), 'конвейер должен согласовывать центральный аппарат');

    ch.submitForApproval({ changeId: change.id, user: employee });
    const byRole = { head, expert, developer, pilot_coordinator: coordinator, dtszn: director };
    for (const row of ch.approvalSheet(change.id)) {
      ch.decideApproval({ changeId: change.id, user: byRole[row.role_code], verdict: 'agree' });
    }
    assert.equal(ch.getChange(change.id).status, 'accepted');

    ch.publishChange({ changeId: change.id, user: director });

    // Вот ради чего всё: правка схемы изменила реальную работу платформы
    assert.equal(wf.stageConfig(3).sla_value, 3, 'конвейер не подхватил согласованное изменение');
    assert.match(wf.stageConfig(3).sla_text, /3 рабочих дней/);
    assert.equal(wf.stages().length, 6, 'состав этапов не должен был измениться');
  });

  test('вклад автора виден в общем рейтинге социальных советников [US-CHG-003/AC7]', () => {
    const stats = hub.advisorStats(employee.id);
    assert.ok(stats.points > 0, 'вклад в процессы не попал в рейтинг');
    const codes = q.all('SELECT DISTINCT rule_code FROM points_ledger WHERE user_id = ?', employee.id)
      .map((r) => r.rule_code);
    for (const code of ['process.change.proposed', 'process.change.accepted', 'process.change.published']) {
      assert.ok(codes.includes(code), `нет начисления по правилу «${code}»`);
    }
  });

  test('очки за одно и то же действие не начисляются дважды [US-CHG-003/AC7]', () => {
    const rows = q.all(`SELECT rule_code, COUNT(*) AS c FROM points_ledger
                        WHERE user_id = ? AND process_change_id = ? GROUP BY rule_code`,
      employee.id, change.id);
    for (const r of rows) assert.equal(r.c, 1, `правило «${r.rule_code}» начислено ${r.c} раза`);
  });
});

describe('Просроченные согласования', () => {
  test('просрочка эскалируется и помечает задачу [US-CHG-003/AC5]', () => {
    const c = ch.createChange({
      defKey: 'dev-build', title: 'Добавить демонстрацию заказчику в каждый спринт',
      rationale: 'Промежуточные демонстрации сейчас необязательны, из-за чего расхождение с ожиданиями всплывает поздно.',
      user: employee,
    });
    const model = structuredClone(repo.getVersion(c.draft_version_id).model);
    model.nodes[3].label = 'Показать результат спринта заказчику';
    ch.saveChangeModel({ changeId: c.id, model, user: employee });
    ch.submitForDiscussion({ changeId: c.id, user: employee });
    ch.submitForApproval({ changeId: c.id, user: employee });

    q.run("UPDATE approvals SET due_at = datetime('now','-2 days') WHERE target_type='process_change' AND target_id = ?", c.id);
    const result = ch.sweepApprovals();
    assert.ok(result.escalated > 0, 'просроченные согласования не эскалированы');
    assert.ok(q.get(`SELECT COUNT(*) AS c FROM tasks
                     WHERE process_change_id = ? AND status = 'escalated'`, c.id).c > 0);
  });
});
