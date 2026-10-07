// Презентация платформы собирается в момент скачивания. Главные требования:
// сначала — принципы взаимодействия и цели, затем каждый компонент тремя слайдами
// (обзор со скриншотом, ключевые экраны, схема совместной работы); разделы, о
// которых рассказывает презентация, действительно есть в портале; у каждого кадра
// есть файл; цифр из базы в презентации нет.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const deck = await import('../server/presentation-deck.js');
const { SLIDES, presentationPdf } = await import('../server/presentation-pdf.js');
const { jpegInfo } = await import('../server/pdf.js');
const routesSrc = readFileSync(new URL('../web/js/app.js', import.meta.url), 'utf8');
const shellSrc = readFileSync(new URL('../web/js/shell.js', import.meta.url), 'utf8');

// Маршруты портала — регулярные выражения из таблицы в app.js
const ROUTES = [...routesSrc.matchAll(/^\s*\[\/(\^[^\n]*?\$)\/,/gm)].map((m) => new RegExp(m[1]));
const routeExists = (path) => ROUTES.some((re) => re.test(path.split('?')[0]));
const shotFile = (file) => new URL(`../assets/presentation/${file}.jpg`, import.meta.url);

describe('Презентация платформы: порядок слайдов', () => {
  test('сначала титул, принципы взаимодействия, цели, участники и состав [US-ADM-003/AC2]', () => {
    assert.deepEqual(SLIDES.slice(0, 5).map((s) => s.id),
      ['cover', 'interaction', 'goals', 'participants', 'components']);
    assert.equal(SLIDES.at(-1).id, 'finale');
  });

  test('на титуле — название концепции и её автор [US-ADM-003/AC2]', () => {
    const { title, author } = deck.PRODUCT;
    assert.equal(title, 'Концепция единой цифровой платформы для комплексного управления реинжинирингом социальных процессов');
    for (const k of ['label', 'name', 'position', 'credentials', 'photo']) {
      assert.ok(author?.[k], `у автора концепции не заполнено поле ${k}`);
    }
    assert.ok(existsSync(shotFile(author.photo)), 'нет фотографии автора концепции');
    // Титул рисует блок автора: фотография встраивается в документ
    const src = readFileSync(new URL('../server/presentation-pdf.js', import.meta.url), 'utf8');
    const cover = src.slice(src.indexOf('function cover('), src.indexOf('function interaction('));
    assert.ok(cover.includes('PRODUCT.author'), 'первый слайд не выводит автора концепции');
  });

  test('каждый компонент — обзор, ключевые экраны и схема подряд [US-ADM-003/AC2]', () => {
    for (const c of deck.COMPONENTS) {
      const i = SLIDES.findIndex((s) => s.id === `c-${c.id}`);
      assert.ok(i > 0, `нет обзора компонента «${c.title}»`);
      assert.equal(SLIDES[i + 1].id, `c-${c.id}-screens`);
      assert.equal(SLIDES[i + 2].id, `c-${c.id}-scheme`);
    }
  });
});

describe('Презентация платформы: содержание', () => {
  test('в презентации нет счётчиков из базы [US-ADM-003/AC3]', () => {
    for (const f of ['presentation-deck.js', 'presentation-pdf.js']) {
      const src = readFileSync(new URL(`../server/${f}`, import.meta.url), 'utf8');
      assert.ok(!/from '\.\/db\.js'/.test(src), `${f} не должен обращаться к базе`);
    }
  });

  test('у компонента есть задача, возможности, роли и хотя бы два кадра [US-ADM-003/AC2]', () => {
    const ids = new Set();
    for (const c of deck.COMPONENTS) {
      assert.ok(!ids.has(c.id), `повтор компонента ${c.id}`); ids.add(c.id);
      assert.ok(c.lead && c.roles, `${c.id}: нет задачи или ролей`);
      assert.ok(c.features.length >= 4, `${c.id}: слишком мало возможностей`);
      assert.ok(c.screens.length >= 2, `${c.id}: нужны кадр обзора и ключевой экран`);
    }
  });

  test('разделы и компоненты ссылаются на существующие маршруты портала [US-ADM-003/AC4]', () => {
    const paths = [...deck.SECTIONS.flatMap((g) => g.items.map((i) => i.path)),
                   ...deck.COMPONENTS.flatMap((c) => [...c.paths, ...c.screens.map((s) => s.shot.path)])];
    for (const p of new Set(paths)) assert.ok(routeExists(p), `маршрута ${p} нет в портале`);
  });

  test('каждый пункт бокового меню есть на карте платформы [US-ADM-003/AC4]', () => {
    const menu = [...shellSrc.matchAll(/path: '([^']+)', title:/g)].map((m) => m[1]);
    const mapped = new Set(deck.SECTIONS.flatMap((g) => g.items.map((i) => i.path)));
    for (const p of new Set(menu)) assert.ok(mapped.has(p), `раздел ${p} из меню не попал в презентацию`);
  });

  test('у каждого кадра есть JPEG в assets/presentation [US-ADM-003/AC4]', () => {
    for (const s of deck.SCREENS) {
      assert.ok(existsSync(shotFile(s.file)), `нет файла ${s.file}.jpg — снимите: npm run screens -- ${s.file}`);
      const { width, height } = jpegInfo(readFileSync(shotFile(s.file)));
      assert.ok(width >= 1000 && height >= 600, `${s.file}.jpg слишком мелкий: ${width}×${height}`);
    }
  });

  test('схемы совместной работы собраны корректно [US-ADM-003/AC2]', () => {
    for (const c of deck.COMPONENTS) {
      const sc = c.scheme;
      assert.ok(sc.title && sc.result, `${c.id}: у схемы нет заголовка или результата`);
      for (const lane of sc.lanes) assert.ok(deck.PARTIES[lane], `${c.id}: неизвестный участник ${lane}`);
      const byId = new Map();
      for (const s of sc.steps) {
        assert.ok(!byId.has(s.id), `${c.id}: повтор шага ${s.id}`);
        assert.ok(sc.lanes.includes(s.lane), `${c.id}: шаг ${s.id} вне дорожек схемы`);
        byId.set(s.id, s);
      }
      // Два шага в одной клетке наложились бы друг на друга
      const cells = sc.steps.map((s) => `${s.lane}:${s.col}`);
      assert.equal(new Set(cells).size, cells.length, `${c.id}: два шага в одной клетке`);
      for (const [from, to] of sc.links) {
        assert.ok(byId.has(from) && byId.has(to), `${c.id}: связь ${from}→${to} ссылается на несуществующий шаг`);
        assert.ok(byId.get(from).col <= byId.get(to).col, `${c.id}: связь ${from}→${to} идёт назад`);
      }
      // Каждый шаг с чем-то связан
      const linked = new Set(sc.links.flat());
      for (const s of sc.steps) assert.ok(linked.has(s.id), `${c.id}: шаг ${s.id} ни с чем не связан`);
    }
  });
});

describe('Презентация платформы: файл', () => {
  test('PDF собирается, текст ищется, скриншоты встроены [US-ADM-003/AC4]', () => {
    const buf = presentationPdf();
    assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
    assert.ok(buf.includes('/ToUnicode'), 'текст презентации должен искаться');
    const src = buf.toString('latin1');
    const pages = (src.match(/\/Type \/Page\b/g) || []).length;
    assert.equal(pages, SLIDES.length);
    const images = (src.match(/\/Subtype \/Image/g) || []).length;
    // Каждый кадр и фотография автора встраиваются один раз
    assert.equal(images, new Set(deck.SCREENS.map((s) => s.file)).size + 1);
  });

  test('размеры JPEG читаются из маркера кадра', () => {
    const { width, height, components } = jpegInfo(readFileSync(shotFile(deck.SCREENS[0].file)));
    assert.ok(width > height && components === 3);
    assert.throws(() => jpegInfo(Buffer.from('not a jpeg')), /Не JPEG/);
  });

  test('скачать презентацию может только администратор [US-ADM-003/AC1]', () => {
    const src = readFileSync(new URL('../server/api/admin.js', import.meta.url), 'utf8');
    const block = src.slice(src.indexOf("'/api/admin/presentation.pdf'"));
    assert.ok(block.slice(0, 200).includes('requireAdmin(user)'));
  });
});
