// Каталог разработчиков ИИ-решений: кому можно поручить разработку и внедрение.
//
// Разработчики трёх видов — внешние вендоры, внутренние команды ДТСЗН и команды,
// которые может выделить ДИТ, — живут в одной таблице: сравнивать их приходится
// между собой, и раздельные реестры сделали бы это сравнение невозможным.
//
// Реальных данных пока нет, поэтому модуль рассчитан прежде всего на ввод: у
// карточки считается заполненность, а давно не обновлявшиеся сведения помечаются.
import { q, tx } from './db.js';
import { HttpError } from './http.js';
import { logAction } from './audit.js';
import { notify } from './notify.js';
import { grantRole, revokeRole, roleTitle, PROVIDER_ROLES } from './auth.js';

// ─────────────────────────────────────────────────────────────
// Справочники
// ─────────────────────────────────────────────────────────────
export const PROVIDER_KINDS = {
  external: { title: 'Внешний вендор', plural: 'Внешние вендоры' },
  internal: { title: 'Внутренняя команда', plural: 'Внутренние команды' },
  dit:      { title: 'Команда ДИТ', plural: 'Команды ДИТ' },
};

// Статус — путь разработчика от первого упоминания до привлечения к работе
export const PROVIDER_STATUS = {
  new:             { title: 'Новый', badge: 'outline' },
  screening:       { title: 'На проверке', badge: 'warn' },
  qualified:       { title: 'Квалифицирован', badge: 'info' },
  engaged:         { title: 'Привлечён к работе', badge: 'ok' },
  not_recommended: { title: 'Не рекомендован', badge: 'danger' },
  archived:        { title: 'Архив', badge: 'outline' },
};

export const AVAILABILITY = {
  available: 'Свободен',
  limited:   'Загружен частично',
  busy:      'Загружен полностью',
  unknown:   'Нет данных',
};

export const COMPETENCIES = {
  llm:     'Языковые модели и ассистенты',
  rag:     'Поиск по документам (RAG)',
  nlp:     'Обработка текстов',
  speech:  'Распознавание и синтез речи',
  cv:      'Компьютерное зрение',
  ocr:     'Распознавание документов',
  predict: 'Прогнозная аналитика',
  recsys:  'Рекомендательные системы',
  chatbot: 'Чат-боты и голосовые помощники',
  rpa:     'Роботизация процессов (RPA)',
  data:    'Инженерия данных',
  mlops:   'MLOps и инфраструктура ИИ',
};

export const DOMAINS = {
  social:    'Социальная защита',
  gov:       'Госуправление и госуслуги',
  health:    'Здравоохранение',
  education: 'Образование',
  employment:'Занятость и кадры',
  finance:   'Финансы',
  city:      'Городское хозяйство',
};

// Требования, без которых разработчика в госсекторе обычно не привлечь
export const COMPLIANCE = {
  ru_registry:   'ПО в реестре отечественного ПО',
  pdn:           'Работа с персональными данными (152-ФЗ)',
  fstec:         'Лицензии ФСТЭК, аттестованные решения',
  on_prem:       'Развёртывание в закрытом контуре',
  gov_contracts: 'Опыт госзаказа (44-ФЗ, 223-ФЗ)',
  msp:           'Субъект МСП',
};

export const SOLUTION_KINDS = {
  product:  'Готовый продукт',
  platform: 'Платформа',
  model:    'Модель или API',
  service:  'Заказная разработка',
  tech:     'Технология, методика',
};

export const MATURITY = {
  prototype:  'Прототип',
  pilot:      'Пилотное внедрение',
  production: 'Промышленная эксплуатация',
};

export const LICENSES = {
  proprietary: 'Проприетарная',
  open_source: 'Открытый код',
  saas:        'Облачный сервис (SaaS)',
};

export const NOTE_KINDS = {
  meeting: 'Встреча',
  call:    'Звонок',
  letter:  'Письмо',
  rfi:     'Запрос информации',
  demo:    'Демонстрация',
  note:    'Заметка',
};

// Сведения старше полугода считаются требующими сверки
export const STALE_DAYS = 180;

export const SORTS = {
  updated:     'Недавно обновлённые',
  name:        'По названию',
  rating:      'По оценке',
  cases:       'По числу проектов',
  solutions:   'По числу решений',
  team:        'По размеру команды',
  completeness:'По заполненности',
};

export const dictionaries = () => ({
  kinds: PROVIDER_KINDS, statuses: PROVIDER_STATUS, availability: AVAILABILITY,
  competencies: COMPETENCIES, domains: DOMAINS, compliance: COMPLIANCE,
  solution_kinds: SOLUTION_KINDS, maturity: MATURITY, licenses: LICENSES,
  note_kinds: NOTE_KINDS, sorts: SORTS, stale_days: STALE_DAYS,
});

// ─────────────────────────────────────────────────────────────
// Проверка ввода
// ─────────────────────────────────────────────────────────────
const JSON_FIELDS = ['competencies', 'domains', 'compliance', 'tags'];

const text = (v, max = 4000) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

const int = (v, { min = -Infinity, max = Infinity, label = 'Значение' } = {}) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${label}: недопустимое значение`);
  return n;
};

const oneOf = (v, dict, label) => {
  if (!(v in dict)) throw new HttpError(400, `${label}: неизвестное значение «${v}»`);
  return v;
};

// Ссылка выводится в интерфейсе атрибутом href — схема javascript: там недопустима
function url(v) {
  const s = text(v, 500);
  if (!s) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  if (!/^https?:\/\/[^\s]+$/i.test(withScheme)) throw new HttpError(400, 'Ссылка должна начинаться с http:// или https://');
  return withScheme;
}

function email(v) {
  const s = text(v, 200);
  if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new HttpError(400, 'Адрес электронной почты указан неверно');
  return s;
}

function inn(v) {
  const s = text(v, 20)?.replace(/\s/g, '') || null;
  if (s && !/^(\d{10}|\d{12})$/.test(s)) throw new HttpError(400, 'ИНН состоит из 10 цифр у организации или 12 у предпринимателя');
  return s;
}

/** Список кодов из справочника: неизвестные коды отбрасываются, а не сохраняются. */
const codes = (v, dict) => [...new Set((Array.isArray(v) ? v : []).filter((c) => c in dict))];

/** Свободные метки технологий: без пустых и повторов, регистр первого написания. */
function tags(v) {
  const out = new Map();
  for (const raw of Array.isArray(v) ? v : String(v ?? '').split(',')) {
    const t = String(raw).trim().replace(/\s+/g, ' ').slice(0, 40);
    if (t && !out.has(t.toLowerCase())) out.set(t.toLowerCase(), t);
  }
  return [...out.values()].slice(0, 30);
}

const parse = (row) => {
  if (!row) return row;
  for (const f of JSON_FIELDS) if (f in row) { try { row[f] = JSON.parse(row[f] || '[]'); } catch { row[f] = []; } }
  return row;
};

// ─────────────────────────────────────────────────────────────
// Заполненность и актуальность
// ─────────────────────────────────────────────────────────────
// Вес пункта — насколько без него нельзя принять решение о привлечении
export const COMPLETENESS = [
  ['description',  15, 'Описание',         (p) => !!p.description],
  ['competencies', 15, 'Компетенции',      (p) => p.competencies.length > 0],
  ['contact',      15, 'Контактное лицо',  (p) => !!(p.contact_name && (p.contact_email || p.contact_phone))],
  ['cases',        15, 'Портфолио',        (p) => p.cases_count > 0],
  ['solutions',    10, 'Каталог решений',  (p) => p.solutions_count > 0],
  ['compliance',   10, 'Соответствие требованиям', (p) => p.compliance.length > 0],
  ['requisites',   10, 'Реквизиты',        (p) => p.kind === 'external' ? !!p.inn : !!p.org_unit],
  ['team',          5, 'Размер команды',   (p) => !!p.team_size],
  ['website',       5, 'Сайт',             (p) => p.kind !== 'external' || !!p.website],
];

export function completeness(p) {
  let score = 0;
  const missing = [];
  for (const [, weight, title, ok] of COMPLETENESS) {
    if (ok(p)) score += weight; else missing.push(title);
  }
  return { score, missing };
}

const daysSince = (ts) => ts ? Math.floor((Date.now() - Date.parse(ts.replace(' ', 'T') + 'Z')) / 864e5) : null;

function decorate(p) {
  parse(p);
  const c = completeness(p);
  p.completeness = c.score;
  p.missing = c.missing;
  p.stale = daysSince(p.updated_at) > STALE_DAYS;
  p.rating = p.rating === null || p.rating === undefined ? null : Math.round(p.rating * 10) / 10;
  return p;
}

// ─────────────────────────────────────────────────────────────
// Список с фильтрами и сортировкой
// ─────────────────────────────────────────────────────────────
const LIST_SQL = `
  SELECT p.*, o.full_name AS owner_name,
    (SELECT COUNT(*) FROM provider_cases c WHERE c.provider_id = p.id) AS cases_count,
    (SELECT COUNT(*) FROM provider_cases c WHERE c.provider_id = p.id AND c.public_sector = 1) AS public_cases,
    (SELECT COUNT(*) FROM provider_solutions s WHERE s.provider_id = p.id) AS solutions_count,
    (SELECT COUNT(*) FROM provider_reviews r WHERE r.provider_id = p.id) AS reviews_count,
    (SELECT AVG((r.quality + r.deadlines + r.communication) / 3.0)
       FROM provider_reviews r WHERE r.provider_id = p.id) AS rating,
    (SELECT MAX(n.happened_at) FROM provider_notes n WHERE n.provider_id = p.id) AS last_contact
  FROM providers p
  LEFT JOIN users o ON o.id = p.owner_id`;

const haystack = (p) => [p.name, p.legal_name, p.inn, p.org_unit, p.description, p.city,
  ...p.tags, ...p.competencies.map((c) => COMPETENCIES[c])].join(' ').toLowerCase();

/**
 * Каталог держит сотни записей, а не миллионы: фильтровать по спискам в JSON
 * проще и надёжнее в коде, чем собирать для этого запрос.
 */
export function listProviders(f = {}) {
  let rows = q.all(LIST_SQL).map(decorate);
  const counts = { all: 0, external: 0, internal: 0, dit: 0 };

  // Архив по умолчанию скрыт — его показывают, только когда его выбрали явно
  if (f.status) rows = rows.filter((p) => p.status === f.status);
  else if (!f.includeArchived) rows = rows.filter((p) => p.status !== 'archived');

  if (f.q) {
    const words = String(f.q).toLowerCase().split(/\s+/).filter(Boolean);
    rows = rows.filter((p) => { const h = haystack(p); return words.every((w) => h.includes(w)); });
  }
  const hasAll = (list, need) => need.every((c) => list.includes(c));
  if (f.competencies?.length) rows = rows.filter((p) => hasAll(p.competencies, f.competencies));
  if (f.compliance?.length) rows = rows.filter((p) => hasAll(p.compliance, f.compliance));
  if (f.domain) rows = rows.filter((p) => p.domains.includes(f.domain));
  if (f.availability) rows = rows.filter((p) => p.availability === f.availability);
  if (f.tag) rows = rows.filter((p) => p.tags.some((t) => t.toLowerCase() === f.tag.toLowerCase()));
  if (f.publicSector) rows = rows.filter((p) => p.public_cases > 0);
  if (f.stale) rows = rows.filter((p) => p.stale);
  if (f.pending) rows = rows.filter((p) => p.profile_status === 'pending');

  // Счётчики по видам — после всех фильтров, кроме самого вида: вкладки показывают,
  // сколько найдётся, если переключиться
  for (const p of rows) { counts.all++; counts[p.kind]++; }
  if (f.kind) rows = rows.filter((p) => p.kind === f.kind);

  const byName = (a, b) => a.name.localeCompare(b.name, 'ru');
  const desc = (key) => (a, b) => (b[key] ?? -1) - (a[key] ?? -1) || byName(a, b);
  const sorters = {
    name: byName,
    updated: (a, b) => b.updated_at.localeCompare(a.updated_at) || byName(a, b),
    rating: desc('rating'),
    cases: desc('cases_count'),
    solutions: desc('solutions_count'),
    team: desc('team_size'),
    completeness: desc('completeness'),
  };
  rows.sort(sorters[f.sort] || sorters.updated);
  if (f.dir === 'asc' && f.sort !== 'name') rows.reverse();
  if (f.dir === 'desc' && f.sort === 'name') rows.reverse();

  return { providers: rows, counts };
}

/** Метки технологий, уже встречающиеся в каталоге, — подсказки при вводе. */
export function knownTags() {
  const seen = new Map();
  const rows = [
    ...q.all('SELECT tags FROM providers'),
    ...q.all('SELECT tags FROM provider_solutions'),
    ...q.all('SELECT tags FROM provider_cases'),
  ];
  for (const r of rows) {
    for (const t of JSON.parse(r.tags || '[]')) {
      const k = t.toLowerCase();
      seen.set(k, { tag: seen.get(k)?.tag ?? t, count: (seen.get(k)?.count ?? 0) + 1 });
    }
  }
  return [...seen.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'ru'));
}

// ─────────────────────────────────────────────────────────────
// Карточка
// ─────────────────────────────────────────────────────────────
export function getProvider(id) {
  const p = q.get(`${LIST_SQL} WHERE p.id = ?`, Number(id));
  if (!p) return null;
  decorate(p);
  p.cases = q.all('SELECT * FROM provider_cases WHERE provider_id = ? ORDER BY year DESC, id DESC', p.id).map(parse);
  p.solutions = q.all('SELECT * FROM provider_solutions WHERE provider_id = ? ORDER BY name', p.id).map(parse);
  p.reviews = q.all(`SELECT r.*, u.full_name AS author_name FROM provider_reviews r
                     JOIN users u ON u.id = r.author_id WHERE r.provider_id = ?
                     ORDER BY r.updated_at DESC`, p.id);
  p.notes = q.all(`SELECT n.*, u.full_name AS author_name FROM provider_notes n
                   LEFT JOIN users u ON u.id = n.author_id WHERE n.provider_id = ?
                   ORDER BY n.happened_at DESC, n.id DESC`, p.id);
  const cu = p.created_by && q.get('SELECT full_name FROM users WHERE id = ?', p.created_by);
  const uu = p.updated_by && q.get('SELECT full_name FROM users WHERE id = ?', p.updated_by);
  p.created_by_name = cu?.full_name ?? null;
  p.updated_by_name = uu?.full_name ?? null;
  p.members = listMembers(p.id);
  const ch = p.profile_changed_by && q.get('SELECT full_name FROM users WHERE id = ?', p.profile_changed_by);
  p.profile_changed_by_name = ch?.full_name ?? null;
  return p;
}

/**
 * Карточка глазами представителя разработчика. Внутренняя кухня каталога —
 * оценки коллег, журнал контактов, статус отбора, ориентир стоимости и кто ведёт
 * контакт — ему не показывается: это сведения о нём, а не для него.
 */
export function representativeView(p) {
  const hidden = ['reviews', 'notes', 'rating', 'reviews_count', 'price_band', 'status',
    'owner_id', 'owner_name', 'last_contact', 'is_demo', 'created_by', 'updated_by'];
  const out = { ...p };
  for (const k of hidden) delete out[k];
  return out;
}

const mustExist = (id) => {
  const p = q.get('SELECT id, name, kind FROM providers WHERE id = ?', Number(id));
  if (!p) throw new HttpError(404, 'Разработчик не найден');
  return p;
};

function providerFields(b, kind) {
  const name = text(b.name, 200);
  if (!name) throw new HttpError(400, 'Укажите название разработчика');
  const external = kind === 'external';
  return {
    name,
    legal_name: external ? text(b.legal_name, 300) : null,
    inn: external ? inn(b.inn) : null,
    org_unit: external ? null : text(b.org_unit, 300),
    description: text(b.description),
    website: url(b.website),
    city: text(b.city, 100),
    team_size: int(b.team_size, { min: 1, max: 100000, label: 'Размер команды' }),
    founded_year: int(b.founded_year, { min: 1900, max: new Date().getFullYear(), label: 'Год основания' }),
    contact_name: text(b.contact_name, 200),
    contact_role: text(b.contact_role, 200),
    contact_email: email(b.contact_email),
    contact_phone: text(b.contact_phone, 50),
    status: oneOf(b.status ?? 'new', PROVIDER_STATUS, 'Статус'),
    availability: oneOf(b.availability ?? 'unknown', AVAILABILITY, 'Загрузка'),
    price_band: int(b.price_band, { min: 1, max: 3, label: 'Уровень стоимости' }),
    competencies: JSON.stringify(codes(b.competencies, COMPETENCIES)),
    domains: JSON.stringify(codes(b.domains, DOMAINS)),
    // Признак МСП есть только у организаций
    compliance: JSON.stringify(codes(b.compliance, COMPLIANCE).filter((c) => external || c !== 'msp')),
    tags: JSON.stringify(tags(b.tags)),
    owner_id: b.owner_id ? Number(b.owner_id) : null,
  };
}

/** Похожие по названию или совпадающие по ИНН — чтобы одного вендора не завели дважды. */
export function findDuplicates({ name, inn: innValue, excludeId = null }) {
  const out = [];
  const cleanInn = innValue ? String(innValue).replace(/\s/g, '') : null;
  const norm = (s) => String(s || '').toLowerCase()
    .replace(/["«»'.,]/g, ' ')
    // \b в регулярных выражениях JS знает только латиницу — границы задаются пробелами
    .replace(/(^|\s)(ооо|ао|пао|зао|ип|гбу|гку|ано)(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const target = norm(name);
  for (const p of q.all('SELECT id, name, kind, inn FROM providers WHERE id IS NOT ?', excludeId)) {
    if (cleanInn && p.inn === cleanInn) out.push({ ...p, reason: 'inn' });
    else if (target && norm(p.name) === target) out.push({ ...p, reason: 'name' });
  }
  return out;
}

export function createProvider(b, user, ip) {
  const kind = oneOf(b.kind, PROVIDER_KINDS, 'Вид разработчика');
  const f = providerFields(b, kind);
  const dup = findDuplicates({ name: f.name, inn: f.inn }).find((d) => d.reason === 'inn');
  if (dup) throw new HttpError(409, `Разработчик с таким ИНН уже есть в каталоге: «${dup.name}»`, { id: dup.id });
  const cols = Object.keys(f);
  const id = q.insert(
    `INSERT INTO providers (kind, ${cols.join(', ')}, created_by, updated_by)
     VALUES (?, ${cols.map(() => '?').join(', ')}, ?, ?)`,
    kind, ...Object.values(f), user.id, user.id);
  logAction(user.id, 'provider.create', 'provider', id, { kind, name: f.name }, ip);
  return getProvider(id);
}

export function updateProvider(id, b, user, ip) {
  const cur = mustExist(id);
  const kind = b.kind ? oneOf(b.kind, PROVIDER_KINDS, 'Вид разработчика') : cur.kind;
  const f = providerFields(b, kind);
  const dup = findDuplicates({ name: f.name, inn: f.inn, excludeId: cur.id }).find((d) => d.reason === 'inn');
  if (dup) throw new HttpError(409, `Разработчик с таким ИНН уже есть в каталоге: «${dup.name}»`, { id: dup.id });
  q.run(`UPDATE providers SET kind = ?, ${Object.keys(f).map((c) => `${c} = ?`).join(', ')},
         updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
    kind, ...Object.values(f), user.id, cur.id);
  logAction(user.id, 'provider.update', 'provider', cur.id, { name: f.name, status: f.status }, ip);
  return getProvider(cur.id);
}

/** Быстрая смена статуса из карточки — без открытия всей формы. */
export function setStatus(id, status, user, ip) {
  const cur = mustExist(id);
  oneOf(status, PROVIDER_STATUS, 'Статус');
  q.run(`UPDATE providers SET status = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
    status, user.id, cur.id);
  logAction(user.id, 'provider.status', 'provider', cur.id, { status }, ip);
  return getProvider(cur.id);
}

export function deleteProvider(id, user, ip) {
  const cur = mustExist(id);
  q.run('DELETE FROM providers WHERE id = ?', cur.id);
  logAction(user.id, 'provider.delete', 'provider', cur.id, { name: cur.name }, ip);
}

/** Любая правка вложенных сведений освежает карточку — по ней судят об актуальности. */
const touch = (providerId, user) =>
  q.run(`UPDATE providers SET updated_by = ?, updated_at = datetime('now') WHERE id = ?`, user.id, providerId);

// ─────────────────────────────────────────────────────────────
// Портфолио
// ─────────────────────────────────────────────────────────────
function caseFields(b) {
  const title = text(b.title, 300);
  if (!title) throw new HttpError(400, 'Укажите название проекта');
  return {
    title,
    customer: text(b.customer, 300),
    year: int(b.year, { min: 1990, max: new Date().getFullYear() + 1, label: 'Год' }),
    description: text(b.description),
    result: text(b.result, 2000),
    tags: JSON.stringify(tags(b.tags)),
    link: url(b.link),
    public_sector: b.public_sector ? 1 : 0,
  };
}

export function saveCase(providerId, caseId, b, user, ip) {
  const p = mustExist(providerId);
  const f = caseFields(b);
  return tx(() => {
    let id = caseId ? Number(caseId) : null;
    if (id) {
      const cur = q.get('SELECT id FROM provider_cases WHERE id = ? AND provider_id = ?', id, p.id);
      if (!cur) throw new HttpError(404, 'Проект портфолио не найден');
      q.run(`UPDATE provider_cases SET ${Object.keys(f).map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
        ...Object.values(f), id);
    } else {
      id = q.insert(`INSERT INTO provider_cases (provider_id, ${Object.keys(f).join(', ')})
                     VALUES (?, ${Object.keys(f).map(() => '?').join(', ')})`, p.id, ...Object.values(f));
    }
    touch(p.id, user);
    logAction(user.id, caseId ? 'provider.case.update' : 'provider.case.create', 'provider', p.id, { case_id: id, title: f.title }, ip);
    return parse(q.get('SELECT * FROM provider_cases WHERE id = ?', id));
  });
}

export function deleteCase(providerId, caseId, user, ip) {
  const p = mustExist(providerId);
  const r = q.run('DELETE FROM provider_cases WHERE id = ? AND provider_id = ?', Number(caseId), p.id);
  if (!r.changes) throw new HttpError(404, 'Проект портфолио не найден');
  touch(p.id, user);
  logAction(user.id, 'provider.case.delete', 'provider', p.id, { case_id: Number(caseId) }, ip);
}

// ─────────────────────────────────────────────────────────────
// Каталог решений и технологий
// ─────────────────────────────────────────────────────────────
function solutionFields(b) {
  const name = text(b.name, 300);
  if (!name) throw new HttpError(400, 'Укажите название решения');
  return {
    name,
    kind: oneOf(b.kind ?? 'product', SOLUTION_KINDS, 'Тип решения'),
    maturity: oneOf(b.maturity ?? 'production', MATURITY, 'Зрелость'),
    license: b.license ? oneOf(b.license, LICENSES, 'Лицензия') : null,
    description: text(b.description),
    competencies: JSON.stringify(codes(b.competencies, COMPETENCIES)),
    tags: JSON.stringify(tags(b.tags)),
    in_registry: b.in_registry ? 1 : 0,
    price_note: text(b.price_note, 500),
    link: url(b.link),
  };
}

export function saveSolution(providerId, solutionId, b, user, ip) {
  const p = mustExist(providerId);
  const f = solutionFields(b);
  return tx(() => {
    let id = solutionId ? Number(solutionId) : null;
    if (id) {
      const cur = q.get('SELECT id FROM provider_solutions WHERE id = ? AND provider_id = ?', id, p.id);
      if (!cur) throw new HttpError(404, 'Решение не найдено');
      q.run(`UPDATE provider_solutions SET ${Object.keys(f).map((c) => `${c} = ?`).join(', ')},
             updated_at = datetime('now') WHERE id = ?`, ...Object.values(f), id);
    } else {
      id = q.insert(`INSERT INTO provider_solutions (provider_id, ${Object.keys(f).join(', ')})
                     VALUES (?, ${Object.keys(f).map(() => '?').join(', ')})`, p.id, ...Object.values(f));
    }
    touch(p.id, user);
    logAction(user.id, solutionId ? 'provider.solution.update' : 'provider.solution.create', 'provider', p.id, { solution_id: id, name: f.name }, ip);
    return parse(q.get('SELECT * FROM provider_solutions WHERE id = ?', id));
  });
}

export function deleteSolution(providerId, solutionId, user, ip) {
  const p = mustExist(providerId);
  const r = q.run('DELETE FROM provider_solutions WHERE id = ? AND provider_id = ?', Number(solutionId), p.id);
  if (!r.changes) throw new HttpError(404, 'Решение не найдено');
  touch(p.id, user);
  logAction(user.id, 'provider.solution.delete', 'provider', p.id, { solution_id: Number(solutionId) }, ip);
}

/** Сквозной каталог: решения всех разработчиков, найденные по потребности, а не по вендору. */
export function listSolutions(f = {}) {
  let rows = q.all(`SELECT s.*, p.name AS provider_name, p.kind AS provider_kind, p.status AS provider_status
                    FROM provider_solutions s JOIN providers p ON p.id = s.provider_id
                    WHERE p.status <> 'archived'`).map(parse);
  if (f.q) {
    const words = String(f.q).toLowerCase().split(/\s+/).filter(Boolean);
    rows = rows.filter((s) => {
      const h = [s.name, s.description, s.provider_name, ...s.tags,
                 ...s.competencies.map((c) => COMPETENCIES[c])].join(' ').toLowerCase();
      return words.every((w) => h.includes(w));
    });
  }
  if (f.competency) rows = rows.filter((s) => s.competencies.includes(f.competency));
  if (f.kind) rows = rows.filter((s) => s.kind === f.kind);
  if (f.maturity) rows = rows.filter((s) => s.maturity === f.maturity);
  if (f.providerKind) rows = rows.filter((s) => s.provider_kind === f.providerKind);
  if (f.registry) rows = rows.filter((s) => s.in_registry);
  if (f.tag) rows = rows.filter((s) => s.tags.some((t) => t.toLowerCase() === f.tag.toLowerCase()));
  // Зрелые решения первыми: их можно брать в работу без разработки
  const rank = { production: 0, pilot: 1, prototype: 2 };
  rows.sort((a, b) => rank[a.maturity] - rank[b.maturity] || a.name.localeCompare(b.name, 'ru'));
  return rows;
}

// ─────────────────────────────────────────────────────────────
// Оценки и журнал взаимодействий
// ─────────────────────────────────────────────────────────────
export function saveReview(providerId, b, user, ip) {
  const p = mustExist(providerId);
  const score = (v, label) => int(v, { min: 1, max: 5, label }) ?? (() => { throw new HttpError(400, `${label}: поставьте оценку от 1 до 5`); })();
  const f = {
    quality: score(b.quality, 'Качество результата'),
    deadlines: score(b.deadlines, 'Соблюдение сроков'),
    communication: score(b.communication, 'Взаимодействие'),
    context: text(b.context, 300),
    comment: text(b.comment, 2000),
  };
  q.run(`INSERT INTO provider_reviews (provider_id, author_id, quality, deadlines, communication, context, comment)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(provider_id, author_id) DO UPDATE SET quality = excluded.quality,
           deadlines = excluded.deadlines, communication = excluded.communication,
           context = excluded.context, comment = excluded.comment, updated_at = datetime('now')`,
    p.id, user.id, f.quality, f.deadlines, f.communication, f.context, f.comment);
  logAction(user.id, 'provider.review', 'provider', p.id, { quality: f.quality, deadlines: f.deadlines, communication: f.communication }, ip);
  return getProvider(p.id).reviews;
}

export function deleteReview(providerId, user, ip) {
  const p = mustExist(providerId);
  q.run('DELETE FROM provider_reviews WHERE provider_id = ? AND author_id = ?', p.id, user.id);
  logAction(user.id, 'provider.review.delete', 'provider', p.id, null, ip);
}

export function addNote(providerId, b, user, ip) {
  const p = mustExist(providerId);
  const body = text(b.body, 4000);
  if (!body) throw new HttpError(400, 'Запись журнала пуста');
  const kind = oneOf(b.kind ?? 'note', NOTE_KINDS, 'Вид записи');
  const day = text(b.happened_at, 10);
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new HttpError(400, 'Дата указана неверно');
  const id = q.insert(`INSERT INTO provider_notes (provider_id, author_id, kind, body, happened_at)
                       VALUES (?,?,?,?, COALESCE(?, date('now')))`, p.id, user.id, kind, body, day);
  touch(p.id, user);
  logAction(user.id, 'provider.note', 'provider', p.id, { note_id: id, kind }, ip);
  return q.get('SELECT * FROM provider_notes WHERE id = ?', id);
}

export function deleteNote(providerId, noteId, user, canModerate, ip) {
  const p = mustExist(providerId);
  const note = q.get('SELECT * FROM provider_notes WHERE id = ? AND provider_id = ?', Number(noteId), p.id);
  if (!note) throw new HttpError(404, 'Запись не найдена');
  if (note.author_id !== user.id && !canModerate) throw new HttpError(403, 'Удалить можно только свою запись');
  q.run('DELETE FROM provider_notes WHERE id = ?', note.id);
  logAction(user.id, 'provider.note.delete', 'provider', p.id, { note_id: note.id }, ip);
}

// ─────────────────────────────────────────────────────────────
// Представители разработчика
// ─────────────────────────────────────────────────────────────
// Технологический профиль — то, что компания знает о себе лучше модератора.
// Реквизиты, контакты, статус отбора и ориентир стоимости остаются за модератором.
export const PROFILE_FIELDS = ['description', 'competencies', 'domains', 'compliance', 'tags',
  'availability', 'team_size'];

export function listMembers(providerId) {
  return q.all(`SELECT m.user_id, m.added_at, u.full_name, u.email, u.position,
                       i.short_name AS institution, a.full_name AS added_by_name
                FROM provider_members m JOIN users u ON u.id = m.user_id
                LEFT JOIN institutions i ON i.id = u.institution_id
                LEFT JOIN users a ON a.id = m.added_by
                WHERE m.provider_id = ? ORDER BY u.full_name`, Number(providerId));
}

export const isMember = (user, providerId) => !!(user && q.get(
  'SELECT 1 FROM provider_members WHERE provider_id = ? AND user_id = ?', Number(providerId), user.id));

/** Карточки, которые ведёт представитель: обычно одна, но может быть и несколько. */
export function membershipsOf(user) {
  return q.all(`SELECT p.id, p.name, p.kind, p.profile_status FROM provider_members m
                JOIN providers p ON p.id = m.provider_id WHERE m.user_id = ? ORDER BY p.name`, user.id);
}

export function addMember(providerId, userId, by, ip) {
  const p = mustExist(providerId);
  const u = q.get('SELECT id, full_name FROM users WHERE id = ? AND is_active = 1', Number(userId));
  if (!u) throw new HttpError(404, 'Участник не найден');
  q.run(`INSERT INTO provider_members (provider_id, user_id, added_by) VALUES (?,?,?)
         ON CONFLICT(provider_id, user_id) DO NOTHING`, p.id, u.id, by.id);
  notify(u.id, 'provider.member', `Вы представитель «${p.name}» в каталоге разработчиков ИИ-решений`,
    'Заполните технологический профиль, портфолио и решения компании. Изменения проверит модератор каталога.',
    { provider_id: p.id });
  logAction(by.id, 'provider.member.add', 'provider', p.id, { user_id: u.id }, ip);
  return listMembers(p.id);
}

export function removeMember(providerId, userId, by, ip) {
  const p = mustExist(providerId);
  q.run('DELETE FROM provider_members WHERE provider_id = ? AND user_id = ?', p.id, Number(userId));
  logAction(by.id, 'provider.member.remove', 'provider', p.id, { user_id: Number(userId) }, ip);
  return listMembers(p.id);
}

/**
 * Правка представителя помечает карточку «ожидает проверки» и сообщает тому, кто
 * ведёт контакт. До подтверждения сведения видны в каталоге с этой пометкой —
 * прятать их незачем, но и выдавать за проверенные нельзя.
 */
export function markProfileChanged(providerId, user, what) {
  const p = q.get('SELECT id, name, owner_id, profile_status FROM providers WHERE id = ?', Number(providerId));
  const note = text(what, 200);
  q.run(`UPDATE providers SET profile_status = 'pending', profile_changed_at = datetime('now'),
         profile_changed_by = ?, profile_note = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
    user.id, note, user.id, p.id);
  // Одно уведомление на серию правок: пока модератор не подтвердил, повторять незачем
  if (p.profile_status !== 'pending' && p.owner_id) {
    notify(p.owner_id, 'provider.pending', `Представитель обновил карточку «${p.name}»`,
      `${user.full_name}: ${note || 'изменён технологический профиль'}. Проверьте и подтвердите сведения.`,
      { provider_id: p.id });
  }
}

export function updateProfile(id, b, user, ip) {
  const cur = mustExist(id);
  const f = {
    description: text(b.description),
    competencies: JSON.stringify(codes(b.competencies, COMPETENCIES)),
    domains: JSON.stringify(codes(b.domains, DOMAINS)),
    compliance: JSON.stringify(codes(b.compliance, COMPLIANCE).filter((c) => cur.kind === 'external' || c !== 'msp')),
    tags: JSON.stringify(tags(b.tags)),
    availability: oneOf(b.availability ?? 'unknown', AVAILABILITY, 'Загрузка'),
    team_size: int(b.team_size, { min: 1, max: 100000, label: 'Размер команды' }),
  };
  tx(() => {
    q.run(`UPDATE providers SET ${Object.keys(f).map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
      ...Object.values(f), cur.id);
    markProfileChanged(cur.id, user, 'изменён технологический профиль');
  });
  logAction(user.id, 'provider.profile', 'provider', cur.id, null, ip);
  return getProvider(cur.id);
}

export function confirmProfile(id, user, ip) {
  const cur = mustExist(id);
  q.run(`UPDATE providers SET profile_status = 'confirmed', profile_note = NULL,
         updated_by = ?, updated_at = datetime('now') WHERE id = ?`, user.id, cur.id);
  for (const m of listMembers(cur.id)) {
    notify(m.user_id, 'provider.confirmed', `Сведения о «${cur.name}» подтверждены`,
      'Модератор каталога проверил изменения — они отображаются без пометки о проверке.', { provider_id: cur.id });
  }
  logAction(user.id, 'provider.profile.confirm', 'provider', cur.id, null, ip);
  return getProvider(cur.id);
}

// ─────────────────────────────────────────────────────────────
// Сводка и выгрузка
// ─────────────────────────────────────────────────────────────
export function summary() {
  const { providers } = listProviders({ includeArchived: false });
  const byKind = Object.fromEntries(Object.keys(PROVIDER_KINDS).map((k) => [k, 0]));
  const byCompetency = Object.fromEntries(Object.keys(COMPETENCIES).map((k) => [k, 0]));
  for (const p of providers) {
    byKind[p.kind]++;
    for (const c of p.competencies) byCompetency[c]++;
  }
  return {
    total: providers.length,
    by_kind: byKind,
    by_competency: byCompetency,
    engaged: providers.filter((p) => p.status === 'engaged').length,
    stale: providers.filter((p) => p.stale).length,
    pending: providers.filter((p) => p.profile_status === 'pending').length,
    incomplete: providers.filter((p) => p.completeness < 60).length,
    solutions: q.get(`SELECT COUNT(*) AS c FROM provider_solutions s JOIN providers p ON p.id = s.provider_id
                      WHERE p.status <> 'archived'`).c,
    // Компетенции, которых в каталоге нет ни у кого, — куда искать разработчиков
    gaps: Object.entries(byCompetency).filter(([, n]) => n === 0).map(([c]) => c),
  };
}

// Ячейка, начинающаяся с =, +, - или @, в табличном редакторе исполняется как формула
const csvCell = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function exportCsv(filters) {
  const { providers } = listProviders(filters);
  const head = ['Вид', 'Название', 'Юрлицо', 'ИНН', 'Подразделение', 'Статус', 'Загрузка', 'Город',
    'Команда, чел.', 'Компетенции', 'Отраслевой опыт', 'Соответствие требованиям', 'Технологии',
    'Проектов', 'Решений', 'Оценка', 'Заполненность, %', 'Контакт', 'Эл. почта', 'Телефон', 'Сайт', 'Обновлено'];
  const lines = providers.map((p) => [
    PROVIDER_KINDS[p.kind].title, p.name, p.legal_name, p.inn, p.org_unit,
    PROVIDER_STATUS[p.status].title, AVAILABILITY[p.availability], p.city, p.team_size,
    p.competencies.map((c) => COMPETENCIES[c]).join(', '),
    p.domains.map((c) => DOMAINS[c]).join(', '),
    p.compliance.map((c) => COMPLIANCE[c]).join(', '),
    p.tags.join(', '), p.cases_count, p.solutions_count, p.rating, p.completeness,
    p.contact_name, p.contact_email, p.contact_phone, p.website, p.updated_at,
  ].map(csvCell).join(';'));
  // Разделитель «;» и BOM — иначе русский Excel откроет файл одной колонкой кракозябр
  return '﻿' + [head.join(';'), ...lines].join('\r\n');
}

// ─────────────────────────────────────────────────────────────
// Доступ к каталогу
// ─────────────────────────────────────────────────────────────
/**
 * Кто и как видит каталог. Доступ бывает двух происхождений: выдан ролью каталога
 * конкретному человеку либо следует из основной роли. Отозвать здесь можно только
 * первый — второй меняется в настройках ролей платформы.
 */
export function accessList() {
  const granted = q.all(`
    SELECT ur.user_id, ur.role_code, ur.granted_at, u.full_name, u.email, u.role AS main_role,
           i.short_name AS institution, g.full_name AS granted_by_name
    FROM user_roles ur
    JOIN users u ON u.id = ur.user_id
    LEFT JOIN institutions i ON i.id = u.institution_id
    LEFT JOIN users g ON g.id = ur.granted_by
    WHERE ur.role_code IN (${PROVIDER_ROLES.map(() => '?').join(',')}) AND u.is_active = 1
    ORDER BY u.full_name`, ...PROVIDER_ROLES);
  const byRole = q.all(`
    SELECT r.code, r.title, COUNT(u.id) AS users FROM roles r
    JOIN role_permissions rp ON rp.role_code = r.code AND rp.permission = 'provider.read'
    LEFT JOIN users u ON u.role = r.code AND u.is_active = 1
    WHERE r.code NOT IN (${PROVIDER_ROLES.map(() => '?').join(',')})
    GROUP BY r.code ORDER BY r.order_idx`, ...PROVIDER_ROLES);
  return {
    granted: granted.map((g) => ({ ...g, role_title: roleTitle(g.role_code), main_role_title: roleTitle(g.main_role) })),
    by_role: byRole,
    roles: PROVIDER_ROLES.map((code) => ({ code, title: roleTitle(code) })),
  };
}

// lower() и LIKE в SQLite различают регистр кириллицы, поэтому «смир» не нашёл бы
// «Смирнову» — сравнение идёт в коде
export function accessCandidates(query) {
  const needle = String(query || '').trim().toLowerCase();
  if (needle.length < 2) return [];
  return q.all(`SELECT u.id, u.full_name, u.email, u.role, i.short_name AS institution
                FROM users u LEFT JOIN institutions i ON i.id = u.institution_id
                WHERE u.is_active = 1 ORDER BY u.full_name`)
    .filter((u) => u.full_name.toLowerCase().includes(needle) || u.email.toLowerCase().includes(needle))
    .slice(0, 12)
    .map((u) => ({ ...u, role_title: roleTitle(u.role) }));
}

/**
 * У человека остаётся одна роль каталога: выдача новой заменяет прежнюю, иначе
 * «понизить модератора до пользователя» пришлось бы делать в два шага.
 */
export function grantAccess(userId, roleCode, by, ip) {
  if (!PROVIDER_ROLES.includes(roleCode)) throw new HttpError(400, 'Эта роль не относится к каталогу разработчиков');
  const target = q.get('SELECT id, full_name FROM users WHERE id = ? AND is_active = 1', Number(userId));
  if (!target) throw new HttpError(404, 'Участник не найден');
  tx(() => {
    for (const r of PROVIDER_ROLES) if (r !== roleCode) revokeRole(target.id, r);
    grantRole(target.id, roleCode, { grantedBy: by.id });
  });
  logAction(by.id, 'provider.access.grant', 'user', target.id, { role: roleCode }, ip);
  return accessList();
}

export function revokeAccess(userId, by, ip) {
  const id = Number(userId);
  if (id === by.id && !q.get(`SELECT 1 FROM role_permissions rp JOIN users u ON u.role = rp.role_code
                              WHERE u.id = ? AND rp.permission = 'provider.admin'`, id)) {
    // Иначе администратор каталога, получивший право только ролью, лишит себя его сам
    throw new HttpError(400, 'Нельзя отозвать доступ у самого себя');
  }
  tx(() => { for (const r of PROVIDER_ROLES) revokeRole(id, r); });
  logAction(by.id, 'provider.access.revoke', 'user', id, null, ip);
  return accessList();
}
