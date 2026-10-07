// Обучающие сценарии ломаются молча: разметку правят в разделе, а тур продолжает
// искать элемент, которого больше нет, — и вместо подсветки показывает подсказку
// по центру экрана. Симптом замечают нескоро, потому что тур внешне работает.
//
// Эти проверки сверяют сценарии с исходниками разделов: маршрут должен вести в
// существующий раздел, а селектор — встречаться в его разметке.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('..', import.meta.url);
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, ROOT)), 'utf8');

// Сценарии разбираются из исходника: модуль тянет за собой DOM и общие модули
// по адресам браузера, поэтому подключить его здесь нельзя.
const tourSrc = read('web/js/tour.js');
const routesSrc = read('web/js/app.js');

const scenarios = [...tourSrc.matchAll(/\{\s*\n\s*id: '([\w-]+)',\s*\n\s*title: '([^']+)'/g)]
  .map((m) => ({ id: m[1], title: m[2] }));

// Разметка разделов одной строкой: шаг может указывать на элемент каркаса, а не
// только своего раздела. Сам tour.js в корпус не входит — иначе каждый селектор
// находил бы себя в собственном определении и проверка ничего не значила бы.
const markup = [
  'web/js/shell.js', 'web/js/core.js', 'web/js/bpmn.js',
  ...readdirSync(fileURLToPath(new URL('web/js/views/', ROOT))).map((f) => `web/js/views/${f}`),
].map(read).join('\n')
  // Из корпуса вычёркиваются доводы querySelector и closest: там селекторы только
  // читаются. Иначе класс, убранный из разметки, но забытый в обработчике, считался
  // бы существующим — а тур уже ничего не подсветит.
  .replace(/\.(?:querySelector|querySelectorAll|closest|matches)\(\s*(['"`])[^'"`]*\1/g, '.q(');

const escapeRx = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, (c) => '\\' + c);

/**
 * Есть ли опора в разметке. Совпадение по границе слова: класс «chg-card» не должен
 * считаться найденным из-за «chg-card__head» — иначе переименование пройдёт незаметно.
 */
const present = (anchor) => new RegExp(escapeRx(anchor) + '(?![\\w-])').test(markup);

/** Разбор шагов сценария из исходника: маршрут и цель подсветки. */
function stepsOf(id) {
  const start = tourSrc.indexOf(`id: '${id}'`);
  assert.ok(start > 0, `сценарий «${id}» не найден`);
  const next = scenarios
    .map((s) => tourSrc.indexOf(`id: '${s.id}'`))
    .filter((i) => i > start).sort((a, b) => a - b)[0];
  const body = tourSrc.slice(start, next ?? tourSrc.indexOf('export function toursForRole'));
  return [...body.matchAll(/\{\s*(?:route: '([^']*)',\s*)?target: (?:'([^']*)'|null)/g)]
    .map((m) => ({ route: m[1] ?? null, target: m[2] ?? null }));
}

/** Опорные части селектора: классы, идентификаторы и атрибуты. */
const parts = (sel) => sel
  .split(/\s+|>/)
  .flatMap((part) => part.match(/\[[\w-]+(?:="[^"]*")?\]|[#.][\w-]+/g) ?? []);

describe('Обучающие сценарии', () => {
  test('сценарии разобраны и шаги у каждого есть [US-EDU-001/AC3]', () => {
    assert.ok(scenarios.length >= 9, `сценариев подозрительно мало: ${scenarios.length}`);
    assert.ok(scenarios.some((s) => s.id === 'process-changes'), 'нет сценария по изменениям процессов');
    for (const s of scenarios) {
      assert.ok(stepsOf(s.id).length >= 3, `${s.id}: сценарий короче трёх шагов`);
    }
  });

  test('каждый маршрут шага существует в таблице маршрутов [US-EDU-001/AC3]', () => {
    for (const s of scenarios) {
      for (const step of stepsOf(s.id)) {
        if (!step.route) continue;
        // Маршрут в таблице записан регулярным выражением: /^\/changes$/
        assert.ok(routesSrc.includes(`/^${step.route.replace(/\//g, '\\/')}$/`),
          `${s.id}: маршрут «${step.route}» отсутствует в таблице маршрутов`);
      }
    }
  });

  test('каждый селектор шага встречается в разметке разделов [US-EDU-001/AC3]', () => {
    for (const s of scenarios) {
      for (const step of stepsOf(s.id)) {
        if (!step.target) continue;
        for (const raw of parts(step.target)) {
          const attr = raw.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
          if (attr) {
            const [, name, value] = attr;
            assert.ok(present(name),
              `${s.id}: селектор «${step.target}» — атрибута «${name}» нет в разметке разделов`);
            // Значение атрибута часто подставляется из данных, поэтому целиком
            // селектор в исходнике не встречается — ищем само значение
            if (value) {
              assert.ok(markup.includes(value),
                `${s.id}: селектор «${step.target}» — значения «${value}» нет в разметке разделов`);
            }
            continue;
          }
          const anchor = raw.replace(/^[.#]/, '');
          assert.ok(present(anchor),
            `${s.id}: селектор «${step.target}» — опоры «${anchor}» нет в разметке разделов`);
        }
      }
    }
  });

  test('у сценария изменений процессов описан весь путь предложения [US-EDU-001/AC5]', () => {
    const steps = stepsOf('process-changes');
    assert.ok(steps.length >= 12, `слишком короткий разбор: шагов ${steps.length}`);
    const targets = steps.map((s) => s.target).join(' ');
    // Ключевые опоры: доска, схема с обсуждением, кнопка предложения, сводка,
    // различие на схеме, лист согласования и поддержка коллег
    for (const [anchor, what] of [
      ['.chg-card', 'карточка предложения'],
      ['.bp-comment', 'замечание на шаге схемы'],
      ['[data-propose-change]', 'кнопка предложения изменения'],
      ['.chg-summary', 'сводка изменений'],
      ['.appr', 'лист согласования'],
      ['.chg-votes', 'поддержка коллег'],
    ]) {
      assert.ok(targets.includes(anchor), `в туре не показана ${what} (${anchor})`);
    }
  });

  test('тур проходит и по доске, и по карточке предложения [US-EDU-001/AC5]', () => {
    const routes = stepsOf('process-changes').map((s) => s.route).filter(Boolean);
    assert.ok(routes.includes('/changes'), 'тур не заходит на доску предложений');
    assert.ok(routes.includes('/processes'), 'тур не показывает, где рождается предложение');
  });

  test('сценарий предложен только тем, кто может предлагать изменения [US-EDU-001/AC5] [US-EDU-001/AC1]', () => {
    const block = tourSrc.slice(tourSrc.indexOf("id: 'process-changes'"));
    const roles = block.match(/roles: \[([^\]]+)\]/)?.[1] ?? '';
    assert.ok(roles.includes('employee'), 'сотрудник должен видеть сценарий');
    assert.ok(roles.includes('head') && roles.includes('dtszn'), 'согласующие должны видеть сценарий');
    // Поставщик может читать схемы, но не предлагать изменения — тур ему не нужен
    assert.ok(!roles.includes('supplier'), 'поставщику сценарий предлагаться не должен');
  });
});
