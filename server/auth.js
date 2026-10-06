// Аутентификация, сессии и ролевая модель доступа.
//
// Роли и права хранятся в базе, а не в коде: администратор заводит роль, передаёт
// право и назначает участнику дополнительные роли без правки исходников. Значения
// ниже — начальное наполнение, записываемое при первом обращении к пустой базе.
//
// Сигнатуры can() и permissionsOf() намеренно оставлены прежними: на них опираются
// все модули API и клиент, и переезд прав в данные не должен их касаться.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { q, tx } from './db.js';

const SESSION_DAYS = 7;

export const DEFAULT_ROLES = {
  employee:          { title: 'Сотрудник учреждения',        short: 'Сотрудник' },
  head:              { title: 'Руководитель учреждения',      short: 'Руководитель' },
  expert:            { title: 'Эксперт ДТСЗН',                short: 'Эксперт' },
  developer:         { title: 'Команда разработки и ЦТ',      short: 'Разработка' },
  supplier:          { title: 'Поставщик технологий и услуг', short: 'Поставщик' },
  pilot_coordinator: { title: 'Координатор пилотных площадок',short: 'Пилот-координатор' },
  dtszn:             { title: 'ДТСЗН (центральный аппарат)',  short: 'ДТСЗН' },
  // Роли базы знаний. Заказчик ролью не заводится: это отношение, а не должность —
  // по своей идее человек заказчик, по чужой рецензент, и роль бы об этом соврала.
  architect:         { title: 'Архитектор решений',           short: 'Архитектор' },
  curator:           { title: 'Куратор кампании',             short: 'Куратор' },
  // Роли каталога разработчиков ИИ-решений. Основной ролью их не назначают: их
  // выдают сверх основной конкретным людям, которым поручена работа с базой подрядчиков.
  provider_viewer:   { title: 'Пользователь каталога разработчиков',   short: 'Каталог: просмотр' },
  provider_editor:   { title: 'Модератор каталога разработчиков',      short: 'Каталог: модерация' },
  provider_manager:  { title: 'Администратор каталога разработчиков',  short: 'Каталог: доступ' },
};

/** Роли, которые администратор каталога разработчиков вправе выдавать сам, без настроек платформы. */
export const PROVIDER_ROLES = ['provider_viewer', 'provider_editor', 'provider_manager'];

// Права: что роль может делать. Проверяются на сервере при каждом запросе.
//
// Модуль «Идеи и решения» добавляет свои права поверх ролей платформы:
//   idea.create      — подавать идеи;
//   idea.propose     — предлагать решения и делиться проверенным опытом (социальный советник);
//   idea.review      — быстрое ревью чужих предложений карточками (ревьюер);
//   idea.moderate    — проверять идеи, подтверждать опыт, отменять начисления (модератор);
//   idea.incentive   — видеть рекомендации к поощрению и формировать их (руководитель);
//   idea.incentive.decide — согласовывать, утверждать и отклонять поощрения;
//   idea.admin       — правила начисления очков, меры поощрения, настройки модуля.
//
// Работа с моделями процессов добавляет ещё один набор:
//   process.read     — смотреть схемы процессов и историю их версий;
//   process.comment  — обсуждать конкретный шаг схемы;
//   process.propose  — предлагать изменение процесса — это и есть краудсорсинг;
//   process.edit     — править черновую версию схемы в редакторе;
//   process.approve  — согласовывать изменения в своей зоне ответственности;
//   process.publish  — публиковать согласованную версию;
//   process.admin    — маршруты согласования, роли и права.
//
// Конструктор форм добавляет три:
//   form.create      — собирать формы и опросы, видеть ответы на свои;
//   form.fill        — заполнять формы;
//   form.admin       — видеть и править любые формы платформы.
//
// Каталог разработчиков ИИ-решений:
//   provider.read    — смотреть карточки разработчиков, портфолио, решения и технологии;
//   provider.edit    — добавлять разработчиков и править сведения, вести журнал, оценивать работу;
//   provider.admin   — выдавать и отзывать доступ к каталогу, удалять карточки;
//   provider.self    — вести технологический профиль, портфолио и решения своей
//                      компании, если учётная запись привязана к её карточке.
export const DEFAULT_PERMISSIONS = {
  employee:          ['initiative.create', 'initiative.read', 'initiative.comment', 'pilot.feedback', 'community', 'survey.answer',
                      'idea.create', 'idea.propose', 'idea.review',
                      'process.read', 'process.comment', 'process.propose',
                      'doc.read', 'doc.comment', 'doc.propose',
                      'form.fill'],
  head:              ['initiative.create', 'initiative.read', 'initiative.comment', 'gate.1', 'pilot.apply', 'pilot.manage', 'analytics.institution', 'community', 'survey.answer', 'rollout.manage',
                      'idea.create', 'idea.propose', 'idea.review', 'idea.incentive', 'idea.incentive.decide',
                      'process.read', 'process.comment', 'process.propose', 'process.edit', 'process.approve',
                      'doc.read', 'doc.comment', 'doc.propose', 'doc.review',
                      'form.create', 'form.fill'],
  expert:            ['initiative.create', 'initiative.read', 'initiative.comment', 'gate.2', 'analytics.expert', 'community', 'survey.answer', 'bestpractice.publish',
                      'idea.create', 'idea.propose', 'idea.review', 'idea.moderate', 'idea.incentive',
                      'process.read', 'process.comment', 'process.propose', 'process.edit', 'process.approve',
                      'doc.read', 'doc.comment', 'doc.propose', 'doc.review',
                      'form.create', 'form.fill'],
  developer:         ['initiative.read', 'initiative.comment', 'gate.3', 'project.manage', 'board.manage', 'docs.manage', 'community', 'survey.answer',
                      'idea.create', 'idea.propose', 'idea.review',
                      'process.read', 'process.comment', 'process.propose', 'process.edit', 'process.approve',
                      'doc.read', 'doc.comment', 'doc.propose', 'doc.edit',
                      'form.fill'],
  supplier:          ['initiative.read', 'initiative.comment', 'community', 'project.contribute',
                      'idea.propose', 'idea.review',
                      'process.read', 'process.comment',
                      'doc.read', 'doc.comment',
                      'form.fill',
                      // Своя карточка в каталоге разработчиков — только если учётная
                      // запись привязана к ней модератором; чужие карточки не видны
                      'provider.self'],
  pilot_coordinator: ['initiative.read', 'initiative.comment', 'gate.4', 'pilot.manage', 'pilot.feedback', 'survey.manage', 'analytics.pilot', 'community', 'survey.answer',
                      'idea.create', 'idea.propose', 'idea.review',
                      'process.read', 'process.comment', 'process.propose', 'process.edit', 'process.approve',
                      'doc.read', 'doc.comment', 'doc.propose',
                      'form.create', 'form.fill'],
  dtszn:             ['initiative.create', 'initiative.read', 'initiative.comment', 'gate.2', 'gate.5', 'analytics.all', 'admin', 'workflow.configure', 'audit.read', 'community', 'rollout.manage', 'bestpractice.publish', 'awards.grant', 'survey.answer', 'pilot.manage',
                      'idea.create', 'idea.propose', 'idea.review', 'idea.moderate', 'idea.incentive', 'idea.incentive.decide', 'idea.admin',
                      'process.read', 'process.comment', 'process.propose', 'process.edit', 'process.approve', 'process.publish', 'process.admin',
                      'doc.read', 'doc.comment', 'doc.propose', 'doc.edit', 'doc.review', 'doc.publish', 'doc.admin', 'campaign.manage',
                      'form.create', 'form.fill', 'form.admin',
                      'provider.read', 'provider.edit', 'provider.admin'],

  // Архитектор решений: рецензирует проекты решений и следит за тем, чтобы новые
  // решения не расходились с уже принятыми. Заводить инициативы и вести пилоты
  // ему не нужно — это чужая работа.
  architect:         ['initiative.read', 'initiative.comment', 'community', 'survey.answer',
                      'idea.propose', 'idea.review',
                      'process.read', 'process.comment', 'process.propose', 'process.approve',
                      'doc.read', 'doc.comment', 'doc.propose', 'doc.edit', 'doc.review',
                      'form.fill'],

  // Куратор кампании: ведёт сбор идей по конкретному вызову, направляет обсуждение
  // и сводит итоги. Решений по инициативам не принимает.
  curator:           ['initiative.read', 'initiative.comment', 'community', 'survey.answer',
                      'idea.create', 'idea.propose', 'idea.review', 'idea.moderate',
                      'campaign.manage',
                      'process.read', 'process.comment',
                      'doc.read', 'doc.comment',
                      'form.create', 'form.fill'],

  provider_viewer:   ['provider.read'],
  provider_editor:   ['provider.read', 'provider.edit'],
  provider_manager:  ['provider.read', 'provider.edit', 'provider.admin'],
};

// Расшифровка прав для интерфейса администратора
export const PERMISSION_CATALOG = [
  ['doc.read', 'Читать базу знаний', 'База знаний'],
  ['doc.comment', 'Обсуждать разделы документа', 'База знаний'],
  ['doc.propose', 'Заводить проект решения', 'База знаний'],
  ['doc.edit', 'Править черновик документа', 'База знаний'],
  ['doc.review', 'Рецензировать проект решения', 'База знаний'],
  ['doc.publish', 'Публиковать решение в базе знаний', 'База знаний'],
  ['doc.admin', 'Настраивать шаблоны разделов', 'База знаний'],
  ['campaign.manage', 'Вести кампании по сбору идей', 'Идеи и решения'],
  ['initiative.create', 'Подавать инициативы', 'Инициативы'],
  ['initiative.read', 'Смотреть реестр инициатив', 'Инициативы'],
  ['initiative.comment', 'Обсуждать инициативы', 'Инициативы'],
  ['gate.1', 'Решение на Gate 1', 'Точки принятия решений'],
  ['gate.2', 'Решение на Gate 2', 'Точки принятия решений'],
  ['gate.3', 'Решение на Gate 3', 'Точки принятия решений'],
  ['gate.4', 'Решение на Gate 4', 'Точки принятия решений'],
  ['gate.5', 'Решение на Gate 5', 'Точки принятия решений'],
  ['workflow.configure', 'Настраивать конвейер', 'Точки принятия решений'],
  ['idea.create', 'Подавать идеи', 'Идеи и решения'],
  ['idea.propose', 'Предлагать решения', 'Идеи и решения'],
  ['idea.review', 'Быстрое ревью предложений', 'Идеи и решения'],
  ['idea.moderate', 'Модерировать идеи и опыт', 'Идеи и решения'],
  ['idea.incentive', 'Видеть рекомендации к поощрению', 'Идеи и решения'],
  ['idea.incentive.decide', 'Решать по поощрениям', 'Идеи и решения'],
  ['idea.admin', 'Настраивать модуль идей', 'Идеи и решения'],
  ['process.read', 'Смотреть схемы процессов', 'Процессы'],
  ['process.comment', 'Обсуждать шаги схемы', 'Процессы'],
  ['process.propose', 'Предлагать изменение процесса', 'Процессы'],
  ['process.edit', 'Править схему в редакторе', 'Процессы'],
  ['process.approve', 'Согласовывать изменения процессов', 'Процессы'],
  ['process.publish', 'Публиковать версию процесса', 'Процессы'],
  ['process.admin', 'Настраивать маршруты, роли и права', 'Процессы'],
  ['pilot.apply', 'Подавать заявку на пилот', 'Пилотирование'],
  ['pilot.manage', 'Вести пилоты', 'Пилотирование'],
  ['pilot.feedback', 'Давать обратную связь по пилоту', 'Пилотирование'],
  ['form.create', 'Собирать формы и опросы', 'Формы и опросы'],
  ['form.fill', 'Заполнять формы', 'Формы и опросы'],
  ['form.admin', 'Управлять всеми формами', 'Формы и опросы'],
  ['provider.read', 'Смотреть каталог разработчиков', 'Каталог разработчиков ИИ-решений'],
  ['provider.edit', 'Добавлять и править разработчиков', 'Каталог разработчиков ИИ-решений'],
  ['provider.admin', 'Выдавать доступ к каталогу разработчиков', 'Каталог разработчиков ИИ-решений'],
  ['provider.self', 'Вести карточку своей компании в каталоге', 'Каталог разработчиков ИИ-решений'],
  ['survey.manage', 'Вести опросы', 'Пилотирование'],
  ['survey.answer', 'Отвечать на опросы', 'Пилотирование'],
  ['project.manage', 'Вести проекты разработки', 'Разработка'],
  ['project.contribute', 'Участвовать в разработке', 'Разработка'],
  ['board.manage', 'Вести доску задач', 'Разработка'],
  ['docs.manage', 'Вести документацию', 'Разработка'],
  ['rollout.manage', 'Оформлять внедрение', 'Масштабирование'],
  ['bestpractice.publish', 'Публиковать лучшие практики', 'Масштабирование'],
  ['awards.grant', 'Присваивать награды', 'Масштабирование'],
  ['analytics.all', 'Полная аналитика', 'Аналитика'],
  ['analytics.institution', 'Аналитика учреждения', 'Аналитика'],
  ['analytics.expert', 'Аналитика эксперта', 'Аналитика'],
  ['analytics.pilot', 'Аналитика пилотов', 'Аналитика'],
  ['audit.read', 'Читать журнал аудита', 'Администрирование'],
  ['admin', 'Администрирование платформы', 'Администрирование'],
  ['community', 'Участие в сообществе', 'Сообщество'],
];

// ─────────────────────────────────────────────────────────────
// Наполнение и кэш
// ─────────────────────────────────────────────────────────────
let cache = null;   // { roles: Map<code, row>, perms: Map<code, Set<permission>> }

/** Сброс кэша. Вызывается при любой правке ролей и прав. */
export function invalidateRoles() { cache = null; }

/**
 * Начальное наполнение. Идемпотентно: заполняет только пустые таблицы, поэтому
 * настройки администратора при перезапуске не затираются.
 */
export function ensureRoles() {
  if (q.get('SELECT COUNT(*) AS c FROM roles').c === 0) {
    tx(() => {
      Object.entries(DEFAULT_ROLES).forEach(([code, r], i) => {
        q.run('INSERT INTO roles (code, title, short, kind, order_idx) VALUES (?,?,?,?,?)',
          code, r.title, r.short, 'system', i);
        for (const p of DEFAULT_PERMISSIONS[code] || []) {
          q.run('INSERT INTO role_permissions (role_code, permission) VALUES (?,?)', code, p);
        }
      });
    });
    invalidateRoles();
  }
  if (q.get('SELECT COUNT(*) AS c FROM permissions_catalog').c === 0) {
    tx(() => {
      PERMISSION_CATALOG.forEach(([code, title, group], i) => {
        q.run('INSERT INTO permissions_catalog (code, title, group_title, order_idx) VALUES (?,?,?,?)',
          code, title, group, i);
      });
    });
  }
  adoptNewRoles();
  adoptNewPermissions();
  renameLegacyTitles();
}

// Раздел «Реестр исполнителей» переименован в «Каталог разработчиков ИИ-решений».
// Названия в работающей базе меняются, только если администратор их не правил.
const LEGACY_TITLES = {
  roles: {
    provider_viewer:  ['Читатель реестра исполнителей', 'Реестр: чтение'],
    provider_editor:  ['Редактор реестра исполнителей', 'Реестр: правка'],
    provider_manager: ['Администратор реестра исполнителей', 'Реестр: доступ'],
  },
  permissions: {
    'provider.read':  'Смотреть реестр исполнителей',
    'provider.edit':  'Вносить и править исполнителей',
    'provider.admin': 'Выдавать доступ к реестру исполнителей',
  },
};

function renameLegacyTitles() {
  let changed = 0;
  for (const [code, [title, short]] of Object.entries(LEGACY_TITLES.roles)) {
    const r = DEFAULT_ROLES[code];
    changed += Number(q.run('UPDATE roles SET title = ?, short = ? WHERE code = ? AND title = ? AND short = ?',
      r.title, r.short, code, title, short).changes);
  }
  for (const [code, title] of Object.entries(LEGACY_TITLES.permissions)) {
    const [, fresh, group] = PERMISSION_CATALOG.find(([c]) => c === code);
    q.run('UPDATE permissions_catalog SET title = ?, group_title = ? WHERE code = ? AND title = ?', fresh, group, code, title);
  }
  if (changed) invalidateRoles();
}

/**
 * Системная роль, появившаяся вместе с новым модулем, заводится в работающей базе
 * со своими правами по умолчанию. Роли не удаляются (их отключают), поэтому
 * отсутствующая в таблице роль — это именно новая, а не удалённая администратором.
 */
function adoptNewRoles() {
  const known = new Set(q.all('SELECT code FROM roles').map((r) => r.code));
  const fresh = Object.keys(DEFAULT_ROLES).filter((code) => !known.has(code));
  if (!fresh.length) return;
  tx(() => {
    const size = q.get('SELECT COUNT(*) AS c FROM roles').c;
    fresh.forEach((code, i) => {
      const r = DEFAULT_ROLES[code];
      q.run('INSERT INTO roles (code, title, short, kind, order_idx) VALUES (?,?,?,?,?)',
        code, r.title, r.short, 'system', size + i);
      for (const p of DEFAULT_PERMISSIONS[code] || []) {
        q.run(`INSERT INTO role_permissions (role_code, permission) VALUES (?,?)
               ON CONFLICT(role_code, permission) DO NOTHING`, code, p);
      }
    });
  });
  invalidateRoles();
}

/**
 * Новый модуль приносит с собой новые права, а роли в работающей базе уже
 * настроены администратором — начальное наполнение их не тронет. Здесь
 * добавляется только то, чего база ещё не знает: право попадает в справочник и
 * раздаётся ролям по умолчанию.
 *
 * Известное право не выдаётся повторно: снятое администратором вручную не должно
 * возвращаться при следующем запуске. Признаком «уже знаем» служит справочник —
 * он пополняется в том же проходе и только после раздачи.
 */
function adoptNewPermissions() {
  const known = new Set(q.all('SELECT code FROM permissions_catalog').map((r) => r.code));
  const fresh = PERMISSION_CATALOG.filter(([code]) => !known.has(code));
  if (!fresh.length) return;

  tx(() => {
    const size = q.get('SELECT COUNT(*) AS c FROM permissions_catalog').c;
    fresh.forEach(([code, title, group], i) => {
      q.run('INSERT INTO permissions_catalog (code, title, group_title, order_idx) VALUES (?,?,?,?)',
        code, title, group, size + i);
      for (const [role, list] of Object.entries(DEFAULT_PERMISSIONS)) {
        if (!list.includes(code)) continue;
        if (!q.get('SELECT code FROM roles WHERE code = ?', role)) continue;
        q.run(`INSERT INTO role_permissions (role_code, permission) VALUES (?,?)
               ON CONFLICT(role_code, permission) DO NOTHING`, role, code);
      }
    });
  });
  invalidateRoles();
}

function load() {
  if (cache) return cache;
  ensureRoles();
  const roles = new Map(q.all('SELECT * FROM roles ORDER BY order_idx, code').map((r) => [r.code, r]));
  const perms = new Map([...roles.keys()].map((c) => [c, new Set()]));
  for (const r of q.all('SELECT role_code, permission FROM role_permissions')) {
    if (!perms.has(r.role_code)) perms.set(r.role_code, new Set());
    perms.get(r.role_code).add(r.permission);
  }
  cache = { roles, perms };
  return cache;
}

/** Справочник ролей в виде объекта — форма сохранена для существующих потребителей. */
export function roleMap() {
  return Object.fromEntries([...load().roles].map(([code, r]) => [code, r]));
}

export const roleTitle = (code) => load().roles.get(code)?.title || code;

/** Все роли участника: основная из users.role плюс назначенные дополнительно. */
export function rolesOf(user) {
  if (!user) return [];
  const extra = user.extra_roles ? String(user.extra_roles).split(',') : [];
  return [...new Set([user.role, ...extra].filter(Boolean))];
}

/** Права одной роли. */
export function permissionsOf(role) {
  return [...(load().perms.get(role) || [])];
}

/** Права участника — объединение прав всех его ролей. */
export function permissionsOfUser(user) {
  const { perms } = load();
  const out = new Set();
  for (const role of rolesOf(user)) for (const p of perms.get(role) || []) out.add(p);
  return [...out];
}

export function can(user, permission) {
  if (!user) return false;
  const { perms } = load();
  return rolesOf(user).some((role) => perms.get(role)?.has(permission));
}

// ── Правка ролей и прав ──────────────────────────────────────
export function setRolePermissions(roleCode, permissions) {
  tx(() => {
    q.run('DELETE FROM role_permissions WHERE role_code = ?', roleCode);
    for (const p of new Set(permissions)) {
      q.run('INSERT INTO role_permissions (role_code, permission) VALUES (?,?)', roleCode, p);
    }
    q.run("UPDATE roles SET updated_at = datetime('now') WHERE code = ?", roleCode);
  });
  invalidateRoles();
}

export function upsertRole({ code, title, short, description, is_active, order_idx }) {
  const exists = q.get('SELECT code FROM roles WHERE code = ?', code);
  if (exists) {
    q.run(`UPDATE roles SET title = COALESCE(?, title), short = COALESCE(?, short),
           description = COALESCE(?, description), is_active = COALESCE(?, is_active),
           order_idx = COALESCE(?, order_idx), updated_at = datetime('now') WHERE code = ?`,
      title ?? null, short ?? null, description ?? null,
      is_active === undefined ? null : (is_active ? 1 : 0), order_idx ?? null, code);
  } else {
    q.run('INSERT INTO roles (code, title, short, kind, description, order_idx) VALUES (?,?,?,?,?,?)',
      code, title, short || title, 'custom', description ?? null, order_idx ?? 100);
  }
  invalidateRoles();
  return q.get('SELECT * FROM roles WHERE code = ?', code);
}

export function grantRole(userId, roleCode, { institutionId = null, grantedBy = null } = {}) {
  q.run(`INSERT INTO user_roles (user_id, role_code, institution_id, granted_by)
         VALUES (?,?,?,?)
         ON CONFLICT(user_id, role_code) DO UPDATE SET institution_id = excluded.institution_id`,
    userId, roleCode, institutionId, grantedBy);
}

export function revokeRole(userId, roleCode) {
  q.run('DELETE FROM user_roles WHERE user_id = ? AND role_code = ?', userId, roleCode);
}

export function extraRolesOf(userId) {
  return q.all(`SELECT ur.*, r.title FROM user_roles ur
                JOIN roles r ON r.code = ur.role_code WHERE ur.user_id = ?`, userId);
}

// ─────────────────────────────────────────────────────────────
// Пароли и сессии
// ─────────────────────────────────────────────────────────────
export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password, hash, salt) {
  const attempt = scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, 'hex');
  return stored.length === attempt.length && timingSafeEqual(stored, attempt);
}

export function createSession(userId, ip, userAgent) {
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString().slice(0, 19).replace('T', ' ');
  q.run(
    'INSERT INTO sessions (token, user_id, expires_at, ip, user_agent) VALUES (?,?,?,?,?)',
    token, userId, expires, ip || '', (userAgent || '').slice(0, 200)
  );
  q.run("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", userId);
  return token;
}

export function userFromToken(token) {
  if (!token) return null;
  // Дополнительные роли забираются тем же запросом: can() вызывается по нескольку раз
  // на запрос, и отдельное обращение к базе на каждую проверку было бы расточительным.
  const row = q.get(`
    SELECT u.*, i.name AS institution_name, i.short_name AS institution_short, i.kind AS institution_kind,
           (SELECT group_concat(ur.role_code) FROM user_roles ur WHERE ur.user_id = u.id) AS extra_roles
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN institutions i ON i.id = u.institution_id
    WHERE s.token = ? AND s.expires_at > datetime('now') AND u.is_active = 1
  `, token);
  if (!row) return null;
  delete row.password_hash;
  delete row.password_salt;
  return row;
}

export function destroySession(token) {
  q.run('DELETE FROM sessions WHERE token = ?', token);
}

export function publicUser(u) {
  if (!u) return null;
  const { password_hash, password_salt, ...rest } = u;
  return {
    ...rest,
    role_title: roleTitle(u.role),
    roles: rolesOf(u),
    permissions: permissionsOfUser(u),
  };
}
