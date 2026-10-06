// Совместная работа над процессами: обсуждение шагов схемы, предложения об изменении,
// поддержка коллег, согласование теми, чью работу изменение затрагивает.
//
// Замысел модуля: сотрудник, который каждый день упирается в лишний шаг, может не
// писать служебную записку, а показать на схеме, что именно убрать, — и провести это
// через согласование. Предложение несёт готовую версию схемы, а не текст пожеланий,
// поэтому обсуждают и утверждают ровно то, что будет опубликовано.
import { q, tx } from './db.js';
import { logAction } from './audit.js';
import { can, roleTitle } from './auth.js';
import { notify, notifyRole } from './notify.js';

import { awardPoints } from './ideahub.js';
import * as repo from './process-repo.js';
import * as approvals from './approvals.js';
import * as discussions from './discussions.js';
import { emit } from './events.js';
import { diffModels, summarize, laneTitlesOf } from '../shared/bpmn/diff.js';

export class ChangeError extends Error {
  constructor(message, details) { super(message); this.status = 400; this.details = details; }
}

export const CHANGE_STATUS = {
  draft:      { title: 'Черновик',        tone: 'muted',  order: 1 },
  discussion: { title: 'Обсуждается',     tone: 'info',   order: 2 },
  approval:   { title: 'На согласовании', tone: 'warn',   order: 3 },
  accepted:   { title: 'Согласовано',     tone: 'accent', order: 4 },
  published:  { title: 'Вступило в силу', tone: 'ok',     order: 5 },
  rejected:   { title: 'Отклонено',       tone: 'muted',  order: 6 },
  withdrawn:  { title: 'Отозвано',        tone: 'muted',  order: 7 },
};

// Вердикты и сроки — общие для всех согласований платформы
export const VERDICTS = approvals.VERDICTS;
const DEFAULT_SLA = approvals.DEFAULT_SLA;

// Статусы, в которых предложение ещё можно править и отзывать
const OPEN_STATUSES = ['draft', 'discussion', 'approval'];

// ─────────────────────────────────────────────────────────────
// Номера
// ─────────────────────────────────────────────────────────────
export function nextChangeNumber() {
  const year = new Date().getFullYear();
  const last = q.get('SELECT number FROM process_changes WHERE number LIKE ? ORDER BY id DESC LIMIT 1',
    `PRC-${year}-%`);
  const n = last ? Number(last.number.split('-')[2]) + 1 : 1;
  return `PRC-${year}-${String(n).padStart(4, '0')}`;
}

// ─────────────────────────────────────────────────────────────
// Предложения
// ─────────────────────────────────────────────────────────────
/**
 * Завести предложение об изменении. Черновик схемы создаётся копией действующей
 * версии — автор правит его в редакторе, а не описывает правку словами.
 */
export function createChange({ defKey, title, rationale, expectedEffect = null,
                               user, ideaId = null, initiativeId = null, ip = null }) {
  const def = repo.defByKey(defKey);
  if (!def) throw new ChangeError('Процесс не найден');
  if (!title?.trim()) throw new ChangeError('Укажите, что предлагается изменить');
  if (!rationale || rationale.trim().length < 20) {
    throw new ChangeError('Обоснование обязательно — не менее 20 символов. ' +
      'Согласующие читают именно его, а не только схему');
  }

  return tx(() => {
    const base = repo.currentVersion(def.id);
    const draft = repo.createDraft({
      defId: def.id, basedOnVersionId: base.id, userId: user.id,
      notes: `Предложение об изменении: ${title.trim()}`,
    });
    const number = nextChangeNumber();
    const id = q.insert(`INSERT INTO process_changes
      (number, def_id, base_version_id, draft_version_id, title, rationale, expected_effect,
       author_id, institution_id, status, idea_id, initiative_id)
      VALUES (?,?,?,?,?,?,?,?,?,'draft',?,?)`,
      number, def.id, base.id, draft.id, title.trim(), rationale.trim(),
      expectedEffect?.trim() || null, user.id, user.institution_id ?? null, ideaId, initiativeId);

    logAction(user.id, 'process.change.create', 'process_change', id,
      { number, def: def.key }, ip);
    return getChange(id);
  });
}

export function getChange(id) {
  const row = q.get(`SELECT c.*, d.key AS def_key, d.title AS def_title, d.is_pipeline,
                            u.full_name AS author_name, u.role AS author_role,
                            inst.short_name AS institution
                     FROM process_changes c
                     JOIN process_defs d ON d.id = c.def_id
                     JOIN users u ON u.id = c.author_id
                     LEFT JOIN institutions inst ON inst.id = c.institution_id
                     WHERE c.id = ?`, Number(id));
  return row || null;
}

export const changeByNumber = (number) =>
  getChange(q.get('SELECT id FROM process_changes WHERE number = ?', number)?.id);

export function listChanges({ status = null, defKey = null, authorId = null, limit = 100 } = {}) {
  const where = [], args = [];
  if (status) { where.push('c.status = ?'); args.push(status); }
  if (defKey) { where.push('d.key = ?'); args.push(defKey); }
  if (authorId) { where.push('c.author_id = ?'); args.push(Number(authorId)); }
  return q.all(`SELECT c.id, c.number, c.title, c.status, c.created_at, c.submitted_at,
                       c.rationale, c.expected_effect,
                       d.key AS def_key, d.title AS def_title, d.is_pipeline,
                       u.full_name AS author_name, u.role AS author_role,
                       inst.short_name AS institution,
                       (SELECT COALESCE(SUM(value), 0) FROM process_change_votes v
                        WHERE v.change_id = c.id) AS support,
                       (SELECT COUNT(*) FROM process_change_votes v WHERE v.change_id = c.id) AS voters,
                       (SELECT COUNT(*) FROM discussions d
                        WHERE d.target_type = 'process_change' AND d.target_id = c.id) AS comments,
                       (SELECT COUNT(*) FROM approvals a
                        WHERE a.target_type = 'process_change' AND a.target_id = c.id
                          AND a.verdict IS NULL) AS pending_approvals
                FROM process_changes c
                JOIN process_defs d ON d.id = c.def_id
                JOIN users u ON u.id = c.author_id
                LEFT JOIN institutions inst ON inst.id = c.institution_id
                ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                ORDER BY c.created_at DESC LIMIT ?`, ...args, Number(limit));
}

/** Правка схемы предложения. Доступна автору, пока предложение не ушло на согласование. */
export function saveChangeModel({ changeId, model, user, ip = null }) {
  const c = getChange(changeId);
  if (!c) throw new ChangeError('Предложение не найдено');
  if (!['draft', 'discussion'].includes(c.status)) {
    throw new ChangeError('Схему нельзя править после отправки на согласование');
  }
  if (c.author_id !== user.id && !can(user, 'process.admin')) {
    throw new ChangeError('Править схему предложения может только его автор');
  }
  repo.saveDraft({ versionId: c.draft_version_id, model, userId: user.id });
  q.run("UPDATE process_changes SET updated_at = datetime('now') WHERE id = ?", changeId);
  logAction(user.id, 'process.change.edit', 'process_change', changeId, { number: c.number }, ip);
  return changeDiff(changeId);
}

/** Изменение относительно действующей версии: структурное различие и сводка. */
export function changeDiff(changeId) {
  const c = getChange(changeId);
  if (!c) throw new ChangeError('Предложение не найдено');
  const base = repo.getVersion(c.base_version_id);
  const draft = repo.getVersion(c.draft_version_id);
  const diff = diffModels(base.model, draft.model);
  return {
    diff,
    summary: summarize(diff, laneTitlesOf(draft.model)),
    base_version: base.version,
    issues: repo.validateForPublish(c.draft_version_id),
  };
}

// ─────────────────────────────────────────────────────────────
// Вынесение на обсуждение
// ─────────────────────────────────────────────────────────────
export function submitForDiscussion({ changeId, user, ip = null }) {
  const c = getChange(changeId);
  if (!c) throw new ChangeError('Предложение не найдено');
  if (c.status !== 'draft') throw new ChangeError('Предложение уже вынесено на обсуждение');
  if (c.author_id !== user.id && !can(user, 'process.admin')) {
    throw new ChangeError('Вынести предложение может только его автор');
  }

  const { diff, issues } = changeDiff(changeId);
  if (!diff.hasSemanticChanges) {
    throw new ChangeError('В схеме нет содержательных изменений — обсуждать нечего');
  }
  if (issues.length) {
    throw new ChangeError('Схема предложения не проходит проверку — исправьте замечания', issues);
  }

  q.run(`UPDATE process_changes SET status = 'discussion', submitted_at = datetime('now'),
         updated_at = datetime('now') WHERE id = ?`, changeId);
  emit('process_change.status.changed', { subjectType: 'process_change', subjectId: changeId,
    actorId: user.id, from: 'draft', to: 'discussion', number: c.number });
  awardPoints({ userId: c.author_id, code: 'process.change.proposed', changeId,
                reason: `Предложение ${c.number}: ${c.title}` });

  // Зовём тех, чью работу изменение затрагивает: обсуждение начинается до согласования
  for (const role of rolesForLanes(changeId)) {
    notifyRole(role, null, 'process_change_discussion',
      `Предложено изменение процесса: ${c.def_title}`,
      `${c.number} «${c.title}». Изменение затрагивает вашу зону ответственности — посмотрите и выскажитесь.`,
      { process_change_id: changeId });
  }
  logAction(user.id, 'process.change.submit', 'process_change', changeId, { number: c.number }, ip);
  return getChange(changeId);
}

export function withdrawChange({ changeId, user, note = null, ip = null }) {
  const c = getChange(changeId);
  if (!c) throw new ChangeError('Предложение не найдено');
  if (!OPEN_STATUSES.includes(c.status)) throw new ChangeError('Предложение уже закрыто');
  if (c.author_id !== user.id && !can(user, 'process.admin')) {
    throw new ChangeError('Отозвать предложение может только его автор');
  }
  q.run(`UPDATE process_changes SET status = 'withdrawn', decision_note = ?,
         decided_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`, note, changeId);
  closeApprovalTasks(changeId);
  logAction(user.id, 'process.change.withdraw', 'process_change', changeId, { note }, ip);
  return getChange(changeId);
}

// ─────────────────────────────────────────────────────────────
// Поддержка коллег
// ─────────────────────────────────────────────────────────────
export function vote({ changeId, user, value = 1, comment = null }) {
  const c = getChange(changeId);
  if (!c) throw new ChangeError('Предложение не найдено');
  if (!['discussion', 'approval'].includes(c.status)) {
    throw new ChangeError('Голосование открыто, пока предложение обсуждается');
  }
  q.run(`INSERT INTO process_change_votes (change_id, user_id, value, comment) VALUES (?,?,?,?)
         ON CONFLICT(change_id, user_id) DO UPDATE SET value = excluded.value,
           comment = excluded.comment, created_at = datetime('now')`,
    changeId, user.id, value >= 0 ? 1 : -1, comment);
  return voteSummary(changeId, user.id);
}

export function unvote({ changeId, user }) {
  q.run('DELETE FROM process_change_votes WHERE change_id = ? AND user_id = ?', changeId, user.id);
  return voteSummary(changeId, user.id);
}

export function voteSummary(changeId, userId = null) {
  const rows = q.all('SELECT value FROM process_change_votes WHERE change_id = ?', changeId);
  return {
    support: rows.filter((r) => r.value > 0).length,
    against: rows.filter((r) => r.value < 0).length,
    my: userId ? q.get('SELECT value FROM process_change_votes WHERE change_id = ? AND user_id = ?',
      changeId, userId)?.value ?? null : null,
  };
}

// ─────────────────────────────────────────────────────────────
// Обсуждение шагов схемы
// ─────────────────────────────────────────────────────────────
/**
 * Замечание к схеме. Привязывается к шагу или переходу — разговор о конкретной
 * фигуре не тонет в общей ленте, и на схеме видно, где именно жмёт.
 */
export function addComment({ defKey, changeId = null, nodeId = null, flowId = null,
                             parentId = null, body, user, ip = null }) {
  const def = repo.defByKey(defKey);
  if (!def) throw new ChangeError('Процесс не найден');
  if (!body?.trim()) throw new ChangeError('Замечание не может быть пустым');

  const version = repo.currentVersion(def.id);
  if (nodeId && !version.model.nodes.some((n) => n.id === nodeId)) {
    throw new ChangeError('Шаг, к которому привязано замечание, отсутствует в схеме');
  }

  // Замечание к схеме и реплика внутри предложения — разные цели обсуждения
  return discussions.add({
    targetType: changeId ? 'process_change' : 'process',
    targetId: changeId ?? def.id,
    contextId: version.id,
    anchorKind: nodeId ? 'node' : flowId ? 'flow' : null,
    anchorId: nodeId ?? flowId ?? null,
    parentId, body, user, ip,
  });
}

export const commentById = discussions.byId;

export function comments({ defKey, changeId = null, nodeId = null, includeResolved = false,
                            targetType = null, targetId = null }) {
  // Документ базы знаний и прочие предметы адресуются напрямую; схема — по ключу
  if (targetType) return discussions.list({ targetType, targetId, anchorId: nodeId, includeResolved });
  const def = repo.defByKey(defKey);
  if (!def) throw new ChangeError('Процесс не найден');
  return discussions.list({
    targetType: changeId ? 'process_change' : 'process',
    targetId: changeId ?? def.id,
    anchorId: nodeId, includeResolved,
  });
}

/** Сколько открытых замечаний висит на каждом шаге — метки прямо на схеме. */
export function commentCountsByNode(defKey) {
  const def = repo.defByKey(defKey);
  if (!def) return {};
  return discussions.countsByAnchor('process', def.id);
}

export function markCommentUseful({ commentId, user }) {
  const c = discussions.markUseful({ id: commentId, user });
  awardPoints({ userId: c.author_id, code: 'process.comment.useful',
                changeId: c.target_type === 'process_change' ? c.target_id : null,
                sourceUserId: user.id, reason: 'Замечание к схеме признано полезным' });
  return discussions.byId(commentId);
}

export const resolveComment = ({ commentId, user, ip = null }) =>
  discussions.resolve({ id: commentId, user, permission: 'process.edit', ip });

// ─────────────────────────────────────────────────────────────
// Маршрут согласования
// ─────────────────────────────────────────────────────────────
/** Роли, отвечающие за дорожки, которых касается изменение. */
export function rolesForLanes(changeId) {
  const c = getChange(changeId);
  const draft = repo.getVersion(c.draft_version_id);
  const base = repo.getVersion(c.base_version_id);
  const diff = diffModels(base.model, draft.model);

  // Дорожка знает свою роль явно; если не задана — берём по совпадению идентификатора
  // с ролью платформы, как в исходных схемах альбома
  const lanes = new Map([...base.model.lanes, ...draft.model.lanes].map((l) => [l.id, l]));
  const roles = new Set();
  for (const laneId of diff.touchedLanes) {
    const lane = lanes.get(laneId);
    const role = lane?.role || LANE_ROLE[laneId] || null;
    if (role) roles.add(role);
  }
  return [...roles];
}

// Соответствие дорожек альбома ролям платформы. Дорожки схем заведены под
// человеческие названия ролей, и явная привязка появляется только у схем,
// нарисованных в редакторе, — для остальных сопоставление задано здесь.
const LANE_ROLE = {
  emp: 'employee', head: 'head', expert: 'expert', dev: 'developer',
  supplier: 'supplier', pilot: 'pilot_coordinator', dtszn: 'dtszn',
  adv: 'employee', rev: 'employee', mod: 'expert',
  sys: null,   // платформа сама себя не согласует
};

/**
 * Собрать лист согласования. Состав выводится из изменения: согласуют те, чью
 * работу оно меняет. Сверх этого маршрут может требовать постоянных участников —
 * например, центральный аппарат для конвейера инициатив.
 */
export function buildApprovalRoute(changeId) {
  const c = getChange(changeId);
  const route = q.get(`SELECT * FROM process_approval_routes
                       WHERE def_id = ? OR (def_id IS NULL AND scenario = ?)
                       ORDER BY def_id IS NULL LIMIT 1`,
    c.def_id, q.get('SELECT scenario FROM process_defs WHERE id = ?', c.def_id)?.scenario ?? null);

  const always = route ? JSON.parse(route.always || '[]') : [];
  // Изменение конвейера всегда идёт через центральный аппарат: этапы и сроки
  // Stage-Gate заданы регламентом, а не только удобством участников
  const mandatory = c.is_pipeline ? ['dtszn'] : [];

  const fromLanes = rolesForLanes(changeId);
  const roles = [...new Set([...fromLanes, ...always, ...mandatory])]
    .filter((r) => r && r !== c.author_role);   // автор не согласует сам себя

  const sla = { value: route?.sla_value ?? DEFAULT_SLA.value, unit: route?.sla_unit ?? DEFAULT_SLA.unit };
  return { roles, sla, fromLanes, always: [...always, ...mandatory] };
}

// Как собирается лист согласования для правки схемы и как её называть в задачах.
// Механика листа общая; предметным здесь остаётся только это.
approvals.registerRoute('process_change', {
  build(changeId) {
    const { roles, sla, fromLanes } = buildApprovalRoute(changeId);
    const laneTitles = laneTitlesOf(repo.getVersion(getChange(changeId).draft_version_id).model);
    const byLane = new Map();
    for (const laneId of Object.keys(laneTitles)) {
      const role = laneRoleOf(laneId, laneTitles);
      if (role) byLane.set(role, laneTitles[laneId]);
    }
    return {
      sla,
      approvers: roles.map((role) => ({
        role_code: role,
        reason: fromLanes.includes(role) && byLane.get(role)
          ? `дорожка «${byLane.get(role)}»`
          : 'обязательное согласование',
      })),
    };
  },
  describe(changeId) {
    const c = getChange(changeId);
    return {
      taskType: 'process_approval',
      title: `Согласование изменения процесса: ${c.title}`,
      subtitle: `${c.number} «${c.title}». Изменение затрагивает вашу зону ответственности.`,
      link: { process_change_id: c.id },
    };
  },
});

const laneRoleOf = (laneId) => LANE_ROLE[laneId] ?? null;

export function submitForApproval({ changeId, user, ip = null }) {
  const c = getChange(changeId);
  if (!c) throw new ChangeError('Предложение не найдено');
  if (c.status !== 'discussion') {
    throw new ChangeError('На согласование выносится предложение, прошедшее обсуждение');
  }
  if (c.author_id !== user.id && !can(user, 'process.admin')) {
    throw new ChangeError('Вынести предложение на согласование может его автор');
  }
  const issues = repo.validateForPublish(c.draft_version_id);
  if (issues.length) throw new ChangeError('Схема предложения не проходит проверку', issues);

  return tx(() => {
    const result = approvals.openSheet({ targetType: 'process_change', targetId: changeId, user, ip });
    q.run(`UPDATE process_changes SET status = 'approval', updated_at = datetime('now') WHERE id = ?`, changeId);
    emit('process_change.status.changed', { subjectType: 'process_change', subjectId: changeId,
      actorId: user.id, from: 'discussion', to: 'approval', number: c.number });
    logAction(user.id, 'process.change.toApproval', 'process_change', changeId, { number: c.number }, ip);
    return result;
  });
}

export const approvalSheet = (changeId) => approvals.sheet('process_change', changeId);

/** Может ли участник поставить вердикт по этому листу. */
export function canApprove(user, changeId) {
  const c = getChange(changeId);
  if (!c) return { ok: false, reason: 'Предложение не найдено' };
  return approvals.canDecide(user, {
    targetType: 'process_change', targetId: changeId,
    authorId: c.author_id, permission: 'process.approve',
    open: c.status === 'approval', closedReason: 'Предложение не на согласовании',
  });
}

/**
 * Вердикт согласующего. Аргументация обязательна при отказе и замечаниях:
 * автору нужно знать, что именно исправить, а не только сам факт отказа.
 */
export function decideApproval({ changeId, user, verdict, comment = null, ip = null }) {
  const check = canApprove(user, changeId);
  if (!check.ok) throw Object.assign(new ChangeError(check.reason), { status: 403 });

  return tx(() => {
    const c = getChange(changeId);
    // Запись вердикта и проверка полноты листа — общая механика; ниже только то,
    // что исход означает именно для предложения об изменении процесса
    const { outcome, pending, sheet } = approvals.decide({
      targetType: 'process_change', targetId: changeId, user, verdict, comment, row: check.row, ip,
    });
    q.run(`UPDATE tasks SET status = 'done', completed_at = datetime('now')
           WHERE process_change_id = ? AND role_target = ? AND status = 'open'`,
      changeId, check.row.role_code);

    if (outcome === 'rejected') {
      q.run(`UPDATE process_changes SET status = 'rejected', decision_note = ?,
             decided_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
        comment?.trim() || null, changeId);
      closeApprovalTasks(changeId);
      notify(c.author_id, 'process_change_rejected',
        `Предложение ${c.number} отклонено`,
        `${roleTitle(user.role)}: ${comment?.trim() || 'без пояснения'}`,
        { process_change_id: changeId });
      emit('process_change.status.changed', { subjectType: 'process_change', subjectId: changeId,
        actorId: user.id, from: 'approval', to: 'rejected', number: c.number });
      return { status: 'rejected', sheet };
    }

    if (outcome === 'accepted') {
      q.run(`UPDATE process_changes SET status = 'accepted', decided_at = datetime('now'),
             updated_at = datetime('now') WHERE id = ?`, changeId);
      closeApprovalTasks(changeId);
      awardPoints({ userId: c.author_id, code: 'process.change.accepted', changeId,
                    reason: `Изменение ${c.number} согласовано` });
      notify(c.author_id, 'process_change_accepted',
        `Предложение ${c.number} согласовано`,
        'Все согласующие поддержали изменение. Осталась публикация версии.',
        { process_change_id: changeId });
      notifyRole('dtszn', null, 'process_change_ready',
        `К публикации: ${c.def_title}`,
        `${c.number} «${c.title}» согласовано и ждёт публикации.`,
        { process_change_id: changeId });
      emit('process_change.accepted', { subjectType: 'process_change', subjectId: changeId,
        actorId: user.id, from: 'approval', to: 'accepted', number: c.number, defKey: c.def_key });
      return { status: 'accepted', sheet };
    }
    return { status: 'approval', pending, sheet };
  });
}

function closeApprovalTasks(changeId) {
  q.run(`UPDATE tasks SET status = 'done', completed_at = datetime('now')
         WHERE process_change_id = ? AND status = 'open'`, changeId);
}

// ─────────────────────────────────────────────────────────────
// Публикация согласованного изменения
// ─────────────────────────────────────────────────────────────
/**
 * Здесь замыкается весь замысел: согласованная правка схемы становится действующей
 * версией, а для конвейера — пересобирает этапы, сроки и ответственных. С этой
 * минуты платформа работает по предложению сотрудника.
 */
export function publishChange({ changeId, user, ip = null }) {
  const c = getChange(changeId);
  if (!c) throw new ChangeError('Предложение не найдено');
  if (c.status !== 'accepted') {
    throw new ChangeError('Публикуется только согласованное предложение');
  }
  return tx(() => {
    repo.publishVersion({ versionId: c.draft_version_id, user, ip });
    q.run(`UPDATE process_changes SET status = 'published', published_at = datetime('now'),
           updated_at = datetime('now') WHERE id = ?`, changeId);
    awardPoints({ userId: c.author_id, code: 'process.change.published', changeId,
                  reason: `Изменение ${c.number} вступило в силу` });
    notify(c.author_id, 'process_change_published',
      `Изменение ${c.number} вступило в силу`,
      `Процесс «${c.def_title}» работает по вашему предложению.`,
      { process_change_id: changeId });

    // Голосовавшие узнают об исходе: они вложились в обсуждение
    for (const v of q.all('SELECT user_id FROM process_change_votes WHERE change_id = ?', changeId)) {
      if (v.user_id === c.author_id) continue;
      notify(v.user_id, 'process_change_published',
        `Изменение процесса «${c.def_title}» принято`,
        `${c.number} «${c.title}» — предложение, которое вы поддержали, вступило в силу.`,
        { process_change_id: changeId });
    }
    emit('process_change.published', { subjectType: 'process_change', subjectId: changeId,
      actorId: user.id, from: 'accepted', to: 'published', number: c.number, defKey: c.def_key });
    logAction(user.id, 'process.change.publish', 'process_change', changeId, { number: c.number }, ip);
    return getChange(changeId);
  });
}

// ─────────────────────────────────────────────────────────────
// Просроченные согласования
// ─────────────────────────────────────────────────────────────
/**
 * Эскалация просроченных согласований. Механика общая для всей платформы; здесь
 * лишь ответ на вопрос, идёт ли согласование по этому предмету до сих пор.
 */
export function sweepApprovals() {
  return approvals.sweepOverdue((targetType, targetId) =>
    targetType !== 'process_change' ||
    q.get("SELECT status FROM process_changes WHERE id = ?", targetId)?.status === 'approval');
}
