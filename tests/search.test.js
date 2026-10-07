// Поиск по базе знаний. Главное требование — находить по той форме слова, которую
// набрал человек, а не по той, которой написан документ: «возвраты заявлений»
// должны приводить к тексту, где сказано «вернули заявление». Без этого поиск
// бесполезен ровно тогда, когда нужен: человек ищет своими словами.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DIR = mkdtempSync(join(tmpdir(), 'social1-search-'));
process.env.SOCIAL1_DB = join(DIR, 'test.db');
process.on('exit', () => rmSync(DIR, { recursive: true, force: true }));

const { q } = await import('../server/db.js');
const auth = await import('../server/auth.js');
const kn = await import('../server/knowledge.js');
const s = await import('../server/search.js');

let institution, director;
before(() => {
  auth.ensureRoles();
  kn.ensureKnowledge();
  institution = q.insert("INSERT INTO institutions (name, short_name) VALUES ('ТЦСО','ТЦСО')");
  const { hash, salt } = auth.hashPassword('test');
  const id = q.insert(`INSERT INTO users (email, full_name, password_hash, password_salt, role, institution_id)
                       VALUES (?,?,?,?,?,?)`, 'dir@s.ru', 'Директор', hash, salt, 'dtszn', institution);
  director = { id, role: 'dtszn', institution_id: institution };
});

describe('Приведение слова к основе [US-KB-003/AC1]', () => {
  test('все формы одного слова дают одну основу', () => {
    const группы = [
      ['заявление', 'заявления', 'заявлению', 'заявлением', 'заявлений', 'заявлениями', 'заявлениях'],
      ['решение', 'решения', 'решений', 'решениями', 'решению'],
      ['инициатива', 'инициативы', 'инициатив', 'инициативами'],
      ['совет', 'советы', 'совета', 'советов', 'советом'],
      ['дом', 'дома', 'дому', 'домом', 'домах'],
    ];
    for (const формы of группы) {
      const основы = new Set(формы.map(s.stem));
      assert.equal(основы.size, 1,
        `формы «${формы[0]}» дали разные основы: ${[...основы].join(', ')} — они не найдут друг друга`);
    }
  });

  test('разные слова не сливаются в одну основу', () => {
    for (const [a, b] of [['процесс', 'процент'], ['работа', 'работник'],
                          ['заявка', 'заявление'], ['совет', 'советник'], ['идея', 'идеал']]) {
      assert.notEqual(s.stem(a), s.stem(b), `«${a}» и «${b}» слились в одну основу`);
    }
  });

  test('регистр и «ё» не влияют на основу', () => {
    assert.equal(s.stem('Решение'), s.stem('решение'));
    assert.equal(s.stem('чётко'), s.stem('четко'));
  });
});

describe('Поиск по базе знаний', () => {
  before(() => {
    const d = kn.createDoc({ kind: 'adr', title: 'Возврат заявления на доработку', user: director });
    kn.saveDraft({ docId: d.id, user: director, sections: {
      context: 'Специалист вернул заявление заявителю без объяснения причины.',
      decision: 'Возврат сопровождается перечнем недостающих сведений.',
      consequences: 'Повторных обращений стало меньше, приём удлинился на две минуты.',
    }});
    kn.publishDoc({ docId: d.id, user: director });
  });

  test('документ находится по другой форме слова [US-KB-003/AC1]', () => {
    for (const query of ['заявления', 'заявлений', 'заявлениями', 'возвраты']) {
      const r = s.search(query, { types: ['knowledge_doc'] });
      assert.ok(r.length > 0, `запрос «${query}» ничего не нашёл`);
      assert.match(r[0].title, /Возврат заявления/);
    }
  });

  test('в выдаче есть фрагмент с найденным словом [US-KB-003/AC1]', () => {
    const [top] = s.search('недостающих сведений', { types: ['knowledge_doc'] });
    assert.ok(top, 'документ не найден по тексту раздела');
    assert.match(top.excerpt, /⟪/, 'не отмечено, что именно совпало');
  });

  test('пустой и бессмысленный запрос не ломает поиск [US-KB-003/AC2]', () => {
    assert.deepEqual(s.search(''), []);
    assert.deepEqual(s.search('   '), []);
    assert.deepEqual(s.search('ыъ'), []);
  });

  test('кавычки в запросе не ломают разбор [US-KB-003/AC2]', () => {
    assert.doesNotThrow(() => s.search('«возврат» "заявления"'));
  });

  test('фильтр по виду сущности сужает выдачу [US-KB-003/AC2]', () => {
    const r = s.search('заявление', { types: ['idea'] });
    assert.ok(r.every((x) => x.entity_type === 'idea'));
  });
});

describe('Поддержание индекса', () => {
  test('черновик в поиск не попадает, опубликованный попадает [US-KB-003/AC3]', () => {
    const d = kn.createDoc({ kind: 'adr', title: 'Черновое решение про питание', user: director });
    kn.saveDraft({ docId: d.id, user: director, sections: {
      context: 'Питание подопечных', decision: 'Изменить меню', consequences: 'Затраты выросли',
    }});
    assert.equal(s.search('питание', { types: ['knowledge_doc'] }).length, 0,
      'черновик не должен находиться: он ещё не знание');

    kn.publishDoc({ docId: d.id, user: director });
    assert.ok(s.search('питание', { types: ['knowledge_doc'] }).length > 0,
      'опубликованное решение обязано находиться сразу, без пересборки индекса');
  });

  test('заменённое решение уходит из выдачи, а заменившее остаётся [US-KB-003/AC3]', () => {
    const first = kn.createDoc({ kind: 'adr', title: 'Прежний порядок выдачи путёвок', user: director });
    kn.saveDraft({ docId: first.id, user: director, sections: {
      context: 'Путёвки выдавались в порядке очереди.',
      decision: 'Выдавать по дате обращения.', consequences: 'Очередь стала предсказуемой.',
    }});
    kn.publishDoc({ docId: first.id, user: director });

    const next = kn.reviseDoc({ docId: first.id, user: director });
    kn.saveDraft({ docId: next.id, user: director, sections: {
      context: 'Порядок по дате обращения не учитывал нуждаемость.',
      decision: 'Выдавать по нуждаемости.', consequences: 'Ожидание для части заявителей выросло.',
    }});
    kn.publishDoc({ docId: next.id, user: director });

    const found = s.search('путёвок выдача', { types: ['knowledge_doc'] });
    assert.ok(!found.some((r) => r.entity_id === first.id),
      'заменённое решение не должно всплывать как действующее');
  });

  test('полная пересборка индекса возвращает то же, что событийная [US-KB-003/AC4]', () => {
    const before = s.search('заявления', { types: ['knowledge_doc'] }).map((r) => r.entity_id).sort();
    s.reindexAll();
    const after = s.search('заявления', { types: ['knowledge_doc'] }).map((r) => r.entity_id).sort();
    assert.deepEqual(after, before, 'событийная индексация разошлась с полной пересборкой');
  });
});

describe('Подсказка «это уже разбирали»', () => {
  test('по тексту идеи находится готовое решение [US-KB-003/AC4] [US-IDEA-001/AC5]', () => {
    const похожие = s.similarTo(
      'Заявление возвращают заявителю, он не понимает, чего не хватает, и приходит снова',
      { types: ['knowledge_doc'], limit: 3 });
    assert.ok(похожие.length > 0, 'подсказка не нашла разобранного решения');
    assert.match(похожие[0].title, /Возврат заявления/);
  });

  test('сам предмет из подсказок исключается [US-KB-003/AC4]', () => {
    const [doc] = s.search('возврат заявления', { types: ['knowledge_doc'] });
    const похожие = s.similarTo('возврат заявления на доработку',
      { types: ['knowledge_doc'], exclude: { type: 'knowledge_doc', id: doc.entity_id } });
    assert.ok(!похожие.some((r) => r.entity_id === doc.entity_id),
      'документ не должен предлагать сам себя');
  });
});
