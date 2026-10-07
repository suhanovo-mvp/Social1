// Репозиторий процессов: версионирование, неизменяемость опубликованного,
// проверка перед публикацией и проекция конвейера.
//
// Главный тест здесь — совпадение проекции с прежней конфигурацией Stage-Gate.
// Конвейер теперь собирается из модели схемы, и этот тест гарантирует, что переезд
// ничего не сдвинул: те же этапы, роли, сроки и критерии.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DIR = mkdtempSync(join(tmpdir(), 'social1-repo-'));
process.env.SOCIAL1_DB = join(DIR, 'test.db');
process.on('exit', () => rmSync(DIR, { recursive: true, force: true }));

const { q, tx } = await import('../server/db.js');
const auth = await import('../server/auth.js');
const wf = await import('../server/workflow.js');
const repo = await import('../server/process-repo.js');
const { stagesFromModel } = await import('../shared/bpmn/model.js');

let admin, institution;
before(() => {
  auth.ensureRoles();
  wf.ensureWorkflow();
  repo.ensureProcesses();
  institution = q.insert("INSERT INTO institutions (name, short_name) VALUES ('ТЦСО «Проверка»','ТЦСО')");
  const { hash, salt } = auth.hashPassword('test');
  const id = q.insert(`INSERT INTO users (email, full_name, password_hash, password_salt, role, institution_id)
                       VALUES (?,?,?,?,?,?)`, 'admin@social1.mos.ru', 'Администратор', hash, salt, 'dtszn', institution);
  admin = { id, role: 'dtszn', institution_id: institution };
});

const pipeline = () => repo.pipelineDef();
const pipelineModel = () => repo.currentVersion(pipeline().id).model;

describe('Проекция конвейера', () => {
  test('совпадает с прежней конфигурацией Stage-Gate по всем полям [US-SG-004/AC1]', () => {
    const got = wf.stages();
    assert.equal(got.length, wf.DEFAULT_WORKFLOW.length, 'изменилось число этапов конвейера');
    for (const want of wf.DEFAULT_WORKFLOW) {
      const g = got.find((x) => x.stage_no === want.stage_no);
      assert.ok(g, `этап № ${want.stage_no} потерян при проекции`);
      for (const f of ['stage_name', 'tz_stage', 'tz_stage_name', 'description', 'trigger_text',
                       'gate_no', 'gate_name', 'role_required', 'sla_value', 'sla_unit', 'sla_text']) {
        assert.deepEqual(g[f], want[f], `этап № ${want.stage_no}, поле «${f}» не совпало`);
      }
      for (const f of ['participants', 'criteria', 'decisions']) {
        assert.deepEqual(g[f], want[f], `этап № ${want.stage_no}, список «${f}» не совпал`);
      }
    }
  });

  test('последний этап считается по факту, а не постоянной [US-SG-004/AC1]', () => {
    assert.equal(wf.lastStage(), 6);
  });

  test('повторная проекция не размножает этапы [US-SG-004/AC1]', () => {
    repo.projectPipeline();
    repo.projectPipeline();
    assert.equal(wf.stages().length, 6);
  });
});

describe('Версии', () => {
  test('черновик создаётся копией действующей версии [US-BPMN-004/AC1]', () => {
    const def = repo.defByKey('emp-submit');
    const draft = repo.createDraft({ defId: def.id, userId: admin.id, notes: 'Проба' });
    assert.equal(draft.status, 'draft');
    assert.equal(draft.version, 2);
    assert.deepEqual(draft.model, repo.currentVersion(def.id).model, 'черновик не совпал с исходником');
  });

  test('опубликованную версию править нельзя [US-BPMN-004/AC2]', () => {
    const def = repo.defByKey('emp-pilot');
    const published = repo.currentVersion(def.id);
    assert.throws(() => repo.saveDraft({ versionId: published.id, model: published.model, userId: admin.id }),
      /неизменяема/, 'опубликованная версия оказалась изменяемой');
  });

  test('публикация переводит прежнюю версию в замещённые [US-BPMN-004/AC2]', () => {
    const def = repo.defByKey('emp-pilot');
    const was = repo.currentVersion(def.id);
    const draft = repo.createDraft({ defId: def.id, userId: admin.id });
    const model = structuredClone(draft.model);
    model.nodes.find((n) => n.id === 'learn').label = 'Пройти короткое обучение по прототипу';
    repo.saveDraft({ versionId: draft.id, model, userId: admin.id });
    repo.publishVersion({ versionId: draft.id, user: admin });

    assert.equal(repo.getVersion(was.id).status, 'superseded');
    assert.equal(repo.currentVersion(def.id).id, draft.id);
    assert.equal(repo.diagram('emp-pilot').nodes.find((n) => n.id === 'learn').label,
      'Пройти короткое обучение по прототипу', 'альбом не подхватил новую версию');
  });

  test('удалить можно только черновик [US-BPMN-004/AC1]', () => {
    const def = repo.defByKey('head-gate1');
    const published = repo.currentVersion(def.id);
    assert.throws(() => repo.deleteDraft(published.id), /черновик/);
    const draft = repo.createDraft({ defId: def.id, userId: admin.id });
    repo.deleteDraft(draft.id);
    assert.equal(repo.getVersion(draft.id), null);
  });
});

describe('Проверка перед публикацией', () => {
  test('схема с разрывом потока не публикуется [US-BPMN-004/AC3]', () => {
    const def = repo.defByKey('expert-gate2');
    const draft = repo.createDraft({ defId: def.id, userId: admin.id });
    const model = structuredClone(draft.model);
    model.flows.push({ from: model.nodes[0].id, to: 'узла-нет', label: null, kind: null, condition: null });
    repo.saveDraft({ versionId: draft.id, model, userId: admin.id });

    const issues = repo.validateForPublish(draft.id);
    assert.ok(issues.some((e) => e.code === 'flow.to'), 'разрыв потока не замечен');
    assert.throws(() => repo.publishVersion({ versionId: draft.id, user: admin }), /не прошла проверку/);
    // Действующая версия не пострадала
    assert.equal(repo.currentVersion(def.id).version, 1);
  });

  test('этап с живыми инициативами убрать нельзя [US-SG-004/AC3]', () => {
    const author = q.insert(`INSERT INTO users (email, full_name, password_hash, password_salt, role, institution_id)
                             VALUES ('a@s.ru','Автор','x','y','employee',?)`, institution);
    q.run(`INSERT INTO initiatives (number, title, problem, solution, expected_effect,
           author_id, institution_id, stage, status)
           VALUES ('SOC-TEST-0001','Проба','П','Р','Э',?,?,3,'active')`, author, institution);

    const draft = repo.createDraft({ defId: pipeline().id, userId: admin.id });
    const model = structuredClone(draft.model);
    // Убираем блок этапа № 3 — на нём стоит живая инициатива
    model.nodes.find((n) => n.stage?.stage_no === 3).stage = null;
    // и перенумеровываем оставшиеся, чтобы не спорить о разрыве нумерации
    for (const n of model.nodes) {
      if (n.stage && n.stage.stage_no > 3) n.stage.stage_no -= 1;
    }
    repo.saveDraft({ versionId: draft.id, model, userId: admin.id });

    const issues = repo.validateForPublish(draft.id);
    assert.ok(issues.some((e) => e.code === 'stage.inUse'),
      `убранный живой этап не замечен: ${JSON.stringify(issues)}`);
    assert.throws(() => repo.publishVersion({ versionId: draft.id, user: admin }), /не прошла проверку/);
    assert.equal(wf.stages().length, 6, 'конвейер изменился, несмотря на отклонённую публикацию');
    repo.deleteDraft(draft.id);
  });

  test('перенумерация живого этапа отклоняется [US-SG-004/AC3]', () => {
    // Этап остаётся в схеме, но получает другой номер. Инициатива, стоящая на нём,
    // оказалась бы на чужой работе — номер занят, и обычная проверка «этап есть»
    // такую подмену пропускает.
    const stage = q.get("SELECT stage FROM initiatives WHERE status='active' LIMIT 1").stage;
    const draft = repo.createDraft({ defId: pipeline().id, userId: admin.id });
    const model = structuredClone(draft.model);
    const node = model.nodes.find((n) => n.stage?.stage_no === stage);
    const other = model.nodes.find((n) => n.stage?.stage_no === stage + 1);
    node.stage.stage_no = stage + 1;
    other.stage.stage_no = stage;

    repo.saveDraft({ versionId: draft.id, model, userId: admin.id });
    const issues = repo.validateForPublish(draft.id);
    assert.ok(issues.some((e) => e.code === 'stage.renumbered'),
      `перенумерация живого этапа не замечена: ${JSON.stringify(issues)}`);
    assert.throws(() => repo.publishVersion({ versionId: draft.id, user: admin }), /не прошла проверку/);
    repo.deleteDraft(draft.id);
  });

  test('срок этапа меняется и вступает в силу после публикации [US-SG-004/AC2]', () => {
    const draft = repo.createDraft({ defId: pipeline().id, userId: admin.id });
    const model = structuredClone(draft.model);
    model.nodes.find((n) => n.stage?.stage_no === 3).stage.sla_value = 3;
    repo.saveDraft({ versionId: draft.id, model, userId: admin.id });
    repo.publishVersion({ versionId: draft.id, user: admin });

    assert.equal(wf.stageConfig(3).sla_value, 3, 'новый срок не попал в конвейер');
    assert.equal(wf.stages().length, 6, 'состав этапов не должен был измениться');
  });
});

describe('Правка этапа из настроек платформы', () => {
  test('пишет в модель, а не в таблицу конвейера [US-ADM-002/AC4] [US-SG-004/AC2]', () => {
    const before = repo.currentVersion(pipeline().id).version;
    repo.patchStage({ stageNo: 2, patch: { sla_value: 2, sla_text: 'Решение за 2 рабочих дня.' }, user: admin });

    assert.equal(wf.stageConfig(2).sla_value, 2, 'проекция не обновилась');
    assert.equal(repo.currentVersion(pipeline().id).version, before + 1, 'новая версия не создана');
    const stage = stagesFromModel(pipelineModel()).find((s) => s.stage_no === 2);
    assert.equal(stage.sla_value, 2, 'модель не содержит новый срок');
  });

  test('правка несуществующего этапа отклоняется [US-ADM-002/AC4]', () => {
    assert.throws(() => repo.patchStage({ stageNo: 99, patch: { sla_value: 1 }, user: admin }),
      /не найден/);
  });

  test('история правок сохраняется версиями [US-SG-004/AC4]', () => {
    const versions = repo.versionsOf(pipeline().id);
    assert.ok(versions.length >= 3, 'история версий конвейера не ведётся');
    assert.equal(versions.filter((v) => v.status === 'published').length, 1,
      'опубликованной может быть только одна версия');
  });
});

describe('Транзакции', () => {
  test('вложенный вызов не открывает свою транзакцию', () => {
    const before = q.get('SELECT COUNT(*) AS c FROM institutions').c;
    tx(() => {
      q.insert("INSERT INTO institutions (name, short_name) VALUES ('Внешняя','В')");
      tx(() => q.insert("INSERT INTO institutions (name, short_name) VALUES ('Вложенная','ВЛ')"));
    });
    assert.equal(q.get('SELECT COUNT(*) AS c FROM institutions').c, before + 2);
  });

  test('сбой во вложенном вызове откатывает всё', () => {
    const before = q.get('SELECT COUNT(*) AS c FROM institutions').c;
    assert.throws(() => tx(() => {
      q.insert("INSERT INTO institutions (name, short_name) VALUES ('Откат','ОТ')");
      tx(() => { throw new Error('сбой внутри'); });
    }), /сбой внутри/);
    assert.equal(q.get('SELECT COUNT(*) AS c FROM institutions').c, before,
      'запись внешнего вызова не откатилась');
  });
});
