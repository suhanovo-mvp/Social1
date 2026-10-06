// Конструктор форм: сборка опросов и анкет, сбор и сводка ответов.
//
// Раньше опрос на платформе был один — по итогам пилота, с тремя типами вопросов,
// зашитыми в код. Любая другая анкета (оценить спрос на решение, обследовать
// учреждения, собрать заявки на обучение) требовала правки исходников, и поэтому
// её собирали во внешнем сервисе, а результаты приносили ссылкой. Здесь форма
// становится данными: состав вопросов, условия показа и правила проверки задаёт
// человек в конструкторе.
//
// Правила показа и разбор ответа живут в shared/forms/schema.js — их разделяет
// браузер. Здесь остаётся то, что браузеру доверить нельзя: доступ, хранение,
// неизменность отправленного ответа и сводка.
import { q, tx } from './db.js';
import { logAction } from './audit.js';
import { can } from './auth.js';
import { emit } from './events.js';
import {
  FormError, QUESTION_TYPES, isAnswerable, kindOf,
  normalizeQuestions, parseAnswers, summarize, visibleKeys,
} from '../shared/forms/schema.js';

export { FormError, QUESTION_TYPES };

export const FORM_STATUS = {
  draft:     { title: 'Черновик',    tone: 'muted', hint: 'Виден только вам: ответы не собираются' },
  published: { title: 'Идёт сбор',   tone: 'ok',    hint: 'Форма открыта, ответы принимаются' },
  closed:    { title: 'Сбор закрыт', tone: 'warn',  hint: 'Ответы больше не принимаются, результаты доступны' },
};

export const ACCESS_MODES = {
  internal: { title: 'Участникам платформы', hint: 'Заполнить может только тот, кто вошёл в Social1' },
  link:     { title: 'По ссылке, без входа', hint: 'Ссылку можно разослать в учреждения — вход не потребуется' },
};

// ─────────────────────────────────────────────────────────────
// Адрес формы
// ─────────────────────────────────────────────────────────────
const TRANSLIT = {
  а:'a', б:'b', в:'v', г:'g', д:'d', е:'e', ё:'e', ж:'zh', з:'z', и:'i', й:'y', к:'k', л:'l',
  м:'m', н:'n', о:'o', п:'p', р:'r', с:'s', т:'t', у:'u', ф:'f', х:'h', ц:'c', ч:'ch', ш:'sh',
  щ:'sch', ъ:'', ы:'y', ь:'', э:'e', ю:'yu', я:'ya',
};

/** Человекочитаемый адрес: ссылку на опрос рассылают письмом, и она должна читаться. */
export function slugify(title) {
  const base = String(title ?? '').toLowerCase()
    .split('').map((ch) => TRANSLIT[ch] ?? ch).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return base || 'form';
}

function uniqueSlug(title, exceptId = null) {
  const base = slugify(title);
  for (let i = 0; ; i += 1) {
    const slug = i ? `${base}-${i + 1}` : base;
    const taken = q.get('SELECT id FROM forms WHERE slug = ?', slug);
    if (!taken || taken.id === exceptId) return slug;
  }
}

// ─────────────────────────────────────────────────────────────
// Чтение
// ─────────────────────────────────────────────────────────────
const parseQuestion = (row) => ({
  ...row,
  required: !!row.required,
  options: JSON.parse(row.options || '[]'),
  settings: JSON.parse(row.settings || '{}'),
  visible_if: row.visible_if ? JSON.parse(row.visible_if) : null,
});

export const questionsOf = (formId) =>
  q.all('SELECT * FROM form_questions WHERE form_id = ? ORDER BY order_idx, id', Number(formId))
    .map(parseQuestion);

const decorate = (form) => {
  if (!form) return null;
  const responses = q.get(
    "SELECT COUNT(*) AS c FROM form_responses WHERE form_id = ? AND status = 'submitted'", form.id).c;
  return {
    ...form,
    is_anonymous: !!form.is_anonymous,
    one_per_user: !!form.one_per_user,
    show_progress: !!form.show_progress,
    responses,
    questions_count: q.get("SELECT COUNT(*) AS c FROM form_questions WHERE form_id = ? AND type != 'section'",
      form.id).c,
    is_open: isOpen(form),
  };
};

const SELECT_FORM = `SELECT f.*, u.full_name AS author_name, i.short_name AS author_institution
                     FROM forms f
                     LEFT JOIN users u ON u.id = f.created_by
                     LEFT JOIN institutions i ON i.id = u.institution_id`;

export const getForm = (id) => decorate(q.get(`${SELECT_FORM} WHERE f.id = ?`, Number(id)));
export const getFormBySlug = (slug) => decorate(q.get(`${SELECT_FORM} WHERE f.slug = ?`, String(slug)));

/** Форма со всем содержимым — то, что нужно и конструктору, и заполнению. */
export function formWithQuestions(id) {
  const form = getForm(id);
  return form ? { ...form, questions: questionsOf(form.id) } : null;
}

/**
 * Каталог. Сотрудник видит опубликованные формы и свои черновики; тот, кому
 * доверено управление всеми формами, — все.
 */
export function listForms({ user, status = null, mine = false, limit = 100 }) {
  const where = [];
  const args = [];
  if (status && FORM_STATUS[status]) { where.push('f.status = ?'); args.push(status); }
  if (mine) { where.push('f.created_by = ?'); args.push(user.id); }
  if (!can(user, 'form.admin') && !mine) {
    where.push("(f.status IN ('published','closed') OR f.created_by = ?)");
    args.push(user.id);
  }
  return q.all(`${SELECT_FORM} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                ORDER BY CASE f.status WHEN 'published' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END,
                         COALESCE(f.published_at, f.updated_at) DESC
                LIMIT ?`, ...args, Math.min(300, Number(limit) || 100))
    .map(decorate);
}

// ─────────────────────────────────────────────────────────────
// Доступ
// ─────────────────────────────────────────────────────────────
/** Открыта ли форма для ответов прямо сейчас. Срок закрывает её сам. */
export function isOpen(form) {
  if (!form || form.status !== 'published') return false;
  if (!form.closes_at) return true;
  return new Date(form.closes_at.replace(' ', 'T') + 'Z').getTime() > Date.now();
}

export const canEdit = (user, form) =>
  !!user && !!form && (can(user, 'form.admin') || (form.created_by === user.id && can(user, 'form.create')));

/** Результаты видит тот, кто ведёт форму: сводка по ответам — не публичные данные. */
export const canSeeResults = (user, form) => canEdit(user, form);

function mustEdit(user, form) {
  if (!form) throw new FormError('Форма не найдена');
  if (!canEdit(user, form)) {
    const e = new FormError('Форму может изменить только её автор');
    e.status = 403;
    throw e;
  }
}

// ─────────────────────────────────────────────────────────────
// Правка формы
// ─────────────────────────────────────────────────────────────
export function createForm({ title, description = null, user, ip = null }) {
  const name = String(title ?? '').trim();
  if (!name) throw new FormError('Укажите название формы');
  return tx(() => {
    const id = q.insert(`INSERT INTO forms (slug, title, description, created_by) VALUES (?,?,?,?)`,
      uniqueSlug(name), name.slice(0, 300), description ? String(description).trim() : null, user.id);
    logAction(user.id, 'form.create', 'form', id, { title: name }, ip);
    return formWithQuestions(id);
  });
}

const SETTABLE = {
  title:         (v) => String(v ?? '').trim().slice(0, 300) || null,
  description:   (v) => (v ? String(v).trim().slice(0, 4000) : null),
  closing_text:  (v) => (v ? String(v).trim().slice(0, 2000) : null),
  access:        (v) => (ACCESS_MODES[v] ? v : null),
  is_anonymous:  (v) => (v ? 1 : 0),
  one_per_user:  (v) => (v ? 1 : 0),
  show_progress: (v) => (v ? 1 : 0),
  closes_at:     (v) => (v ? String(v).slice(0, 19).replace('T', ' ') : null),
};

export function updateForm({ formId, patch, user, ip = null }) {
  const form = getForm(formId);
  mustEdit(user, form);

  const sets = [];
  const args = [];
  for (const [key, clean] of Object.entries(SETTABLE)) {
    if (!(key in patch)) continue;
    const value = clean(patch[key]);
    if (key === 'title' && value === null) throw new FormError('Название формы не может быть пустым');
    if (key === 'access' && value === null) throw new FormError('Неизвестный способ доступа к форме');
    sets.push(`${key} = ?`);
    args.push(value);
  }
  if (!sets.length) return formWithQuestions(form.id);

  // Ссылку на форму уже могли разослать, поэтому адрес переезжает только у
  // черновика: у опубликованной формы переименование сломало бы рассылку.
  if ('title' in patch && form.status === 'draft') {
    sets.push('slug = ?');
    args.push(uniqueSlug(SETTABLE.title(patch.title), form.id));
  }
  q.run(`UPDATE forms SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...args, form.id);
  logAction(user.id, 'form.update', 'form', form.id, patch, ip);
  return formWithQuestions(form.id);
}

/**
 * Сохранение структуры целиком.
 *
 * Вопросы сопоставляются по ключу, а не переписываются заново: ответ ссылается на
 * строку вопроса, и полная перезапись стёрла бы уже собранные ответы вместе с
 * вопросами. Удалённый вопрос уносит свои ответы намеренно — держать ответ на
 * вопрос, которого в форме больше нет, значит показывать его в сводке без текста.
 */
export function saveQuestions({ formId, questions, user, ip = null }) {
  const form = getForm(formId);
  mustEdit(user, form);
  const list = normalizeQuestions(questions);

  return tx(() => {
    const existing = new Map(
      q.all('SELECT id, key FROM form_questions WHERE form_id = ?', form.id).map((r) => [r.key, r.id]));
    const kept = new Set();

    list.forEach((qn, i) => {
      const payload = [
        qn.type, qn.title, qn.hint, qn.required ? 1 : 0,
        JSON.stringify(qn.options), JSON.stringify(qn.settings),
        qn.visible_if ? JSON.stringify(qn.visible_if) : null, i,
      ];
      const id = existing.get(qn.key);
      if (id) {
        q.run(`UPDATE form_questions SET type=?, title=?, hint=?, required=?, options=?, settings=?,
               visible_if=?, order_idx=? WHERE id=?`, ...payload, id);
        kept.add(id);
      } else {
        kept.add(q.insert(`INSERT INTO form_questions
          (form_id, key, type, title, hint, required, options, settings, visible_if, order_idx)
          VALUES (?,?,?,?,?,?,?,?,?,?)`, form.id, qn.key, ...payload));
      }
    });

    for (const id of existing.values()) {
      if (!kept.has(id)) q.run('DELETE FROM form_questions WHERE id = ?', id);
    }
    q.run("UPDATE forms SET updated_at = datetime('now') WHERE id = ?", form.id);
    logAction(user.id, 'form.questions', 'form', form.id, { count: list.length }, ip);
    return formWithQuestions(form.id);
  });
}

/** Что мешает опубликовать форму. Пустой список — можно публиковать. */
export function publishIssues(formId) {
  const questions = questionsOf(formId);
  const issues = [];
  const answerable = questions.filter((qn) => isAnswerable(qn.type));
  if (!answerable.length) issues.push('В форме нет ни одного вопроса');
  for (const qn of questions) {
    if (QUESTION_TYPES[qn.type]?.options && !qn.options.length && !qn.settings?.allow_other) {
      issues.push(`«${qn.title.slice(0, 50)}»: не заданы варианты ответа`);
    }
  }
  try { normalizeQuestions(questions); }
  catch (e) { issues.push(e.message); }
  return issues;
}

export function publishForm({ formId, user, ip = null }) {
  const form = getForm(formId);
  mustEdit(user, form);
  const issues = publishIssues(form.id);
  if (issues.length) throw new FormError('Форму нельзя опубликовать', issues);

  q.run(`UPDATE forms SET status = 'published',
         published_at = COALESCE(published_at, datetime('now')), updated_at = datetime('now')
         WHERE id = ?`, form.id);
  logAction(user.id, 'form.publish', 'form', form.id, null, ip);
  emit('form.published', { subjectType: 'form', subjectId: form.id, actorId: user.id,
                           from: form.status, to: 'published', title: form.title });
  return formWithQuestions(form.id);
}

export function setStatus({ formId, status, user, ip = null }) {
  const form = getForm(formId);
  mustEdit(user, form);
  if (!FORM_STATUS[status]) throw new FormError('Неизвестное состояние формы');
  if (status === 'published') return publishForm({ formId, user, ip });
  // Возврат опубликованной формы в черновик закрыт: собранные ответы относятся к
  // тому составу вопросов, который люди видели, и правка «на черновую» разошлась
  // бы с ними молча. Сбор останавливают закрытием.
  if (status === 'draft' && form.responses > 0) {
    throw new FormError('По форме уже есть ответы — её можно только закрыть');
  }
  q.run("UPDATE forms SET status = ?, updated_at = datetime('now') WHERE id = ?", status, form.id);
  logAction(user.id, `form.${status}`, 'form', form.id, null, ip);
  emit('form.status', { subjectType: 'form', subjectId: form.id, actorId: user.id,
                        from: form.status, to: status });
  return formWithQuestions(form.id);
}

/** Копия формы вместе с вопросами — обычный способ завести похожий опрос. */
export function duplicateForm({ formId, user, ip = null }) {
  const source = formWithQuestions(formId);
  if (!source) throw new FormError('Форма не найдена');
  if (!can(user, 'form.create')) {
    const e = new FormError('Недостаточно прав'); e.status = 403; throw e;
  }
  return tx(() => {
    const title = `${source.title} — копия`;
    const id = q.insert(`INSERT INTO forms
      (slug, title, description, closing_text, access, is_anonymous, one_per_user,
       show_progress, created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`,
      uniqueSlug(title), title.slice(0, 300), source.description, source.closing_text,
      source.access, source.is_anonymous ? 1 : 0, source.one_per_user ? 1 : 0,
      source.show_progress ? 1 : 0, user.id);
    for (const qn of source.questions) {
      q.run(`INSERT INTO form_questions
        (form_id, key, type, title, hint, required, options, settings, visible_if, order_idx)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
        id, qn.key, qn.type, qn.title, qn.hint, qn.required ? 1 : 0,
        JSON.stringify(qn.options), JSON.stringify(qn.settings),
        qn.visible_if ? JSON.stringify(qn.visible_if) : null, qn.order_idx);
    }
    logAction(user.id, 'form.duplicate', 'form', id, { source: source.id }, ip);
    return formWithQuestions(id);
  });
}

export function deleteForm({ formId, user, ip = null }) {
  const form = getForm(formId);
  mustEdit(user, form);
  q.run('DELETE FROM forms WHERE id = ?', form.id);
  logAction(user.id, 'form.delete', 'form', form.id, { title: form.title, responses: form.responses }, ip);
  return { deleted: form.id };
}

// ─────────────────────────────────────────────────────────────
// Ответы
// ─────────────────────────────────────────────────────────────
const answersOf = (responseId) =>
  q.all(`SELECT a.*, qn.key FROM form_answers a
         JOIN form_questions qn ON qn.id = a.question_id
         WHERE a.response_id = ?`, Number(responseId));

/** Ответы одной анкеты в виде «ключ вопроса → значение» — для показа и правки. */
export function answersByKey(responseId) {
  const out = {};
  for (const a of answersOf(responseId)) out[a.key] = a.value === null ? null : JSON.parse(a.value);
  return out;
}

export function myResponse(formId, user) {
  if (!user) return null;
  const row = q.get(`SELECT * FROM form_responses WHERE form_id = ? AND respondent_id = ?
                     ORDER BY id DESC LIMIT 1`, Number(formId), user.id);
  return row ? { ...row, answers: answersByKey(row.id) } : null;
}

function assertFillable(form, user, source) {
  if (!form) throw new FormError('Форма не найдена');
  if (form.status === 'draft') throw new FormError('Форма ещё не опубликована');
  if (!isOpen(form)) throw new FormError('Сбор ответов по этой форме закрыт');
  if (source === 'link' && form.access !== 'link') {
    const e = new FormError('Эта форма доступна только участникам платформы');
    e.status = 403;
    throw e;
  }
  if (source !== 'link' && !can(user, 'form.fill')) {
    const e = new FormError('Недостаточно прав для заполнения формы');
    e.status = 403;
    throw e;
  }
}

/**
 * Отправка ответа.
 *
 * Ответы проверяются здесь целиком, а не по одному полю на клиенте: браузеру
 * доверять нельзя, а условия показа делают проверку неочевидной — обязательным
 * считается только то, что респондент действительно видел.
 */
export function submitResponse({ form, user = null, answers = {}, source = 'portal', ip = null,
                                 responseId = null }) {
  assertFillable(form, user, source);
  const questions = questionsOf(form.id);
  const { values, errors } = parseAnswers(questions, answers);
  if (errors.length) throw new FormError('Проверьте заполнение формы', errors);

  const anonymous = !!form.is_anonymous || source === 'link';
  const respondent = anonymous ? null : user?.id ?? null;

  if (respondent && form.one_per_user) {
    const already = q.get(`SELECT id FROM form_responses
                           WHERE form_id = ? AND respondent_id = ? AND status = 'submitted'`,
      form.id, respondent);
    if (already && already.id !== Number(responseId)) {
      const e = new FormError('Вы уже отвечали на эту форму');
      e.status = 409;
      throw e;
    }
  }

  const byId = new Map(questions.map((qn) => [qn.key, qn.id]));
  return tx(() => {
    // Черновик собственного ответа превращается в отправленный, а не плодит второй.
    // Чужой ответ так не перезаписать: строка ищется вместе с автором, и без него —
    // а это ответ по ссылке или анонимный — не ищется вовсе.
    const draft = respondent
      ? q.get(`SELECT * FROM form_responses
               WHERE form_id = ? AND respondent_id = ? AND (id = ? OR status = 'draft')
               ORDER BY CASE status WHEN 'draft' THEN 0 ELSE 1 END LIMIT 1`,
        form.id, respondent, responseId ? Number(responseId) : -1)
      : null;

    let id = draft?.id;
    if (id) {
      q.run(`UPDATE form_responses SET status = 'submitted', submitted_at = datetime('now'),
             updated_at = datetime('now'), source = ? WHERE id = ?`, source, id);
      q.run('DELETE FROM form_answers WHERE response_id = ?', id);
    } else {
      id = q.insert(`INSERT INTO form_responses
        (form_id, respondent_id, institution_id, status, source, submitted_at)
        VALUES (?,?,?,'submitted',?,datetime('now'))`,
        form.id, respondent, anonymous ? null : user?.institution_id ?? null, source);
    }
    writeAnswers(id, values, byId);

    logAction(respondent, 'form.respond', 'form', form.id, { response: id, source }, ip);
    emit('form.responded', { subjectType: 'form', subjectId: form.id, actorId: respondent,
                             responseId: id, source });
    return { id, form_id: form.id, status: 'submitted', answered: values.size };
  });
}

/** Черновик ответа — «сохранить и вернуться позже». Обязательность не проверяется. */
export function saveResponseDraft({ form, user, answers = {}, ip = null }) {
  assertFillable(form, user, 'portal');
  if (!user) throw new FormError('Черновик ответа доступен только после входа в систему');
  if (form.is_anonymous) throw new FormError('У анонимной формы черновик ответа не сохраняется');

  const questions = questionsOf(form.id);
  const { values } = parseAnswers(questions, answers, { requireAll: false });
  const byId = new Map(questions.map((qn) => [qn.key, qn.id]));

  return tx(() => {
    const sent = q.get(`SELECT id FROM form_responses
                        WHERE form_id = ? AND respondent_id = ? AND status = 'submitted'`,
      form.id, user.id);
    if (sent && form.one_per_user) throw new FormError('Ответ по этой форме уже отправлен');

    const existing = q.get(`SELECT * FROM form_responses
                            WHERE form_id = ? AND respondent_id = ? AND status = 'draft'`,
      form.id, user.id);
    const id = existing?.id ?? q.insert(`INSERT INTO form_responses
      (form_id, respondent_id, institution_id, status, source) VALUES (?,?,?,'draft','portal')`,
      form.id, user.id, user.institution_id ?? null);
    q.run("UPDATE form_responses SET updated_at = datetime('now') WHERE id = ?", id);
    q.run('DELETE FROM form_answers WHERE response_id = ?', id);
    writeAnswers(id, values, byId);
    return { id, status: 'draft', answered: values.size };
  });
}

function writeAnswers(responseId, values, byId) {
  for (const [key, parsed] of values) {
    q.run(`INSERT INTO form_answers (response_id, question_id, value, value_num, value_text)
           VALUES (?,?,?,?,?)`,
      responseId, byId.get(key), JSON.stringify(parsed.value), parsed.num, parsed.text);
  }
}

// ─────────────────────────────────────────────────────────────
// Результаты
// ─────────────────────────────────────────────────────────────
/**
 * Сводка по форме: распределение ответов по каждому вопросу и охват.
 *
 * Показанным считается вопрос, который респондент видел, а не тот, на который
 * ответил: для условного вопроса «сколько из тех, кому он показывался» — это
 * совсем другое число, и без него доля отвечающих врёт.
 */
export function results(formId) {
  const form = getForm(formId);
  if (!form) throw new FormError('Форма не найдена');
  const questions = questionsOf(form.id);
  const responses = q.all(
    "SELECT * FROM form_responses WHERE form_id = ? AND status = 'submitted' ORDER BY id", form.id);

  const perQuestion = new Map(questions.map((qn) => [qn.key, []]));
  const shown = new Map(questions.map((qn) => [qn.key, 0]));
  for (const r of responses) {
    const answers = answersByKey(r.id);
    for (const key of visibleKeys(questions, answers)) shown.set(key, (shown.get(key) ?? 0) + 1);
    for (const [key, value] of Object.entries(answers)) {
      if (value !== null && perQuestion.has(key)) perQuestion.get(key).push(value);
    }
  }

  return {
    form,
    responses: responses.length,
    first_at: responses[0]?.submitted_at ?? null,
    last_at: responses.at(-1)?.submitted_at ?? null,
    questions: questions.filter((qn) => isAnswerable(qn.type)).map((qn) => ({
      key: qn.key, title: qn.title, type: qn.type, kind: kindOf(qn.type),
      required: qn.required, conditional: !!qn.visible_if,
      shown: shown.get(qn.key) ?? 0,
      ...summarize(qn, perQuestion.get(qn.key) ?? []),
    })),
    sections: questions.filter((qn) => qn.type === 'section')
      .map((qn) => ({ key: qn.key, title: qn.title, order_idx: qn.order_idx })),
  };
}

/** Ответы построчно — таблица на экране и выгрузка получают одно и то же. */
export function responseTable(formId) {
  const form = getForm(formId);
  if (!form) throw new FormError('Форма не найдена');
  const questions = questionsOf(form.id).filter((qn) => isAnswerable(qn.type));
  const rows = q.all(`SELECT r.*, u.full_name AS respondent_name, i.short_name AS institution
                      FROM form_responses r
                      LEFT JOIN users u ON u.id = r.respondent_id
                      LEFT JOIN institutions i ON i.id = r.institution_id
                      WHERE r.form_id = ? AND r.status = 'submitted'
                      ORDER BY r.submitted_at, r.id`, form.id);

  return {
    form,
    columns: questions.map((qn) => ({ key: qn.key, title: qn.title, type: qn.type })),
    rows: rows.map((r) => {
      const texts = {};
      for (const a of answersOf(r.id)) texts[a.key] = a.value_text;
      return {
        id: r.id,
        submitted_at: r.submitted_at,
        respondent: form.is_anonymous ? null : r.respondent_name,
        institution: form.is_anonymous ? null : r.institution,
        source: r.source,
        values: texts,
      };
    }),
  };
}

/**
 * Выгрузка в CSV с разделителем «;» и BOM — так файл открывается Excel как есть.
 *
 * Ответ, начинающийся со знака равенства или плюса, табличный редактор принимает
 * за формулу. По форме, открытой ссылкой, отвечает кто угодно, поэтому такие
 * значения выгружаются с ведущим апострофом — они останутся текстом.
 */
export function toCsv(formId) {
  const { form, columns, rows } = responseTable(formId);
  const cell = (v) => {
    const text = String(v ?? '');
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const head = ['№', 'Отправлен', ...(form.is_anonymous ? [] : ['Респондент', 'Учреждение']),
                ...columns.map((c) => c.title)];
  const body = rows.map((r, i) => [
    i + 1, r.submitted_at,
    ...(form.is_anonymous ? [] : [r.respondent ?? 'без входа', r.institution ?? '']),
    ...columns.map((c) => r.values[c.key] ?? ''),
  ]);
  return '﻿' + [head, ...body].map((line) => line.map(cell).join(';')).join('\n');
}
