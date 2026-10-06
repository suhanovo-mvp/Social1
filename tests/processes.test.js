// Тесты альбома схем: целостность модели BPMN, разделение на два пользовательских
// пути и матрицы ответственности ролей.
//
// Проверка целостности вынесена в shared/bpmn/model.js и вызывается здесь тем же
// кодом, каким сервер проверяет версию перед публикацией. Схема, принятая тестом,
// не может быть отвергнута публикацией по другой причине — и наоборот.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DIR = mkdtempSync(join(tmpdir(), 'social1-proc-'));
process.env.SOCIAL1_DB = join(DIR, 'test.db');
process.on('exit', () => rmSync(DIR, { recursive: true, force: true }));

const { DIAGRAMS, SCENARIOS, scenarioOf, diagramsForRole, diagramsForScenario, ROLE_ORDER } =
  await import('../server/seed-processes.js');
const { validateModel, stagesFromModel } = await import('../shared/bpmn/model.js');
const { SHAPES } = await import('../shared/bpmn/layout.js');

const problems = (model) => validateModel(model).map((e) => `${e.code}: ${e.message}`);

describe('Целостность схем', () => {
  test('каждая схема начального наполнения проходит проверку модели', () => {
    for (const d of DIAGRAMS) {
      assert.deepEqual(problems(d), [], `${d.id}: схема не проходит проверку`);
    }
  });

  test('идентификаторы схем уникальны', () => {
    const ids = DIAGRAMS.map((d) => d.id);
    assert.equal(new Set(ids).size, ids.length, 'повторяющийся идентификатор схемы');
  });

  test('используются только известные типы фигур', () => {
    for (const d of DIAGRAMS) {
      for (const n of d.nodes) {
        assert.ok(SHAPES[n.type], `${d.id}: неизвестный тип фигуры ${n.type} у узла ${n.id}`);
      }
    }
  });

  // Ниже — проверки самого валидатора: без них «схемы в порядке» означало бы лишь то,
  // что проверка ничего не проверяет
  test('валидатор ловит поток в несуществующий узел', () => {
    const broken = structuredClone(DIAGRAMS[0]);
    broken.flows.push({ from: broken.nodes[0].id, to: 'нет-такого-узла' });
    assert.ok(problems(broken).some((p) => p.startsWith('flow.to')), 'разрыв потока не замечен');
  });

  test('валидатор ловит узел вне объявленной дорожки', () => {
    const broken = structuredClone(DIAGRAMS[0]);
    broken.nodes[1].lane = 'чужая-дорожка';
    assert.ok(problems(broken).some((p) => p.startsWith('node.lane')), 'узел вне дорожки не замечен');
  });

  test('валидатор ловит недостижимый узел', () => {
    const broken = structuredClone(DIAGRAMS[0]);
    broken.nodes.push({ id: 'сирота', type: 'user', lane: broken.lanes[0].id, col: 0, row: 5, label: 'Ничем не вызываемый шаг' });
    assert.ok(problems(broken).some((p) => p.startsWith('node.unreachable')), 'недостижимый узел не замечен');
  });

  test('валидатор ловит поток из завершающего события', () => {
    const broken = structuredClone(DIAGRAMS[0]);
    const end = broken.nodes.find((n) => n.type === 'end');
    broken.flows.push({ from: end.id, to: broken.nodes[0].id });
    assert.ok(problems(broken).some((p) => p.startsWith('flow.fromEnd')), 'поток из завершения не замечен');
  });

  test('валидатор ловит подпись, не умещающуюся в фигуру', () => {
    const broken = structuredClone(DIAGRAMS[0]);
    broken.nodes[1].label = 'Очень длинная подпись, которая заведомо не умещается ни в какую фигуру схемы и должна быть отклонена';
    assert.ok(problems(broken).some((p) => p.startsWith('node.overflow')), 'переполнение подписи не замечено');
  });
});

describe('Конвейер инициатив в модели', () => {
  const pipeline = () => DIAGRAMS.find((d) => d.isPipeline);

  test('конвейер отмечен ровно один', () => {
    assert.equal(DIAGRAMS.filter((d) => d.isPipeline).length, 1);
  });

  test('этапы описаны подряд, с первого по шестой', () => {
    const stages = stagesFromModel(pipeline());
    assert.equal(stages.length, 6, 'этапов в конвейере должно быть шесть');
    stages.forEach((s, i) => assert.equal(s.stage_no, i + 1, 'нумерация этапов идёт не подряд'));
  });

  test('на каждой точке принятия решения указаны роль и допустимые решения', () => {
    for (const s of stagesFromModel(pipeline())) {
      if (!s.gate_no) continue;
      assert.ok(s.role_required, `${s.gate_name}: не указана решающая роль`);
      assert.ok(s.decisions.length, `${s.gate_name}: не задан перечень решений`);
      assert.ok(s.criteria.length, `${s.gate_name}: не заданы критерии оценки`);
    }
  });

  test('разрыв в нумерации этапов не проходит проверку', () => {
    const broken = structuredClone(pipeline());
    const node = broken.nodes.find((n) => n.stage?.stage_no === 3);
    node.stage.stage_no = 9;
    assert.ok(problems(broken).some((p) => p.startsWith('stage.gapInNumbering')),
      'разрыв в нумерации этапов не замечен');
  });

  test('срок этапа задан в известных единицах', () => {
    for (const s of stagesFromModel(pipeline())) {
      if (s.sla_value === null) continue;
      assert.ok(['workdays', 'calendardays'].includes(s.sla_unit),
        `этап № ${s.stage_no}: неизвестная единица срока «${s.sla_unit}»`);
    }
  });
});

describe('Пользовательские пути', () => {
  test('сценариев четыре и все наполнены', () => {
    assert.deepEqual(SCENARIOS.map((s) => s.id), ['initiative', 'ideas', 'providers', 'collab']);
    for (const s of SCENARIOS) {
      assert.ok(s.title && s.lead && s.description, `${s.id}: сценарий описан не полностью`);
      assert.ok(diagramsForScenario(s.id).length > 0, `${s.id}: в сценарии нет схем`);
    }
  });

  test('каждая схема отнесена к существующему сценарию', () => {
    for (const d of DIAGRAMS) {
      assert.ok(d.scenario, `${d.id}: схема без сценария`);
      assert.equal(scenarioOf(d.scenario).id, d.scenario, `${d.id}: неизвестный сценарий ${d.scenario}`);
    }
  });

  test('схемы сценария идут в альбоме подряд', () => {
    // Нумерация разделов сквозная, поэтому перемешанные сценарии сломали бы содержание
    const order = DIAGRAMS.map((d) => d.scenario);
    const changes = order.filter((s, i) => i === 0 || s !== order[i - 1]).length;
    assert.equal(changes, SCENARIOS.length, 'схемы сценариев перемешаны в альбоме');
  });

  test('у каждой роли сценария описано, что она делает', () => {
    for (const s of SCENARIOS) {
      assert.ok(s.roles.length >= 5, `${s.id}: слишком мало ролей в матрице ответственности`);
      for (const r of s.roles) {
        assert.ok(r.title, `${s.id}: роль без названия`);
        assert.ok(r.does && r.does.length > 40, `${s.id}: у роли «${r.title}» не описан вклад`);
      }
    }
  });

  test('путь обсуждения идей покрывает роли модуля', () => {
    const ideas = SCENARIOS.find((s) => s.id === 'ideas');
    const roles = ideas.roles.map((r) => r.role);
    for (const expected of ['advisor', 'reviewer', 'moderator', 'head']) {
      assert.ok(roles.includes(expected), `в матрице нет роли ${expected}`);
    }
  });

  test('быстрое ревью описано отдельной схемой с разбором', () => {
    const d = DIAGRAMS.find((x) => x.id === 'adv-review');
    assert.ok(d, 'схема ревью отсутствует в альбоме');
    assert.equal(d.scenario, 'ideas');
    assert.ok(d.walkthrough.length >= 5, 'разбор схемы ревью слишком короткий');
    // Свайпы и дублирующие их кнопки должны быть видны на схеме
    const labels = d.nodes.map((n) => n.label).join(' ');
    for (const word of ['вправо', 'влево', 'вверх', 'подробности']) {
      assert.ok(labels.toLowerCase().includes(word), `на схеме ревью нет действия «${word}»`);
    }
  });

  test('путь каталога разработчиков описан для всех трёх ролей каталога', () => {
    const groups = new Set(diagramsForScenario('providers').map((d) => d.group));
    for (const g of ['Пользователь каталога', 'Модератор каталога', 'Администратор каталога']) {
      assert.ok(groups.has(g), `нет схемы для группы «${g}»`);
    }
    // Новые схемы дописываются в конец альбома: разделы каталога остаются 21–25
    assert.deepEqual(DIAGRAMS.slice(20, 25).map((d) => d.scenario), Array(5).fill('providers'));
  });

  test('совместная работа: изменение процессов, база знаний и опросы описаны схемами', () => {
    const ids = diagramsForScenario('collab').map((d) => d.id);
    // Сквозной путь изменения, согласование, документ базы знаний, связь с работой, опросы
    for (const id of ['chg-e2e', 'chg-approve', 'kb-doc', 'kb-work', 'form-build', 'form-fill']) {
      assert.ok(ids.includes(id), `нет схемы ${id}`);
    }
    // Путь дописан после всех прежних разделов: их номера из регламентов не сдвинулись
    assert.deepEqual(DIAGRAMS.slice(25).map((d) => d.scenario), Array(ids.length).fill('collab'));
    for (const id of ids) {
      assert.ok(DIAGRAMS.find((d) => d.id === id).walkthrough.length >= 3, `${id}: разбор слишком короткий`);
    }
  });
});

describe('Отбор схем', () => {
  test('фильтр по роли включает сквозные схемы', () => {
    const forEmployee = diagramsForRole('employee');
    assert.ok(forEmployee.every((d) => d.role === 'employee' || d.role === 'all'));
    assert.ok(forEmployee.some((d) => d.role === 'all'));
  });

  test('перечень ролей покрывает все схемы', () => {
    for (const d of DIAGRAMS) {
      assert.ok(ROLE_ORDER.includes(d.role), `${d.id}: роль ${d.role} отсутствует в перечне`);
    }
  });
});

describe('Альбом из репозитория', () => {
  let repo;
  before(async () => {
    const auth = await import('../server/auth.js');
    const wf = await import('../server/workflow.js');
    repo = await import('../server/process-repo.js');
    auth.ensureRoles();
    wf.ensureWorkflow();
    repo.ensureProcesses();
  });

  test('в репозиторий попали все схемы начального наполнения', () => {
    assert.equal(repo.listDefs().length, DIAGRAMS.length);
  });

  test('порядок разделов в альбоме сохранён', () => {
    assert.deepEqual(repo.album().map((d) => d.id), DIAGRAMS.map((d) => d.id));
  });

  test('действующие модели из репозитория проходят проверку', () => {
    for (const d of repo.album()) {
      assert.deepEqual(problems(d), [], `${d.id}: модель из репозитория не проходит проверку`);
    }
  });

  test('первая версия каждой схемы опубликована', () => {
    for (const def of repo.listDefs()) {
      assert.equal(def.current_version, 1, `${def.key}: нет действующей версии`);
      assert.ok(def.published_at, `${def.key}: версия не помечена опубликованной`);
    }
  });
});

describe('Оглавление альбома', () => {
  test('в оглавление попадают все схемы и ни одна страница не переполнена', async () => {
    const { tocLayout, TOC_HEIGHT } = await import('../server/bpmn-pdf.js');
    // Растим альбом вдвое: оглавление обязано переходить на следующие страницы
    const many = [...DIAGRAMS, ...DIAGRAMS.map((d) => ({ ...d, id: `${d.id}-copy` }))];
    for (const list of [DIAGRAMS, many]) {
      const pages = tocLayout(list);
      const rows = pages.flat().filter((it) => it.kind === 'row').map((it) => it.i);
      assert.deepEqual(rows, list.map((_, i) => i), 'оглавление потеряло или перепутало схемы');
      for (const p of pages) {
        assert.ok(p.reduce((s, it) => s + it.h, 0) <= TOC_HEIGHT, 'страница оглавления переполнена');
        assert.notEqual(p.at(-1).kind, 'scenario', 'заголовок пути остался без строк');
        assert.notEqual(p.at(-1).kind, 'group', 'заголовок группы остался без строк');
      }
    }
    assert.ok(tocLayout(DIAGRAMS).length >= 2, 'альбом не помещается в одну страницу оглавления');
  });
});
