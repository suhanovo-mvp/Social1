// Образец формы: опросник ДЗМ, собранный по функциональным требованиям.
//
// Проверяется не «форма создалась», а то, ради чего требования писались: пять
// блоков, оценка каждого решения по шкале и уточняющие вопросы, которые видит
// только тот, кто поставил 3 и выше. Если условие потеряется, анкета станет
// длиннее вдвое для всех — включая тех, кому решение не нужно.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DIR = mkdtempSync(join(tmpdir(), 'social1-sample-form-'));
process.env.SOCIAL1_DB = join(DIR, 'test.db');
process.on('exit', () => rmSync(DIR, { recursive: true, force: true }));

const { q } = await import('../server/db.js');
const auth = await import('../server/auth.js');
const forms = await import('../server/forms.js');
const sample = await import('../server/seed-forms.js');
const { visibleKeys, isAnswerable } = await import('../shared/forms/schema.js');

let form, questions;

before(() => {
  auth.ensureRoles();
  const inst = ['ТЦСО «Ясенево»', 'ЦСО «Бабушкинский»', 'РЦ «Преодоление»', 'ЦЗН «Моя работа»']
    .map((name) => q.insert('INSERT INTO institutions (name, short_name, kind) VALUES (?,?,?)',
      name, name.slice(0, 12), 'institution'));
  ['dtszn', 'head', 'employee', 'expert', 'pilot_coordinator', 'employee']
    .forEach((role, i) => {
      const { hash, salt } = auth.hashPassword('test');
      q.insert(`INSERT INTO users (email, full_name, password_hash, password_salt, role, institution_id, position)
                VALUES (?,?,?,?,?,?,?)`,
        `u${i}@social1.mos.ru`, `Участник ${i}`, hash, salt, role, inst[i % inst.length], 'специалист');
    });
  form = sample.ensureSampleForms();
  questions = forms.questionsOf(form.id);
});

describe('Опросник ИИ-решений ДЗМ', () => {
  test('форма опубликована и доступна по ссылке без входа [US-FORM-005/AC1]', () => {
    assert.equal(form.slug, sample.AI_DZM_SLUG);
    assert.equal(form.status, 'published');
    assert.equal(form.access, 'link');
    assert.match(form.title, /Оценка потенциала переиспользования ИИ-решений ДЗМ/);
    assert.match(form.description, /5–7 минут/);
  });

  test('пять блоков требований стали разделами формы [US-FORM-005/AC2]', () => {
    const blocks = questions.filter((qn) => qn.type === 'section' && /^Блок \d/.test(qn.title));
    assert.equal(blocks.length, 5);
    assert.deepEqual(blocks.map((b) => b.title.replace(/^Блок \d\. /, '')), [
      'Общие сведения',
      'Текущие «болевые точки» процессов',
      'Оценка ИИ-решений и ожидаемые эффекты',
      'Техническая готовность и инфраструктура',
      'Готовность к пилоту и открытые предложения',
    ]);
  });

  test('каждое из пяти решений ДЗМ оценивается по шкале от 1 до 5 [US-FORM-005/AC2]', () => {
    const scales = questions.filter((qn) => qn.type === 'scale');
    assert.equal(scales.length, 5);
    for (const s of scales) {
      assert.equal(s.settings.min, 1);
      assert.equal(s.settings.max, 5);
      assert.equal(s.required, true, `${s.key}: оценка решения обязательна`);
    }
    const solutions = questions.filter((qn) => qn.type === 'section' && /Решение \d/.test(qn.title));
    assert.equal(solutions.length, 5, 'у каждого решения свой раздел с описанием');
    for (const s of solutions) assert.ok(s.hint, `${s.title}: нет описания решения`);
  });

  test('вопросы требований на месте — 24 плюс условное описание ограничений [US-FORM-005/AC2]', () => {
    const answerable = questions.filter((qn) => isAnswerable(qn.type));
    assert.equal(answerable.length, 25);
    assert.ok(answerable.every((qn) => qn.title.trim().length > 10));
    // Справочник учреждений подставлен из базы, а не набран руками
    const institutions = questions.find((qn) => qn.key === 'q2');
    assert.equal(institutions.type, 'select');
    assert.equal(institutions.options.length, 4);
    assert.equal(institutions.settings.allow_other, true);
  });

  test('уточнения об эффектах показываются только при оценке 3 и выше [US-FORM-005/AC3]', () => {
    const low = visibleKeys(questions, { q7: 2, q11: 1, q14: 2, q16: 2, q18: 1 });
    for (const key of ['q8', 'q9', 'q10', 'q12', 'q15', 'q17', 'q19']) {
      assert.ok(!low.has(key), `${key}: уточнение показано при низкой оценке`);
    }
    const high = visibleKeys(questions, { q7: 4, q11: 3, q14: 5, q16: 3, q18: 3 });
    for (const key of ['q8', 'q9', 'q10', 'q12', 'q15', 'q17', 'q19']) {
      assert.ok(high.has(key), `${key}: уточнение скрыто при высокой оценке`);
    }
    // Оценка решения спрашивается всегда — она и решает, что показать дальше
    assert.ok(low.has('q11') && low.has('q18'));
  });

  test('описание ограничений безопасности открывается только строгим ответом [US-FORM-005/AC3]', () => {
    assert.ok(!visibleKeys(questions, { q21: { choice: 'open' } }).has('q21_details'));
    assert.ok(!visibleKeys(questions, { q21: { choice: 'legal' } }).has('q21_details'));
    assert.ok(visibleKeys(questions, { q21: { choice: 'strict' } }).has('q21_details'));
  });

  test('короткая анкета проходит целиком: обязательны только показанные вопросы [US-FORM-002/AC3]', () => {
    // Отвечает участник, которого нет среди демонстрационных ответов
    const { hash, salt } = auth.hashPassword('test');
    const id = q.insert(`INSERT INTO users (email, full_name, password_hash, password_salt, role, institution_id)
                         VALUES (?,?,?,?,'employee',(SELECT id FROM institutions LIMIT 1))`,
      'fresh@social1.mos.ru', 'Иванова Анна Петровна', hash, salt);
    const user = q.get('SELECT * FROM users WHERE id = ?', id);
    const options = new Map(questions.map((qn) => [qn.key, qn.options]));
    const first = (key) => ({ choice: options.get(key)[0].code });
    const saved = forms.submitResponse({
      form, user: { ...user, extra_roles: null },
      answers: {
        q1: 'Иванова А. П., заведующий отделением', q2: first('q2'), q3: first('q3'),
        q4: 'ivanova@social1.mos.ru',
        q5: 'Перенос данных из бумажных актов в АИС.',
        q6: { choices: [options.get('q6')[0].code] },
        q7: 1, q11: 1, q13: first('q13'), q14: 2, q16: 2, q18: 1,
        q20: first('q20'), q21: { choice: 'open' }, q22: first('q22'),
      },
    });
    assert.equal(saved.status, 'submitted');
    assert.equal(saved.answered, 15, 'сохранены только показанные вопросы');
  });

  test('демонстрационные ответы собраны и сводка их считает [US-FORM-005/AC4]', () => {
    const r = forms.results(form.id);
    assert.ok(r.responses >= 6, `ответов слишком мало: ${r.responses}`);

    const voice = r.questions.find((x) => x.key === 'q7');
    assert.ok(voice.avg > 1 && voice.avg <= 5);
    assert.equal(voice.rows.reduce((s, x) => s + x.count, 0), voice.answered);

    // Охват условного вопроса меньше числа анкет — иначе условие не работает
    const where = r.questions.find((x) => x.key === 'q8');
    assert.equal(where.conditional, true);
    assert.ok(where.shown < r.responses, 'условный вопрос показали всем');
    assert.ok(where.shown > 0, 'условный вопрос не показали никому');
  });

  test('выгрузка содержит все вопросы анкеты [US-FORM-005/AC4]', () => {
    const head = forms.toCsv(form.id).split('\n')[0];
    assert.match(head, /ФИО и должность/);
    assert.match(head, /Дополнительные комментарии/);
    assert.equal(head.split(';').length, 25 + 4, 'колонки: служебные плюс все вопросы');
  });

  test('повторный запуск форму не задваивает [US-FORM-005/AC1]', () => {
    assert.equal(sample.ensureSampleForms(), null);
    assert.equal(q.get('SELECT COUNT(*) AS c FROM forms').c, 1);
  });
});
