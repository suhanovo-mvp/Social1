// Репозиторий процессов: определения, версии, публикация и проекция в конвейер.
//
// Опубликованная версия — источник истины. Из блоков stage её модели собирается
// workflow_config, поэтому согласованная правка схемы меняет сроки и ответственных
// в реальной работе платформы. Это и отличает совместное проектирование процессов
// от рисования картинок: результат обсуждения вступает в силу.
//
// Опубликованная версия неизменяема. Правка идёт через черновик, иначе ссылка из
// регламента на шаг «3.5» перестала бы что-либо значить.
import { q, tx } from './db.js';
import { logAction } from './audit.js';
import { validateModel, normalizeModel, stagesFromModel } from '../shared/bpmn/model.js';
import { DIAGRAMS } from './seed-processes.js';

export { SCENARIOS, ROLE_ORDER, scenarioOf, diagramsForRole, diagramsForScenario } from './seed-processes.js';

export class ProcessError extends Error {
  constructor(message, details) { super(message); this.status = 400; this.details = details; }
}

const parse = (row) => (row ? { ...row, model: JSON.parse(row.model) } : null);

// ─────────────────────────────────────────────────────────────
// Начальное наполнение
// ─────────────────────────────────────────────────────────────
export function ensureProcesses() {
  if (q.get('SELECT COUNT(*) AS c FROM process_defs').c > 0) { adoptNewDiagrams(); return; }
  tx(() => {
    DIAGRAMS.forEach((d, i) => insertSeedDiagram(d, i));
  });
  projectPipeline();
}

/**
 * Схемы, появившиеся с новым модулем, дописываются в конец альбома работающей базы.
 * Порядок уже действующих схем не трогается: номер раздела — это ссылка из
 * регламентов, и сдвиг перенаправил бы её на другую схему. Существующие схемы не
 * перезаписываются — их могли изменить через согласование.
 */
function adoptNewDiagrams() {
  const known = new Set(q.all('SELECT key FROM process_defs').map((r) => r.key));
  const fresh = DIAGRAMS.filter((d) => !known.has(d.id));
  if (!fresh.length) return;
  const base = (q.get('SELECT MAX(order_idx) AS n FROM process_defs').n ?? -1) + 1;
  tx(() => fresh.forEach((d, i) => insertSeedDiagram(d, base + i)));
}

function insertSeedDiagram(d, i) {
  const defId = q.insert(`INSERT INTO process_defs
    (key, title, description, scenario, group_title, role_owner, sla_text, order_idx, is_pipeline, status)
    VALUES (?,?,?,?,?,?,?,?,?,'published')`,
    d.id, d.title, d.description ?? null, d.scenario ?? null, d.group ?? null,
    d.role ?? null, d.sla ?? null, i, d.isPipeline ? 1 : 0);

  const versionId = q.insert(`INSERT INTO process_versions
    (def_id, version, model, notes, status, published_at)
    VALUES (?, 1, ?, ?, 'published', datetime('now'))`,
    defId, JSON.stringify(modelFromSeed(d)), 'Исходная редакция альбома схем');

  q.run('UPDATE process_defs SET current_version_id = ? WHERE id = ?', versionId, defId);
}

/** Модель схемы из записи начального наполнения: только поля модели, без метаданных. */
function modelFromSeed(d) {
  return normalizeModel({
    lanes: d.lanes, nodes: d.nodes, flows: d.flows, walkthrough: d.walkthrough,
  });
}

// ─────────────────────────────────────────────────────────────
// Чтение
// ─────────────────────────────────────────────────────────────
export function listDefs({ scenario = null } = {}) {
  const where = scenario ? 'WHERE d.scenario = ?' : '';
  const args = scenario ? [scenario] : [];
  return q.all(`SELECT d.*, v.version AS current_version, v.published_at,
                       (SELECT COUNT(*) FROM process_versions pv WHERE pv.def_id = d.id) AS versions_count
                FROM process_defs d
                LEFT JOIN process_versions v ON v.id = d.current_version_id
                ${where}
                ORDER BY d.order_idx`, ...args);
}

export const defByKey = (key) => q.get('SELECT * FROM process_defs WHERE key = ?', key);
export const defById = (id) => q.get('SELECT * FROM process_defs WHERE id = ?', Number(id));

export const pipelineDef = () => q.get('SELECT * FROM process_defs WHERE is_pipeline = 1');

export function versionsOf(defId) {
  return q.all(`SELECT v.id, v.version, v.status, v.notes, v.created_at, v.published_at,
                       u.full_name AS created_by_name, p.full_name AS published_by_name
                FROM process_versions v
                LEFT JOIN users u ON u.id = v.created_by
                LEFT JOIN users p ON p.id = v.published_by
                WHERE v.def_id = ? ORDER BY v.version DESC`, Number(defId));
}

export const getVersion = (id) => parse(q.get('SELECT * FROM process_versions WHERE id = ?', Number(id)));

export function currentVersion(defId) {
  return parse(q.get(`SELECT v.* FROM process_versions v
                      JOIN process_defs d ON d.current_version_id = v.id
                      WHERE d.id = ?`, Number(defId)));
}

/** Действующая модель схемы по её ключу. */
export function publishedModel(key) {
  const def = defByKey(key);
  return def ? currentVersion(def.id)?.model ?? null : null;
}

/**
 * Альбом действующих схем в порядке разделов — в том виде, в каком его ждут
 * отрисовка в SVG и выгрузка в PDF: метаданные определения плюс модель.
 */
export function album() {
  return listDefs().map((d) => {
    const v = currentVersion(d.id);
    return {
      id: d.key, title: d.title, description: d.description, scenario: d.scenario,
      group: d.group_title, role: d.role_owner, sla: d.sla_text,
      isPipeline: !!d.is_pipeline, version: v?.version ?? null,
      ...(v?.model ?? { lanes: [], nodes: [], flows: [], walkthrough: [] }),
    };
  });
}

/** Одна действующая схема в той же форме, что и в альбоме. */
export const diagram = (key) => album().find((d) => d.id === key) || null;

// ─────────────────────────────────────────────────────────────
// Черновики
// ─────────────────────────────────────────────────────────────
export function createDraft({ defId, basedOnVersionId = null, userId = null, notes = null }) {
  const def = defById(defId);
  if (!def) throw new ProcessError('Процесс не найден');
  const base = basedOnVersionId ? getVersion(basedOnVersionId) : currentVersion(defId);
  if (!base) throw new ProcessError('Не найдена версия, от которой создаётся черновик');

  const next = (q.get('SELECT MAX(version) AS n FROM process_versions WHERE def_id = ?', defId).n || 0) + 1;
  const id = q.insert(`INSERT INTO process_versions
    (def_id, version, model, notes, status, based_on_version_id, created_by)
    VALUES (?,?,?,?,'draft',?,?)`,
    defId, next, JSON.stringify(base.model), notes, base.id, userId);
  return getVersion(id);
}

export function saveDraft({ versionId, model, userId = null, notes = undefined }) {
  const v = getVersion(versionId);
  if (!v) throw new ProcessError('Версия не найдена');
  if (v.status === 'published' || v.status === 'superseded') {
    throw new ProcessError('Опубликованная версия неизменяема — создайте черновик');
  }
  const normalized = normalizeModel(model);
  q.run(`UPDATE process_versions SET model = ?, updated_at = datetime('now'),
         notes = COALESCE(?, notes) WHERE id = ?`,
    JSON.stringify(normalized), notes ?? null, versionId);
  return getVersion(versionId);
}

export function deleteDraft(versionId) {
  const v = getVersion(versionId);
  if (!v) throw new ProcessError('Версия не найдена');
  if (v.status !== 'draft') throw new ProcessError('Удалить можно только черновик');
  q.run('DELETE FROM process_versions WHERE id = ?', versionId);
}

// ─────────────────────────────────────────────────────────────
// Проверка перед публикацией
// ─────────────────────────────────────────────────────────────
/** Сколько инициатив сейчас находится на каждом этапе конвейера. */
export function liveStageUsage() {
  return q.all(`SELECT stage, COUNT(*) AS count FROM initiatives
                WHERE status IN ('active','hold') GROUP BY stage ORDER BY stage`);
}

const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
};

/**
 * Отдельная защита для конвейера: этап, на котором стоят живые инициативы, нельзя
 * ни убрать, ни перенумеровать.
 *
 * Сравнение идёт по узлу схемы, а не по номеру этапа. Номер — это позиция, и она
 * сдвигается: если убрать третий этап и сдвинуть остальные, номер 3 останется
 * занятым, но за ним будет стоять уже другая работа. Инициатива, ожидающая решения
 * руководителя, молча оказалась бы на разработке прототипа. Узел же остаётся собой.
 */
export function guardPipeline(model) {
  const def = pipelineDef();
  const published = def ? currentVersion(def.id)?.model : null;
  if (!published) return [];   // сравнивать не с чем — конвейер ещё не публиковался

  const wasByStage = new Map(stagesFromModel(published).map((s) => [s.stage_no, s]));
  const nextByNode = new Map(stagesFromModel(model).map((s) => [s.node_id, s]));

  const errors = [];
  for (const row of liveStageUsage()) {
    const was = wasByStage.get(row.stage);
    if (!was) continue;                       // этап и раньше не был описан в модели
    const count = `${row.count} ${plural(row.count, 'инициатива', 'инициативы', 'инициатив')}`;
    const move = plural(row.count, 'переведите её', 'переведите их', 'переведите их');
    const land = plural(row.count, 'она оказалась бы', 'они оказались бы', 'они оказались бы');
    const now = nextByNode.get(was.node_id);
    if (!now) {
      errors.push({
        code: 'stage.inUse',
        node: was.node_id,
        message: `Этап № ${row.stage} «${was.stage_name}» убран, но на нём находится ${count} — ` +
                 `сначала ${move} дальше по конвейеру`,
      });
    } else if (now.stage_no !== row.stage) {
      errors.push({
        code: 'stage.renumbered',
        node: was.node_id,
        message: `Этап «${was.stage_name}» переномерован с № ${row.stage} на № ${now.stage_no}, ` +
                 `но на нём находится ${count} — ${land} на чужом этапе`,
      });
    }
  }
  return errors;
}

/** Полная проверка версии перед публикацией. Пустой перечень — версию можно публиковать. */
export function validateForPublish(versionId) {
  const v = getVersion(versionId);
  if (!v) throw new ProcessError('Версия не найдена');
  const def = defById(v.def_id);
  const errors = validateModel(v.model);
  if (def.is_pipeline) {
    errors.push(...guardPipeline(v.model));
    if (!stagesFromModel(v.model).length) {
      errors.push({ code: 'pipeline.noStages', message: 'В конвейере не описан ни один этап' });
    }
  }
  return errors;
}

// ─────────────────────────────────────────────────────────────
// Публикация
// ─────────────────────────────────────────────────────────────
export function publishVersion({ versionId, user = null, ip = null, force = false }) {
  const errors = validateForPublish(versionId);
  if (errors.length && !force) {
    throw new ProcessError('Версию нельзя опубликовать: схема не прошла проверку', errors);
  }
  return tx(() => {
    const v = getVersion(versionId);
    const def = defById(v.def_id);

    q.run(`UPDATE process_versions SET status = 'superseded'
           WHERE def_id = ? AND status = 'published'`, def.id);
    q.run(`UPDATE process_versions SET status = 'published', published_at = datetime('now'),
           published_by = ? WHERE id = ?`, user?.id ?? null, versionId);
    q.run(`UPDATE process_defs SET current_version_id = ?, status = 'published',
           updated_at = datetime('now') WHERE id = ?`, versionId, def.id);

    if (def.is_pipeline) projectPipeline(v.model);

    logAction(user?.id ?? null, 'process.publish', 'process_version', versionId,
      { key: def.key, version: v.version, pipeline: !!def.is_pipeline }, ip);
    return getVersion(versionId);
  });
}

// ─────────────────────────────────────────────────────────────
// Проекция конвейера
// ─────────────────────────────────────────────────────────────
/**
 * Переписывает workflow_config из блоков stage опубликованной модели.
 *
 * Таблица намеренно сохранена: на неё опираются аналитика, контроль SLA и шесть
 * разделов портала. Она перестала быть самостоятельной настройкой и стала
 * производной от модели — единственным местом записи остаётся схема.
 */
export function projectPipeline(model = null) {
  const src = model ?? currentVersion(pipelineDef()?.id)?.model;
  if (!src) return 0;
  const stages = stagesFromModel(src);
  if (!stages.length) return 0;

  return tx(() => {
    q.run('DELETE FROM workflow_config');
    for (const s of stages) {
      q.run(`INSERT INTO workflow_config
        (stage_no, stage_name, tz_stage, tz_stage_name, description, trigger_text, participants,
         gate_no, gate_name, role_required, sla_value, sla_unit, sla_text, criteria, decisions)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        s.stage_no, s.stage_name, s.tz_stage, s.tz_stage_name, s.description, s.trigger_text,
        JSON.stringify(s.participants), s.gate_no, s.gate_name, s.role_required,
        s.sla_value, s.sla_unit, s.sla_text, JSON.stringify(s.criteria), JSON.stringify(s.decisions));
    }
    return stages.length;
  });
}

/**
 * Правка одного этапа конвейера напрямую — путь для админ-панели настройки Stage-Gate.
 * Записывает не в workflow_config, а в модель: создаёт версию, публикует её и
 * пересобирает проекцию. Так у конфигурации остаётся единственный источник и полная
 * история изменений, кем бы правка ни была внесена.
 */
export function patchStage({ stageNo, patch, user = null, ip = null }) {
  const def = pipelineDef();
  if (!def) throw new ProcessError('Конвейер инициатив не заведён в репозитории');
  const current = currentVersion(def.id);
  const model = structuredClone(current.model);
  const node = model.nodes.find((n) => n.stage && Number(n.stage.stage_no) === Number(stageNo));
  if (!node) throw new ProcessError(`Этап № ${stageNo} в схеме конвейера не найден`);

  for (const [field, value] of Object.entries(patch)) {
    if (value !== undefined) node.stage[field] = value;
  }

  const draft = createDraft({
    defId: def.id, userId: user?.id ?? null,
    notes: `Правка этапа № ${stageNo} через настройки платформы`,
  });
  saveDraft({ versionId: draft.id, model, userId: user?.id ?? null });
  publishVersion({ versionId: draft.id, user, ip });
  return stagesFromModel(model).find((s) => Number(s.stage_no) === Number(stageNo));
}
