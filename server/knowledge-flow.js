// Переходы между документом и работой: принятый проект решения превращается в
// задачу, завершённая задача — в предложение зафиксировать решение.
//
// Исследование называет ручной перенос документа в трекер главной причиной, по
// которой опыт теряется: контекст остаётся в одной системе, работа идёт в другой.
// Здесь связь неразрывна — задача несёт ссылку на документ-основание, а документ
// знает задачу, которая его реализовала.
//
// Подписки вынесены в отдельный модуль, чтобы knowledge.js не знал про доску
// разработки, а work — про базу знаний: связывает их событие, а не импорт.
import { q } from './db.js';
import { on } from './events.js';
import { notify } from './notify.js';
import { getDoc, currentVersion, createDoc, KINDS } from './knowledge.js';

/** Проект решения принят — заводим задачу в проекте разработки. */
on('doc.accepted', 'работа: задача по принятому проекту решения', (e) => {
  const doc = getDoc(e.subjectId);
  if (doc.kind !== 'rfc') return;          // задачу порождает только проект решения

  const project = projectFor(doc);
  if (!project) return;                    // предмет не дошёл до разработки — задачи нет

  const order = q.get('SELECT COALESCE(MAX(order_idx), 0) AS n FROM board_items WHERE project_id = ?',
    project.id).n;
  const taskId = q.insert(`INSERT INTO board_items
    (project_id, knowledge_doc_id, title, description, type, status, priority, order_idx)
    VALUES (?,?,?,?,'story','todo','normal',?)`,
    project.id, doc.id, doc.title,
    `Основание: ${doc.number}. Решение согласовано рецензентами; описание, ` +
    `рассмотренные альтернативы и риски — в документе.`, order + 1);

  q.run('UPDATE knowledge_docs SET task_id = ? WHERE id = ?', taskId, doc.id);
  notify(doc.author_id, 'doc_task_created', `${doc.number}: задача заведена`,
    `Работа по принятому проекту решения добавлена в проект «${project.name}».`,
    { knowledge_doc_id: doc.id });
});

/** Работа завершена — предлагаем зафиксировать решение, а не оставлять его в голове. */
on('task.completed', 'база знаний: предложить зафиксировать решение', (e) => {
  const item = q.get('SELECT * FROM board_items WHERE id = ?', e.subjectId);
  if (!item?.knowledge_doc_id) return;     // задача не выросла из проекта решения

  const rfc = getDoc(item.knowledge_doc_id);
  if (!rfc || rfc.kind !== 'rfc') return;
  if (q.get("SELECT id FROM knowledge_docs WHERE source_doc_id = ? AND kind = 'adr'", rfc.id)) return;

  q.run(`INSERT INTO tasks (user_id, knowledge_doc_id, type, title)
         VALUES (?,?,'doc_adr',?)`,
    item.assignee_id ?? rfc.author_id, rfc.id,
    `Зафиксировать решение по ${rfc.number}: «${rfc.title}»`);
  notify(item.assignee_id ?? rfc.author_id, 'doc_adr_due',
    `Осталось зафиксировать решение по ${rfc.number}`,
    'Работа завершена. Опишите, что в итоге решили и с какими последствиями — ' +
    'контекст и отклонённые варианты перенесутся из проекта решения.',
    { knowledge_doc_id: rfc.id });
});

/** Проект разработки, к которому относится документ. */
function projectFor(doc) {
  if (doc.subject_type === 'project') {
    return q.get('SELECT * FROM projects WHERE id = ?', doc.subject_id);
  }
  const initiativeId = doc.subject_type === 'initiative' ? doc.subject_id
    : doc.subject_type === 'idea'
      ? q.get('SELECT initiative_id FROM ideas WHERE id = ?', doc.subject_id)?.initiative_id
      : null;
  if (!initiativeId) return null;
  return q.get("SELECT * FROM projects WHERE initiative_id = ? AND status = 'active' LIMIT 1",
    initiativeId);
}

/**
 * Заготовка зафиксированного решения по проекту решения. Разделы переносятся
 * из проекта: переписывать контекст и отклонённые варианты заново незачем.
 */
export function draftDecisionFrom(rfcId, user) {
  const rfc = getDoc(rfcId);
  if (!rfc) throw new Error('Проект решения не найден');
  const adr = createDoc({
    kind: 'adr', title: rfc.title,
    subjectType: rfc.subject_type, subjectId: rfc.subject_id,
    sourceDocId: rfc.id, user,
  });
  q.run(`UPDATE tasks SET status = 'done', completed_at = datetime('now')
         WHERE knowledge_doc_id = ? AND type = 'doc_adr' AND status = 'open'`, rfc.id);
  return adr;
}

export const KIND_TITLES = KINDS;
