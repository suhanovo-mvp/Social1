// Конструктор форм: структура, условия показа, сбор ответов и сводка.
//
// Главная проверка здесь — согласие двух вещей, которые легко расходятся: что
// человеку показали и что от него потребовали. Условный вопрос не показан —
// значит, он не обязателен и его ответ не хранится; показан — обязателен и
// попадает в сводку со своим охватом. Если эта пара разъезжается, форма начинает
// либо не отправляться без видимой причины, либо копить ответы-призраки.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DIR = mkdtempSync(join(tmpdir(), 'social1-forms-'));
process.env.SOCIAL1_DB = join(DIR, 'test.db');
process.on('exit', () => rmSync(DIR, { recursive: true, force: true }));

const { q } = await import('../server/db.js');
const auth = await import('../server/auth.js');
const forms = await import('../server/forms.js');
const schema = await import('../shared/forms/schema.js');

let institution, author, colleague, outsider;

const makeUser = (email, role) => {
  const { hash, salt } = auth.hashPassword('test');
  const id = q.insert(`INSERT INTO users (email, full_name, password_hash, password_salt, role, institution_id)
                       VALUES (?,?,?,?,?,?)`, email, `Участник ${role}`, hash, salt, role, institution);
  return { id, role, institution_id: institution, extra_roles: null };
};

// Анкета, повторяющая устройство настоящей: оценка по шкале и два вопроса,
// которые показываются только при высокой оценке
const SCALED = [
  { type: 'section', key: 's1', title: 'Оценка решения' },
  { type: 'scale', key: 'rate', title: 'Насколько это актуально?', required: true,
    settings: { min: 1, max: 5, min_label: 'Совсем нет', max_label: 'Критически важно' } },
  { type: 'long_text', key: 'where', title: 'Где видите применение?', required: true,
    visible_if: { op: 'all', rules: [{ q: 'rate', cmp: 'gte', value: 3 }] } },
  { type: 'checkbox', key: 'effect', title: 'Главный ожидаемый эффект',
    options: [{ code: 'time', label: 'Экономия времени' }, { code: 'quality', label: 'Меньше ошибок' }],
    settings: { allow_other: true },
    visible_if: { op: 'all', rules: [{ q: 'rate', cmp: 'gte', value: 3 }] } },
];

const newForm = (user = author, questions = SCALED, patch = {}) => {
  const form = forms.createForm({ title: 'Опрос об ИИ-решениях', user });
  forms.saveQuestions({ formId: form.id, questions, user });
  if (Object.keys(patch).length) forms.updateForm({ formId: form.id, patch, user });
  return forms.getForm(form.id);
};

const published = (...args) => {
  const form = newForm(...args);
  forms.publishForm({ formId: form.id, user: author });
  return forms.getForm(form.id);
};

before(() => {
  auth.ensureRoles();
  institution = q.insert("INSERT INTO institutions (name, short_name) VALUES ('ТЦСО «Ясенево»','ТЦСО')");
  author = makeUser('coord@s.ru', 'pilot_coordinator');
  colleague = makeUser('emp@s.ru', 'employee');
  outsider = makeUser('sup@s.ru', 'supplier');
});

beforeEach(() => {
  q.run('DELETE FROM form_responses');
  q.run('DELETE FROM forms');
});

// ─────────────────────────────────────────────────────────────
describe('Структура формы', () => {
  test('вопросы сохраняются с ключами, порядком и вариантами [US-FORM-001/AC2]', () => {
    const form = newForm();
    const questions = forms.questionsOf(form.id);
    assert.equal(questions.length, 4);
    assert.deepEqual(questions.map((qn) => qn.key), ['s1', 'rate', 'where', 'effect']);
    assert.deepEqual(questions[3].options.map((o) => o.code), ['time', 'quality']);
    assert.equal(questions[1].settings.max_label, 'Критически важно');
  });

  test('вопрос без текста не сохраняется [US-FORM-001/AC2]', () => {
    const form = forms.createForm({ title: 'Пустая', user: author });
    assert.throws(() => forms.saveQuestions({
      formId: form.id, user: author,
      questions: [{ type: 'short_text', title: '   ' }],
    }), /не заполнен текст вопроса/);
  });

  test('условие не может ссылаться на вопрос ниже по форме [US-FORM-002/AC2]', () => {
    const form = forms.createForm({ title: 'Кривая', user: author });
    assert.throws(() => forms.saveQuestions({
      formId: form.id, user: author,
      questions: [
        { type: 'short_text', key: 'a', title: 'Первый',
          visible_if: { op: 'all', rules: [{ q: 'b', cmp: 'answered' }] } },
        { type: 'short_text', key: 'b', title: 'Второй' },
      ],
    }), /идёт ниже по форме/);
  });

  test('сравнение проверяется по типу вопроса, на который ссылается условие [US-FORM-002/AC2]', () => {
    const form = forms.createForm({ title: 'Кривая', user: author });
    assert.throws(() => forms.saveQuestions({
      formId: form.id, user: author,
      questions: [
        { type: 'short_text', key: 'a', title: 'Фамилия' },
        { type: 'short_text', key: 'b', title: 'Второй',
          visible_if: { op: 'all', rules: [{ q: 'a', cmp: 'gte', value: 3 }] } },
      ],
    }), /не подходит/);
  });

  test('шкала не выходит за допустимые границы [US-FORM-001/AC2]', () => {
    const form = forms.createForm({ title: 'Шкала', user: author });
    assert.throws(() => forms.saveQuestions({
      formId: form.id, user: author,
      questions: [{ type: 'scale', key: 'r', title: 'Оценка', settings: { min: 1, max: 100 } }],
    }), /шкала/i);
  });

  test('правка структуры сохраняет уже собранные ответы [US-FORM-001/AC4]', () => {
    const form = published();
    forms.submitResponse({ form, user: colleague, answers: { rate: 4, where: 'В кол-центре' } });

    forms.saveQuestions({
      formId: form.id, user: author,
      questions: [...SCALED, { type: 'short_text', key: 'extra', title: 'Ещё вопрос' }],
    });
    const table = forms.responseTable(form.id);
    assert.equal(table.rows.length, 1);
    assert.equal(table.rows[0].values.where, 'В кол-центре', 'ответ пережил правку структуры');
    assert.ok(table.columns.some((c) => c.key === 'extra'));
  });

  test('удалённый вопрос уносит свои ответы [US-FORM-001/AC4]', () => {
    const form = published();
    forms.submitResponse({ form, user: colleague, answers: { rate: 4, where: 'В кол-центре' } });
    forms.saveQuestions({ formId: form.id, user: author, questions: SCALED.slice(0, 2) });
    assert.equal(forms.responseTable(form.id).rows[0].values.where, undefined);
  });
});

// ─────────────────────────────────────────────────────────────
describe('Публикация', () => {
  test('форма без вопросов не публикуется [US-FORM-003/AC1]', () => {
    const form = forms.createForm({ title: 'Пустая', user: author });
    assert.deepEqual(forms.publishIssues(form.id), ['В форме нет ни одного вопроса']);
    assert.throws(() => forms.publishForm({ formId: form.id, user: author }), /нельзя опубликовать/);
  });

  test('форма из одних разделов вопросом не считается [US-FORM-003/AC1]', () => {
    const form = newForm(author, [{ type: 'section', key: 's', title: 'Блок' }]);
    assert.ok(forms.publishIssues(form.id).length);
  });

  test('черновик не принимает ответы [US-FORM-003/AC1]', () => {
    const form = newForm();
    assert.throws(() => forms.submitResponse({ form, user: colleague, answers: { rate: 3 } }),
      /ещё не опубликована/);
  });

  test('закрытая форма ответы не принимает, но результаты остаются [US-FORM-003/AC1]', () => {
    const form = published();
    forms.submitResponse({ form, user: colleague, answers: { rate: 2 } });
    forms.setStatus({ formId: form.id, status: 'closed', user: author });
    const closed = forms.getForm(form.id);
    assert.equal(closed.is_open, false);
    assert.throws(() => forms.submitResponse({ form: closed, user: outsider, answers: { rate: 2 } }),
      /закрыт/);
    assert.equal(forms.results(form.id).responses, 1);
  });

  test('срок сбора закрывает форму сам [US-FORM-003/AC2]', () => {
    const form = published(author, SCALED, { closes_at: '2020-01-01 00:00:00' });
    assert.equal(forms.isOpen(form), false);
  });

  test('форму с ответами нельзя вернуть в черновик [US-FORM-003/AC2]', () => {
    const form = published();
    forms.submitResponse({ form, user: colleague, answers: { rate: 5, where: 'Приём' } });
    assert.throws(() => forms.setStatus({ formId: form.id, status: 'draft', user: author }),
      /только закрыть/);
  });
});

// ─────────────────────────────────────────────────────────────
describe('Условные вопросы [US-FORM-002/AC3]', () => {
  test('скрытый вопрос не обязателен, даже если помечен обязательным', () => {
    const form = published();
    const saved = forms.submitResponse({ form, user: colleague, answers: { rate: 1 } });
    assert.equal(saved.answered, 1, 'сохранён только ответ по шкале');
  });

  test('показанный вопрос обязателен', () => {
    const form = published();
    assert.throws(() => forms.submitResponse({ form, user: colleague, answers: { rate: 4 } }),
      /Проверьте заполнение/);
  });

  test('ответ на скрытый вопрос не сохраняется', () => {
    const form = published();
    const saved = forms.submitResponse({
      form, user: colleague,
      answers: { rate: 1, where: 'Передумал и понизил оценку', effect: { choices: ['time'] } },
    });
    assert.equal(saved.answered, 1);
    const row = forms.responseTable(form.id).rows[0];
    assert.equal(row.values.where, undefined, 'ответ на невидимый вопрос не попал в таблицу');
  });

  test('цепочка условий рвётся вместе с первым звеном', () => {
    const questions = [
      { type: 'radio', key: 'ready', title: 'Готовы к пилоту?',
        options: [{ code: 'yes', label: 'Да' }, { code: 'no', label: 'Нет' }] },
      { type: 'short_text', key: 'who', title: 'Кто куратор?',
        visible_if: { op: 'all', rules: [{ q: 'ready', cmp: 'eq', value: 'yes' }] } },
      { type: 'short_text', key: 'when', title: 'С какого месяца?',
        visible_if: { op: 'all', rules: [{ q: 'who', cmp: 'answered' }] } },
    ];
    const visible = schema.visibleKeys(questions, { ready: { choice: 'no' }, who: 'Иванов' });
    assert.ok(!visible.has('who'));
    assert.ok(!visible.has('when'), 'вопрос за скрытым звеном тоже скрыт');
  });
});

// ─────────────────────────────────────────────────────────────
describe('Проверка ответов', () => {
  // Ошибки складываются в details по вопросам: человеку показывают их сразу все,
  // рядом с полями, а не по одной за отправку
  const failure = (fn) => {
    try { fn(); assert.fail('форма принята с ошибочным ответом'); }
    catch (e) { return (e.details ?? []).map((d) => d.message).join(' | '); }
  };

  test('вариант не из списка отвергается [US-FORM-003/AC7]', () => {
    const form = published();
    assert.match(failure(() => forms.submitResponse({
      form, user: colleague, answers: { rate: 4, where: 'Приём', effect: { choices: ['подделка'] } },
    })), /которого нет в списке/);
  });

  test('оценка вне шкалы отвергается [US-FORM-003/AC7]', () => {
    const form = published();
    assert.match(failure(() => forms.submitResponse({ form, user: colleague, answers: { rate: 9 } })),
      /вне шкалы от 1 до 5/);
  });

  test('«другое» принимается только там, где оно разрешено [US-FORM-001/AC3]', () => {
    const form = published();
    const ok = forms.submitResponse({
      form, user: colleague,
      answers: { rate: 5, where: 'Приём', effect: { choices: ['time'], other: 'Меньше выгорания' } },
    });
    assert.equal(ok.answered, 3);
    assert.match(forms.responseTable(form.id).rows[0].values.effect, /Меньше выгорания/);

    const strict = published(author, [
      { type: 'radio', key: 'k', title: 'Тип учреждения', required: true,
        options: [{ code: 'cso', label: 'ЦСО' }] },
    ]);
    assert.match(failure(() => forms.submitResponse({
      form: strict, user: colleague, answers: { k: { choice: schema.OTHER, other: 'Диспансер' } },
    })), /свой ответ не предусмотрен/);
  });

  test('почта проверяется по написанию [US-FORM-003/AC7]', () => {
    const form = published(author, [{ type: 'email', key: 'mail', title: 'Почта', required: true }]);
    assert.match(failure(() => forms.submitResponse({ form, user: colleague, answers: { mail: 'без-собаки' } })),
      /записан неверно/);
    assert.ok(forms.submitResponse({ form, user: colleague, answers: { mail: 'i@mos.ru' } }).id);
  });

  test('ошибки возвращаются списком по вопросам, а не первой попавшейся [US-FORM-003/AC7]', () => {
    const form = published(author, [
      { type: 'short_text', key: 'fio', title: 'ФИО', required: true },
      { type: 'short_text', key: 'pos', title: 'Должность', required: true },
    ]);
    try {
      forms.submitResponse({ form, user: colleague, answers: {} });
      assert.fail('форма принята без обязательных ответов');
    } catch (e) {
      assert.equal(e.details.length, 2);
      assert.deepEqual(e.details.map((d) => d.key), ['fio', 'pos']);
    }
  });
});

// ─────────────────────────────────────────────────────────────
describe('Сбор ответов', () => {
  test('повторный ответ не принимается, когда так настроена форма [US-FORM-003/AC5]', () => {
    const form = published();
    forms.submitResponse({ form, user: colleague, answers: { rate: 2 } });
    assert.throws(() => forms.submitResponse({ form, user: colleague, answers: { rate: 3, where: 'Тут' } }),
      /уже отвечали/);
  });

  test('при разрешении нескольких ответов принимается каждый [US-FORM-003/AC5]', () => {
    const form = published(author, SCALED, { one_per_user: 0 });
    forms.submitResponse({ form, user: colleague, answers: { rate: 2 } });
    forms.submitResponse({ form, user: colleague, answers: { rate: 4, where: 'Кол-центр' } });
    assert.equal(forms.results(form.id).responses, 2);
  });

  test('анонимная форма не запоминает, кто отвечал [US-FORM-003/AC5]', () => {
    const form = published(author, SCALED, { is_anonymous: 1 });
    forms.submitResponse({ form, user: colleague, answers: { rate: 5, where: 'Приём' } });
    const row = q.get('SELECT * FROM form_responses WHERE form_id = ?', form.id);
    assert.equal(row.respondent_id, null);
    assert.equal(row.institution_id, null);
    assert.equal(forms.responseTable(form.id).rows[0].respondent, null);
  });

  test('черновик ответа превращается в отправленный, а не во второй ответ [US-FORM-003/AC6]', () => {
    const form = published();
    const draft = forms.saveResponseDraft({ form, user: colleague, answers: { rate: 4 } });
    assert.equal(draft.status, 'draft');
    assert.equal(forms.results(form.id).responses, 0, 'черновик в сводку не попадает');

    const sent = forms.submitResponse({ form, user: colleague, answers: { rate: 4, where: 'Приём' } });
    assert.equal(sent.id, draft.id);
    assert.equal(q.get('SELECT COUNT(*) AS c FROM form_responses WHERE form_id = ?', form.id).c, 1);
    assert.equal(forms.results(form.id).responses, 1);
  });

  test('чужой ответ не перезаписывается указанием его номера [US-FORM-003/AC6]', () => {
    const form = published(author, SCALED, { one_per_user: 0 });
    const mine = forms.submitResponse({ form, user: colleague, answers: { rate: 2 } });
    const other = forms.submitResponse({
      form, user: outsider, answers: { rate: 5, where: 'Приём' }, responseId: mine.id,
    });
    assert.notEqual(other.id, mine.id);
    assert.equal(q.get('SELECT respondent_id FROM form_responses WHERE id = ?', mine.id).respondent_id,
      colleague.id);
  });

  test('форму «только участникам» нельзя заполнить по ссылке [US-FORM-003/AC3]', () => {
    const form = published();
    assert.throws(() => forms.submitResponse({ form, user: null, answers: { rate: 2 }, source: 'link' }),
      /только участникам платформы/);
  });

  test('ответ по ссылке принимается без входа и остаётся безымянным [US-FORM-003/AC3]', () => {
    const form = published(author, SCALED, { access: 'link' });
    forms.submitResponse({ form, user: null, answers: { rate: 3, where: 'Приём' }, source: 'link' });
    const row = q.get('SELECT * FROM form_responses WHERE form_id = ?', form.id);
    assert.equal(row.respondent_id, null);
    assert.equal(row.source, 'link');
  });
});

// ─────────────────────────────────────────────────────────────
describe('Результаты', () => {
  const fill = (form) => {
    forms.submitResponse({ form, user: colleague, answers: { rate: 5, where: 'Первичный приём',
      effect: { choices: ['time', 'quality'] } } });
    forms.submitResponse({ form, user: outsider, answers: { rate: 3, where: 'Кол-центр',
      effect: { choices: ['time'], other: 'Контроль качества' } } });
    forms.submitResponse({ form, user: author, answers: { rate: 1 } });
  };

  test('сводка считает среднее по шкале и распределение по вариантам [US-FORM-004/AC1]', () => {
    const form = published(author, SCALED, { one_per_user: 0 });
    fill(form);
    const r = forms.results(form.id);
    assert.equal(r.responses, 3);

    const rate = r.questions.find((x) => x.key === 'rate');
    assert.equal(rate.answered, 3);
    assert.equal(Math.round(rate.avg * 10) / 10, 3);

    const effect = r.questions.find((x) => x.key === 'effect');
    assert.equal(effect.rows.find((x) => x.code === 'time').count, 2);
    assert.equal(effect.rows.find((x) => x.code === 'quality').count, 1);
    assert.equal(effect.rows.find((x) => x.code === schema.OTHER).count, 1);
    assert.deepEqual(effect.rows.find((x) => x.code === schema.OTHER).texts, ['Контроль качества']);
  });

  test('у условного вопроса охват считается по тем, кому он показывался [US-FORM-004/AC2]', () => {
    const form = published(author, SCALED, { one_per_user: 0 });
    fill(form);
    const where = forms.results(form.id).questions.find((x) => x.key === 'where');
    assert.equal(where.conditional, true);
    assert.equal(where.shown, 2, 'вопрос видели двое из трёх');
    assert.equal(where.answered, 2);
  });

  test('тексты свободных ответов возвращаются целиком [US-FORM-004/AC1]', () => {
    const form = published(author, SCALED, { one_per_user: 0 });
    fill(form);
    const where = forms.results(form.id).questions.find((x) => x.key === 'where');
    assert.deepEqual(where.texts.sort(), ['Кол-центр', 'Первичный приём']);
  });

  test('выгрузка содержит заголовки вопросов и ответы построчно [US-FORM-004/AC3]', () => {
    const form = published(author, SCALED, { one_per_user: 0 });
    fill(form);
    const csv = forms.toCsv(form.id);
    const [head, ...rows] = csv.replace('﻿', '').split('\n');
    assert.match(head, /"Насколько это актуально\?"/);
    assert.equal(rows.length, 3);
    assert.match(csv, /Первичный приём/);
    assert.match(csv, /Экономия времени; Меньше ошибок/);
  });
});

// ─────────────────────────────────────────────────────────────
describe('Доступ', () => {
  test('чужую форму нельзя изменить [US-FORM-001/AC5]', () => {
    const form = newForm();
    assert.throws(() => forms.updateForm({ formId: form.id, patch: { title: 'Моя' }, user: colleague }),
      /только её автор/);
    assert.equal(forms.canEdit(colleague, form), false);
    assert.equal(forms.canSeeResults(colleague, form), false);
  });

  test('администратор форм ведёт любую [US-FORM-001/AC5]', () => {
    const admin = makeUser(`dtszn-${Date.now()}@s.ru`, 'dtszn');
    const form = newForm();
    assert.equal(forms.canEdit(admin, form), true);
    assert.equal(forms.updateForm({ formId: form.id, patch: { title: 'Правка ДТСЗН' }, user: admin }).title,
      'Правка ДТСЗН');
  });

  test('адрес формы читается и не повторяется [US-FORM-003/AC4]', () => {
    const a = forms.createForm({ title: 'Оценка ИИ-решений ДЗМ', user: author });
    const b = forms.createForm({ title: 'Оценка ИИ-решений ДЗМ', user: author });
    assert.equal(a.slug, 'ocenka-ii-resheniy-dzm');
    assert.equal(b.slug, 'ocenka-ii-resheniy-dzm-2');
  });

  test('адрес опубликованной формы не меняется вместе с названием [US-FORM-003/AC4]', () => {
    const form = published();
    const slug = form.slug;
    const renamed = forms.updateForm({ formId: form.id, patch: { title: 'Новое название' }, user: author });
    assert.equal(renamed.slug, slug, 'разосланная ссылка продолжает работать');
  });

  test('копия формы повторяет вопросы и начинается черновиком [US-FORM-001/AC5]', () => {
    const form = published();
    const copy = forms.duplicateForm({ formId: form.id, user: author });
    assert.equal(copy.status, 'draft');
    assert.equal(copy.responses, 0);
    assert.deepEqual(forms.questionsOf(copy.id).map((x) => x.key),
      forms.questionsOf(form.id).map((x) => x.key));
  });
});
