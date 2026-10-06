// Совместная работа над процессами: замечания на шагах схемы, предложения об
// изменении, поддержка коллег, лист согласования и публикация.
import { route, readJson, HttpError } from '../http.js';
import { can } from '../auth.js';
import * as ch from '../process-changes.js';
import * as repo from '../process-repo.js';

const need = (user, permission, message) => {
  if (!can(user, permission)) throw new HttpError(403, message);
};

// ─────────────────────────────────────────────────────────────
// Замечания на схеме
// ─────────────────────────────────────────────────────────────
route.get('/api/processes/:key/comments', async ({ params, url, sendJson }) => {
  sendJson(200, {
    comments: ch.comments({
      defKey: params.key,
      changeId: url.searchParams.get('change') || null,
      nodeId: url.searchParams.get('node') || null,
      includeResolved: url.searchParams.get('resolved') === '1',
    }),
    counts: ch.commentCountsByNode(params.key),
  });
});

route.post('/api/processes/:key/comments', async ({ req, user, params, ip, sendJson }) => {
  need(user, 'process.comment', 'Обсуждение схем доступно сотрудникам учреждений');
  const b = await readJson(req);
  sendJson(201, ch.addComment({
    defKey: params.key, changeId: b.change_id ?? null, nodeId: b.node_id ?? null,
    flowId: b.flow_id ?? null, parentId: b.parent_id ?? null, body: b.body, user, ip,
  }));
});

route.post('/api/process-comments/:id/useful', async ({ user, params, sendJson }) => {
  need(user, 'process.comment', 'Недостаточно прав');
  sendJson(200, ch.markCommentUseful({ commentId: Number(params.id), user }));
});

route.post('/api/process-comments/:id/resolve', async ({ user, params, ip, sendJson }) => {
  sendJson(200, ch.resolveComment({ commentId: Number(params.id), user, ip }));
});

// ─────────────────────────────────────────────────────────────
// Предложения об изменении
// ─────────────────────────────────────────────────────────────
route.get('/api/process-changes', async ({ user, url, sendJson }) => {
  const mine = url.searchParams.get('mine') === '1';
  sendJson(200, {
    changes: ch.listChanges({
      status: url.searchParams.get('status') || null,
      defKey: url.searchParams.get('process') || null,
      authorId: mine ? user.id : null,
      limit: Math.min(200, Number(url.searchParams.get('limit')) || 100),
    }),
    statuses: ch.CHANGE_STATUS,
    verdicts: ch.VERDICTS,
  });
});

route.post('/api/process-changes', async ({ req, user, ip, sendJson }) => {
  need(user, 'process.propose', 'Предлагать изменения процессов может сотрудник учреждения');
  const b = await readJson(req);
  sendJson(201, ch.createChange({
    defKey: b.process, title: b.title, rationale: b.rationale,
    expectedEffect: b.expected_effect ?? null,
    ideaId: b.idea_id ?? null, initiativeId: b.initiative_id ?? null, user, ip,
  }));
});

/** Карточка предложения: схема, различие с действующей версией, обсуждение, лист. */
route.get('/api/process-changes/:id', async ({ user, params, sendJson }) => {
  const change = ch.getChange(params.id);
  if (!change) throw new HttpError(404, 'Предложение не найдено');
  const { diff, summary, base_version, issues } = ch.changeDiff(change.id);
  sendJson(200, {
    change,
    diff, summary, base_version, issues,
    base: repo.getVersion(change.base_version_id),
    draft: repo.getVersion(change.draft_version_id),
    votes: ch.voteSummary(change.id, user.id),
    approvals: ch.approvalSheet(change.id),
    can_approve: ch.canApprove(user, change.id),
    comments: ch.comments({ defKey: change.def_key, changeId: change.id }),
  });
});

route.put('/api/process-changes/:id/model', async ({ req, user, params, ip, sendJson }) => {
  const b = await readJson(req);
  if (!b.model) throw new HttpError(400, 'В запросе нет модели схемы');
  sendJson(200, ch.saveChangeModel({ changeId: Number(params.id), model: b.model, user, ip }));
});

route.post('/api/process-changes/:id/submit', async ({ user, params, ip, sendJson }) => {
  sendJson(200, ch.submitForDiscussion({ changeId: Number(params.id), user, ip }));
});

route.post('/api/process-changes/:id/withdraw', async ({ req, user, params, ip, sendJson }) => {
  const b = await readJson(req);
  sendJson(200, ch.withdrawChange({ changeId: Number(params.id), user, note: b.note ?? null, ip }));
});

// ── Поддержка коллег ──
route.post('/api/process-changes/:id/vote', async ({ req, user, params, sendJson }) => {
  const b = await readJson(req);
  sendJson(200, ch.vote({ changeId: Number(params.id), user, value: b.value ?? 1, comment: b.comment ?? null }));
});

route.delete('/api/process-changes/:id/vote', async ({ user, params, sendJson }) => {
  sendJson(200, ch.unvote({ changeId: Number(params.id), user }));
});

// ── Согласование ──
/** Кто будет согласовывать — показывается автору до отправки. */
route.get('/api/process-changes/:id/route', async ({ params, sendJson }) => {
  sendJson(200, ch.buildApprovalRoute(Number(params.id)));
});

route.post('/api/process-changes/:id/to-approval', async ({ user, params, ip, sendJson }) => {
  sendJson(200, ch.submitForApproval({ changeId: Number(params.id), user, ip }));
});

route.post('/api/process-changes/:id/approve', async ({ req, user, params, ip, sendJson }) => {
  need(user, 'process.approve', 'Согласование доступно ответственным за процессы');
  const b = await readJson(req);
  sendJson(200, ch.decideApproval({
    changeId: Number(params.id), user, verdict: b.verdict, comment: b.comment ?? null, ip,
  }));
});

route.post('/api/process-changes/:id/publish', async ({ user, params, ip, sendJson }) => {
  need(user, 'process.publish', 'Публикация версии доступна центральному аппарату ДТСЗН');
  sendJson(200, ch.publishChange({ changeId: Number(params.id), user, ip }));
});
