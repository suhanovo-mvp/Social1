// События платформы: что произошло и кто на это откликается.
//
// До появления этого слоя модули дёргали друг друга напрямую: публикация изменения
// внутри себя начисляла очки, слала уведомления и пересобирала конвейер. Пока
// откликов один-два, это читается; когда их пять и они из разных модулей —
// перестаёт. Событие разворачивает зависимость: публикация сообщает, что
// произошло, а кто на это отзывается — дело подписчиков.
//
// Доставка синхронная и в той же транзакции. Асинхронная на SQLite дала бы гонки
// при записи, а «сделано» в интерфейсе означало бы «возможно, сделано».
import { q } from './db.js';

const handlers = new Map();

/**
 * Подписка. Имя обработчика попадает в журнал сбоев, поэтому оно должно говорить,
 * кто именно упал: 'knowledge:создать задачу по принятому проекту решения'.
 */
export function on(type, name, handler) {
  if (!handlers.has(type)) handlers.set(type, []);
  handlers.get(type).push({ name, handler });
}

/** Снять все подписки — нужно тестам, чтобы наборы не влияли друг на друга. */
export function reset() { handlers.clear(); }

export const subscriptions = () =>
  [...handlers].map(([type, list]) => ({ type, handlers: list.map((h) => h.name) }));

/**
 * Сообщить о произошедшем. Событие записывается всегда, даже если подписчиков нет:
 * журнал событий — источник для метрик времени в состоянии, а не только шина.
 *
 * Упавший обработчик не роняет исходное действие: иначе сбой начисления очков
 * отменил бы публикацию решения. Сбой пишется в event_failures — молча не теряется.
 */
export function emit(type, { subjectType, subjectId = null, actorId = null,
                             from = null, to = null, ...payload } = {}) {
  const eventId = q.insert(
    `INSERT INTO events (type, subject_type, subject_id, actor_id, from_state, to_state, payload)
     VALUES (?,?,?,?,?,?,?)`,
    type, subjectType, subjectId, actorId, from, to,
    Object.keys(payload).length ? JSON.stringify(payload) : null);

  const event = { id: eventId, type, subjectType, subjectId, actorId, from, to, ...payload };
  for (const { name, handler } of handlers.get(type) ?? []) {
    try {
      handler(event);
    } catch (e) {
      q.run('INSERT INTO event_failures (event_id, handler, message) VALUES (?,?,?)',
        eventId, name, String(e?.message ?? e).slice(0, 500));
      console.error(`Событие ${type}: обработчик «${name}» не выполнен — ${e?.message ?? e}`);
    }
  }
  return event;
}

// ─────────────────────────────────────────────────────────────
// Чтение
// ─────────────────────────────────────────────────────────────
export function eventsOf(subjectType, subjectId, limit = 200) {
  return q.all(`SELECT * FROM events WHERE subject_type = ? AND subject_id = ?
                ORDER BY id LIMIT ?`, subjectType, Number(subjectId), limit)
    .map((e) => ({ ...e, payload: e.payload ? JSON.parse(e.payload) : null }));
}

/**
 * Сколько предмет пробыл в каждом состоянии — метрика Cycle Time из исследования.
 * Считается по переходам: время от входа в состояние до следующего перехода, а для
 * последнего — до текущего момента, если предмет ещё живёт.
 *
 * @param finished состояния, в которых отсчёт прекращается
 */
export function timeInStates(subjectType, subjectId, { finished = [] } = {}) {
  const rows = q.all(`SELECT to_state, at FROM events
                      WHERE subject_type = ? AND subject_id = ? AND to_state IS NOT NULL
                      ORDER BY id`, subjectType, Number(subjectId));
  const spent = {};
  rows.forEach((row, i) => {
    const next = rows[i + 1];
    if (!next && finished.includes(row.to_state)) return;   // дошло до конца — не копим
    const from = new Date(row.at.replace(' ', 'T') + 'Z').getTime();
    const to = next ? new Date(next.at.replace(' ', 'T') + 'Z').getTime() : Date.now();
    spent[row.to_state] = (spent[row.to_state] ?? 0) + (to - from) / 36e5;
  });
  return spent;
}

/** Среднее время в каждом состоянии по всем предметам типа — поиск узких мест. */
export function bottlenecks(subjectType, { finished = [] } = {}) {
  const subjects = q.all(`SELECT DISTINCT subject_id FROM events
                          WHERE subject_type = ? AND to_state IS NOT NULL`, subjectType);
  const totals = {};
  for (const { subject_id } of subjects) {
    for (const [state, hours] of Object.entries(timeInStates(subjectType, subject_id, { finished }))) {
      (totals[state] ??= { state, subjects: 0, hours: 0 });
      totals[state].subjects += 1;
      totals[state].hours += hours;
    }
  }
  return Object.values(totals)
    .map((t) => ({ state: t.state, subjects: t.subjects, avg_hours: t.hours / t.subjects }))
    .sort((a, b) => b.avg_hours - a.avg_hours);
}

export const recentFailures = (limit = 50) =>
  q.all(`SELECT f.*, e.type FROM event_failures f LEFT JOIN events e ON e.id = f.event_id
         ORDER BY f.id DESC LIMIT ?`, limit);
