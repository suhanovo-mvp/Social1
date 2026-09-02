// Тесты альбома схем: целостность модели BPMN, разделение на два пользовательских
// пути и матрицы ответственности ролей. Схемы — рукописные данные, поэтому
// проверка ссылок и переносов подписей дешевле, чем разбор кривой выгрузки.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { DIAGRAMS, SCENARIOS, scenarioOf, diagramsForRole, diagramsForScenario, ROLE_ORDER } =
  await import('../web/js/processes-data.js');
const { wrapText, SHAPES } = await import('../web/js/bpmn-layout.js');

// Параметры переноса совпадают с отрисовкой в bpmn.js
const WRAP = {
  user: [23, 3], service: [23, 3], task: [23, 3], manual: [23, 3],
  start: [24, 3], end: [24, 3], timer: [24, 3], message: [24, 3],
  xor: [24, 2], and: [24, 2],
};

describe('Целостность схем', () => {
  test('каждый узел лежит в объявленной дорожке', () => {
    for (const d of DIAGRAMS) {
      const lanes = new Set(d.lanes.map((l) => l.id));
      for (const n of d.nodes) {
        assert.ok(lanes.has(n.lane), `${d.id}: узел ${n.id} в неизвестной дорожке ${n.lane}`);
      }
    }
  });

  test('каждый поток соединяет существующие узлы', () => {
    for (const d of DIAGRAMS) {
      const ids = new Set(d.nodes.map((n) => n.id));
      for (const f of d.flows) {
        assert.ok(ids.has(f.from), `${d.id}: поток из несуществующего узла ${f.from}`);
        assert.ok(ids.has(f.to), `${d.id}: поток в несуществующий узел ${f.to}`);
      }
    }
  });

  test('разбор по шагам ссылается на существующие узлы', () => {
    for (const d of DIAGRAMS) {
      const ids = new Set(d.nodes.map((n) => n.id));
      for (const w of d.walkthrough || []) {
        assert.ok(ids.has(w.node), `${d.id}: разбор для несуществующего узла ${w.node}`);
        assert.ok(w.title && w.body, `${d.id}: шаг ${w.node} без заголовка или пояснения`);
      }
    }
  });

  test('идентификаторы схем и узлов уникальны', () => {
    const ids = DIAGRAMS.map((d) => d.id);
    assert.equal(new Set(ids).size, ids.length, 'повторяющийся идентификатор схемы');
    for (const d of DIAGRAMS) {
      const nodeIds = d.nodes.map((n) => n.id);
      assert.equal(new Set(nodeIds).size, nodeIds.length, `${d.id}: повторяющийся идентификатор узла`);
    }
  });

  test('используются только известные типы фигур', () => {
    for (const d of DIAGRAMS) {
      for (const n of d.nodes) {
        assert.ok(SHAPES[n.type], `${d.id}: неизвестный тип фигуры ${n.type} у узла ${n.id}`);
      }
    }
  });

  test('подписи узлов умещаются без усечения', () => {
    for (const d of DIAGRAMS) {
      for (const n of d.nodes) {
        const [chars, lines] = WRAP[n.type] || [23, 3];
        const wrapped = wrapText(n.label, chars, lines);
        assert.ok(!wrapped.some((l) => l.endsWith('…')),
          `${d.id}: подпись «${n.label}» не умещается в фигуру`);
      }
    }
  });

  test('у каждой схемы есть начало и завершение', () => {
    for (const d of DIAGRAMS) {
      const types = d.nodes.map((n) => n.type);
      assert.ok(types.includes('start') || types.includes('message') || types.includes('timer'),
        `${d.id}: нет стартового события`);
      assert.ok(types.includes('end'), `${d.id}: нет завершающего события`);
    }
  });

  test('из завершающего события потоки не выходят', () => {
    for (const d of DIAGRAMS) {
      const ends = new Set(d.nodes.filter((n) => n.type === 'end').map((n) => n.id));
      for (const f of d.flows) {
        assert.ok(!ends.has(f.from), `${d.id}: поток выходит из завершающего события ${f.from}`);
      }
    }
  });

  test('каждый узел, кроме стартового, достижим по потокам', () => {
    for (const d of DIAGRAMS) {
      const incoming = new Set(d.flows.map((f) => f.to));
      const starts = d.nodes.filter((n) => ['start', 'message', 'timer'].includes(n.type));
      for (const n of d.nodes) {
        if (!incoming.has(n.id) && !starts.some((s) => s.id === n.id)) {
          assert.fail(`${d.id}: узел ${n.id} недостижим — в него не входит ни один поток`);
        }
      }
    }
  });
});

describe('Пользовательские пути', () => {
  test('сценариев ровно два и оба наполнены', () => {
    assert.equal(SCENARIOS.length, 2);
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
