// Расчёт и состояние сроков. Общий примитив: по нему живут и точки принятия решений
// конвейера, и согласование изменений процессов.
export const iso = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

/** Разбор времени в формате хранения SQLite как UTC. */
export const parseSql = (v) => new Date(String(v).replace(' ', 'T') + 'Z');

// Единицы срока живут в общей модели схемы: там же, где проверяется этап конвейера
export { SLA_UNITS } from '../shared/bpmn/model.js';

export function addWorkdays(from, days) {
  const d = new Date(from);
  let left = days;
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return d;
}

export function dueDate(fromISO, value, unit) {
  if (!value || !unit) return null;
  const from = parseSql(fromISO || iso(new Date()));
  const d = unit === 'workdays' ? addWorkdays(from, value) : new Date(from.getTime() + value * 864e5);
  return iso(d);
}

/**
 * Состояние срока: в рамках, риск нарушения (менее суток) или нарушен.
 * @param dueAt срок в формате хранения; null — срок не задан
 * @param active следят ли за сроком сейчас (остановленное дело срок не нарушает)
 */
export function slaStateOf(dueAt, active = true) {
  if (!dueAt || !active) return { code: 'none', label: '—' };
  const hoursLeft = (parseSql(dueAt).getTime() - Date.now()) / 36e5;
  if (hoursLeft < 0) return { code: 'breached', label: 'SLA нарушен', hoursLeft };
  if (hoursLeft < 24) return { code: 'risk', label: 'Риск нарушения SLA', hoursLeft };
  return { code: 'ok', label: 'В рамках SLA', hoursLeft };
}

/** Сколько часов прошло с указанного момента. */
export const hoursSince = (sqlTime) => (Date.now() - parseSql(sqlTime).getTime()) / 36e5;
