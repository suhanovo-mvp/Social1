// Модуль «Идеи и решения»: доменная логика.
// Статусы идей и предложений, начисление очков по настраиваемым правилам,
// защита от накруток, рейтинг социальных советников, знаки отличия и рекомендации к поощрению.
import { q, tx } from './db.js';
import { logAction } from './audit.js';
import { notify as sendNotification } from './notify.js';

// ── Словари статусов ─────────────────────────────────────────
export const IDEA_STATUS = {
  new:         { title: 'Новая',                 tone: 'info',   order: 1 },
  review:      { title: 'На рассмотрении',       tone: 'warn',   order: 2 },
  accepted:    { title: 'Принята к обсуждению',  tone: 'accent', order: 3 },
  in_progress: { title: 'В работе',              tone: 'purple', order: 4 },
  done:        { title: 'Реализована',           tone: 'ok',     order: 5 },
  rejected:    { title: 'Отклонена',             tone: 'muted',  order: 6 },
  archived:    { title: 'Архив',                 tone: 'muted',  order: 7 },
};

export const PROPOSAL_STATUS = {
  published:   { title: 'Опубликовано',    tone: 'info' },
  useful:      { title: 'Полезное',        tone: 'accent' },
  verified:    { title: 'Проверенный опыт',tone: 'ok' },
  implemented: { title: 'Внедрено',        tone: 'ok' },
  rejected:    { title: 'Отклонено',       tone: 'muted' },
};

// Обсуждать решения можно только по идее, прошедшей проверку, — это и защита
// от спама, и гарантия того, что очки начисляются за осмысленный вклад.
export const OPEN_FOR_PROPOSALS = ['review', 'accepted', 'in_progress'];

// Быстрые шаблоны подачи: заполняют форму типовыми формулировками
export const TEMPLATES = [
  { code: 'ui',        title: 'Улучшить интерфейс',    category: 'Цифровые сервисы',
    problem: 'В интерфейсе приходится делать лишние действия: ',
    desired_result: 'Действие выполняется в одном окне, без переключений.' },
  { code: 'speed',     title: 'Ускорить процесс',      category: 'Оптимизация процессов',
    problem: 'Процесс занимает больше времени, чем нужно: ',
    desired_result: 'Время выполнения сокращается с ___ до ___ минут.' },
  { code: 'errors',    title: 'Уменьшить ошибки',      category: 'Качество услуг',
    problem: 'Регулярно возникают ошибки при: ',
    desired_result: 'Доля ошибок снижается, проверка выполняется автоматически.' },
  { code: 'automate',  title: 'Автоматизировать действие', category: 'Цифровые сервисы',
    problem: 'Действие выполняется вручную: ',
    desired_result: 'Действие выполняется системой без участия сотрудника.' },
  { code: 'other',     title: 'Другое',                category: null, problem: '', desired_result: '' },
];

// ── Правила начисления очков (значения по умолчанию из регламента) ──
export const DEFAULT_POINTS_RULES = [
  { code: 'idea.approved',       title: 'Идея прошла модерацию',                      points: 2,  cap: null,
    description: 'Начисляется автору идеи после того, как модератор принял её к обсуждению.' },
  { code: 'proposal.created',    title: 'Предложено решение',                         points: 3,  cap: null,
    description: 'Начисляется социальному советнику за опубликованное предложение по чужой идее.' },
  { code: 'proposal.useful',     title: 'Решение отмечено автором идеи как полезное',  points: 5,  cap: null,
    description: 'Отмечает только автор идеи. Самооценка не начисляется.' },
  { code: 'proposal.endorsed',   title: 'Решение поддержано другими пользователями',   points: 1,  cap: 10,
    description: 'По одному очку за подтверждение коллеги, но не более 10 очков за одно предложение.' },
  { code: 'experience.verified', title: 'Проверенный опыт подтверждён',                points: 10, cap: null,
    description: 'Начисляется после подтверждения модератором или руководителем.' },
  { code: 'proposal.accepted',   title: 'Предложение принято в работу',                points: 15, cap: null },
  { code: 'proposal.implemented',title: 'Предложение внедрено и дало эффект',          points: 25, cap: null },

  // Вклад в перестройку самих процессов. Очки те же и рейтинг тот же: замечание к шагу
  // схемы и предложение решения по чужой идее — разные способы одного и того же участия.
  { code: 'process.comment.useful', title: 'Замечание к шагу процесса признано полезным', points: 2, cap: 6,
    description: 'Начисляется автору замечания на схеме, отмеченного коллегами как полезное, но не более 6 очков за одно замечание.' },
  { code: 'process.change.proposed', title: 'Предложено изменение процесса',            points: 5,  cap: null,
    description: 'Начисляется, когда предложение об изменении схемы вынесено на обсуждение.' },
  { code: 'process.change.accepted', title: 'Изменение процесса согласовано',            points: 20, cap: null,
    description: 'Начисляется автору после того, как все согласующие поддержали изменение.' },
  { code: 'process.change.published',title: 'Изменение процесса вступило в силу',        points: 30, cap: null,
    description: 'Начисляется после публикации версии: процесс работает по предложению автора.' },
];

// ── Знаки отличия ────────────────────────────────────────────
export const BADGES = [
  { code: 'active_advisor',  title: 'Активный социальный советник',
    hint: 'Пять и более предложений по идеям коллег',
    test: (s) => s.proposals >= 5 },
  { code: 'solution_expert', title: 'Эксперт решений',
    hint: 'Три и более предложения признаны полезными или внедрены',
    test: (s) => s.useful >= 3 },
  { code: 'verified_experience', title: 'Проверенный опыт',
    hint: 'Подтверждённый модератором опыт применения решения',
    test: (s) => s.verified >= 1 },
  { code: 'mentor', title: 'Наставник',
    hint: 'Двадцать пять и более подтверждений предложений от коллег',
    test: (s) => s.endorsements >= 25 },
  { code: 'practice_author', title: 'Автор полезной практики',
    hint: 'Предложение внедрено и дало измеримый эффект',
    test: (s) => s.implemented >= 1 },
];

// ── Меры поощрения ───────────────────────────────────────────
// Все меры применяются только в рамках трудового законодательства, внутренних
// регламентов и правил государственной службы. Система фиксирует рекомендацию,
// итоговое решение принимает руководитель или уполномоченное лицо.
export const INCENTIVE_TYPES = [
  ['extra_day_off',    'Дополнительный выходной день', 'time',
   'По согласованию с руководителем, в порядке, установленном внутренними актами.'],
  ['comp_rest_day',    'Компенсационный день отдыха', 'time',
   'За участие в улучшении процессов сверх основных обязанностей.'],
  ['flexible_start',   'Гибкое начало рабочего дня', 'time',
   'Один день в неделю или месяц, если это допустимо правилами трудового распорядка.'],
  ['short_friday',     'Сокращённый рабочий день в пятницу', 'time',
   'Только если предусмотрено внутренними правилами учреждения.'],
  ['remote_day',       'День дистанционной работы', 'time',
   'Если должность допускает удалённый формат.'],
  ['head_gratitude',   'Благодарность руководителя с записью в личном деле', 'recognition', null],
  ['certificate',      'Почётная грамота или благодарственное письмо', 'recognition', null],
  ['board_of_honour',  'Размещение на доске почёта или внутреннем портале', 'recognition', null],
  ['kpi_points',       'Баллы к КПЭ или внутренней оценке эффективности', 'recognition',
   'Если в учреждении действует такая система оценки.'],
  ['bonus',            'Премия или материальное поощрение', 'material',
   'Только если предусмотрено фондом оплаты труда.'],
  ['training_priority','Приоритетное направление на обучение', 'development',
   'Курсы, семинары, конференции в рамках утверждённого плана обучения.'],
  ['talent_pool',      'Включение в кадровый резерв или экспертный совет', 'development', null],
  ['mentor_role',      'Назначение наставником для новых сотрудников', 'development', null],
  ['pilot_group',      'Участие в пилотном проекте или рабочей группе', 'development', null],
  ['health_program',   'Путёвка в санаторий или оздоровительное мероприятие', 'social',
   'При наличии соответствующей программы в учреждении.'],
  ['travel_comp',      'Компенсация проезда, парковки или питания', 'material',
   'Если это разрешено внутренними актами.'],
  ['sport_pass',       'Абонемент на спорт', 'social',
   'При наличии социальной программы в учреждении.'],
  ['public_praise',    'Публичное признание на собрании подразделения', 'recognition', null],
  ['fast_track_review','Внеочередное рассмотрение заявки на обучение или аттестацию', 'development',
   'Если это не нарушает общий порядок рассмотрения.'],
  ['advisor_of_month', 'Сертификат «Лучший социальный советник месяца»', 'recognition',
   'Без материальной ценности, подходит для портфолио сотрудника.'],
];

export const INCENTIVE_STATUS = {
  proposed:    { title: 'Предложено',  tone: 'info' },
  agreed:      { title: 'Согласовано', tone: 'accent' },
  approved:    { title: 'Утверждено',  tone: 'ok' },
  rejected:    { title: 'Отклонено',   tone: 'muted' },
  implemented: { title: 'Реализовано', tone: 'ok' },
};

const DEFAULT_SETTINGS = {
  moderation_required: '1',   // новая идея публикуется только после проверки
  rating_visible: '1',        // рейтинг виден рядовым участникам
  incentive_threshold: '25',  // очки за период, с которых формируется рекомендация
  incentive_top: '5',         // сколько человек попадает в рекомендации
  // Быстрое ревью предложений
  review_undo: '1',           // можно вернуться к предыдущей карточке
  review_top_threshold: '5',  // с какого числа лайков предложение попадает в «Топ»
  review_min_ms: '800',       // быстрее этого оценка считается непрочитанной
  review_burst_limit: '5',    // столько быстрых оценок подряд — сигнал модератору
  review_per_minute: '30',    // предел оценок в минуту
  review_per_hour: '300',     // предел оценок в час
};

/** Первичное наполнение справочников модуля. Идемпотентно. */
// ── Переименование сущности: «советчик» → «социальный советник» ──
// Значения по умолчанию записываются только в пустые таблицы, поэтому у работающей
// установки названия правил, знаков отличия и мер поощрения остались бы прежними.
// Журналы — начисления, уведомления и аудит — не переписываются: это запись о том,
// что было сказано в своё время, а не действующая надпись в интерфейсе.
const ADVISOR_FORMS = {
  '':    ['социальный',  'советник'],
  'а':   ['социального', 'советника'],
  'у':   ['социальному', 'советнику'],
  'ом':  ['социальным',  'советником'],
  'е':   ['социальном',  'советнике'],
  'и':   ['социальные',  'советники'],
  'ов':  ['социальных',  'советников'],
  'ам':  ['социальным',  'советникам'],
  'ами': ['социальными', 'советниками'],
  'ах':  ['социальных',  'советниках'],
};
// Длинные окончания проверяются первыми: иначе «советчиками» разберётся как «советчикам»
const ADVISOR_RX = /([Сс])оветчик(ами|ах|ам|ов|ом|е|у|а|и|)(?![а-яё])/g;

export const renameAdvisor = (text) => String(text ?? '').replace(ADVISOR_RX, (_, first, suffix) => {
  const [adj, noun] = ADVISOR_FORMS[suffix];
  return (first === 'С' ? adj[0].toUpperCase() + adj.slice(1) : adj) + ' ' + noun;
});

/** Обновляет справочные надписи, оставшиеся от прежнего названия сущности. */
export function renameAdvisorWording() {
  const targets = [
    ['points_rules', 'code', ['title', 'description']],
    ['incentive_types', 'code', ['title', 'description', 'legal_note']],
    ['advisor_badges', 'id', ['title']],
  ];
  let updated = 0;
  for (const [table, key, columns] of targets) {
    const where = columns.map((c) => `${c} LIKE '%оветчик%'`).join(' OR ');
    for (const row of q.all(`SELECT ${key}, ${columns.join(', ')} FROM ${table} WHERE ${where}`)) {
      const sets = columns.map((c) => `${c}=?`).join(', ');
      q.run(`UPDATE ${table} SET ${sets} WHERE ${key}=?`,
        ...columns.map((c) => (row[c] === null ? null : renameAdvisor(row[c]))), row[key]);
      updated += 1;
    }
  }
  return updated;
}

export function ensureIdeaHub() {
  for (const r of DEFAULT_POINTS_RULES) {
    if (q.get('SELECT code FROM points_rules WHERE code=?', r.code)) continue;
    q.run(`INSERT INTO points_rules (code, title, points, cap_per_target, description, order_idx)
           VALUES (?,?,?,?,?,?)`,
      r.code, r.title, r.points, r.cap ?? null, r.description ?? null,
      DEFAULT_POINTS_RULES.indexOf(r));
  }
  INCENTIVE_TYPES.forEach(([code, title, category, note], i) => {
    if (q.get('SELECT code FROM incentive_types WHERE code=?', code)) return;
    q.run(`INSERT INTO incentive_types (code, title, category, legal_note, order_idx)
           VALUES (?,?,?,?,?)`, code, title, category, note, i);
  });
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (!q.get('SELECT key FROM ideahub_settings WHERE key=?', key)) {
      q.run('INSERT INTO ideahub_settings (key, value) VALUES (?,?)', key, value);
    }
  }
  renameAdvisorWording();
}

// ── Настройки ────────────────────────────────────────────────
export function settings() {
  const rows = q.all('SELECT key, value FROM ideahub_settings');
  return { ...DEFAULT_SETTINGS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
}
export function setting(key) { return settings()[key]; }
export function setSetting(key, value) {
  q.run(`INSERT INTO ideahub_settings (key, value, updated_at) VALUES (?,?,datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`,
    key, String(value));
}

// ── Номер идеи ───────────────────────────────────────────────
export function nextIdeaNumber() {
  const year = new Date().getFullYear();
  const last = q.get('SELECT number FROM ideas WHERE number LIKE ? ORDER BY id DESC LIMIT 1', `IDEA-${year}-%`);
  const seq = last ? Number(last.number.split('-')[2]) + 1 : 1;
  return `IDEA-${year}-${String(seq).padStart(4, '0')}`;
}

// ── Уведомления модуля ───────────────────────────────────────
export function notifyIdea(userId, ideaId, type, title, body) {
  if (!userId) return;
  q.run('INSERT INTO notifications (user_id, idea_id, type, title, body) VALUES (?,?,?,?,?)',
    userId, ideaId ?? null, type, title, body ?? null);
}

export function notifyIdeaRole(role, ideaId, type, title, body) {
  const users = q.all('SELECT id FROM users WHERE role=? AND is_active=1', role);
  for (const u of users) notifyIdea(u.id, ideaId, type, title, body);
  return users.length;
}

/** Роли, выполняющие модерацию модуля. */
export const MODERATOR_ROLES = ['expert', 'dtszn'];

export function notifyModerators(ideaId, type, title, body) {
  for (const role of MODERATOR_ROLES) notifyIdeaRole(role, ideaId, type, title, body);
}

// ─────────────────────────────────────────────────────────────
// Очки
// ─────────────────────────────────────────────────────────────
export function rule(code) {
  return q.get('SELECT * FROM points_rules WHERE code=? AND is_active=1', code);
}

// Ключ намеренно не меняет вид для начислений модуля идей: приписка добавляется
// только у начислений за процессы, иначе уже выданные очки перестали бы
// опознаваться и были бы начислены повторно.
const dedupKey = (userId, code, ideaId, proposalId, sourceUserId, changeId = null) => {
  const base = [userId, code, ideaId ?? '', proposalId ?? '', sourceUserId ?? ''].join(':');
  return changeId ? `${base}:change=${changeId}` : base;
};

/**
 * Начисление очков социальному советнику.
 * Возвращает { awarded, points, reason } — начисление может быть отклонено:
 * правило выключено, действие уже оплачено, достигнут предел или это самооценка.
 */
export function awardPoints({ userId, code, ideaId = null, proposalId = null, changeId = null,
                              sourceUserId = null, reason = null, awardedBy = null }) {
  if (!userId) return { awarded: false, points: 0, reason: 'Получатель не указан' };
  const r = rule(code);
  if (!r) return { awarded: false, points: 0, reason: 'Правило отключено администратором' };

  // Очки не начисляются за собственные действия
  if (sourceUserId && Number(sourceUserId) === Number(userId)) {
    return { awarded: false, points: 0, reason: 'Самооценка не учитывается' };
  }

  // Предел очков по одному объекту
  if (r.cap_per_target != null) {
    const target = changeId ? 'process_change_id' : proposalId ? 'proposal_id' : 'idea_id';
    const targetId = changeId ?? proposalId ?? ideaId;
    const earned = q.get(
      `SELECT COALESCE(SUM(points),0) AS s FROM points_ledger
       WHERE user_id=? AND rule_code=? AND ${target}=? AND status='approved'`,
      userId, code, targetId).s;
    if (earned + r.points > r.cap_per_target) {
      return { awarded: false, points: 0, reason: `Достигнут предел ${r.cap_per_target} очков по этому объекту` };
    }
  }

  const key = dedupKey(userId, code, ideaId, proposalId, sourceUserId, changeId);
  if (q.get('SELECT id FROM points_ledger WHERE dedup_key=?', key)) {
    return { awarded: false, points: 0, reason: 'Очки за это действие уже начислены' };
  }

  q.run(`INSERT INTO points_ledger
         (user_id, rule_code, points, idea_id, proposal_id, process_change_id,
          source_user_id, reason, awarded_by, dedup_key)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
    userId, code, r.points, ideaId, proposalId, changeId, sourceUserId, reason || r.title, awardedBy, key);

  refreshBadges(userId);
  sendNotification(userId, 'points', `Начислено ${r.points} ${pluralPoints(r.points)}`,
    reason || r.title, { idea_id: ideaId, process_change_id: changeId });
  return { awarded: true, points: r.points, reason: r.title };
}

function pluralPoints(n) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return 'очков';
  if (b > 1 && b < 5) return 'очка';
  if (b === 1) return 'очко';
  return 'очков';
}

/** Отмена начисления модератором при нарушении правил. */
export function revokePoints(entryId, byUser, reason) {
  const e = q.get('SELECT * FROM points_ledger WHERE id=?', entryId);
  if (!e) throw Object.assign(new Error('Начисление не найдено'), { status: 404 });
  if (e.status === 'revoked') throw Object.assign(new Error('Начисление уже отменено'), { status: 400 });
  q.run(`UPDATE points_ledger SET status='revoked', revoked_at=datetime('now'), revoked_by=?, revoke_reason=?
         WHERE id=?`, byUser, reason || null, entryId);
  notifyIdea(e.user_id, e.idea_id, 'points_revoked', 'Начисление очков отменено',
    reason || 'Модератор отменил начисление в связи с нарушением правил.');
  return q.get('SELECT * FROM points_ledger WHERE id=?', entryId);
}

// ─────────────────────────────────────────────────────────────
// Периоды и рейтинг
// ─────────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');

/** Границы периода для расчёта рейтинга: месяц, квартал, год или всё время. */
export function periodBounds(period = 'month', ref = new Date()) {
  const y = ref.getFullYear(), m = ref.getMonth();
  if (period === 'all') {
    return { period, from: '0001-01-01', to: '9999-12-31', label: 'За всё время' };
  }
  if (period === 'year') {
    return { period, from: `${y}-01-01`, to: `${y + 1}-01-01`, label: `${y} год` };
  }
  if (period === 'quarter') {
    const qn = Math.floor(m / 3);
    const from = new Date(y, qn * 3, 1), to = new Date(y, qn * 3 + 3, 1);
    return { period, from: iso(from), to: iso(to), label: `${qn + 1} квартал ${y}` };
  }
  const from = new Date(y, m, 1), to = new Date(y, m + 1, 1);
  const MONTHS = ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
  return { period: 'month', from: iso(from), to: iso(to), label: `${MONTHS[m]} ${y}` };
}
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Рейтинг социальных советников за период. institutionId ограничивает выборку учреждением. */
export function rating({ period = 'month', institutionId = null, limit = 100 } = {}) {
  const b = periodBounds(period);
  const args = [b.from, b.to];
  let where = '';
  if (institutionId) { where = 'AND u.institution_id = ?'; args.push(Number(institutionId)); }
  const rows = q.all(`
    SELECT u.id, u.full_name, u.role, u.position, inst.short_name AS institution,
           SUM(l.points) AS points,
           COUNT(l.id) AS entries,
           SUM(CASE WHEN l.rule_code='proposal.created' THEN 1 ELSE 0 END) AS proposals,
           SUM(CASE WHEN l.rule_code='experience.verified' THEN 1 ELSE 0 END) AS verified,
           SUM(CASE WHEN l.rule_code='proposal.implemented' THEN 1 ELSE 0 END) AS implemented,
           MAX(l.created_at) AS last_at
    FROM points_ledger l
    JOIN users u ON u.id = l.user_id
    LEFT JOIN institutions inst ON inst.id = u.institution_id
    WHERE l.status='approved' AND date(l.created_at) >= date(?) AND date(l.created_at) < date(?)
      AND u.is_active = 1 ${where}
    GROUP BY u.id
    ORDER BY points DESC, verified DESC, proposals DESC, u.full_name
    LIMIT ?`, ...args, limit);
  const badges = badgesByUser(rows.map((r) => r.id));
  return {
    ...b,
    items: rows.map((r, i) => ({ ...r, rank: i + 1, badges: badges[r.id] || [] })),
  };
}

function badgesByUser(ids) {
  if (!ids.length) return {};
  const rows = q.all(
    `SELECT user_id, code, title FROM advisor_badges WHERE user_id IN (${ids.map(() => '?').join(',')})`, ...ids);
  const out = {};
  for (const r of rows) (out[r.user_id] ||= []).push({ code: r.code, title: r.title });
  return out;
}

/** Сводка вклада участника — для профиля и проверки условий знаков отличия. */
export function advisorStats(userId) {
  const s = q.get(`
    SELECT
      (SELECT COUNT(*) FROM ideas WHERE author_id=?)                                   AS ideas,
      (SELECT COUNT(*) FROM proposals WHERE author_id=?)                               AS proposals,
      (SELECT COUNT(*) FROM proposals WHERE author_id=? AND status IN ('useful','implemented','verified')) AS useful,
      (SELECT COUNT(*) FROM proposals WHERE author_id=? AND status='verified')          AS verified,
      (SELECT COUNT(*) FROM proposals WHERE author_id=? AND status='implemented')       AS implemented,
      (SELECT COUNT(*) FROM proposal_endorsements e JOIN proposals p ON p.id=e.proposal_id
        WHERE p.author_id=? AND e.user_id != p.author_id)                               AS endorsements,
      (SELECT COALESCE(SUM(points),0) FROM points_ledger WHERE user_id=? AND status='approved') AS points
  `, userId, userId, userId, userId, userId, userId, userId);
  return s;
}

/** Пересчёт знаков отличия участника по фактическому вкладу. */
export function refreshBadges(userId) {
  const s = advisorStats(userId);
  const granted = [];
  for (const b of BADGES) {
    if (!b.test(s)) continue;
    if (q.get('SELECT id FROM advisor_badges WHERE user_id=? AND code=?', userId, b.code)) continue;
    q.run('INSERT INTO advisor_badges (user_id, code, title) VALUES (?,?,?)', userId, b.code, b.title);
    notifyIdea(userId, null, 'badge', `Получен знак отличия: ${b.title}`, b.hint);
    granted.push(b.code);
  }
  return granted;
}

// ─────────────────────────────────────────────────────────────
// Защита от дублей
// ─────────────────────────────────────────────────────────────
const STOP = new Set(['и','в','во','не','что','он','на','я','с','со','как','а','то','все','она','так',
  'его','но','да','ты','к','у','же','вы','за','бы','по','только','ее','мне','было','вот','от','меня',
  'еще','нет','о','из','ему','теперь','когда','даже','ну','вдруг','ли','если','уже','или','ни','быть',
  'был','него','до','вас','нибудь','опять','уж','вам','ведь','там','потом','себя','ничего','ей','может',
  'для','это','этот','эта','эти','чтобы','при','над','под','без','the','a','an','of','to']);

export function tokenize(text) {
  return String(text || '').toLowerCase()
    .replace(/[^a-zа-яё0-9\s]/gi, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    // Грубое усечение окончаний: «пандус», «пандусе», «пандусом» дают одну основу.
    // Точной морфологии здесь не нужно — это подсказка автору, а не поиск.
    .map((w) => w.slice(0, 5));
}

/** Мера схожести двух текстов (коэффициент Жаккара по значимым словам). */
export function similarity(a, b) {
  const A = new Set(tokenize(a)), B = new Set(tokenize(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/**
 * Похожие идеи — подсказка автору при подаче и модератору при разборе дублей.
 * Порог намеренно невысокий: пропущенный дубль дороже лишней подсказки,
 * а степень совпадения показывается рядом, чтобы человек решил сам.
 */
export function similarIdeas(text, excludeId = null, threshold = 0.16) {
  const rows = q.all(`SELECT id, number, title, problem, status FROM ideas
                      WHERE status NOT IN ('archived') ${excludeId ? 'AND id != ?' : ''}
                      ORDER BY id DESC LIMIT 300`, ...(excludeId ? [excludeId] : []));
  return rows
    .map((r) => ({ ...r, score: similarity(text, `${r.title} ${r.problem}`) }))
    .filter((r) => r.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((r) => ({ ...r, score: Math.round(r.score * 100) }));
}

/** Дублирующее предложение по той же идее — очки за копию не начисляются. */
export function findDuplicateProposal(ideaId, text, threshold = 0.62) {
  const rows = q.all('SELECT id, author_id, summary, how_to_apply FROM proposals WHERE idea_id=?', ideaId);
  for (const r of rows) {
    if (similarity(text, `${r.summary} ${r.how_to_apply || ''}`) >= threshold) return r;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// Быстрое ревью предложений
// ─────────────────────────────────────────────────────────────
export const REVIEW_VERDICTS = {
  like:     { title: 'Полезно',      tone: 'ok' },
  skip:     { title: 'Пропустить',   tone: 'muted' },
  favorite: { title: 'В избранное',  tone: 'purple' },
};

// Причины отрицательной оценки: короткий закрытый список, чтобы сигнал
// оставался сравнимым между предложениями и был полезен модератору.
export const SKIP_REASONS = {
  unclear:      'Неясно',
  costly:       'Дорого',
  risky:        'Рискованно',
  duplicate:    'Дубль',
  irrelevant:   'Неактуально',
  against_rules:'Противоречит регламентам',
};

/**
 * Проверка частоты оценок. Возвращает { ok } либо { ok: false, retryAfter }.
 * Пределы заданы настройками модуля и защищают от механического пролистывания.
 */
export function checkReviewRate(userId) {
  const cfg = settings();
  const perMinute = Number(cfg.review_per_minute) || 30;
  const perHour = Number(cfg.review_per_hour) || 300;
  const lastMinute = q.get(
    `SELECT COUNT(*) AS c FROM proposal_reviews
     WHERE user_id=? AND created_at >= datetime('now','-1 minute')`, userId).c;
  if (lastMinute >= perMinute) {
    return { ok: false, limit: perMinute, window: 'минуту', retryAfter: 60 };
  }
  const lastHour = q.get(
    `SELECT COUNT(*) AS c FROM proposal_reviews
     WHERE user_id=? AND created_at >= datetime('now','-1 hour')`, userId).c;
  if (lastHour >= perHour) {
    return { ok: false, limit: perHour, window: 'час', retryAfter: 600 };
  }
  return { ok: true };
}

/** Сигнал модератору о подозрительной активности. Повторные сигналы не дублируются. */
export function raiseReviewFlag(userId, kind, details) {
  const open = q.get(
    `SELECT id FROM review_flags WHERE user_id=? AND kind=? AND status='open'`, userId, kind);
  if (open) {
    q.run('UPDATE review_flags SET details=?, created_at=datetime(\'now\') WHERE id=?',
      JSON.stringify(details || null), open.id);
    return open.id;
  }
  const id = q.insert('INSERT INTO review_flags (user_id, kind, details) VALUES (?,?,?)',
    userId, kind, JSON.stringify(details || null));
  const who = q.get('SELECT full_name FROM users WHERE id=?', userId);
  const TITLES = {
    burst: 'Серия слишком быстрых оценок',
    rate_limit: 'Превышена частота оценок',
    shared_device: 'Оценки нескольких учётных записей с одного устройства',
  };
  notifyModerators(null, 'review_flag', `Антифрод: ${TITLES[kind] || kind}`,
    `Участник: ${who?.full_name || '—'}. Проверьте активность в разделе модерации.`);
  return id;
}

/**
 * Проверки после записи оценки: серия непрочитанных карточек и оценки
 * нескольких учётных записей с одного устройства.
 */
export function detectReviewAbuse(userId, device) {
  const cfg = settings();
  const minMs = Number(cfg.review_min_ms) || 800;
  const burst = Number(cfg.review_burst_limit) || 5;

  const recent = q.all(
    `SELECT dwell_ms FROM proposal_reviews WHERE user_id=? ORDER BY id DESC LIMIT ?`, userId, burst);
  if (recent.length === burst && recent.every((r) => r.dwell_ms !== null && r.dwell_ms < minMs)) {
    raiseReviewFlag(userId, 'burst', { count: burst, min_ms: minMs });
    return 'burst';
  }

  if (device) {
    const accounts = q.get(
      `SELECT COUNT(DISTINCT user_id) AS c FROM proposal_reviews WHERE device=?`, device).c;
    if (accounts > 1) {
      raiseReviewFlag(userId, 'shared_device', { device: String(device).slice(0, 24), accounts });
      return 'shared_device';
    }
  }
  return null;
}

/** Счётчики предложения после оценки — статистика обновляется сразу. */
export function reviewCounts(proposalId) {
  return q.get(`SELECT
      (SELECT COUNT(*) FROM proposal_reviews WHERE proposal_id=? AND verdict='like')     AS likes,
      (SELECT COUNT(*) FROM proposal_reviews WHERE proposal_id=? AND verdict='favorite') AS favorites,
      (SELECT COUNT(*) FROM proposal_reviews WHERE proposal_id=? AND verdict='skip')     AS skips`,
    proposalId, proposalId, proposalId);
}

/**
 * Показатель полезности предложения: лайк — единица, избранное — две,
 * потому что избранное поднимает предложение в очереди модератора.
 */
export const usefulnessSql = (alias = 'p') => `(
  (SELECT COUNT(*) FROM proposal_reviews rv WHERE rv.proposal_id = ${alias}.id AND rv.verdict='like')
  + 2 * (SELECT COUNT(*) FROM proposal_reviews rv WHERE rv.proposal_id = ${alias}.id AND rv.verdict='favorite')
)`;

// ─────────────────────────────────────────────────────────────
// Рекомендации к поощрению
// ─────────────────────────────────────────────────────────────
/**
 * Формирует рекомендации к поощрению по итогам периода.
 * Система только предлагает — решение принимает руководитель или уполномоченное лицо.
 */
export function buildIncentiveRecommendations({ period = 'month', proposedBy = null, institutionId = null } = {}) {
  const cfg = settings();
  const threshold = Number(cfg.incentive_threshold) || 40;
  const top = Number(cfg.incentive_top) || 5;
  const r = rating({ period, institutionId, limit: top });
  const created = [];

  for (const person of r.items) {
    if (person.points < threshold) continue;
    // Повторную рекомендацию за тот же период не создаём
    const exists = q.get(`SELECT id FROM incentives WHERE user_id=? AND period_label=? AND status != 'rejected'`,
      person.id, r.label);
    if (exists) continue;
    const type = suggestIncentiveType(person);
    if (!type) continue;
    const id = q.insert(`INSERT INTO incentives
      (user_id, type_code, period, period_label, points_at_creation, rank_at_creation, note, proposed_by)
      VALUES (?,?,?,?,?,?,?,?)`,
      person.id, type.code, r.period, r.label, person.points, person.rank,
      `${person.points} ${pluralPoints(person.points)} за период, ${person.rank} место в рейтинге социальных советников.`,
      proposedBy);
    created.push({ id, user_id: person.id, type_code: type.code });
    notifyIdea(person.id, null, 'incentive_proposed', 'Ваш вклад направлен руководителю',
      `Сформирована рекомендация к поощрению по итогам периода «${r.label}». Решение принимает руководитель.`);
  }

  if (created.length) {
    notifyIdeaRole('head', null, 'incentive_batch', 'Новые рекомендации к поощрению',
      `Сформировано рекомендаций: ${created.length}. Период: ${r.label}.`);
  }
  return { period: r.period, label: r.label, created, considered: r.items.length };
}

/** Подбор меры поощрения по характеру вклада. */
function suggestIncentiveType(person) {
  const active = q.all('SELECT * FROM incentive_types WHERE is_active=1 ORDER BY order_idx');
  const byCode = Object.fromEntries(active.map((t) => [t.code, t]));
  const preferred = person.implemented > 0 ? ['bonus', 'extra_day_off', 'head_gratitude']
    : person.verified > 0 ? ['certificate', 'training_priority', 'head_gratitude']
    : person.rank === 1 ? ['advisor_of_month', 'head_gratitude', 'public_praise']
    : ['head_gratitude', 'public_praise', 'advisor_of_month'];
  for (const code of preferred) if (byCode[code]) return byCode[code];
  return active[0] || null;
}

/**
 * Регулярное обслуживание модуля: обновление знаков отличия и формирование
 * рекомендаций к поощрению по итогам месяца.
 */
export function sweepIdeaHub() {
  const users = q.all(`SELECT DISTINCT user_id FROM points_ledger WHERE status='approved'`);
  let badges = 0;
  for (const u of users) badges += refreshBadges(u.user_id).length;
  const rec = buildIncentiveRecommendations({ period: 'month' });
  if (badges || rec.created.length) {
    logAction(null, 'ideahub.sweep', 'system', null,
      { badges, incentives: rec.created.length, period: rec.label }, 'system');
  }
  return { badges, incentives: rec.created.length };
}

// ─────────────────────────────────────────────────────────────
// Переходы статусов идеи
// ─────────────────────────────────────────────────────────────
export const MODERATION_ACTIONS = {
  approve:   { to: 'accepted',    title: 'Принять к обсуждению' },
  reject:    { to: 'rejected',    title: 'Отклонить' },
  clarify:   { to: 'review',      title: 'Запросить уточнение' },
  archive:   { to: 'archived',    title: 'Переместить в архив' },
  merge:     { to: 'archived',    title: 'Объединить с дублем' },
  progress:  { to: 'in_progress', title: 'Взять в работу' },
  complete:  { to: 'done',        title: 'Отметить реализованной' },
};

/** Перевод идеи в новый статус с записью в аудит и уведомлением автора. */
export function moderateIdea({ user, ideaId, action, note, duplicateOfId, ip }) {
  return tx(() => {
    const idea = q.get('SELECT * FROM ideas WHERE id=?', ideaId);
    if (!idea) throw Object.assign(new Error('Идея не найдена'), { status: 404 });
    const step = MODERATION_ACTIONS[action];
    if (!step) throw Object.assign(new Error('Неизвестное действие модерации'), { status: 400 });
    if ((action === 'reject' || action === 'clarify') && (!note || note.trim().length < 5)) {
      throw Object.assign(new Error('Укажите причину — она будет видна автору идеи'), { status: 400 });
    }
    if (action === 'merge' && !duplicateOfId) {
      throw Object.assign(new Error('Укажите идею, с которой объединяется дубль'), { status: 400 });
    }

    q.run(`UPDATE ideas SET status=?, moderation_note=?, moderated_by=?, moderated_at=datetime('now'),
           duplicate_of_id=?, updated_at=datetime('now'),
           closed_at = CASE WHEN ? IN ('rejected','archived','done') THEN datetime('now') ELSE closed_at END
           WHERE id=?`,
      step.to, note?.trim() || null, user.id,
      action === 'merge' ? Number(duplicateOfId) : idea.duplicate_of_id,
      step.to, idea.id);

    // Очки автору — только после того, как идея прошла проверку
    if (step.to === 'accepted') {
      awardPoints({ userId: idea.author_id, code: 'idea.approved', ideaId: idea.id,
        reason: `Идея ${idea.number} принята к обсуждению`, awardedBy: user.id });
    }

    const TITLES = {
      approve: 'принята к обсуждению', reject: 'отклонена', clarify: 'требует уточнения',
      archive: 'перемещена в архив', merge: 'объединена с похожей идеей',
      progress: 'взята в работу', complete: 'отмечена реализованной',
    };
    notifyIdea(idea.author_id, idea.id, `idea_${action}`,
      `Идея ${idea.number} ${TITLES[action]}`, note?.trim() || null);
    logAction(user.id, `idea.${action}`, 'idea', idea.id,
      { from: idea.status, to: step.to, note: note?.trim() || null }, ip);

    return q.get('SELECT * FROM ideas WHERE id=?', idea.id);
  });
}
