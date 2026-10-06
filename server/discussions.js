// Обсуждение чего угодно с привязкой к месту внутри предмета.
//
// Замечание к шагу схемы и замечание к разделу документа — одно и то же действие:
// человек показывает пальцем на конкретное место и говорит, что с ним не так.
// Разговор о конкретном месте не тонет в общей ленте, и на схеме или в документе
// видно, где именно жмёт. Поэтому механика одна, а предметные модули добавляют
// поверх только проверку, что якорь существует.
import { q } from './db.js';
import { logAction } from './audit.js';
import { can } from './auth.js';

export class DiscussionError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

const SELECT = `SELECT c.*, c.anchor_id AS node_id,
                       u.full_name AS author_name, u.role AS author_role,
                       (SELECT COUNT(*) FROM discussion_votes v WHERE v.discussion_id = c.id) AS useful
                FROM discussions c JOIN users u ON u.id = c.author_id`;

export const byId = (id) => q.get(`${SELECT} WHERE c.id = ?`, Number(id));

export function add({ targetType, targetId, contextId = null, anchorKind = null, anchorId = null,
                      parentId = null, body, user, ip = null }) {
  if (!body?.trim()) throw new DiscussionError('Замечание не может быть пустым');
  const id = q.insert(`INSERT INTO discussions
    (target_type, target_id, context_id, anchor_kind, anchor_id, parent_id, author_id, body)
    VALUES (?,?,?,?,?,?,?,?)`,
    targetType, Number(targetId), contextId, anchorKind, anchorId, parentId, user.id, body.trim());
  logAction(user.id, `${targetType}.comment`, targetType, Number(targetId),
    { anchor: anchorId, discussion: id }, ip);
  return byId(id);
}

export function list({ targetType, targetId, anchorId = null, includeResolved = false }) {
  const where = ['c.target_type = ?', 'c.target_id = ?'];
  const args = [targetType, Number(targetId)];
  if (anchorId) { where.push('c.anchor_id = ?'); args.push(anchorId); }
  if (!includeResolved) where.push("c.status = 'open'");
  return q.all(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY c.created_at`, ...args);
}

/** Сколько открытых замечаний висит на каждом якоре — метки прямо на схеме или в документе. */
export function countsByAnchor(targetType, targetId) {
  const rows = q.all(`SELECT anchor_id, COUNT(*) AS count FROM discussions
                      WHERE target_type = ? AND target_id = ? AND anchor_id IS NOT NULL
                        AND status = 'open'
                      GROUP BY anchor_id`, targetType, Number(targetId));
  return Object.fromEntries(rows.map((r) => [r.anchor_id, r.count]));
}

export function markUseful({ id, user }) {
  const c = byId(id);
  if (!c) throw new DiscussionError('Замечание не найдено');
  if (c.author_id === user.id) throw new DiscussionError('Своё замечание отмечать нельзя');
  q.run(`INSERT INTO discussion_votes (discussion_id, user_id) VALUES (?,?)
         ON CONFLICT(discussion_id, user_id) DO NOTHING`, id, user.id);
  return byId(id);
}

export function resolve({ id, user, permission = null, ip = null }) {
  const c = byId(id);
  if (!c) throw new DiscussionError('Замечание не найдено');
  if (c.author_id !== user.id && permission && !can(user, permission)) {
    throw new DiscussionError('Закрыть замечание может автор или ответственный');
  }
  q.run(`UPDATE discussions SET status = 'resolved', resolved_by = ?, resolved_at = datetime('now')
         WHERE id = ?`, user.id, id);
  logAction(user.id, `${c.target_type}.comment.resolve`, c.target_type, c.target_id, null, ip);
  return byId(id);
}
