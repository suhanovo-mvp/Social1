// База знаний: проекты решений и зафиксированные решения, их рецензирование,
// публикация и поиск.
import { route, readJson, HttpError } from '../http.js';
import { can } from '../auth.js';
import * as kn from '../knowledge.js';
import * as flow from '../knowledge-flow.js';
import * as search from '../search.js';
import * as ch from '../process-changes.js';

const need = (user, permission, message) => {
  if (!can(user, permission)) throw new HttpError(403, message);
};

// ─────────────────────────────────────────────────────────────
// Каталог
// ─────────────────────────────────────────────────────────────
route.get('/api/knowledge', async ({ user, url, sendJson }) => {
  need(user, 'doc.read', 'Раздел доступен сотрудникам учреждений');
  const p = url.searchParams;
  sendJson(200, {
    docs: kn.listDocs({
      kind: p.get('kind') || null,
      status: p.get('status') || null,
      subjectType: p.get('subject_type') || null,
      subjectId: p.get('subject_id') || null,
      authorId: p.get('mine') === '1' ? user.id : null,
      limit: Math.min(200, Number(p.get('limit')) || 100),
    }),
    kinds: kn.KINDS,
    statuses: kn.DOC_STATUS,
  });
});

/** Шаблон разделов вида документа — по нему рисуется форма. */
route.get('/api/knowledge/template/:kind', async ({ params, sendJson }) => {
  const sections = kn.sectionsOf(params.kind);
  if (!sections.length) throw new HttpError(404, 'Шаблон такого вида документа не задан');
  sendJson(200, { kind: params.kind, meta: kn.KINDS[params.kind], sections });
});

route.post('/api/knowledge', async ({ req, user, ip, sendJson }) => {
  need(user, 'doc.propose', 'Заводить документы могут сотрудники учреждений');
  const b = await readJson(req);
  sendJson(201, kn.createDoc({
    kind: b.kind, title: b.title,
    subjectType: b.subject_type ?? null, subjectId: b.subject_id ?? null,
    sourceDocId: b.source_doc_id ?? null, user, ip,
  }));
});

// ─────────────────────────────────────────────────────────────
// Документ
// ─────────────────────────────────────────────────────────────
route.get('/api/knowledge/:id', async ({ user, params, sendJson }) => {
  need(user, 'doc.read', 'Недостаточно прав');
  const doc = kn.getDoc(params.id);
  if (!doc) throw new HttpError(404, 'Документ не найден');
  const version = kn.currentVersion(doc.id);
  sendJson(200, {
    doc,
    version,
    sections: kn.sectionsOf(doc.kind),
    issues: kn.validate(doc.id),
    versions: kn.versionsOf(doc.id),
    reviews: kn.reviewSheet(doc.id),
    can_review: kn.canReview(user, doc.id),
    comments: ch.comments({ defKey: null, targetType: 'knowledge_doc', targetId: doc.id }),
    // «Это уже разбирали» — то же и для читателя, а не только для автора
    related: search.similarTo(`${doc.title} ${version?.body ?? ''}`,
      { types: ['knowledge_doc'], limit: 4, exclude: { type: 'knowledge_doc', id: doc.id } }),
  });
});

route.put('/api/knowledge/:id', async ({ req, user, params, ip, sendJson }) => {
  const b = await readJson(req);
  if (!b.sections) throw new HttpError(400, 'В запросе нет разделов документа');
  sendJson(200, kn.saveDraft({
    docId: Number(params.id), sections: b.sections, notes: b.notes ?? null, user, ip,
  }));
});

route.post('/api/knowledge/:id/review', async ({ user, params, ip, sendJson }) => {
  sendJson(200, kn.submitForReview({ docId: Number(params.id), user, ip }));
});

// Право не проверяется здесь: состав рецензентов уже определён листом, и заказчик
// попадает в него по предмету, а не по должности. Проверку ведёт canReview.
route.post('/api/knowledge/:id/verdict', async ({ req, user, params, ip, sendJson }) => {
  const b = await readJson(req);
  sendJson(200, kn.decideReview({
    docId: Number(params.id), user, verdict: b.verdict, comment: b.comment ?? null, ip,
  }));
});

route.post('/api/knowledge/:id/publish', async ({ user, params, ip, sendJson }) => {
  need(user, 'doc.publish', 'Публикация доступна центральному аппарату ДТСЗН');
  sendJson(200, kn.publishDoc({ docId: Number(params.id), user, ip }));
});

/** Новая редакция взамен действующей: прежняя остаётся в истории. */
route.post('/api/knowledge/:id/revise', async ({ user, params, ip, sendJson }) => {
  need(user, 'doc.propose', 'Недостаточно прав');
  sendJson(201, kn.reviseDoc({ docId: Number(params.id), user, ip }));
});

/** Зафиксировать решение по завершённому проекту решения. */
route.post('/api/knowledge/:id/decision', async ({ user, params, sendJson }) => {
  need(user, 'doc.propose', 'Недостаточно прав');
  sendJson(201, flow.draftDecisionFrom(Number(params.id), user));
});

route.get('/api/knowledge/:id/versions/:versionId', async ({ params, sendJson }) => {
  const v = kn.getVersion(params.versionId);
  if (!v || v.doc_id !== Number(params.id)) throw new HttpError(404, 'Версия не найдена');
  sendJson(200, v);
});

// ─────────────────────────────────────────────────────────────
// Поиск
// ─────────────────────────────────────────────────────────────
route.get('/api/search', async ({ user, url, sendJson }) => {
  const query = url.searchParams.get('q') ?? '';
  const types = url.searchParams.get('types')?.split(',').filter(Boolean) ?? null;
  sendJson(200, {
    query,
    results: query.trim() ? search.search(query, { types, limit: 30 }) : [],
    types: search.SEARCHABLE,
  });
});

/** Подсказка «похожее уже разбирали» — по тексту, который человек ещё набирает. */
route.post('/api/search/similar', async ({ req, sendJson }) => {
  const b = await readJson(req);
  sendJson(200, search.similarTo(b.text ?? '', {
    types: b.types ?? ['knowledge_doc', 'idea'],
    limit: Math.min(10, Number(b.limit) || 5),
    exclude: b.exclude ?? null,
  }));
});

route.post('/api/search/reindex', async ({ user, sendJson }) => {
  need(user, 'admin', 'Пересборка индекса доступна администратору');
  sendJson(200, { indexed: search.reindexAll() });
});

// ─────────────────────────────────────────────────────────────
// Обсуждение разделов документа
// ─────────────────────────────────────────────────────────────
route.post('/api/knowledge/:id/comments', async ({ req, user, params, ip, sendJson }) => {
  need(user, 'doc.comment', 'Обсуждение доступно сотрудникам учреждений');
  const b = await readJson(req);
  const doc = kn.getDoc(params.id);
  if (!doc) throw new HttpError(404, 'Документ не найден');
  if (b.section && !kn.sectionsOf(doc.kind).some((s) => s.key === b.section)) {
    throw new HttpError(400, 'Раздел, к которому привязано замечание, отсутствует в документе');
  }
  const { add } = await import('../discussions.js');
  sendJson(201, add({
    targetType: 'knowledge_doc', targetId: doc.id,
    contextId: doc.current_version_id,
    anchorKind: b.section ? 'section' : null, anchorId: b.section ?? null,
    parentId: b.parent_id ?? null, body: b.body, user, ip,
  }));
});

route.get('/api/knowledge/:id/comments', async ({ params, url, sendJson }) => {
  const { list, countsByAnchor } = await import('../discussions.js');
  sendJson(200, {
    comments: list({
      targetType: 'knowledge_doc', targetId: Number(params.id),
      anchorId: url.searchParams.get('section') || null,
      includeResolved: url.searchParams.get('resolved') === '1',
    }),
    counts: countsByAnchor('knowledge_doc', Number(params.id)),
  });
});
