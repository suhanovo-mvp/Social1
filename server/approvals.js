// Согласование чего угодно: правки схемы процесса, проекта решения, документа.
//
// Состав листа не задаётся списком должностей, а выводится из самого предмета —
// но выводится по-разному: для правки схемы из затронутых дорожек, для проекта
// решения из его предмета и ролей, которых он касается. Поэтому машина листа
// (сроки, задачи, вердикты, эскалация) живёт здесь и одна на всех, а способ
// собрать состав регистрируется предметным модулем.
import { q, tx } from './db.js';
import { can, roleTitle } from './auth.js';
import { notify, notifyRole } from './notify.js';
import { dueDate, slaStateOf } from './sla.js';
import { logAction } from './audit.js';

export const VERDICTS = {
  agree:   { title: 'Согласовано',                tone: 'ok' },
  remarks: { title: 'Согласовано с замечаниями',  tone: 'warn' },
  reject:  { title: 'Не согласовано',             tone: 'stop' },
};

// Срок ответа по умолчанию — столько же, сколько на решение руководителя в конвейере
export const DEFAULT_SLA = { value: 5, unit: 'workdays' };

// ─────────────────────────────────────────────────────────────
// Стратегии предметных модулей
// ─────────────────────────────────────────────────────────────
const strategies = new Map();

/**
 * @param targetType   тип предмета согласования
 * @param build        (targetId) => { approvers: [{ role_code, user_id, reason, required }], sla }
 * @param describe     (targetId) => { title, subtitle, link, taskType } — для задач и уведомлений
 */
export function registerRoute(targetType, { build, describe }) {
  strategies.set(targetType, { build, describe });
}

const strategyFor = (targetType) => {
  const s = strategies.get(targetType);
  if (!s) throw new Error(`Маршрут согласования для «${targetType}» не зарегистрирован`);
  return s;
};

export const buildRoute = (targetType, targetId) => strategyFor(targetType).build(targetId);

// ─────────────────────────────────────────────────────────────
// Лист согласования
// ─────────────────────────────────────────────────────────────
/** Открыть согласование: лист, задачи в кабинетах и уведомления затронутым ролям. */
export function openSheet({ targetType, targetId, user = null, ip = null }) {
  const { build, describe } = strategyFor(targetType);
  const { approvers, sla = DEFAULT_SLA } = build(targetId);
  if (!approvers.length) {
    throw Object.assign(new Error('Не удалось определить согласующих: изменение не затрагивает ни одной роли'),
      { status: 400 });
  }
  const info = describe(targetId);
  const due = dueDate(null, sla.value, sla.unit);
  const units = sla.unit === 'workdays' ? 'рабочих дней' : 'календарных дней';

  return tx(() => {
    q.run('DELETE FROM approvals WHERE target_type = ? AND target_id = ?', targetType, targetId);
    approvers.forEach((a, i) => {
      q.insert(`INSERT INTO approvals
        (target_type, target_id, step_no, reason, role_code, user_id, institution_id, required, due_at)
        VALUES (?,?,?,?,?,?,?,?,?)`,
        targetType, targetId, i + 1, a.reason ?? null, a.role_code ?? null, a.user_id ?? null,
        a.institution_id ?? null, a.required === false ? 0 : 1, due);

      if (a.role_code) {
        q.run(`INSERT INTO tasks (user_id, role_target, type, title, due_at, ${linkColumn(info.link)})
               VALUES (NULL, ?, ?, ?, ?, ?)`,
          a.role_code, info.taskType, info.title, due, linkValue(info.link));
        notifyRole(a.role_code, a.institution_id ?? null, `${info.taskType}_pending`,
          info.title, `${info.subtitle} Срок — ${sla.value} ${units}.`, info.link);
      } else if (a.user_id) {
        q.run(`INSERT INTO tasks (user_id, type, title, due_at, ${linkColumn(info.link)})
               VALUES (?,?,?,?,?)`, a.user_id, info.taskType, info.title, due, linkValue(info.link));
        notify(a.user_id, `${info.taskType}_pending`, info.title,
          `${info.subtitle} Срок — ${sla.value} ${units}.`, info.link);
      }
    });
    logAction(user?.id ?? null, `${targetType}.approval.open`, targetType, targetId,
      { approvers: approvers.map((a) => a.role_code ?? a.user_id) }, ip);
    return sheet(targetType, targetId);
  });
}

// Привязка задач и уведомлений: у каждого предмета своя колонка-ссылка
const linkColumn = (link) => Object.keys(link)[0];
const linkValue = (link) => Object.values(link)[0];

export function sheet(targetType, targetId) {
  return q.all(`SELECT a.*, u.full_name AS decided_by_name
                FROM approvals a LEFT JOIN users u ON u.id = a.decided_by
                WHERE a.target_type = ? AND a.target_id = ?
                ORDER BY a.step_no`, targetType, Number(targetId))
    .map((r) => ({
      ...r,
      role_title: r.role_code ? roleTitle(r.role_code) : null,
      verdict_title: r.verdict ? VERDICTS[r.verdict]?.title : null,
      sla: slaStateOf(r.due_at, !r.verdict),
    }));
}

export const pendingCount = (targetType, targetId) =>
  q.get(`SELECT COUNT(*) AS c FROM approvals
         WHERE target_type = ? AND target_id = ? AND verdict IS NULL AND required = 1`,
    targetType, Number(targetId)).c;

const rolesOfUser = (user) => {
  const extra = user.extra_roles ? String(user.extra_roles).split(',') : [];
  return new Set([user.role, ...extra].filter(Boolean));
};

/**
 * Может ли участник поставить вердикт. Авторство проверяется раньше прав: это более
 * точная причина отказа и она не зависит от роли — иначе руководитель, предложивший
 * изменение, узнавал бы «недостаточно прав» вместо «автор не согласует сам себя».
 */
export function canDecide(user, { targetType, targetId, authorId, permission, open = true, closedReason }) {
  if (!open) return { ok: false, reason: closedReason ?? 'Предмет не на согласовании' };
  if (authorId && authorId === user.id) {
    return { ok: false, reason: 'Автор не согласует собственное предложение' };
  }
  const mine = rolesOfUser(user);
  const row = q.all(`SELECT * FROM approvals
                     WHERE target_type = ? AND target_id = ? AND verdict IS NULL`,
    targetType, Number(targetId))
    .find((a) => a.user_id === user.id || (a.role_code && mine.has(a.role_code)));
  if (!row) return { ok: false, reason: 'Ваша роль не входит в лист согласования или уже высказалась' };

  // Право спрашивается только у строк, попавших в лист по роли. Участника, названного
  // поимённо, туда поставили осознанно: заказчик рецензирует решение своей проблемы
  // не потому, что он рецензент по должности, а потому, что это его проблема.
  if (row.role_code && permission && !can(user, permission)) {
    return { ok: false, reason: 'Недостаточно прав' };
  }
  return { ok: true, row };
}

/**
 * Записать вердикт. Возвращает исход для предметного модуля: он решает, что значит
 * «отклонено» и «согласовано полностью» для его сущности.
 *
 * Аргументация обязательна при отказе и замечаниях: автору нужно знать, что именно
 * исправить, а не только сам факт отказа.
 */
export function decide({ targetType, targetId, user, verdict, comment = null, row, ip = null }) {
  if (!VERDICTS[verdict]) {
    throw Object.assign(new Error(`Неизвестный вердикт «${verdict}»`), { status: 400 });
  }
  if (verdict !== 'agree' && (!comment || comment.trim().length < 10)) {
    throw Object.assign(new Error('Укажите причину: не менее 10 символов. Автору нужно знать, что исправить'),
      { status: 400 });
  }
  q.run(`UPDATE approvals SET verdict = ?, comment = ?, decided_by = ?, decided_at = datetime('now')
         WHERE id = ?`, verdict, comment?.trim() || null, user.id, row.id);
  logAction(user.id, `${targetType}.approval.${verdict}`, targetType, targetId, { comment }, ip);

  if (verdict === 'reject') return { outcome: 'rejected', sheet: sheet(targetType, targetId) };
  const left = pendingCount(targetType, targetId);
  return {
    outcome: left === 0 ? 'accepted' : 'pending',
    pending: left,
    sheet: sheet(targetType, targetId),
  };
}

/** Закрыть открытые задачи согласования по предмету. */
export function closeTasks(link, taskType) {
  q.run(`UPDATE tasks SET status = 'done', completed_at = datetime('now')
         WHERE ${linkColumn(link)} = ? AND type = ? AND status = 'open'`,
    linkValue(link), taskType);
}

// ─────────────────────────────────────────────────────────────
// Просроченные согласования
// ─────────────────────────────────────────────────────────────
/**
 * Эскалация просрочек — по тем же правилам, что и точки принятия решений в
 * конвейере: задача помечается просроченной, координатор получает уведомление.
 *
 * @param isOpen (targetType, targetId) => boolean — предмет ещё на согласовании?
 */
export function sweepOverdue(isOpen = () => true) {
  const overdue = q.all(`SELECT * FROM approvals
                         WHERE verdict IS NULL AND due_at IS NOT NULL AND due_at < datetime('now')`);
  let escalated = 0;
  for (const a of overdue) {
    if (!isOpen(a.target_type, a.target_id)) continue;
    const { describe } = strategies.get(a.target_type) ?? {};
    if (!describe) continue;
    const info = describe(a.target_id);
    const open = q.all(`SELECT id FROM tasks
                        WHERE ${linkColumn(info.link)} = ? AND role_target = ? AND status = 'open'`,
      linkValue(info.link), a.role_code);
    for (const t of open) {
      q.run("UPDATE tasks SET status = 'escalated' WHERE id = ?", t.id);
      escalated += 1;
    }
    if (open.length) {
      notifyRole('dtszn', null, `${info.taskType}_overdue`,
        `Просрочено согласование: ${info.title}`,
        `Роль «${roleTitle(a.role_code)}» не ответила в срок.`, info.link);
      logAction(null, `${a.target_type}.approval.overdue`, a.target_type, a.target_id,
        { role: a.role_code, due: a.due_at }, 'system');
    }
  }
  return { overdue: overdue.length, escalated };
}
