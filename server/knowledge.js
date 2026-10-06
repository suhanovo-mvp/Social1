// База знаний: проекты решений и зафиксированные решения.
//
// Платформа умеет довести решение до внедрения, но до сих пор не превращала его в
// знание: следующий автор не находил, что похожее уже разбирали, какие варианты
// отклонили и почему. Документ закрывает именно это — он хранит не только решение,
// но и контекст, рассмотренные альтернативы и последствия.
//
// Механика повторяет репозиторий процессов: черновик, проверка, публикация,
// неизменяемость опубликованного. Согласование берётся из общего модуля.
import { q, tx } from './db.js';
import { logAction } from './audit.js';
import { can, roleTitle } from './auth.js';
import { notify, notifyRole } from './notify.js';
import { emit } from './events.js';
import * as approvals from './approvals.js';

export class DocError extends Error {
  constructor(message, details) { super(message); this.status = 400; this.details = details; }
}

// Проект решения обсуждают до реализации, зафиксированное — описывает уже принятое.
// Оба показываются по-русски: аббревиатура рядом нужна технической команде, но
// сотруднику учреждения она ничего не объясняет.
export const KINDS = {
  rfc: { title: 'Проект решения',        short: 'RFC', prefix: 'РД',
         lead: 'Что предлагается сделать, какие варианты рассмотрены и чем рискуем' },
  adr: { title: 'Зафиксированное решение', short: 'ADR', prefix: 'ЗР',
         lead: 'Что решили, в каком контексте и с какими последствиями' },
  spec: { title: 'Спецификация',         short: '',    prefix: 'СП',
          lead: 'Техническое описание того, как устроено решение' },
  guide: { title: 'Методические материалы', short: '', prefix: 'ММ',
           lead: 'Как применять решение в учреждении' },
};

export const DOC_STATUS = {
  draft:      { title: 'Черновик',           tone: 'muted',  order: 1 },
  review:     { title: 'На рецензировании',  tone: 'warn',   order: 2 },
  accepted:   { title: 'Согласовано',        tone: 'accent', order: 3 },
  published:  { title: 'В базе знаний',      tone: 'ok',     order: 4 },
  rejected:   { title: 'Отклонено',          tone: 'muted',  order: 5 },
  superseded: { title: 'Заменено',           tone: 'muted',  order: 6 },
};

// Состав разделов по умолчанию. Записывается в базу при первом запуске и дальше
// правится администратором — как правила начисления очков.
export const DEFAULT_SECTIONS = [
  ['rfc', 'problem', 'Проблема', 'Что именно не работает и кого это касается. Без решения — только факты.', 1],
  ['rfc', 'solution', 'Предлагаемое решение', 'Что предлагается сделать и как это меняет работу.', 1],
  ['rfc', 'alternatives', 'Рассмотренные альтернативы',
   'Какие ещё варианты обсуждались и почему отклонены. Это самый ценный раздел: он избавляет следующего автора от повторного разбора.', 1],
  ['rfc', 'risks', 'Риски и последствия', 'Что может пойти не так, кого затронет и чем придётся пожертвовать.', 1],
  ['rfc', 'effect', 'Ожидаемый эффект', 'Чем измерим, что решение сработало.', 0],

  ['adr', 'context', 'Контекст', 'В какой ситуации принималось решение и какие были ограничения.', 1],
  ['adr', 'decision', 'Решение', 'Что решили — коротко и однозначно.', 1],
  ['adr', 'consequences', 'Последствия', 'Что стало лучше и какой ценой. Отрицательные последствия называть обязательно.', 1],
  ['adr', 'alternatives', 'Отклонённые варианты', 'Что рассматривали и почему не выбрали.', 0],

  ['spec', 'overview', 'Назначение', 'Для чего решение и кто им пользуется.', 1],
  ['spec', 'details', 'Устройство', 'Как устроено и из чего состоит.', 1],

  ['guide', 'audience', 'Для кого', 'Кому адресованы материалы.', 1],
  ['guide', 'steps', 'Порядок применения', 'Что делать по шагам.', 1],
];

export function ensureKnowledge() {
  if (q.get('SELECT COUNT(*) AS c FROM knowledge_sections').c > 0) return;
  tx(() => {
    DEFAULT_SECTIONS.forEach(([kind, key, title, hint, required], i) => {
      q.run(`INSERT INTO knowledge_sections (kind, key, title, hint, required, order_idx)
             VALUES (?,?,?,?,?,?)`, kind, key, title, hint, required, i);
    });
  });
}

export const sectionsOf = (kind) =>
  q.all('SELECT * FROM knowledge_sections WHERE kind = ? ORDER BY order_idx', kind);

// ─────────────────────────────────────────────────────────────
// Номера и сборка текста
// ─────────────────────────────────────────────────────────────
export function nextNumber(kind) {
  const prefix = KINDS[kind]?.prefix ?? 'ДОК';
  const year = new Date().getFullYear();
  const last = q.get('SELECT number FROM knowledge_docs WHERE number LIKE ? ORDER BY id DESC LIMIT 1',
    `${prefix}-${year}-%`);
  const n = last ? Number(last.number.split('-')[2]) + 1 : 1;
  return `${prefix}-${year}-${String(n).padStart(4, '0')}`;
}

/**
 * Разделы — источник истины, Markdown собирается из них.
 * Так замечание вешается на конкретный раздел, а выгрузка и поиск получают
 * связный текст, и эти два требования не спорят друг с другом.
 */
export function assembleBody(kind, sections) {
  return sectionsOf(kind)
    .filter((s) => (sections[s.key] ?? '').trim())
    .map((s) => `## ${s.title}\n\n${sections[s.key].trim()}`)
    .join('\n\n');
}

const parse = (row) => (row ? { ...row, sections: JSON.parse(row.sections || '{}') } : null);

// ─────────────────────────────────────────────────────────────
// Документы
// ─────────────────────────────────────────────────────────────
export function createDoc({ kind, title, subjectType = null, subjectId = null,
                            sourceDocId = null, supersedesId = null, user, ip = null }) {
  if (!KINDS[kind]) throw new DocError(`Неизвестный вид документа «${kind}»`);
  if (!title?.trim()) throw new DocError('Укажите название документа');

  return tx(() => {
    const number = nextNumber(kind);
    const docId = q.insert(`INSERT INTO knowledge_docs
      (number, kind, title, status, author_id, institution_id, subject_type, subject_id,
       source_doc_id, supersedes_id)
      VALUES (?,?,?,'draft',?,?,?,?,?,?)`,
      number, kind, title.trim(), user.id, user.institution_id ?? null,
      subjectType, subjectId, sourceDocId, supersedesId);

    // Зафиксированное решение начинается не с чистого листа: контекст и отклонённые
    // варианты уже описаны в проекте решения, переписывать их заново незачем
    const seed = sourceDocId ? carryOver(sourceDocId, kind) : {};
    const versionId = q.insert(`INSERT INTO knowledge_versions
      (doc_id, version, sections, body, status, created_by) VALUES (?,1,?,?,'draft',?)`,
      docId, JSON.stringify(seed), assembleBody(kind, seed), user.id);
    q.run('UPDATE knowledge_docs SET current_version_id = ? WHERE id = ?', versionId, docId);

    emit('doc.created', { subjectType: 'knowledge_doc', subjectId: docId, actorId: user.id,
      to: 'draft', kind, number });
    logAction(user.id, 'doc.create', 'knowledge_doc', docId, { number, kind }, ip);
    return getDoc(docId);
  });
}

/** Перенос разделов из проекта решения в зафиксированное по совпадению смысла. */
function carryOver(sourceDocId, targetKind) {
  const src = currentVersion(sourceDocId);
  if (!src) return {};
  const map = { rfc: { adr: { problem: 'context', alternatives: 'alternatives', solution: 'decision' } } };
  const rules = map[getDoc(sourceDocId)?.kind]?.[targetKind] ?? {};
  const out = {};
  for (const [from, to] of Object.entries(rules)) {
    if (src.sections[from]) out[to] = src.sections[from];
  }
  return out;
}

export function getDoc(id) {
  return q.get(`SELECT d.*, u.full_name AS author_name, u.role AS author_role,
                       inst.short_name AS institution,
                       v.version AS current_version,
                       s.number AS supersedes_number, s.title AS supersedes_title,
                       src.number AS source_number
                FROM knowledge_docs d
                JOIN users u ON u.id = d.author_id
                LEFT JOIN institutions inst ON inst.id = d.institution_id
                LEFT JOIN knowledge_versions v ON v.id = d.current_version_id
                LEFT JOIN knowledge_docs s ON s.id = d.supersedes_id
                LEFT JOIN knowledge_docs src ON src.id = d.source_doc_id
                WHERE d.id = ?`, Number(id)) || null;
}

export const docByNumber = (number) =>
  getDoc(q.get('SELECT id FROM knowledge_docs WHERE number = ?', number)?.id);

export function listDocs({ kind = null, status = null, subjectType = null, subjectId = null,
                           authorId = null, limit = 100 } = {}) {
  const where = [], args = [];
  if (kind) { where.push('d.kind = ?'); args.push(kind); }
  if (status) { where.push('d.status = ?'); args.push(status); }
  if (subjectType) { where.push('d.subject_type = ?'); args.push(subjectType); }
  if (subjectId) { where.push('d.subject_id = ?'); args.push(Number(subjectId)); }
  if (authorId) { where.push('d.author_id = ?'); args.push(Number(authorId)); }
  return q.all(`SELECT d.id, d.number, d.kind, d.title, d.status, d.created_at, d.published_at,
                       d.subject_type, d.subject_id,
                       u.full_name AS author_name, u.role AS author_role,
                       inst.short_name AS institution,
                       (SELECT COUNT(*) FROM discussions dc
                        WHERE dc.target_type = 'knowledge_doc' AND dc.target_id = d.id) AS comments
                FROM knowledge_docs d
                JOIN users u ON u.id = d.author_id
                LEFT JOIN institutions inst ON inst.id = d.institution_id
                ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                ORDER BY d.created_at DESC LIMIT ?`, ...args, Number(limit));
}

// ─────────────────────────────────────────────────────────────
// Версии
// ─────────────────────────────────────────────────────────────
export const getVersion = (id) =>
  parse(q.get('SELECT * FROM knowledge_versions WHERE id = ?', Number(id)));

export function currentVersion(docId) {
  return parse(q.get(`SELECT v.* FROM knowledge_versions v
                      JOIN knowledge_docs d ON d.current_version_id = v.id
                      WHERE d.id = ?`, Number(docId)));
}

export const versionsOf = (docId) =>
  q.all(`SELECT v.id, v.version, v.status, v.notes, v.created_at, v.published_at,
                u.full_name AS created_by_name
         FROM knowledge_versions v LEFT JOIN users u ON u.id = v.created_by
         WHERE v.doc_id = ? ORDER BY v.version DESC`, Number(docId));

export function saveDraft({ docId, sections, notes = null, user, ip = null }) {
  const doc = getDoc(docId);
  if (!doc) throw new DocError('Документ не найден');
  if (!['draft', 'review'].includes(doc.status)) {
    throw new DocError('Опубликованный документ неизменяем — заведите новую редакцию');
  }
  if (doc.author_id !== user.id && !can(user, 'doc.admin')) {
    throw new DocError('Править документ может его автор');
  }
  const v = currentVersion(docId);
  const merged = { ...v.sections, ...sections };
  q.run(`UPDATE knowledge_versions SET sections = ?, body = ?, notes = COALESCE(?, notes),
         updated_at = datetime('now') WHERE id = ?`,
    JSON.stringify(merged), assembleBody(doc.kind, merged), notes, v.id);
  q.run("UPDATE knowledge_docs SET updated_at = datetime('now') WHERE id = ?", docId);
  logAction(user.id, 'doc.edit', 'knowledge_doc', docId, { version: v.version }, ip);
  return { ...getVersion(v.id), issues: validate(docId) };
}

/** Незаполненные обязательные разделы — публиковать с ними нельзя. */
export function validate(docId) {
  const doc = getDoc(docId);
  const v = currentVersion(docId);
  return sectionsOf(doc.kind)
    .filter((s) => s.required && !(v.sections[s.key] ?? '').trim())
    .map((s) => ({ code: 'section.empty', section: s.key,
                   message: `Раздел «${s.title}» обязателен и пока пуст` }));
}

// ─────────────────────────────────────────────────────────────
// Рецензирование
// ─────────────────────────────────────────────────────────────
// Состав рецензентов выводится из предмета документа: спрашивают заказчика — того,
// чью проблему решают, — и архитектора, который следит, чтобы решения не расходились.
approvals.registerRoute('knowledge_doc', {
  build(docId) {
    const d = getDoc(docId);
    const approvers = [];
    const owner = subjectOwner(d);
    if (owner && owner !== d.author_id) {
      approvers.push({ user_id: owner, reason: 'заказчик — автор предмета' });
    }
    // Автор не рецензирует сам себя: если проект решения пишет архитектор,
    // архитектурная проверка ложится на экспертов ДТСЗН
    if (d.author_role !== 'architect') {
      approvers.push({ role_code: 'architect', reason: 'архитектурное рецензирование' });
    } else {
      approvers.push({ role_code: 'expert', reason: 'методологическое рецензирование' });
    }
    if (d.kind === 'adr') {
      approvers.push({ role_code: 'dtszn', reason: 'фиксация решения в базе знаний' });
    }
    return { approvers, sla: approvals.DEFAULT_SLA };
  },
  describe(docId) {
    const d = getDoc(docId);
    return {
      taskType: 'doc_review',
      title: `Рецензирование: ${d.title}`,
      subtitle: `${d.number} «${d.title}». ${KINDS[d.kind].title} ждёт вашего отзыва.`,
      link: { knowledge_doc_id: d.id },
    };
  },
});

/** Кто заказчик документа — автор идеи или инициативы, к которой он относится. */
function subjectOwner(doc) {
  if (!doc.subject_type || !doc.subject_id) return null;
  const table = { idea: 'ideas', initiative: 'initiatives' }[doc.subject_type];
  if (!table) return null;
  return q.get(`SELECT author_id FROM ${table} WHERE id = ?`, doc.subject_id)?.author_id ?? null;
}

export function submitForReview({ docId, user, ip = null }) {
  const doc = getDoc(docId);
  if (!doc) throw new DocError('Документ не найден');
  if (doc.status !== 'draft') throw new DocError('Документ уже вынесен на рецензирование');
  if (doc.author_id !== user.id && !can(user, 'doc.admin')) {
    throw new DocError('Вынести документ на рецензирование может его автор');
  }
  const issues = validate(docId);
  if (issues.length) throw new DocError('Документ заполнен не полностью', issues);

  return tx(() => {
    const sheet = approvals.openSheet({ targetType: 'knowledge_doc', targetId: docId, user, ip });
    q.run("UPDATE knowledge_docs SET status = 'review', updated_at = datetime('now') WHERE id = ?", docId);
    emit('doc.status.changed', { subjectType: 'knowledge_doc', subjectId: docId, actorId: user.id,
      from: 'draft', to: 'review', number: doc.number, kind: doc.kind });
    logAction(user.id, 'doc.review', 'knowledge_doc', docId, { number: doc.number }, ip);
    return sheet;
  });
}

export const reviewSheet = (docId) => approvals.sheet('knowledge_doc', docId);

export function canReview(user, docId) {
  const doc = getDoc(docId);
  if (!doc) return { ok: false, reason: 'Документ не найден' };
  return approvals.canDecide(user, {
    targetType: 'knowledge_doc', targetId: docId, authorId: doc.author_id,
    permission: 'doc.review', open: doc.status === 'review',
    closedReason: 'Документ не на рецензировании',
  });
}

export function decideReview({ docId, user, verdict, comment = null, ip = null }) {
  const check = canReview(user, docId);
  if (!check.ok) throw Object.assign(new DocError(check.reason), { status: 403 });

  return tx(() => {
    const doc = getDoc(docId);
    const { outcome, pending, sheet } = approvals.decide({
      targetType: 'knowledge_doc', targetId: docId, user, verdict, comment, row: check.row, ip,
    });
    q.run(`UPDATE tasks SET status = 'done', completed_at = datetime('now')
           WHERE knowledge_doc_id = ? AND status = 'open'
             AND (role_target = ? OR user_id = ?)`,
      docId, check.row.role_code, check.row.user_id);

    if (outcome === 'rejected') {
      q.run(`UPDATE knowledge_docs SET status = 'rejected', decision_note = ?,
             decided_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
        comment?.trim() || null, docId);
      closeTasks(docId);
      notify(doc.author_id, 'doc_rejected', `${doc.number}: не согласовано`,
        `${roleTitle(user.role)}: ${comment?.trim() || 'без пояснения'}`,
        { knowledge_doc_id: docId });
      emit('doc.status.changed', { subjectType: 'knowledge_doc', subjectId: docId,
        actorId: user.id, from: 'review', to: 'rejected', number: doc.number });
      return { status: 'rejected', sheet };
    }

    if (outcome === 'accepted') {
      q.run(`UPDATE knowledge_docs SET status = 'accepted', decided_at = datetime('now'),
             updated_at = datetime('now') WHERE id = ?`, docId);
      closeTasks(docId);
      notify(doc.author_id, 'doc_accepted', `${doc.number} согласовано`,
        'Рецензенты поддержали документ.', { knowledge_doc_id: docId });
      // Здесь замыкается переход от документа к работе: подписчик заводит задачу
      emit('doc.accepted', { subjectType: 'knowledge_doc', subjectId: docId, actorId: user.id,
        from: 'review', to: 'accepted', number: doc.number, kind: doc.kind });
      return { status: 'accepted', sheet };
    }
    return { status: 'review', pending, sheet };
  });
}

const closeTasks = (docId) =>
  q.run(`UPDATE tasks SET status = 'done', completed_at = datetime('now')
         WHERE knowledge_doc_id = ? AND status = 'open'`, docId);

// ─────────────────────────────────────────────────────────────
// Публикация
// ─────────────────────────────────────────────────────────────
export function publishDoc({ docId, user, ip = null }) {
  const doc = getDoc(docId);
  if (!doc) throw new DocError('Документ не найден');
  if (!['accepted', 'draft'].includes(doc.status)) {
    throw new DocError('Публикуется согласованный документ');
  }
  const issues = validate(docId);
  if (issues.length) throw new DocError('Документ заполнен не полностью', issues);

  return tx(() => {
    const v = currentVersion(docId);
    q.run(`UPDATE knowledge_versions SET status = 'published', published_at = datetime('now'),
           published_by = ? WHERE id = ?`, user.id, v.id);
    q.run(`UPDATE knowledge_docs SET status = 'published', published_at = datetime('now'),
           updated_at = datetime('now') WHERE id = ?`, docId);

    // Прежнее решение не удаляется: по нему поймут, почему передумали
    if (doc.supersedes_id) {
      q.run(`UPDATE knowledge_docs SET status = 'superseded', updated_at = datetime('now')
             WHERE id = ? AND status = 'published'`, doc.supersedes_id);
      emit('doc.superseded', { subjectType: 'knowledge_doc', subjectId: doc.supersedes_id,
        actorId: user.id, to: 'superseded', by: docId });
    }

    notify(doc.author_id, 'doc_published', `${doc.number} в базе знаний`,
      'Документ опубликован и виден коллегам.', { knowledge_doc_id: docId });
    emit('doc.published', { subjectType: 'knowledge_doc', subjectId: docId, actorId: user.id,
      from: doc.status, to: 'published', number: doc.number, kind: doc.kind });
    logAction(user.id, 'doc.publish', 'knowledge_doc', docId, { number: doc.number }, ip);
    return getDoc(docId);
  });
}

/** Новая редакция взамен действующей: прежняя останется в истории. */
export function reviseDoc({ docId, user, ip = null }) {
  const doc = getDoc(docId);
  if (!doc) throw new DocError('Документ не найден');
  if (doc.status !== 'published') throw new DocError('Заменяют только опубликованное решение');
  return createDoc({
    kind: doc.kind, title: doc.title,
    subjectType: doc.subject_type, subjectId: doc.subject_id,
    supersedesId: docId, user, ip,
  });
}

export function sweepReviews() {
  return approvals.sweepOverdue((targetType, targetId) =>
    targetType !== 'knowledge_doc' ||
    q.get('SELECT status FROM knowledge_docs WHERE id = ?', targetId)?.status === 'review');
}
