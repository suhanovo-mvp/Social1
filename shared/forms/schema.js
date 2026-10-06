// Схема формы: типы вопросов, условия показа и разбор ответов.
//
// Модуль общий для браузера и сервера — как раскладка BPMN. Причина та же и здесь
// важнее: правила показа вопроса и проверки ответа должны совпадать до буквы. Если
// клиент считает вопрос скрытым, а сервер — обязательным, человек упирается в
// ошибку, которую не видит на экране; если наоборот — в выгрузку попадают ответы
// на вопросы, которых респонденту не показывали. Одно описание снимает оба случая.
//
// Значение ответа хранится нормализованным: строка, число, дата или объект выбора.
// Разбор всегда идёт через answerOf(), поэтому в базу не попадает то, что пришло
// из браузера в исходном виде.

export class FormError extends Error {
  constructor(message, details) { super(message); this.status = 400; this.details = details; }
}

// ─────────────────────────────────────────────────────────────
// Типы вопросов
// ─────────────────────────────────────────────────────────────
// kind определяет, как хранится и как сводится ответ:
//   layout — не ответ вовсе, а разделитель блока;
//   text   — строка; number — число; date — дата;
//   choice — один вариант из списка; multi — несколько вариантов.
export const QUESTION_TYPES = {
  section: {
    title: 'Раздел', kind: 'layout', icon: 'section',
    hint: 'Заголовок блока с пояснением — вопросов не задаёт, делит форму на части',
  },
  short_text: {
    title: 'Короткий текст', kind: 'text', icon: 'text',
    hint: 'Одна строка: фамилия, должность, название',
  },
  long_text: {
    title: 'Длинный текст', kind: 'text', icon: 'paragraph', multiline: true,
    hint: 'Развёрнутый ответ в несколько предложений',
  },
  radio: {
    title: 'Один вариант', kind: 'choice', icon: 'radio', options: true, other: true,
    hint: 'Список, из которого выбирают один ответ',
  },
  checkbox: {
    title: 'Несколько вариантов', kind: 'multi', icon: 'checkbox', options: true, other: true,
    hint: 'Список, из которого выбирают сколько угодно ответов',
  },
  select: {
    title: 'Выпадающий список', kind: 'choice', icon: 'select', options: true, other: true,
    hint: 'То же, что «Один вариант», но список длинный — например справочник учреждений',
  },
  scale: {
    title: 'Шкала', kind: 'number', icon: 'scale',
    hint: 'Оценка от и до с подписями у краёв — например актуальность от 1 до 5',
  },
  number: {
    title: 'Число', kind: 'number', icon: 'number',
    hint: 'Числовой ответ: количество, часы, доля',
  },
  date: {
    title: 'Дата', kind: 'date', icon: 'date',
    hint: 'Календарная дата',
  },
  email: {
    title: 'Электронная почта', kind: 'text', icon: 'email',
    hint: 'Адрес почты — проверяется при отправке',
  },
  phone: {
    title: 'Телефон', kind: 'text', icon: 'phone',
    hint: 'Номер телефона или внутренний добавочный',
  },
};

export const kindOf = (type) => QUESTION_TYPES[type]?.kind ?? null;
export const hasOptions = (type) => !!QUESTION_TYPES[type]?.options;
export const isAnswerable = (type) => !!QUESTION_TYPES[type] && QUESTION_TYPES[type].kind !== 'layout';

/** Код варианта «свой ответ». Заведён константой: на него ссылаются и условия. */
export const OTHER = '__other__';

export const SCALE_LIMITS = { min: 0, max: 10, maxSpan: 10 };

// ─────────────────────────────────────────────────────────────
// Условия показа
// ─────────────────────────────────────────────────────────────
// Условие читается как предложение: «показать, если в вопросе 7 оценка не меньше 3».
// Сравнения выбраны под то, что реально спрашивают в анкетах, и намеренно не
// расширены до языка выражений: условие должно оставаться понятным тому, кто
// собирает форму, а не только тому, кто пишет код.
export const CONDITION_OPS = {
  eq:       { title: 'равно',            kinds: ['text', 'number', 'date', 'choice'], value: true },
  ne:       { title: 'не равно',         kinds: ['text', 'number', 'date', 'choice'], value: true },
  in:       { title: 'один из',          kinds: ['choice', 'multi', 'number'],        value: 'list' },
  gte:      { title: 'не меньше',        kinds: ['number'],                            value: true },
  lte:      { title: 'не больше',        kinds: ['number'],                            value: true },
  contains: { title: 'среди выбранных',  kinds: ['multi'],                             value: true },
  answered: { title: 'есть ответ',       kinds: ['text', 'number', 'date', 'choice', 'multi'], value: false },
  empty:    { title: 'нет ответа',       kinds: ['text', 'number', 'date', 'choice', 'multi'], value: false },
};

/** Ответ на один вопрос в виде, удобном для сравнения: число, строка или список кодов. */
function comparable(question, answer) {
  if (answer === undefined || answer === null) return null;
  switch (kindOf(question.type)) {
    case 'number': return typeof answer === 'number' ? answer : null;
    case 'multi': {
      const codes = [...(answer.choices ?? [])];
      if (answer.other) codes.push(OTHER);
      return codes.length ? codes : null;
    }
    case 'choice': return answer.choice ?? null;
    default: return answer === '' ? null : answer;
  }
}

/** Выполнено ли одно правило. Ответ на скрытый вопрос сюда не попадает. */
function ruleHolds(rule, question, answer) {
  const op = CONDITION_OPS[rule.cmp];
  if (!op || !question) return false;
  const actual = comparable(question, answer);
  switch (rule.cmp) {
    case 'answered': return actual !== null;
    case 'empty':    return actual === null;
    case 'eq':       return actual !== null && String(actual) === String(rule.value);
    case 'ne':       return actual === null || String(actual) !== String(rule.value);
    case 'gte':      return typeof actual === 'number' && actual >= Number(rule.value);
    case 'lte':      return typeof actual === 'number' && actual <= Number(rule.value);
    case 'in': {
      const list = (Array.isArray(rule.value) ? rule.value : [rule.value]).map(String);
      if (Array.isArray(actual)) return actual.some((c) => list.includes(String(c)));
      return actual !== null && list.includes(String(actual));
    }
    case 'contains':
      return Array.isArray(actual) && actual.map(String).includes(String(rule.value));
    default: return false;
  }
}

/**
 * Показывать ли вопрос при таком наборе ответов.
 * Ответы передаются уже очищенными от скрытых вопросов — см. visibleKeys().
 */
export function isVisible(question, answers, byKey) {
  const cond = question.visible_if;
  if (!cond || !cond.rules?.length) return true;
  const holds = (r) => ruleHolds(r, byKey.get(r.q), answers[r.q]);
  return cond.op === 'any' ? cond.rules.some(holds) : cond.rules.every(holds);
}

/**
 * Какие вопросы видны при таком наборе ответов.
 *
 * Проход идёт по порядку, и ответ скрытого вопроса дальше не учитывается: иначе
 * цепочка «вопрос 9 виден при оценке 3+, вопрос 10 виден при ответе на 9» уцелела
 * бы после того, как респондент понизил оценку, — на экране вопроса нет, а условие
 * по нему всё ещё срабатывает. Условие вправе ссылаться только назад, это
 * проверяется при сохранении структуры, поэтому одного прохода достаточно.
 */
export function visibleKeys(questions, answers = {}) {
  const byKey = new Map(questions.map((qn) => [qn.key, qn]));
  const effective = {};
  const visible = new Set();
  for (const qn of questions) {
    if (!isVisible(qn, effective, byKey)) continue;
    visible.add(qn.key);
    if (answers[qn.key] !== undefined) effective[qn.key] = answers[qn.key];
  }
  return visible;
}

/** Понятная запись условия — для конструктора и карточки вопроса. */
export function describeCondition(question, byKey) {
  const cond = question.visible_if;
  if (!cond?.rules?.length) return '';
  const parts = cond.rules.map((r) => {
    const target = byKey.get(r.q);
    const name = target ? `«${target.title}»` : `вопрос ${r.q}`;
    const op = CONDITION_OPS[r.cmp]?.title ?? r.cmp;
    if (!CONDITION_OPS[r.cmp]?.value) return `${name}: ${op}`;
    const values = (Array.isArray(r.value) ? r.value : [r.value])
      .map((v) => optionLabel(target, v) ?? v).join(', ');
    return `${name} ${op} ${values}`;
  });
  return parts.join(cond.op === 'any' ? ' или ' : ' и ');
}

export function optionLabel(question, code) {
  if (!question) return null;
  if (String(code) === OTHER) return 'Другое';
  return (question.options ?? []).find((o) => o.code === String(code))?.label ?? null;
}

// ─────────────────────────────────────────────────────────────
// Структура формы
// ─────────────────────────────────────────────────────────────
const KEY_RX = /^[a-zA-Z][\w-]{0,39}$/;
const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Свободный ключ вопроса: q1, q2, … Ключ переживает правку текста вопроса. */
export function nextKey(questions, prefix = 'q') {
  const taken = new Set(questions.map((qn) => qn.key));
  for (let i = 1; ; i += 1) if (!taken.has(`${prefix}${i}`)) return `${prefix}${i}`;
}

/** Свободный код варианта в пределах вопроса. */
export function nextOptionCode(options, prefix = 'o') {
  const taken = new Set((options ?? []).map((o) => o.code));
  for (let i = 1; ; i += 1) if (!taken.has(`${prefix}${i}`)) return `${prefix}${i}`;
}

/**
 * Варианты из произвольного вида (строки или объекты) — в нормальный.
 *
 * Заданные коды разбираются первым проходом, свободные раздаются вторым: иначе
 * вариант без кода мог занять «o1», который ниже по списку уже занят явно, — и
 * условие показа, ссылающееся на этот код, сработало бы не на том варианте.
 */
export function normalizeOptions(raw) {
  const items = (raw ?? [])
    .map((item) => ({
      label: String(typeof item === 'string' ? item : item.label ?? '').trim(),
      code: typeof item === 'object' && item?.code ? String(item.code) : null,
    }))
    .filter((item) => item.label);

  const taken = items.filter((i) => i.code).map((i) => ({ code: i.code }));
  return items.map((item) => {
    if (item.code) return { code: item.code, label: item.label };
    const code = nextOptionCode(taken);
    taken.push({ code });
    return { code, label: item.label };
  });
}

const CLEAN_SETTINGS = {
  scale: (s) => ({
    min: Number.isFinite(+s.min) ? Math.round(+s.min) : 1,
    max: Number.isFinite(+s.max) ? Math.round(+s.max) : 5,
    min_label: s.min_label ? String(s.min_label).slice(0, 80) : null,
    max_label: s.max_label ? String(s.max_label).slice(0, 80) : null,
  }),
  number: (s) => ({
    min: s.min === null || s.min === undefined || s.min === '' ? null : Number(s.min),
    max: s.max === null || s.max === undefined || s.max === '' ? null : Number(s.max),
    unit: s.unit ? String(s.unit).slice(0, 40) : null,
  }),
};

/** Один вопрос из того, что прислал конструктор, — в вид, пригодный для хранения. */
export function normalizeQuestion(raw, index, existing = []) {
  const type = String(raw.type ?? '');
  if (!QUESTION_TYPES[type]) throw new FormError(`Неизвестный тип вопроса «${type}»`);

  const key = raw.key && KEY_RX.test(String(raw.key)) ? String(raw.key) : nextKey(existing);
  const title = String(raw.title ?? '').trim();
  if (!title) throw new FormError(`Вопрос ${index + 1}: не заполнен текст вопроса`);

  const settings = { ...(raw.settings ?? {}) };
  if (QUESTION_TYPES[type].other) settings.allow_other = !!settings.allow_other;
  if (settings.placeholder) settings.placeholder = String(settings.placeholder).slice(0, 120);
  const cleaned = CLEAN_SETTINGS[type]?.(settings);

  const question = {
    key,
    type,
    title: title.slice(0, 500),
    hint: raw.hint ? String(raw.hint).trim().slice(0, 1000) : null,
    required: isAnswerable(type) ? !!raw.required : false,
    options: hasOptions(type) ? normalizeOptions(raw.options) : [],
    settings: cleaned ? { ...settings, ...cleaned } : settings,
    visible_if: normalizeCondition(raw.visible_if),
    order_idx: index,
  };
  checkQuestion(question, index);
  return question;
}

function normalizeCondition(raw) {
  if (!raw || !Array.isArray(raw.rules) || !raw.rules.length) return null;
  const rules = raw.rules
    .filter((r) => r && r.q && CONDITION_OPS[r.cmp])
    .map((r) => {
      const spec = CONDITION_OPS[r.cmp].value;
      if (!spec) return { q: String(r.q), cmp: String(r.cmp) };
      const value = spec === 'list' && !Array.isArray(r.value) ? [r.value] : r.value;
      // Правило без значения не выполнится никогда, и вопрос молча исчезнет из
      // формы — недонастроенное условие честнее не сохранить
      const empty = value === '' || value === null || value === undefined
        || (Array.isArray(value) && !value.filter((v) => v !== '' && v !== null).length);
      if (empty) throw new FormError('В условии показа не выбрано значение');
      return { q: String(r.q), cmp: String(r.cmp), value };
    });
  return rules.length ? { op: raw.op === 'any' ? 'any' : 'all', rules } : null;
}

function checkQuestion(qn, index) {
  const meta = QUESTION_TYPES[qn.type];
  const where = `Вопрос ${index + 1} («${qn.title.slice(0, 40)}»)`;
  if (meta.options && !qn.options.length && !qn.settings.allow_other) {
    throw new FormError(`${where}: не задан ни один вариант ответа`);
  }
  if (qn.type === 'scale') {
    const { min, max } = qn.settings;
    if (max <= min) throw new FormError(`${where}: верхняя граница шкалы должна быть больше нижней`);
    if (min < SCALE_LIMITS.min || max > SCALE_LIMITS.max) {
      throw new FormError(`${where}: шкала допустима в пределах от ${SCALE_LIMITS.min} до ${SCALE_LIMITS.max}`);
    }
    if (max - min > SCALE_LIMITS.maxSpan) {
      throw new FormError(`${where}: слишком длинная шкала — не больше ${SCALE_LIMITS.maxSpan} делений`);
    }
  }
  if (qn.type === 'number') {
    const { min, max } = qn.settings;
    if (min !== null && max !== null && Number(max) < Number(min)) {
      throw new FormError(`${where}: верхняя граница меньше нижней`);
    }
  }
}

/**
 * Проверка структуры целиком: ключи, ссылки условий и их направление.
 * Возвращает нормализованные вопросы — сохранять следует именно их.
 */
export function normalizeQuestions(rawList) {
  const list = [];
  for (const [i, raw] of (rawList ?? []).entries()) {
    list.push(normalizeQuestion(raw, i, list));
  }
  const seen = new Set();
  for (const qn of list) {
    if (seen.has(qn.key)) throw new FormError(`Ключ вопроса «${qn.key}» встречается дважды`);
    seen.add(qn.key);
  }
  // Условие смотрит только назад: вперёд смотреть нечем — ответа ещё нет, а
  // взаимные ссылки двух вопросов дали бы форму, которую нельзя показать.
  const before = new Set();
  const byKey = new Map(list.map((qn) => [qn.key, qn]));
  for (const [i, qn] of list.entries()) {
    for (const rule of qn.visible_if?.rules ?? []) {
      const target = byKey.get(rule.q);
      if (!target) throw new FormError(`Вопрос ${i + 1}: условие ссылается на вопрос «${rule.q}», которого нет в форме`);
      if (!before.has(rule.q)) {
        throw new FormError(`Вопрос ${i + 1}: условие ссылается на вопрос «${target.title.slice(0, 40)}», который идёт ниже по форме`);
      }
      if (!isAnswerable(target.type)) {
        throw new FormError(`Вопрос ${i + 1}: условие ссылается на раздел, а у раздела нет ответа`);
      }
      const allowed = CONDITION_OPS[rule.cmp].kinds;
      if (!allowed.includes(kindOf(target.type))) {
        throw new FormError(`Вопрос ${i + 1}: сравнение «${CONDITION_OPS[rule.cmp].title}» не подходит `
          + `к вопросу «${target.title.slice(0, 40)}»`);
      }
    }
    before.add(qn.key);
  }
  return list;
}

// ─────────────────────────────────────────────────────────────
// Ответы
// ─────────────────────────────────────────────────────────────
const isEmptyRaw = (v) => v === undefined || v === null || v === ''
  || (Array.isArray(v) && !v.length);

/**
 * Ответ на один вопрос: нормализованное значение, число для сводки и текст для
 * выгрузки. Пустой ответ возвращается как empty — обязательность проверяется выше,
 * потому что зависит от того, показан ли вопрос.
 */
export function answerOf(question, raw) {
  const meta = QUESTION_TYPES[question.type];
  if (!meta || meta.kind === 'layout') return null;
  if (isEmptyRaw(raw)) return { empty: true, value: null, num: null, text: null };
  const where = `«${String(question.title).slice(0, 60)}»`;

  switch (meta.kind) {
    case 'text': {
      const text = String(raw).trim();
      if (!text) return { empty: true, value: null, num: null, text: null };
      if (question.type === 'email' && !EMAIL_RX.test(text)) {
        throw new FormError(`${where}: адрес почты записан неверно`);
      }
      if (text.length > 5000) throw new FormError(`${where}: ответ длиннее 5000 знаков`);
      return { empty: false, value: text, num: null, text };
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).replace(',', '.'));
      if (!Number.isFinite(n)) throw new FormError(`${where}: ожидается число`);
      const s = question.settings ?? {};
      if (question.type === 'scale') {
        if (n < s.min || n > s.max || !Number.isInteger(n)) {
          throw new FormError(`${where}: оценка вне шкалы от ${s.min} до ${s.max}`);
        }
      } else {
        if (s.min !== null && s.min !== undefined && n < s.min) throw new FormError(`${where}: значение меньше ${s.min}`);
        if (s.max !== null && s.max !== undefined && n > s.max) throw new FormError(`${where}: значение больше ${s.max}`);
      }
      return { empty: false, value: n, num: n, text: String(n) };
    }
    case 'date': {
      const text = String(raw).slice(0, 10);
      if (!DATE_RX.test(text) || Number.isNaN(Date.parse(text))) {
        throw new FormError(`${where}: дата записана неверно`);
      }
      return { empty: false, value: text, num: null, text };
    }
    case 'choice': {
      const picked = typeof raw === 'object' ? raw : { choice: raw };
      const code = picked.choice === undefined || picked.choice === null ? null : String(picked.choice);
      const other = picked.other ? String(picked.other).trim().slice(0, 1000) : null;
      if (!code) return { empty: true, value: null, num: null, text: null };
      if (code === OTHER) {
        if (!question.settings?.allow_other) throw new FormError(`${where}: свой ответ не предусмотрен`);
        if (!other) return { empty: true, value: null, num: null, text: null };
        return { empty: false, value: { choice: OTHER, other }, num: null, text: other };
      }
      const opt = (question.options ?? []).find((o) => o.code === code);
      if (!opt) throw new FormError(`${where}: выбран вариант, которого нет в списке`);
      return { empty: false, value: { choice: code, other: null }, num: null, text: opt.label };
    }
    case 'multi': {
      const picked = Array.isArray(raw) ? { choices: raw } : (raw ?? {});
      const codes = [...new Set((picked.choices ?? []).map(String))];
      const other = picked.other ? String(picked.other).trim().slice(0, 1000) : null;
      const labels = [];
      const kept = [];
      for (const code of codes) {
        if (code === OTHER) continue;
        const opt = (question.options ?? []).find((o) => o.code === code);
        if (!opt) throw new FormError(`${where}: выбран вариант, которого нет в списке`);
        kept.push(code);
        labels.push(opt.label);
      }
      const withOther = codes.includes(OTHER) || !!other;
      if (withOther) {
        if (!question.settings?.allow_other) throw new FormError(`${where}: свой ответ не предусмотрен`);
        if (other) labels.push(other);
      }
      if (!kept.length && !other) return { empty: true, value: null, num: null, text: null };
      return {
        empty: false,
        value: { choices: kept, other: other || null },
        num: kept.length + (other ? 1 : 0),
        text: labels.join('; '),
      };
    }
    default: return null;
  }
}

/**
 * Разбор всего набора ответов.
 *
 * Ответы на скрытые вопросы отбрасываются молча: это не ошибка респондента, а
 * след того, что он передумал — выбрал оценку 4, ответил на уточняющие вопросы,
 * затем вернулся и поставил 1. Хранить эти ответы нельзя: в сводке они выглядели
 * бы ответами тех, кому вопрос вообще не показывали.
 *
 * @returns {{ values: Map<string, object>, visible: Set<string>, errors: Array }}
 */
export function parseAnswers(questions, raw = {}, { requireAll = true } = {}) {
  const byKey = new Map(questions.map((qn) => [qn.key, qn]));
  const values = new Map();
  const errors = [];
  const effective = {};
  const visible = new Set();

  for (const qn of questions) {
    if (!isVisible(qn, effective, byKey)) continue;
    visible.add(qn.key);
    if (!isAnswerable(qn.type)) continue;

    let parsed;
    try {
      parsed = answerOf(qn, raw[qn.key]);
    } catch (e) {
      errors.push({ key: qn.key, message: e.message });
      continue;
    }
    if (parsed.empty) {
      if (requireAll && qn.required) {
        errors.push({ key: qn.key, message: `«${qn.title.slice(0, 60)}»: ответ обязателен` });
      }
      continue;
    }
    values.set(qn.key, parsed);
    effective[qn.key] = parsed.value;
  }
  return { values, visible, errors };
}

// ─────────────────────────────────────────────────────────────
// Сводка
// ─────────────────────────────────────────────────────────────
/**
 * Сводка по одному вопросу: распределение для выбора, среднее для чисел, тексты
 * как есть. Считается на месте, а не запросом: вариант хранится кодом, и разбирать
 * его в SQL пришлось бы разбором JSON — так только запутаннее.
 *
 * @param answers значения ответов (то, что лежит в values), в порядке ответов
 */
export function summarize(question, answers) {
  const kind = kindOf(question.type);
  const answered = answers.length;
  if (kind === 'choice' || kind === 'multi') {
    const counts = new Map((question.options ?? []).map((o) => [o.code, 0]));
    let other = 0;
    const otherTexts = [];
    for (const a of answers) {
      const codes = kind === 'multi' ? a.choices ?? [] : (a.choice === OTHER ? [] : [a.choice]);
      for (const c of codes) counts.set(c, (counts.get(c) ?? 0) + 1);
      const otherText = kind === 'multi' ? a.other : (a.choice === OTHER ? a.other : null);
      if (otherText) { other += 1; otherTexts.push(otherText); }
    }
    const rows = (question.options ?? []).map((o) => ({
      code: o.code, label: o.label, count: counts.get(o.code) ?? 0,
      share: answered ? (counts.get(o.code) ?? 0) / answered : 0,
    }));
    if (question.settings?.allow_other) {
      rows.push({ code: OTHER, label: 'Другое', count: other, share: answered ? other / answered : 0,
                  texts: otherTexts });
    }
    return { kind, answered, rows };
  }
  if (kind === 'number') {
    const nums = answers.filter((a) => typeof a === 'number');
    const sum = nums.reduce((s, n) => s + n, 0);
    const sorted = [...nums].sort((a, b) => a - b);
    const buckets = new Map();
    for (const n of nums) buckets.set(n, (buckets.get(n) ?? 0) + 1);
    return {
      kind, answered,
      avg: nums.length ? sum / nums.length : null,
      median: sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null,
      min: sorted[0] ?? null, max: sorted.at(-1) ?? null,
      rows: [...buckets].sort((a, b) => a[0] - b[0])
        .map(([value, count]) => ({ code: String(value), label: String(value), count,
                                    share: nums.length ? count / nums.length : 0 })),
    };
  }
  return { kind, answered, texts: answers.map(String) };
}
