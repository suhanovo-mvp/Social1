// Уведомления и подбор адресатов по ролям.
// Раньше эта механика существовала в двух видах: конвейер писал уведомления со ссылкой
// на инициативу, модуль идей — со ссылкой на идею, и запрос «найти всех в роли»
// был написан дважды. Здесь одно ядро, а привязка к сущности передаётся ссылками.
import { q } from './db.js';

// К чему уведомление может вести. Список закрытый: значения подставляются в SQL
// как имена колонок, и принимать их из вызова без проверки нельзя.
const LINK_COLUMNS = ['initiative_id', 'idea_id', 'process_change_id', 'knowledge_doc_id', 'provider_id'];

/**
 * @param links привязка уведомления, любые из LINK_COLUMNS
 */
export function notify(userId, type, title, body, links = {}) {
  if (!userId) return;
  const used = LINK_COLUMNS.filter((c) => links[c] != null);
  const unknown = Object.keys(links).filter((k) => !LINK_COLUMNS.includes(k));
  if (unknown.length) throw new Error(`Неизвестная привязка уведомления: ${unknown.join(', ')}`);

  const columns = ['user_id', ...used, 'type', 'title', 'body'];
  q.run(`INSERT INTO notifications (${columns.join(', ')})
         VALUES (${columns.map(() => '?').join(',')})`,
    userId, ...used.map((c) => links[c]), type, title, body ?? null);
}

/** Активные участники роли, при указанном учреждении — только его сотрудники. */
export function usersInRole(role, institutionId = null) {
  return institutionId
    ? q.all('SELECT id FROM users WHERE role = ? AND institution_id = ? AND is_active = 1', role, institutionId)
    : q.all('SELECT id FROM users WHERE role = ? AND is_active = 1', role);
}

export function notifyRole(role, institutionId, type, title, body, links = {}) {
  const users = usersInRole(role, institutionId);
  for (const u of users) notify(u.id, type, title, body, links);
  return users.length;
}
