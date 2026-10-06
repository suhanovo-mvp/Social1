// Сравнение двух версий схемы процесса. Возвращает структурное различие и краткую
// сводку обычным языком — именно её читают голосующие и согласующие, поэтому сводка
// здесь такая же часть результата, как и сам разбор изменений.
//
// Перестановка фигур отделена от смысловых правок: маршрут согласования выводится
// из затронутых дорожек, и перекладывание схемы не должно поднимать на согласование
// половину департамента.
import { normalizeModel, stagesFromModel, flowKey, STAGE_FIELDS, SLA_UNITS } from './model.js';

const SEMANTIC_NODE_FIELDS = ['type', 'lane', 'label'];
const POSITION_FIELDS = ['col', 'row'];

const byId = (list) => new Map(list.map((x) => [x.id, x]));
const eq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function fieldDiff(a, b, fields) {
  return fields
    .filter((f) => !eq(a[f], b[f]))
    .map((f) => ({ field: f, from: a[f] ?? null, to: b[f] ?? null }));
}

/** Структурное различие двух моделей. */
export function diffModels(baseRaw, nextRaw) {
  const base = normalizeModel(baseRaw);
  const next = normalizeModel(nextRaw);

  // ── Дорожки ──
  const baseLanes = byId(base.lanes), nextLanes = byId(next.lanes);
  const lanes = {
    added: next.lanes.filter((l) => !baseLanes.has(l.id)),
    removed: base.lanes.filter((l) => !nextLanes.has(l.id)),
    changed: next.lanes
      .filter((l) => baseLanes.has(l.id))
      .map((l) => ({ id: l.id, title: l.title, fields: fieldDiff(baseLanes.get(l.id), l, ['title', 'role', 'assignment']) }))
      .filter((x) => x.fields.length),
  };

  // ── Узлы ──
  const baseNodes = byId(base.nodes), nextNodes = byId(next.nodes);
  const changed = [], moved = [];
  for (const n of next.nodes) {
    const was = baseNodes.get(n.id);
    if (!was) continue;
    const fields = fieldDiff(was, n, SEMANTIC_NODE_FIELDS);
    if (!eq(was.stage, n.stage)) fields.push({ field: 'stage', from: was.stage, to: n.stage });
    if (fields.length) changed.push({ id: n.id, label: n.label, lane: n.lane, was, now: n, fields });
    const pos = fieldDiff(was, n, POSITION_FIELDS);
    if (pos.length) moved.push({ id: n.id, label: n.label, fields: pos });
  }
  const nodes = {
    added: next.nodes.filter((n) => !baseNodes.has(n.id)),
    removed: base.nodes.filter((n) => !nextNodes.has(n.id)),
    changed,
    moved,
  };

  // ── Потоки ──
  const baseFlows = new Map(base.flows.map((f) => [flowKey(f), f]));
  const nextFlows = new Map(next.flows.map((f) => [flowKey(f), f]));
  const flows = {
    added: next.flows.filter((f) => !baseFlows.has(flowKey(f))),
    removed: base.flows.filter((f) => !nextFlows.has(flowKey(f))),
    changed: next.flows
      .filter((f) => baseFlows.has(flowKey(f)))
      .map((f) => ({ from: f.from, to: f.to, fields: fieldDiff(baseFlows.get(flowKey(f)), f, ['label', 'kind', 'condition']) }))
      .filter((x) => x.fields.length),
  };

  // ── Этапы конвейера ──
  const baseStages = new Map(stagesFromModel(base).map((s) => [s.stage_no, s]));
  const nextStages = new Map(stagesFromModel(next).map((s) => [s.stage_no, s]));
  const stages = {
    added: [...nextStages.values()].filter((s) => !baseStages.has(s.stage_no)),
    removed: [...baseStages.values()].filter((s) => !nextStages.has(s.stage_no)),
    changed: [...nextStages.values()]
      .filter((s) => baseStages.has(s.stage_no))
      .map((s) => ({ stage_no: s.stage_no, stage_name: s.stage_name, was: baseStages.get(s.stage_no), now: s,
                     fields: fieldDiff(baseStages.get(s.stage_no), s, STAGE_FIELDS) }))
      .filter((x) => x.fields.length),
  };

  // ── Затронутые дорожки: только смысловые правки, не перекладывание ──
  const touched = new Set();
  for (const n of nodes.added) touched.add(n.lane);
  for (const n of nodes.removed) touched.add(n.lane);
  for (const n of nodes.changed) { touched.add(n.was.lane); touched.add(n.now.lane); }
  for (const l of [...lanes.added, ...lanes.removed]) touched.add(l.id);
  for (const l of lanes.changed) touched.add(l.id);
  for (const f of [...flows.added, ...flows.removed, ...flows.changed]) {
    for (const id of [f.from, f.to]) {
      const node = nextNodes.get(id) || baseNodes.get(id);
      if (node) touched.add(node.lane);
    }
  }

  const counts = {
    nodesAdded: nodes.added.length, nodesRemoved: nodes.removed.length,
    nodesChanged: nodes.changed.length, nodesMoved: nodes.moved.length,
    flowsAdded: flows.added.length, flowsRemoved: flows.removed.length,
    flowsChanged: flows.changed.length,
    stagesAdded: stages.added.length, stagesRemoved: stages.removed.length,
    stagesChanged: stages.changed.length,
    lanesTouched: touched.size,
  };
  const semantic = counts.nodesAdded + counts.nodesRemoved + counts.nodesChanged
    + counts.flowsAdded + counts.flowsRemoved + counts.flowsChanged
    + lanes.added.length + lanes.removed.length + lanes.changed.length;

  return {
    lanes, nodes, flows, stages, counts,
    touchedLanes: [...touched].filter(Boolean),
    hasSemanticChanges: semantic > 0,
    isEmpty: semantic === 0 && counts.nodesMoved === 0,
  };
}

// ── Сводка обычным языком ────────────────────────────────────
const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
};
const steps = (n) => `${n} ${plural(n, 'шаг', 'шага', 'шагов')}`;

function slaPhrase(was, now) {
  if (was.sla_value === now.sla_value && was.sla_unit === now.sla_unit) return null;
  const name = now.gate_name || now.stage_name || `этап № ${now.stage_no}`;
  if (was.sla_value === null) return `${name}: установлен срок ${now.sla_value} ${SLA_UNITS[now.sla_unit] || ''}`.trim();
  if (now.sla_value === null) return `${name}: срок снят`;
  const verb = now.sla_value < was.sla_value ? 'сокращён' : 'увеличен';
  return `${name}: срок ${verb} с ${was.sla_value} до ${now.sla_value} ${SLA_UNITS[now.sla_unit] || ''}`.trim();
}

/**
 * Краткая сводка изменений. Первая строка отвечает на вопрос «что поменялось»,
 * дальше — то, что влияет на работу людей: сроки, ответственные, состав шагов.
 *
 * @param laneTitles словарь идентификатор дорожки → название, для читаемости
 */
export function summarize(diff, laneTitles = {}) {
  const out = [];
  const c = diff.counts;

  if (diff.isEmpty) return ['Изменений нет'];
  if (!diff.hasSemanticChanges) return [`Изменена только раскладка: переставлено ${steps(c.nodesMoved)}`];

  if (c.nodesAdded) out.push(`Добавлено ${steps(c.nodesAdded)}: ${diff.nodes.added.map((n) => `«${n.label}»`).join(', ')}`);
  if (c.nodesRemoved) out.push(`Убрано ${steps(c.nodesRemoved)}: ${diff.nodes.removed.map((n) => `«${n.label}»`).join(', ')}`);

  for (const n of diff.nodes.changed) {
    for (const f of n.fields) {
      if (f.field === 'label') out.push(`Переформулирован шаг: «${f.from}» → «${f.to}»`);
      else if (f.field === 'lane') {
        out.push(`Шаг «${n.label}» передан: ${laneTitles[f.from] || f.from} → ${laneTitles[f.to] || f.to}`);
      } else if (f.field === 'type') out.push(`Шаг «${n.label}» сменил тип: ${f.from} → ${f.to}`);
    }
  }

  for (const s of diff.stages.changed) {
    const sla = slaPhrase(s.was, s.now);
    if (sla) out.push(sla);
    const role = s.fields.find((f) => f.field === 'role_required');
    if (role) out.push(`${s.now.gate_name || s.stage_name}: решение переходит от роли «${role.from}» к роли «${role.to}»`);
    const dec = s.fields.find((f) => f.field === 'decisions');
    if (dec) out.push(`${s.now.gate_name || s.stage_name}: изменён перечень допустимых решений`);
    const crit = s.fields.find((f) => f.field === 'criteria');
    if (crit) out.push(`${s.now.gate_name || s.stage_name}: изменены критерии оценки`);
  }
  if (c.stagesAdded) out.push(`Добавлено этапов конвейера: ${c.stagesAdded}`);
  if (c.stagesRemoved) out.push(`Убрано этапов конвейера: ${c.stagesRemoved}`);

  if (c.flowsAdded || c.flowsRemoved) {
    const parts = [];
    if (c.flowsAdded) parts.push(`добавлено ${c.flowsAdded}`);
    if (c.flowsRemoved) parts.push(`убрано ${c.flowsRemoved}`);
    out.push(`Переходы между шагами: ${parts.join(', ')}`);
  }

  const names = diff.touchedLanes.map((id) => laneTitles[id] || id);
  if (names.length) out.push(`Затронуты дорожки: ${names.join(', ')}`);
  return out;
}

/** Словарь названий дорожек из модели — для читаемой сводки. */
export const laneTitlesOf = (model) =>
  Object.fromEntries(normalizeModel(model).lanes.map((l) => [l.id, l.title]));
