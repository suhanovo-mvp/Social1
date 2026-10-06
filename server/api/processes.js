// Репозиторий процессов: каталог схем, действующие модели, история версий,
// черновики, публикация и выгрузка в PDF.
//
// Схемы — справочный материал платформы, поэтому чтение доступно любому участнику
// после входа. Правка и публикация ограничены правами.
import { route, readJson, HttpError } from '../http.js';
import { can } from '../auth.js';
import { logAction } from '../audit.js';
import { diagramPdf, albumPdf } from '../bpmn-pdf.js';
import * as repo from '../process-repo.js';
import { validateModel } from '../../shared/bpmn/model.js';

const fileName = (s) => String(s)
  .replace(/[«»"]/g, '').replace(/[^\wА-Яа-яЁё0-9-]+/g, '_').replace(/_+/g, '_').slice(0, 80);

function sendPdf(res, buf, name) {
  // filename* с кодировкой UTF-8 — иначе браузер испортит кириллицу в имени файла
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': buf.length,
    'Content-Disposition': `attachment; filename="social1.pdf"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

const need = (user, permission, message) => {
  if (!can(user, permission)) throw new HttpError(403, message);
};

/** Схема по ключу или по номеру раздела — ссылки в регламентах используют оба вида. */
function findDiagram(idOrSeq) {
  const all = repo.album();
  const byKey = all.find((d) => d.id === idOrSeq);
  if (byKey) return { diagram: byKey, seq: all.indexOf(byKey) + 1 };
  const bySeq = all[Number(idOrSeq) - 1];
  if (bySeq) return { diagram: bySeq, seq: Number(idOrSeq) };
  throw new HttpError(404, 'Схема не найдена');
}

// ─────────────────────────────────────────────────────────────
// Чтение
// ─────────────────────────────────────────────────────────────
/**
 * Альбом целиком: метаданные, действующие модели, пользовательские пути и перечень
 * ролей. Клиент рисует схемы сам, поэтому получает модели, а не картинки.
 */
route.get('/api/processes', async ({ sendJson }) => {
  const diagrams = repo.album();
  sendJson(200, {
    diagrams: diagrams.map((d, i) => ({ ...d, seq: i + 1 })),
    scenarios: repo.SCENARIOS,
    roleOrder: repo.ROLE_ORDER,
  });
});

/** Краткий перечень без моделей — для списков и проверки доступности выгрузки. */
route.get('/api/processes/index', async ({ sendJson }) => {
  sendJson(200, repo.album().map((d, i) => ({
    seq: i + 1, id: d.id, role: d.role, scenario: d.scenario, group: d.group,
    title: d.title, sla: d.sla || null, version: d.version, isPipeline: d.isPipeline,
    nodes: d.nodes.length, steps: d.walkthrough?.length || 0,
  })));
});

// Альбом всех схем: титул, содержание, по странице на схему
route.get('/api/processes/album/pdf', async ({ user, ip, res }) => {
  const buf = albumPdf();
  logAction(user.id, 'processes.export', 'processes', null,
    { kind: 'album', pages: repo.album().length + 2 }, ip);
  sendPdf(res, buf, `Social1_Схемы_процессов_${new Date().toISOString().slice(0, 10)}.pdf`);
});

route.get('/api/processes/:id', async ({ params, sendJson }) => {
  const { diagram, seq } = findDiagram(params.id);
  const def = repo.defByKey(diagram.id);
  sendJson(200, {
    ...diagram, seq,
    def: { id: def.id, key: def.key, status: def.status, is_pipeline: !!def.is_pipeline },
    versions: repo.versionsOf(def.id),
  });
});

// Одна схема в PDF
route.get('/api/processes/:id/pdf', async ({ user, params, ip, res }) => {
  const { diagram, seq } = findDiagram(params.id);
  const buf = diagramPdf(diagram, seq);
  logAction(user.id, 'processes.export', 'processes', seq, { kind: 'diagram', id: diagram.id }, ip);
  sendPdf(res, buf, `Social1_${seq}_${fileName(diagram.title)}.pdf`);
});

route.get('/api/processes/:id/versions', async ({ params, sendJson }) => {
  const def = repo.defByKey(params.id);
  if (!def) throw new HttpError(404, 'Процесс не найден');
  sendJson(200, repo.versionsOf(def.id));
});

route.get('/api/process-versions/:id', async ({ params, sendJson }) => {
  const v = repo.getVersion(params.id);
  if (!v) throw new HttpError(404, 'Версия не найдена');
  const def = repo.defById(v.def_id);
  sendJson(200, { ...v, def: { key: def.key, title: def.title, is_pipeline: !!def.is_pipeline } });
});

// ─────────────────────────────────────────────────────────────
// Черновики и публикация
// ─────────────────────────────────────────────────────────────
route.post('/api/processes/:id/draft', async ({ req, user, params, ip, sendJson }) => {
  need(user, 'process.edit', 'Правка схем доступна ответственным за процессы');
  const def = repo.defByKey(params.id);
  if (!def) throw new HttpError(404, 'Процесс не найден');
  const b = await readJson(req);
  const draft = repo.createDraft({
    defId: def.id, basedOnVersionId: b.based_on ?? null, userId: user.id, notes: b.notes ?? null,
  });
  logAction(user.id, 'process.draft.create', 'process_version', draft.id,
    { key: def.key, version: draft.version }, ip);
  sendJson(201, draft);
});

route.put('/api/process-versions/:id', async ({ req, user, params, ip, sendJson }) => {
  need(user, 'process.edit', 'Правка схем доступна ответственным за процессы');
  const b = await readJson(req);
  if (!b.model) throw new HttpError(400, 'В запросе нет модели схемы');
  const saved = repo.saveDraft({ versionId: Number(params.id), model: b.model, userId: user.id, notes: b.notes });
  logAction(user.id, 'process.draft.save', 'process_version', saved.id, { version: saved.version }, ip);
  // Замечания возвращаются вместе с сохранением: черновик можно хранить незавершённым,
  // но автор должен видеть, что мешает публикации, пока правит схему
  sendJson(200, { ...saved, issues: validateModel(saved.model) });
});

route.delete('/api/process-versions/:id', async ({ user, params, ip, sendJson }) => {
  need(user, 'process.edit', 'Недостаточно прав');
  repo.deleteDraft(Number(params.id));
  logAction(user.id, 'process.draft.delete', 'process_version', Number(params.id), null, ip);
  sendJson(200, { ok: true });
});

/** Проверка перед публикацией — тем же кодом, что и сама публикация. */
route.get('/api/process-versions/:id/validate', async ({ params, sendJson }) => {
  sendJson(200, { issues: repo.validateForPublish(Number(params.id)) });
});

route.post('/api/process-versions/:id/publish', async ({ req, user, params, ip, sendJson }) => {
  need(user, 'process.publish', 'Публикация версии доступна центральному аппарату ДТСЗН');
  const b = await readJson(req);
  const published = repo.publishVersion({ versionId: Number(params.id), user, ip, force: !!b.force });
  const def = repo.defById(published.def_id);
  sendJson(200, {
    ...published,
    pipeline_projected: !!def.is_pipeline,
  });
});

/** На каких этапах конвейера сейчас стоят инициативы — показывается перед публикацией. */
route.get('/api/processes/pipeline/usage', async ({ sendJson }) => {
  sendJson(200, repo.liveStageUsage());
});
