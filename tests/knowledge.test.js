// База знаний: проект решения, рецензирование, переход в работу и фиксация решения.
//
// Главная проверка здесь — сквозная. Ценность модуля не в том, что документ можно
// сохранить, а в том, что принятое решение доходит до работы и возвращается
// оттуда знанием, которое найдёт следующий. Если цепочка рвётся, всё остальное
// теряет смысл: получается ещё одно хранилище текстов.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DIR = mkdtempSync(join(tmpdir(), 'social1-knowledge-'));
process.env.SOCIAL1_DB = join(DIR, 'test.db');
process.on('exit', () => rmSync(DIR, { recursive: true, force: true }));

const { q } = await import('../server/db.js');
const auth = await import('../server/auth.js');
const wf = await import('../server/workflow.js');
const hub = await import('../server/ideahub.js');
const kn = await import('../server/knowledge.js');
const flow = await import('../server/knowledge-flow.js');
const ev = await import('../server/events.js');

let institution, employee, architect, expert, director, developer;

const makeUser = (email, role) => {
  const { hash, salt } = auth.hashPassword('test');
  const id = q.insert(`INSERT INTO users (email, full_name, password_hash, password_salt, role, institution_id)
                       VALUES (?,?,?,?,?,?)`, email, `Участник ${role}`, hash, salt, role, institution);
  return { id, role, institution_id: institution, extra_roles: null };
};

// Полный набор разделов проекта решения — чтобы проверки не спотыкались о пустоту
const FULL_RFC = {
  problem: 'Заявление на льготу принимается в бумажном виде и вносится в систему вручную.',
  solution: 'Принимать заявление через портал с автоматическим переносом в учётную систему.',
  alternatives: 'Рассматривали сканирование бумажных бланков — отклонено: распознавание даёт ошибки в адресах.',
  risks: 'Часть заявителей без доступа к интернету — бумажный приём сохраняется как запасной путь.',
};

before(() => {
  auth.ensureRoles();
  wf.ensureWorkflow();
  hub.ensureIdeaHub();
  kn.ensureKnowledge();
  institution = q.insert("INSERT INTO institutions (name, short_name) VALUES ('ТЦСО','ТЦСО')");
  employee = makeUser('emp@s.ru', 'employee');
  architect = makeUser('arch@s.ru', 'architect');
  expert = makeUser('exp@s.ru', 'expert');
  director = makeUser('dir@s.ru', 'dtszn');
  developer = makeUser('dev@s.ru', 'developer');
});

const newRfc = (user = employee, subject = {}) => kn.createDoc({
  kind: 'rfc', title: 'Приём заявлений на льготу через портал', user, ...subject,
});

describe('Документ и его разделы', () => {
  test('заводится черновиком с номером своего вида [US-KB-001/AC1]', () => {
    const d = newRfc();
    assert.equal(d.status, 'draft');
    assert.match(d.number, /^РД-\d{4}-\d{4}$/);
    assert.equal(d.current_version, 1);
  });

  test('обязательные разделы названы, пока не заполнены [US-KB-001/AC2]', () => {
    const d = newRfc();
    const issues = kn.validate(d.id);
    assert.equal(issues.length, 4, 'у проекта решения четыре обязательных раздела');
    assert.ok(issues.some((i) => i.section === 'alternatives'),
      'раздел с альтернативами обязателен — ради него документ и заводится');
  });

  test('текст собирается из разделов, а не хранится отдельно [US-KB-001/AC1]', () => {
    const d = newRfc();
    kn.saveDraft({ docId: d.id, sections: FULL_RFC, user: employee });
    const v = kn.currentVersion(d.id);
    assert.deepEqual(kn.validate(d.id), []);
    assert.match(v.body, /## Проблема/);
    assert.match(v.body, /## Рассмотренные альтернативы/);
    assert.ok(v.body.indexOf('## Проблема') < v.body.indexOf('## Предлагаемое решение'),
      'разделы идут в заданном шаблоном порядке');
  });

  test('чужой документ править нельзя [US-KB-001/AC3]', () => {
    const d = newRfc();
    assert.throws(() => kn.saveDraft({ docId: d.id, sections: FULL_RFC, user: expert }),
      /может его автор/);
  });

  test('незаполненный документ не выносится на рецензирование [US-KB-001/AC2]', () => {
    const d = newRfc();
    assert.throws(() => kn.submitForReview({ docId: d.id, user: employee }), /не полностью/);
  });
});

describe('Рецензирование', () => {
  let doc;
  before(() => {
    doc = newRfc();
    kn.saveDraft({ docId: doc.id, sections: FULL_RFC, user: employee });
  });

  test('состав рецензентов выводится из документа, а не задаётся списком [US-KB-001/AC4]', () => {
    const sheet = kn.submitForReview({ docId: doc.id, user: employee });
    const roles = sheet.map((s) => s.role_code);
    assert.ok(roles.includes('architect'), 'проект решения смотрит архитектор');
    assert.ok(sheet.every((s) => s.reason), 'у каждого рецензента названо основание');
    assert.equal(kn.getDoc(doc.id).status, 'review');
  });

  test('рецензенту приходит задача со сроком [US-KB-001/AC5]', () => {
    const t = q.get("SELECT * FROM tasks WHERE knowledge_doc_id = ? AND type = 'doc_review'", doc.id);
    assert.ok(t, 'задача рецензенту не создана');
    assert.ok(t.due_at, 'у рецензирования нет срока');
  });

  test('автор не рецензирует свой документ [US-KB-001/AC5]', () => {
    const check = kn.canReview(employee, doc.id);
    assert.equal(check.ok, false);
    assert.match(check.reason, /Автор не согласует/);
  });

  test('отказ требует пояснения [US-KB-001/AC5]', () => {
    assert.throws(() => kn.decideReview({ docId: doc.id, user: architect, verdict: 'reject', comment: 'нет' }),
      /Укажите причину/);
  });

  test('согласование всеми рецензентами переводит документ в согласованные [US-KB-001/AC6]', () => {
    const byRole = { architect, expert, dtszn: director };
    let last;
    for (const row of kn.reviewSheet(doc.id)) {
      if (row.verdict) continue;
      const who = row.user_id ? employee : byRole[row.role_code];
      last = kn.decideReview({ docId: doc.id, user: who, verdict: 'agree' });
    }
    assert.equal(last.status, 'accepted');
    assert.equal(q.get("SELECT COUNT(*) AS c FROM tasks WHERE knowledge_doc_id = ? AND status = 'open'", doc.id).c, 0,
      'задачи рецензентам не закрыты');
  });

  test('если проект решения пишет архитектор, его рецензируют эксперты [US-KB-001/AC4]', () => {
    const own = kn.createDoc({ kind: 'rfc', title: 'Решение от архитектора', user: architect });
    kn.saveDraft({ docId: own.id, sections: FULL_RFC, user: architect });
    const sheet = kn.submitForReview({ docId: own.id, user: architect });
    const roles = sheet.map((s) => s.role_code);
    assert.ok(!roles.includes('architect'), 'автор не может быть собственным рецензентом');
    assert.ok(roles.includes('expert'), 'архитектурную проверку подхватывают эксперты');
  });
});

describe('Заказчик как рецензент', () => {
  test('автор идеи попадает в лист по своему предмету [US-KB-001/AC4]', () => {
    const ideaAuthor = makeUser('ideaowner@s.ru', 'employee');
    const ideaId = q.insert(`INSERT INTO ideas (number, title, problem, desired_result, author_id, institution_id)
                             VALUES ('IDEA-T-1','Идея','П','Р',?,?)`, ideaAuthor.id, institution);
    const d = kn.createDoc({ kind: 'rfc', title: 'Решение по идее коллеги',
                             subjectType: 'idea', subjectId: ideaId, user: employee });
    kn.saveDraft({ docId: d.id, sections: FULL_RFC, user: employee });
    const sheet = kn.submitForReview({ docId: d.id, user: employee });

    const owner = sheet.find((s) => s.user_id === ideaAuthor.id);
    assert.ok(owner, 'заказчик — автор идеи — должен быть в листе');
    assert.match(owner.reason, /заказчик/);
  });
});

describe('От решения к работе и обратно', () => {
  let idea, initiative, project, rfc;

  before(() => {
    idea = q.insert(`INSERT INTO ideas (number, title, problem, desired_result, author_id, institution_id)
                     VALUES ('IDEA-T-2','Идея для работы','П','Р',?,?)`, employee.id, institution);
    initiative = q.insert(`INSERT INTO initiatives (number, title, problem, solution, expected_effect,
                           author_id, institution_id, stage, status)
                           VALUES ('SOC-T-1','Инициатива','П','Р','Э',?,?,4,'active')`, employee.id, institution);
    q.run('UPDATE ideas SET initiative_id = ? WHERE id = ?', initiative, idea);
    project = q.insert(`INSERT INTO projects (initiative_id, name, status)
                        VALUES (?,'Проект по инициативе','active')`, initiative);
  });

  test('принятый проект решения заводит задачу со ссылкой на себя [US-KB-002/AC1]', () => {
    rfc = kn.createDoc({ kind: 'rfc', title: 'Как реализуем приём заявлений',
                         subjectType: 'initiative', subjectId: initiative, user: employee });
    kn.saveDraft({ docId: rfc.id, sections: FULL_RFC, user: employee });
    kn.submitForReview({ docId: rfc.id, user: employee });
    const byRole = { architect, expert, dtszn: director };
    for (const row of kn.reviewSheet(rfc.id)) {
      if (!row.verdict) kn.decideReview({ docId: rfc.id, user: byRole[row.role_code], verdict: 'agree' });
    }

    const item = q.get('SELECT * FROM board_items WHERE knowledge_doc_id = ?', rfc.id);
    assert.ok(item, 'задача по принятому проекту решения не заведена');
    assert.equal(item.project_id, project);
    assert.match(item.description, new RegExp(rfc.number), 'задача не ссылается на документ-основание');
    assert.equal(kn.getDoc(rfc.id).task_id, item.id, 'документ не знает свою задачу');
  });

  test('завершение задачи напоминает зафиксировать решение [US-KB-002/AC2]', () => {
    const item = q.get('SELECT * FROM board_items WHERE knowledge_doc_id = ?', rfc.id);
    q.run("UPDATE board_items SET status = 'done' WHERE id = ?", item.id);
    ev.emit('task.completed', { subjectType: 'task', subjectId: item.id, actorId: developer.id,
      from: 'in_progress', to: 'done' });

    const t = q.get("SELECT * FROM tasks WHERE knowledge_doc_id = ? AND type = 'doc_adr'", rfc.id);
    assert.ok(t, 'напоминание зафиксировать решение не создано');
  });

  test('зафиксированное решение наследует контекст проекта решения [US-KB-002/AC2]', () => {
    const adr = flow.draftDecisionFrom(rfc.id, developer);
    const v = kn.currentVersion(adr.id);
    assert.equal(adr.kind, 'adr');
    assert.match(adr.number, /^ЗР-/);
    assert.equal(v.sections.context, FULL_RFC.problem, 'контекст не перенесён из проекта решения');
    assert.equal(v.sections.alternatives, FULL_RFC.alternatives, 'отклонённые варианты не перенесены');
    assert.equal(v.sections.decision, FULL_RFC.solution);
    assert.equal(q.get("SELECT COUNT(*) AS c FROM tasks WHERE knowledge_doc_id = ? AND type='doc_adr' AND status='open'", rfc.id).c,
      0, 'напоминание не закрыто после создания решения');
  });
});

describe('Публикация и замена решения', () => {
  const publish = (title) => {
    const d = kn.createDoc({ kind: 'adr', title, user: director });
    kn.saveDraft({ docId: d.id, user: director, sections: {
      context: 'Приём заявлений шёл на бумаге.',
      decision: 'Перевести приём на портал.',
      consequences: 'Срок обработки сократился; часть заявителей нуждается в помощи оператора.',
    }});
    return kn.publishDoc({ docId: d.id, user: director });
  };

  test('опубликованный документ виден в базе знаний [US-KB-001/AC6]', () => {
    const d = publish('Приём заявлений через портал');
    assert.equal(d.status, 'published');
    assert.ok(d.published_at);
    assert.equal(kn.currentVersion(d.id).status, 'published');
  });

  test('опубликованный документ неизменяем [US-KB-001/AC6]', () => {
    const d = publish('Неизменяемое решение');
    assert.throws(() => kn.saveDraft({ docId: d.id, sections: { decision: 'иначе' }, user: director }),
      /неизменяем/);
  });

  test('новая редакция заменяет прежнюю, не стирая её [US-KB-001/AC7]', () => {
    const first = publish('Решение, которое передумают');
    const next = kn.reviseDoc({ docId: first.id, user: director });
    kn.saveDraft({ docId: next.id, user: director, sections: {
      context: 'Опыт года показал недостатки прежнего решения.',
      decision: 'Вернуть очный приём для заявителей старше 80 лет.',
      consequences: 'Нагрузка на операторов выросла, доступность услуги — тоже.',
    }});
    kn.publishDoc({ docId: next.id, user: director });

    assert.equal(kn.getDoc(first.id).status, 'superseded', 'прежнее решение должно быть помечено заменённым');
    assert.equal(kn.getDoc(next.id).supersedes_id, first.id, 'связь с заменённым решением потеряна');
    assert.ok(kn.currentVersion(first.id), 'текст прежнего решения обязан сохраниться');
  });

  test('неполный документ не публикуется [US-KB-001/AC2]', () => {
    const d = kn.createDoc({ kind: 'adr', title: 'Решение без последствий', user: director });
    kn.saveDraft({ docId: d.id, sections: { decision: 'Что-то решили' }, user: director });
    assert.throws(() => kn.publishDoc({ docId: d.id, user: director }), /не полностью/);
  });
});

describe('Журнал событий документа', () => {
  test('путь документа виден по событиям [US-KB-001/AC7]', () => {
    const d = kn.createDoc({ kind: 'adr', title: 'Документ для журнала', user: director });
    kn.saveDraft({ docId: d.id, user: director, sections: {
      context: 'К', decision: 'Р', consequences: 'П',
    }});
    kn.publishDoc({ docId: d.id, user: director });
    const types = ev.eventsOf('knowledge_doc', d.id).map((e) => e.type);
    assert.deepEqual(types, ['doc.created', 'doc.published']);
  });
});
