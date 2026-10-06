// Редактор схемы процесса. Работает поверх того же рендерера, что и просмотр:
// схема остаётся живым SVG, а правка сводится к смене ячейки в сетке col/row.
//
// Свободного позиционирования здесь намеренно нет. Сетка — не упрощение, а условие
// читаемости: дорожки остаются ровными, шаги выстраиваются по колонкам, и схема,
// собранная сотрудником без навыков черчения, выглядит так же, как нарисованная
// проектировщиком. Ту же сетку печатает выгрузка в PDF.
import { api, esc, html, toast, modal, confirmDialog, navigate, ROLE_TITLES } from '../core.js';
import { renderDiagram } from '../bpmn.js';
import { GEO, layout, SHAPES } from '/shared/bpmn/layout.js';
import { validateModel, normalizeModel, stagesFromModel, SLA_UNITS } from '/shared/bpmn/model.js';
import { diffModels, summarize, laneTitlesOf } from '/shared/bpmn/diff.js';

// Палитра: то же, что понимает рендерер, человеческими словами
const PALETTE = [
  ['start', 'Начало', 'Событие, запускающее процесс'],
  ['user', 'Задача участника', 'Шаг, который выполняет человек'],
  ['service', 'Задача платформы', 'Шаг, который выполняет система'],
  ['xor', 'Развилка', 'Выбирается одна ветвь'],
  ['and', 'Параллельно', 'Ветви идут одновременно'],
  ['timer', 'Ожидание', 'Пауза или срок'],
  ['message', 'Сообщение', 'Уведомление или задача извне'],
  ['end', 'Завершение', 'Чем процесс заканчивается'],
];

const DECISION_TITLES = {
  go: 'Go — продолжить', kill: 'Kill — остановить',
  hold: 'Hold — приостановить', redirect: 'Redirect — перенаправить',
};

const uid = (prefix, taken) => {
  let i = 1;
  while (taken.has(`${prefix}${i}`)) i += 1;
  return `${prefix}${i}`;
};

/**
 * @param opts.model      модель, которую правим
 * @param opts.baseModel  действующая версия — для показа различий
 * @param opts.onSave     сохранение: получает модель, возвращает промис
 * @param opts.readOnly   только просмотр (например, чужое предложение)
 */
export function mountEditor(host, { model, baseModel = null, onSave, readOnly = false, title = '' }) {
  let draft = normalizeModel(model);
  let selected = null;          // { kind: 'node' | 'flow' | 'lane', id }
  let connectFrom = null;       // идентификатор узла, от которого тянем переход
  let pendingType = null;       // тип фигуры, выбранный в палитре
  let dirty = false;

  const nodeIds = () => new Set(draft.nodes.map((n) => n.id));
  const issues = () => validateModel(draft);
  const changes = () => (baseModel ? diffModels(baseModel, draft) : null);

  function markDirty() { dirty = true; render(); }

  // ── Геометрия: экран → ячейка сетки ────────────────────────
  function cellAt(svg, evt) {
    const pt = new DOMPoint(evt.clientX, evt.clientY).matrixTransform(svg.getScreenCTM().inverse());
    const { lanes } = layout(draft, 1);
    const lane = lanes.find((l) => pt.y >= l.top && pt.y < l.top + l.height) ?? lanes.at(-1);
    if (!lane) return null;
    const col = Math.max(0, Math.round((pt.x - GEO.LANE_LABEL - GEO.COL / 2) / GEO.COL));
    const row = Math.max(0, Math.round((pt.y - lane.top - GEO.PAD_Y / 2 - GEO.ROW / 2) / GEO.ROW));
    return { lane: lane.id, col, row };
  }

  const occupied = (cell, exceptId = null) => draft.nodes.some(
    (n) => n.id !== exceptId && n.lane === cell.lane && n.col === cell.col && n.row === cell.row);

  // ── Правка модели ──────────────────────────────────────────
  function addNode(type, cell) {
    if (occupied(cell)) { toast('Ячейка занята — выберите свободное место', 'warn'); return; }
    const id = uid(type === 'xor' || type === 'and' ? 'g' : type.slice(0, 2), nodeIds());
    draft.nodes.push({ id, type, lane: cell.lane, col: cell.col, row: cell.row,
                       label: 'Новый шаг', stage: null });
    selected = { kind: 'node', id };
    pendingType = null;
    markDirty();
  }

  function moveNode(id, cell) {
    if (occupied(cell, id)) return;
    const n = draft.nodes.find((x) => x.id === id);
    Object.assign(n, cell);
    markDirty();
  }

  function removeNode(id) {
    draft.nodes = draft.nodes.filter((n) => n.id !== id);
    draft.flows = draft.flows.filter((f) => f.from !== id && f.to !== id);
    draft.walkthrough = draft.walkthrough.filter((w) => w.node !== id);
    selected = null;
    markDirty();
  }

  function connect(from, to) {
    if (from === to) { toast('Шаг нельзя соединить с самим собой', 'warn'); return; }
    if (draft.flows.some((f) => f.from === from && f.to === to)) {
      toast('Такой переход уже есть', 'warn'); return;
    }
    draft.flows.push({ from, to, label: null, kind: null, condition: null });
    connectFrom = null;
    selected = { kind: 'flow', id: `${from}→${to}` };
    markDirty();
  }

  const flowByKey = (key) => draft.flows.find((f) => `${f.from}→${f.to}` === key);

  function removeFlow(key) {
    draft.flows = draft.flows.filter((f) => `${f.from}→${f.to}` !== key);
    selected = null;
    markDirty();
  }

  // ── Отрисовка ──────────────────────────────────────────────
  function render() {
    const problems = issues();
    const diff = changes();
    host.innerHTML = html`
      <div class="ed">
        <div class="ed__bar">
          <div class="ed__title">
            <b>${esc(title || 'Схема процесса')}</b>
            <span class="ed__hint">${readOnly ? 'Просмотр' : 'Перетащите шаг, чтобы переместить. Двойной щелчок — свойства.'}</span>
          </div>
          <div class="row" style="gap:8px">
            ${problems.length
              ? `<span class="badge badge--warn" title="Схему нельзя опубликовать, пока есть замечания">Замечаний: ${problems.length}</span>`
              : '<span class="badge badge--ok">Схема корректна</span>'}
            ${diff && !diff.isEmpty ? `<span class="badge badge--info">Изменений: ${diff.counts.nodesAdded + diff.counts.nodesRemoved + diff.counts.nodesChanged}</span>` : ''}
            ${readOnly ? '' : '<button class="btn btn--primary btn--sm" data-save>Сохранить</button>'}
          </div>
        </div>

        ${readOnly ? '' : html`
        <div class="ed__palette">
          <span class="ed__palette-label">Добавить шаг:</span>
          ${PALETTE.map(([type, label, hint]) => html`
            <button class="ed__shape ${pendingType === type ? 'is-on' : ''}"
                    data-shape="${type}" title="${esc(hint)}">${esc(label)}</button>`)}
          <button class="ed__shape ${connectFrom ? 'is-on' : ''}" data-connect
                  title="Выберите шаг, затем тот, к которому ведёт переход">
            ${connectFrom ? 'Куда ведёт переход?' : 'Соединить шаги'}</button>
          <button class="ed__shape" data-lanes title="Дорожки — зоны ответственности">Дорожки</button>
        </div>`}

        <div class="ed__body">
          <div class="bp-canvas ed__canvas ${pendingType ? 'is-placing' : ''} ${connectFrom ? 'is-connecting' : ''}">
            <div class="bp-canvas__inner">${renderDiagram(draft, null)}</div>
          </div>
          <aside class="ed__side">${sidePanel(problems, diff)}</aside>
        </div>
      </div>`;

    decorate();
    bind();
  }

  /** Пометки на схеме: выбранное, добавленное, изменённое относительно действующей версии. */
  function decorate() {
    const svg = host.querySelector('.bp-svg');
    if (!svg) return;
    const diff = changes();
    if (diff) {
      const added = new Set(diff.nodes.added.map((n) => n.id));
      const edited = new Set(diff.nodes.changed.map((n) => n.id));
      svg.querySelectorAll('.bp-node').forEach((el) => {
        el.classList.toggle('is-added', added.has(el.dataset.node));
        el.classList.toggle('is-edited', edited.has(el.dataset.node));
      });
    }
    if (selected?.kind === 'node') {
      svg.querySelector(`[data-node="${CSS.escape(selected.id)}"]`)?.classList.add('is-selected');
    }
    if (connectFrom) {
      svg.querySelector(`[data-node="${CSS.escape(connectFrom)}"]`)?.classList.add('is-source');
    }
  }

  // ── Боковая панель ─────────────────────────────────────────
  function sidePanel(problems, diff) {
    if (selected?.kind === 'node') return nodePanel(problems);
    if (selected?.kind === 'flow') return flowPanel();
    return overviewPanel(problems, diff);
  }

  function overviewPanel(problems, diff) {
    const stages = stagesFromModel(draft);
    return html`
      <div class="ed__panel">
        <h4>Схема целиком</h4>
        <div class="ed__stats">
          <div><b>${draft.nodes.length}</b><span>шагов</span></div>
          <div><b>${draft.flows.length}</b><span>переходов</span></div>
          <div><b>${draft.lanes.length}</b><span>дорожек</span></div>
        </div>
        ${stages.length ? html`
          <div class="ed__group">
            <div class="ed__group-title">Этапы конвейера</div>
            <p class="ed__note">Эта схема задаёт конвейер инициатив: её этапы становятся
               сроками и ответственными в реальной работе платформы.</p>
            ${stages.map((s) => html`
              <button class="ed__stage" data-goto-node="${esc(s.node_id)}">
                <b>${s.stage_no}. ${esc(s.stage_name || '—')}</b>
                <small>${s.gate_no ? `Gate ${s.gate_no} · ${esc(ROLE_TITLES[s.role_required] || s.role_required || '—')}` : 'без точки принятия решения'}
                  ${s.sla_value ? ` · ${s.sla_value} ${esc(SLA_UNITS[s.sla_unit] ?? '')}` : ''}</small>
              </button>`)}
          </div>` : ''}
        ${diff && !diff.isEmpty ? html`
          <div class="ed__group">
            <div class="ed__group-title">Что меняется</div>
            <ul class="ed__list">${summarize(diff, laneTitlesOf(draft)).map((l) => `<li>${esc(l)}</li>`)}</ul>
          </div>` : ''}
        ${problems.length ? html`
          <div class="ed__group">
            <div class="ed__group-title">Замечания к схеме</div>
            <ul class="ed__list ed__list--warn">
              ${problems.map((p) => `<li>${p.node ? `<button data-goto-node="${esc(p.node)}">${esc(p.message)}</button>` : esc(p.message)}</li>`)}
            </ul>
          </div>` : ''}
        <p class="ed__note">Выберите шаг на схеме, чтобы изменить его свойства.</p>
      </div>`;
  }

  function nodePanel(problems) {
    const n = draft.nodes.find((x) => x.id === selected.id);
    if (!n) { selected = null; return overviewPanel(problems, changes()); }
    const own = problems.filter((p) => p.node === n.id);
    const outgoing = draft.flows.filter((f) => f.from === n.id);
    return html`
      <div class="ed__panel">
        <div class="ed__panel-head">
          <h4>Шаг</h4>
          <button class="icon-btn" data-close-panel aria-label="Назад к схеме">✕</button>
        </div>
        ${own.length ? `<div class="ed__warn">${own.map((p) => esc(p.message)).join('<br>')}</div>` : ''}

        <label class="field__label" for="ed-label">Подпись на схеме</label>
        <textarea class="textarea" id="ed-label" rows="2" ${readOnly ? 'disabled' : ''}>${esc(n.label)}</textarea>

        <label class="field__label" for="ed-type">Тип фигуры</label>
        <select class="input" id="ed-type" ${readOnly ? 'disabled' : ''}>
          ${PALETTE.map(([t, l]) => `<option value="${t}" ${n.type === t ? 'selected' : ''}>${esc(l)}</option>`)}
          ${SHAPES[n.type] && !PALETTE.some(([t]) => t === n.type)
            ? `<option value="${esc(n.type)}" selected>${esc(n.type)}</option>` : ''}
        </select>

        <label class="field__label" for="ed-lane">Дорожка — кто отвечает</label>
        <select class="input" id="ed-lane" ${readOnly ? 'disabled' : ''}>
          ${draft.lanes.map((l) => `<option value="${esc(l.id)}" ${n.lane === l.id ? 'selected' : ''}>${esc(l.title)}</option>`)}
        </select>

        ${outgoing.length ? html`
          <div class="ed__group">
            <div class="ed__group-title">Переходы из шага</div>
            ${outgoing.map((f) => html`
              <button class="ed__flow" data-flow-key="${esc(f.from)}→${esc(f.to)}">
                <span>${esc(draft.nodes.find((x) => x.id === f.to)?.label || f.to)}</span>
                ${f.label ? `<small>${esc(f.label)}</small>` : ''}
              </button>`)}
          </div>` : ''}

        ${n.stage ? stagePanel(n) : (isPipelineNode(n) && !readOnly ? html`
          <div class="ed__group">
            <button class="btn btn--sm" data-add-stage>Сделать этапом конвейера</button>
          </div>` : '')}

        ${readOnly ? '' : html`
          <div class="ed__group">
            <button class="btn btn--sm" data-connect-from>Провести переход отсюда</button>
            <button class="btn btn--sm btn--danger" data-del-node>Убрать шаг</button>
          </div>`}
      </div>`;
  }

  // Этап конвейера имеет смысл только у схемы, которая конвейер и описывает
  const isPipelineNode = () => stagesFromModel(draft).length > 0;

  function stagePanel(n) {
    const s = n.stage;
    return html`
      <div class="ed__group ed__group--stage">
        <div class="ed__group-title">Этап конвейера № ${s.stage_no}</div>
        <p class="ed__note">Эти значения становятся сроком, ответственным и критериями
           в реальной работе платформы после публикации версии.</p>

        <label class="field__label" for="st-name">Название этапа</label>
        <input class="input" id="st-name" value="${esc(s.stage_name || '')}" ${readOnly ? 'disabled' : ''}>

        <label class="field__label" for="st-role">Решение принимает</label>
        <select class="input" id="st-role" ${readOnly ? 'disabled' : ''}>
          <option value="">— этап без точки принятия решения —</option>
          ${Object.entries(ROLE_TITLES).map(([code, t]) =>
            `<option value="${code}" ${s.role_required === code ? 'selected' : ''}>${esc(t)}</option>`)}
        </select>

        <div class="row" style="gap:8px">
          <div style="flex:1">
            <label class="field__label" for="st-sla">Срок</label>
            <input class="input" id="st-sla" type="number" min="0" step="1"
                   value="${s.sla_value ?? ''}" ${readOnly ? 'disabled' : ''}>
          </div>
          <div style="flex:1.4">
            <label class="field__label" for="st-unit">Считается в</label>
            <select class="input" id="st-unit" ${readOnly ? 'disabled' : ''}>
              ${Object.entries(SLA_UNITS).map(([u, t]) =>
                `<option value="${u}" ${s.sla_unit === u ? 'selected' : ''}>${esc(t)}</option>`)}
            </select>
          </div>
        </div>

        <label class="field__label" for="st-slatext">Формулировка срока для участников</label>
        <textarea class="textarea" id="st-slatext" rows="2" ${readOnly ? 'disabled' : ''}>${esc(s.sla_text || '')}</textarea>

        <label class="field__label">Допустимые решения</label>
        <div class="ed__checks">
          ${Object.entries(DECISION_TITLES).map(([code, t]) => html`
            <label class="checkbox">
              <input type="checkbox" data-decision="${code}" ${s.decisions.includes(code) ? 'checked' : ''}
                     ${readOnly ? 'disabled' : ''}>
              <span>${esc(t)}</span>
            </label>`)}
        </div>

        <label class="field__label" for="st-criteria">Критерии оценки — по одному в строке</label>
        <textarea class="textarea" id="st-criteria" rows="4" ${readOnly ? 'disabled' : ''}>${esc(s.criteria.join('\n'))}</textarea>
      </div>`;
  }

  function flowPanel() {
    const f = flowByKey(selected.id);
    if (!f) { selected = null; return overviewPanel(issues(), changes()); }
    const label = (id) => draft.nodes.find((n) => n.id === id)?.label || id;
    return html`
      <div class="ed__panel">
        <div class="ed__panel-head">
          <h4>Переход</h4>
          <button class="icon-btn" data-close-panel aria-label="Назад к схеме">✕</button>
        </div>
        <p class="ed__note">${esc(label(f.from))} → ${esc(label(f.to))}</p>

        <label class="field__label" for="fl-label">Подпись — условие ветвления</label>
        <input class="input" id="fl-label" value="${esc(f.label || '')}" placeholder="например, «Go» или «да»"
               ${readOnly ? 'disabled' : ''}>

        <label class="field__label" for="fl-kind">Вид перехода</label>
        <select class="input" id="fl-kind" ${readOnly ? 'disabled' : ''}>
          <option value="" ${!f.kind ? 'selected' : ''}>Поток управления — следующий шаг</option>
          <option value="message" ${f.kind === 'message' ? 'selected' : ''}>Поток сообщений — передача между участниками</option>
        </select>

        ${readOnly ? '' : '<div class="ed__group"><button class="btn btn--sm btn--danger" data-del-flow>Убрать переход</button></div>'}
      </div>`;
  }

  // ── Обработчики ────────────────────────────────────────────
  function bind() {
    const svg = host.querySelector('.bp-svg');

    // Палитра
    host.querySelectorAll('[data-shape]').forEach((b) => b.onclick = () => {
      pendingType = pendingType === b.dataset.shape ? null : b.dataset.shape;
      connectFrom = null;
      render();
    });
    host.querySelector('[data-connect]')?.addEventListener('click', () => {
      connectFrom = connectFrom ? null : (selected?.kind === 'node' ? selected.id : null);
      if (!connectFrom) toast('Сначала выберите шаг, от которого идёт переход');
      pendingType = null;
      render();
    });
    host.querySelector('[data-lanes]')?.addEventListener('click', laneDialog);
    host.querySelector('[data-save]')?.addEventListener('click', save);
    host.querySelector('[data-close-panel]')?.addEventListener('click', () => { selected = null; render(); });

    host.querySelectorAll('[data-goto-node]').forEach((b) => b.onclick = () => {
      selected = { kind: 'node', id: b.dataset.gotoNode };
      render();
    });
    host.querySelectorAll('[data-flow-key]').forEach((b) => b.onclick = () => {
      selected = { kind: 'flow', id: b.dataset.flowKey };
      render();
    });

    // Свойства узла
    const onNode = (sel, apply) => {
      const el = host.querySelector(sel);
      if (!el) return;
      el.onchange = () => {
        const n = draft.nodes.find((x) => x.id === selected.id);
        apply(n, el.value);
        markDirty();
      };
    };
    onNode('#ed-label', (n, v) => { n.label = v; });
    onNode('#ed-type', (n, v) => { n.type = v; });
    onNode('#ed-lane', (n, v) => {
      // При переносе в другую дорожку ячейка может оказаться занятой
      let row = n.row;
      while (draft.nodes.some((x) => x.id !== n.id && x.lane === v && x.col === n.col && x.row === row)) row += 1;
      n.lane = v; n.row = row;
    });

    // Свойства этапа
    const onStage = (sel, apply, event = 'change') => {
      const el = host.querySelector(sel);
      if (!el) return;
      el[`on${event}`] = () => {
        const n = draft.nodes.find((x) => x.id === selected.id);
        apply(n.stage, el.value);
        markDirty();
      };
    };
    onStage('#st-name', (s, v) => { s.stage_name = v; });
    onStage('#st-role', (s, v) => { s.role_required = v || null; });
    onStage('#st-sla', (s, v) => { s.sla_value = v === '' ? null : Number(v); });
    onStage('#st-unit', (s, v) => { s.sla_unit = v; });
    onStage('#st-slatext', (s, v) => { s.sla_text = v; });
    onStage('#st-criteria', (s, v) => { s.criteria = v.split('\n').map((x) => x.trim()).filter(Boolean); });
    host.querySelectorAll('[data-decision]').forEach((cb) => cb.onchange = () => {
      const s = draft.nodes.find((x) => x.id === selected.id).stage;
      const code = cb.dataset.decision;
      s.decisions = cb.checked ? [...new Set([...s.decisions, code])] : s.decisions.filter((d) => d !== code);
      markDirty();
    });

    host.querySelector('[data-add-stage]')?.addEventListener('click', () => {
      const n = draft.nodes.find((x) => x.id === selected.id);
      const next = Math.max(0, ...stagesFromModel(draft).map((s) => s.stage_no)) + 1;
      n.stage = { stage_no: next, stage_name: n.label, tz_stage: null, tz_stage_name: null,
                  description: null, trigger_text: null, participants: [], gate_no: next - 1 || null,
                  gate_name: null, role_required: null, sla_value: null, sla_unit: 'workdays',
                  sla_text: null, criteria: [], decisions: ['go', 'kill'] };
      markDirty();
    });

    // Свойства перехода
    const flowField = (sel, apply) => {
      const el = host.querySelector(sel);
      if (!el) return;
      el.onchange = () => { apply(flowByKey(selected.id), el.value); markDirty(); };
    };
    flowField('#fl-label', (f, v) => { f.label = v || null; });
    flowField('#fl-kind', (f, v) => { f.kind = v || null; });

    host.querySelector('[data-del-flow]')?.addEventListener('click', async () => {
      if (await confirmDialog('Убрать переход', 'Переход исчезнет со схемы. Шаги останутся.', 'Убрать')) {
        removeFlow(selected.id);
      }
    });
    host.querySelector('[data-del-node]')?.addEventListener('click', async () => {
      const n = draft.nodes.find((x) => x.id === selected.id);
      const warn = n.stage
        ? 'Это этап конвейера. Вместе с шагом исчезнут его срок и ответственный.'
        : 'Шаг и связанные с ним переходы будут убраны.';
      if (await confirmDialog(`Убрать шаг «${n.label}»`, warn, 'Убрать')) removeNode(n.id);
    });
    host.querySelector('[data-connect-from]')?.addEventListener('click', () => {
      connectFrom = selected.id;
      toast('Выберите шаг, к которому ведёт переход');
      render();
    });

    if (!svg) return;

    // Клик по схеме: выбор, размещение фигуры, соединение
    svg.addEventListener('click', (e) => {
      const nodeEl = e.target.closest('.bp-node');
      if (pendingType && !nodeEl) {
        const cell = cellAt(svg, e);
        if (cell) addNode(pendingType, cell);
        return;
      }
      if (!nodeEl) {
        const flowEl = e.target.closest('[data-flow]');
        if (flowEl) {
          const f = draft.flows[Number(flowEl.dataset.flow)];
          selected = f ? { kind: 'flow', id: `${f.from}→${f.to}` } : null;
        } else selected = null;
        connectFrom = null;
        render();
        return;
      }
      const id = nodeEl.dataset.node;
      if (connectFrom) { connect(connectFrom, id); return; }
      selected = { kind: 'node', id };
      render();
    });

    if (readOnly) return;

    // Перетаскивание шага по ячейкам сетки
    svg.addEventListener('pointerdown', (e) => {
      const nodeEl = e.target.closest('.bp-node');
      if (!nodeEl || pendingType || connectFrom) return;
      const id = nodeEl.dataset.node;
      let moved = false;
      const onMove = (ev) => {
        const cell = cellAt(svg, ev);
        const n = draft.nodes.find((x) => x.id === id);
        if (!cell || (cell.lane === n.lane && cell.col === n.col && cell.row === n.row)) return;
        moved = true;
        moveNode(id, cell);
        // После перерисовки продолжаем тянуть уже новый элемент
        host.querySelector('.bp-svg')?.dispatchEvent(new Event('noop'));
      };
      const onUp = () => {
        removeEventListener('pointermove', onMove);
        removeEventListener('pointerup', onUp);
        if (moved) toast('Шаг перемещён', 'ok');
      };
      addEventListener('pointermove', onMove);
      addEventListener('pointerup', onUp);
    });
  }

  // ── Дорожки ────────────────────────────────────────────────
  function laneDialog() {
    const body = html`
      <p class="prose" style="margin-bottom:12px">Дорожка — зона ответственности: кто выполняет
         шаги, лежащие в ней. Из затронутых дорожек выводится состав согласующих.</p>
      <div class="ed__lanes">
        ${draft.lanes.map((l, i) => html`
          <div class="ed__lane-row">
            <input class="input" data-lane-title="${esc(l.id)}" value="${esc(l.title)}">
            <select class="input" data-lane-role="${esc(l.id)}">
              <option value="">— роль не задана —</option>
              ${Object.entries(ROLE_TITLES).map(([c, t]) =>
                `<option value="${c}" ${l.role === c ? 'selected' : ''}>${esc(t)}</option>`)}
            </select>
            <button class="icon-btn" data-lane-del="${esc(l.id)}" title="Убрать дорожку"
              ${draft.nodes.some((n) => n.lane === l.id) ? 'disabled' : ''}>✕</button>
          </div>`)}
      </div>
      <button class="btn btn--sm" data-lane-add style="margin-top:12px">Добавить дорожку</button>`;

    modal({
      title: 'Дорожки схемы', body, wide: true,
      footer: '<button class="btn btn--primary" data-close>Готово</button>',
      onMount: (el, close) => {
        el.querySelectorAll('[data-lane-title]').forEach((i) => i.onchange = () => {
          draft.lanes.find((l) => l.id === i.dataset.laneTitle).title = i.value;
          dirty = true;
        });
        el.querySelectorAll('[data-lane-role]').forEach((s) => s.onchange = () => {
          draft.lanes.find((l) => l.id === s.dataset.laneRole).role = s.value || null;
          dirty = true;
        });
        el.querySelectorAll('[data-lane-del]').forEach((b) => b.onclick = () => {
          draft.lanes = draft.lanes.filter((l) => l.id !== b.dataset.laneDel);
          close(); markDirty(); laneDialog();
        });
        el.querySelector('[data-lane-add]').onclick = () => {
          const id = uid('lane', new Set(draft.lanes.map((l) => l.id)));
          draft.lanes.push({ id, title: 'Новая дорожка', role: null, assignment: null });
          close(); markDirty(); laneDialog();
        };
        el.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) render(); });
      },
    });
  }

  // ── Сохранение ─────────────────────────────────────────────
  async function save() {
    const problems = issues();
    if (problems.length) {
      const ok = await confirmDialog('В схеме есть замечания',
        `${problems.map((p) => '• ' + p.message).join('\n')}\n\nЧерновик можно сохранить незавершённым, ` +
        'но опубликовать его не получится, пока замечания не исправлены.', 'Всё равно сохранить');
      if (!ok) return;
    }
    try {
      await onSave(draft);
      dirty = false;
      toast('Схема сохранена', 'ok');
      render();
    } catch (e) {
      toast(e.message, 'danger', 'Не удалось сохранить');
    }
  }

  render();
  return {
    model: () => draft,
    isDirty: () => dirty,
    destroy() {},
  };
}
