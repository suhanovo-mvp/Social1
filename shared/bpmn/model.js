// Схема модели процесса: нормализация, проверка целостности, разбор блоков этапов.
// Модуль не зависит от DOM и от базы — им пользуются редактор в браузере, проверка
// перед публикацией на сервере и тесты. Одни правила во всех трёх местах: схема,
// прошедшая проверку в редакторе, не может быть отвергнута публикацией по другой причине.
import { SHAPES, shapeOf, wrapLabel } from './layout.js';

// Событий, с которых процесс может начаться: обычный старт, входящее сообщение, таймер
export const START_TYPES = ['start', 'message', 'timer'];

// Поля блока этапа — один в один колонки workflow_config, чтобы проекция
// опубликованной версии в конвейер была переносом значений, а не преобразованием.
export const STAGE_FIELDS = [
  'stage_no', 'stage_name', 'tz_stage', 'tz_stage_name', 'description', 'trigger_text',
  'participants', 'gate_no', 'gate_name', 'role_required',
  'sla_value', 'sla_unit', 'sla_text', 'criteria', 'decisions',
];

// Единицы срока и их названия. Определены здесь, а не в серверном модуле сроков:
// список нужен и проверке схемы, и редактору в браузере.
export const SLA_UNITS = {
  workdays: 'рабочих дней',
  calendardays: 'календарных дней',
};

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (v === null || v === undefined ? '' : String(v));

/** Канонический вид модели: заполненные значения по умолчанию, отброшенные лишние поля. */
export function normalizeModel(model = {}) {
  return {
    lanes: arr(model.lanes).map((l) => ({
      id: str(l.id),
      title: str(l.title),
      role: l.role ?? null,               // роль платформы, отвечающая за дорожку
      assignment: l.assignment ?? null,   // правило назначения внутри роли
    })),
    nodes: arr(model.nodes).map((n) => ({
      id: str(n.id),
      type: str(n.type) || 'task',
      lane: str(n.lane),
      col: Number(n.col) || 0,
      row: Number(n.row) || 0,
      label: str(n.label),
      stage: n.stage ? normalizeStage(n.stage) : null,
    })),
    flows: arr(model.flows).map((f) => ({
      from: str(f.from),
      to: str(f.to),
      label: f.label ?? null,
      kind: f.kind ?? null,               // message — поток сообщений, иначе поток управления
      condition: f.condition ?? null,
    })),
    walkthrough: arr(model.walkthrough).map((w) => ({
      node: str(w.node), title: str(w.title), body: str(w.body),
    })),
  };
}

export function normalizeStage(stage = {}) {
  const s = {};
  for (const f of STAGE_FIELDS) s[f] = stage[f] ?? null;
  s.participants = arr(stage.participants);
  s.criteria = arr(stage.criteria);
  s.decisions = arr(stage.decisions);
  s.stage_no = Number(stage.stage_no) || null;
  s.tz_stage = stage.tz_stage === null || stage.tz_stage === undefined ? null : Number(stage.tz_stage);
  s.gate_no = stage.gate_no === null || stage.gate_no === undefined ? null : Number(stage.gate_no);
  s.sla_value = stage.sla_value === null || stage.sla_value === undefined ? null : Number(stage.sla_value);
  return s;
}

export const emptyModel = () => ({ lanes: [], nodes: [], flows: [], walkthrough: [] });

/** Блоки этапов, объявленные в модели, по возрастанию номера. */
export function stagesFromModel(model) {
  return normalizeModel(model).nodes
    .filter((n) => n.stage && n.stage.stage_no)
    .map((n) => ({ ...n.stage, node_id: n.id }))
    .sort((a, b) => a.stage_no - b.stage_no);
}

const err = (code, message, node = null) => ({ code, message, node });

/**
 * Проверка целостности схемы. Возвращает перечень нарушений: пустой — схема корректна.
 * Порядок проверок — от структуры к содержанию, чтобы автор сначала видел разрывы
 * в модели, а не замечания к длине подписей.
 */
export function validateModel(raw) {
  const m = normalizeModel(raw);
  const errors = [];

  // ── Дорожки ──
  const laneIds = new Set();
  for (const l of m.lanes) {
    if (!l.id) errors.push(err('lane.id', 'У дорожки не задан идентификатор'));
    else if (laneIds.has(l.id)) errors.push(err('lane.duplicate', `Дорожка «${l.id}» объявлена дважды`));
    else laneIds.add(l.id);
    if (!l.title) errors.push(err('lane.title', `У дорожки «${l.id}» нет названия`));
  }
  if (!m.lanes.length) errors.push(err('lane.none', 'В схеме нет ни одной дорожки'));

  // ── Узлы ──
  const nodeIds = new Set();
  for (const n of m.nodes) {
    if (!n.id) { errors.push(err('node.id', 'У узла не задан идентификатор')); continue; }
    if (nodeIds.has(n.id)) errors.push(err('node.duplicate', `Узел «${n.id}» объявлен дважды`, n.id));
    else nodeIds.add(n.id);
    if (!SHAPES[n.type]) errors.push(err('node.type', `Неизвестный тип фигуры «${n.type}»`, n.id));
    if (!laneIds.has(n.lane)) errors.push(err('node.lane', `Узел «${n.id}» лежит вне объявленных дорожек`, n.id));
    if (!n.label) errors.push(err('node.label', `У узла «${n.id}» нет подписи`, n.id));
    else if (wrapLabel(n.label, shapeOf(n.type)).some((l) => l.endsWith('…'))) {
      errors.push(err('node.overflow', `Подпись «${n.label}» не умещается в фигуру`, n.id));
    }
  }
  if (!m.nodes.length) errors.push(err('node.none', 'В схеме нет ни одного шага'));

  // ── Потоки ──
  const endIds = new Set(m.nodes.filter((n) => n.type === 'end').map((n) => n.id));
  for (const f of m.flows) {
    if (!nodeIds.has(f.from)) errors.push(err('flow.from', `Поток выходит из несуществующего узла «${f.from}»`));
    if (!nodeIds.has(f.to)) errors.push(err('flow.to', `Поток входит в несуществующий узел «${f.to}»`));
    if (endIds.has(f.from)) errors.push(err('flow.fromEnd', `Из завершающего события «${f.from}» выходит поток`, f.from));
  }

  // ── Начало, завершение, достижимость ──
  const starts = m.nodes.filter((n) => START_TYPES.includes(n.type));
  if (!starts.length) errors.push(err('model.noStart', 'В схеме нет стартового события'));
  if (!endIds.size) errors.push(err('model.noEnd', 'В схеме нет завершающего события'));
  const incoming = new Set(m.flows.map((f) => f.to));
  const startIds = new Set(starts.map((n) => n.id));
  for (const n of m.nodes) {
    if (!incoming.has(n.id) && !startIds.has(n.id)) {
      errors.push(err('node.unreachable', `Узел «${n.id}» недостижим — в него не входит ни один поток`, n.id));
    }
  }

  // ── Разбор по шагам ──
  for (const w of m.walkthrough) {
    if (!nodeIds.has(w.node)) errors.push(err('walk.node', `Разбор ссылается на несуществующий узел «${w.node}»`));
    if (!w.title || !w.body) errors.push(err('walk.empty', `Шаг разбора «${w.node}» без заголовка или пояснения`, w.node));
  }

  errors.push(...validateStages(m));
  return errors;
}

/**
 * Проверка блоков этапов. Схема-документация их не содержит и проходит проверку
 * без замечаний; конвейер инициатив обязан описывать этапы подряд с первого.
 */
export function validateStages(raw) {
  const stages = stagesFromModel(raw);
  const errors = [];
  if (!stages.length) return errors;

  const seen = new Set();
  for (const s of stages) {
    if (seen.has(s.stage_no)) errors.push(err('stage.duplicate', `Этап № ${s.stage_no} объявлен дважды`, s.node_id));
    seen.add(s.stage_no);
    if (!s.stage_name) errors.push(err('stage.name', `У этапа № ${s.stage_no} нет названия`, s.node_id));
    if (s.gate_no) {
      if (!s.role_required) errors.push(err('stage.role', `На «${s.gate_name || 'Gate ' + s.gate_no}» не указана решающая роль`, s.node_id));
      if (!s.decisions.length) errors.push(err('stage.decisions', `На «${s.gate_name || 'Gate ' + s.gate_no}» не задан перечень решений`, s.node_id));
    }
    if (s.sla_value !== null && !SLA_UNITS[s.sla_unit]) {
      errors.push(err('stage.slaUnit', `У этапа № ${s.stage_no} срок задан в неизвестных единицах`, s.node_id));
    }
  }

  // Разрыв в нумерации оставил бы инициативу на несуществующем этапе
  stages.forEach((s, i) => {
    if (s.stage_no !== i + 1) {
      errors.push(err('stage.gapInNumbering',
        `Нумерация этапов должна идти подряд с первого: ожидался № ${i + 1}, объявлен № ${s.stage_no}`, s.node_id));
    }
  });

  const gates = stages.filter((s) => s.gate_no).map((s) => s.gate_no);
  if (new Set(gates).size !== gates.length) {
    errors.push(err('stage.gateDuplicate', 'Номер точки принятия решения повторяется'));
  }
  return errors;
}

/** Ключ потока для сравнения версий: пара узлов однозначно определяет связь. */
export const flowKey = (f) => `${f.from}→${f.to}`;
