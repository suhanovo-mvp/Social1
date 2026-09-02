// Отрисовка BPMN-схем в инлайновый SVG. Геометрия, нумерация и перенос подписей
// вынесены в bpmn-layout.js — их разделяет генератор PDF на сервере.
import { esc, html } from './core.js';
import { GEO, layout, routeFlow, pathToSvg, wrapText, numberAnchor } from './bpmn-layout.js';

export { GEO, layout };

function textBlock(lines, cx, cy, lh = 13.5) {
  const startY = cy - ((lines.length - 1) * lh) / 2;
  return lines.map((l, i) => `<tspan x="${cx}" y="${startY + i * lh}">${esc(l)}</tspan>`).join('');
}

function glyphMarkup(glyph, cx, cy) {
  const g = {
    clock: `<circle cx="${cx}" cy="${cy}" r="8.5" class="bp-glyph-stroke"/>
            <path d="M${cx} ${cy - 5}V${cy}L${cx + 4} ${cy + 3}" class="bp-glyph-stroke"/>`,
    envelope: `<rect x="${cx - 8}" y="${cy - 5.5}" width="16" height="11" rx="1" class="bp-glyph-stroke"/>
               <path d="M${cx - 8} ${cy - 5}l8 6 8-6" class="bp-glyph-stroke"/>`,
    x: `<path d="M${cx - 8} ${cy - 8}l16 16M${cx + 8} ${cy - 8}l-16 16" class="bp-glyph-stroke bp-glyph-bold"/>`,
    plus: `<path d="M${cx} ${cy - 10}v20M${cx - 10} ${cy}h20" class="bp-glyph-stroke bp-glyph-bold"/>`,
    user: `<circle cx="${cx}" cy="${cy - 2.5}" r="3.4" class="bp-glyph-stroke"/>
           <path d="M${cx - 6} ${cy + 5.5}a6 6 0 0112 0" class="bp-glyph-stroke"/>`,
    gear: `<circle cx="${cx}" cy="${cy}" r="3.2" class="bp-glyph-stroke"/>
           <circle cx="${cx}" cy="${cy}" r="6.4" class="bp-glyph-stroke" stroke-dasharray="2.2 2.2"/>`,
    hand: `<path d="M${cx - 5} ${cy + 5}v-7a1.6 1.6 0 013.2 0v-2a1.6 1.6 0 013.2 0v1a1.6 1.6 0 013.2 0v6a4.5 4.5 0 01-4.5 4.5h-2.6a3 3 0 01-2.5-1.3z" class="bp-glyph-stroke"/>`,
  }[glyph];
  return g || '';
}

/** Номер шага — метка в левом верхнем углу фигуры. */
function stepNumber(b) {
  const w = b.num.length * 5.6 + 9;
  const a = numberAnchor(b);
  const x = a.align === 'right' ? a.x - w : a.x;
  const y = a.side === 'left' ? a.y + 5 : a.y;
  return html`<g class="bp-num">
    <rect x="${x}" y="${y - 8}" width="${w}" height="14" rx="3"/>
    <text x="${x + w / 2}" y="${y + 2.5}" text-anchor="middle">${esc(b.num)}</text>
  </g>`;
}

export function renderDiagram(diagram, seq = null) {
  const { lanes, boxes, width, height } = layout(diagram, seq);

  const laneShapes = lanes.map((l) => {
    const lh = l.titleFont + 2;
    const startY = -((l.titleLines.length - 1) * lh) / 2;
    return html`
    <g class="bp-lane">
      <rect x="0" y="${l.top}" width="${width}" height="${l.height}" class="bp-lane-bg"/>
      <rect x="0" y="${l.top}" width="${GEO.LANE_LABEL}" height="${l.height}" class="bp-lane-head"/>
      <g transform="translate(${GEO.LANE_LABEL / 2} ${l.top + l.height / 2}) rotate(-90)">
        <text class="bp-lane-title" text-anchor="middle" style="font-size:${l.titleFont}px">
          ${l.titleLines.map((line, i) => `<tspan x="0" y="${startY + i * lh + l.titleFont / 3}">${esc(line)}</tspan>`).join('')}
        </text>
      </g>
      <line x1="0" y1="${l.top}" x2="${width}" y2="${l.top}" class="bp-lane-line"/>
    </g>`;
  }).join('');

  const flowShapes = (diagram.flows || []).map((f, i) => {
    const a = boxes[f.from], b = boxes[f.to];
    if (!a || !b) return '';
    const { d, mid } = routeFlow(a, b);
    const cls = `bp-flow${f.kind === 'message' ? ' bp-flow--message' : ''}`;
    const label = f.label ? html`
      <g class="bp-flow-label">
        <rect x="${mid.x - (f.label.length * 3.3 + 6)}" y="${mid.y - 9}"
              width="${f.label.length * 6.6 + 12}" height="17" rx="3"/>
        <text x="${mid.x}" y="${mid.y + 3.5}" text-anchor="middle">${esc(f.label)}</text>
      </g>` : '';
    return html`<g data-flow="${i}"><path d="${pathToSvg(d)}" class="${cls}"
        marker-end="url(#${f.kind === 'message' ? 'bp-arrow-open' : 'bp-arrow'})"/>${label}</g>`;
  }).join('');

  const nodeShapes = diagram.nodes.map((n) => {
    const b = boxes[n.id];
    let shape = '', labelEl = '';

    if (b.shape === 'event') {
      shape = html`<circle cx="${b.cx}" cy="${b.cy}" r="${GEO.EVENT_R}" class="bp-event"
                     style="stroke-width:${b.ring}"/>
        ${b.double ? `<circle cx="${b.cx}" cy="${b.cy}" r="${GEO.EVENT_R - 3.5}" class="bp-event"/>` : ''}
        ${glyphMarkup(b.glyph, b.cx, b.cy)}`;
      labelEl = html`<text class="bp-label bp-label--out" text-anchor="middle">
        ${textBlock(wrapText(n.label, 24, 3), b.cx, b.cy + GEO.EVENT_R + 15, 12.5)}</text>`;
    } else if (b.shape === 'gateway') {
      const h = GEO.GW / 2;
      shape = html`<path d="M${b.cx} ${b.cy - h}L${b.cx + h} ${b.cy}L${b.cx} ${b.cy + h}L${b.cx - h} ${b.cy}Z"
                     class="bp-gateway"/>${glyphMarkup(b.glyph, b.cx, b.cy)}`;
      labelEl = html`<text class="bp-label bp-label--out" text-anchor="middle">
        ${textBlock(wrapText(n.label, 24, 2), b.cx, b.cy - h - 16, 12.5)}</text>`;
    } else if (b.shape === 'note') {
      shape = html`<path d="M${b.x + 9} ${b.y}h${b.w - 9}v${b.h}h-${b.w - 9}" class="bp-note"/>`;
      labelEl = html`<text class="bp-label bp-label--note" text-anchor="start">
        ${textBlock(wrapText(n.label, 26, 3), b.x + 15, b.cy, 13)}</text>`;
    } else {
      shape = html`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="7" class="bp-task"/>
        ${b.glyph ? glyphMarkup(b.glyph, b.x + 13, b.y + 13) : ''}`;
      labelEl = html`<text class="bp-label" text-anchor="middle">
        ${textBlock(wrapText(n.label, 23, 3), b.cx, b.cy + (b.glyph ? 5 : 0), 13.5)}</text>`;
    }

    return html`<g class="bp-node bp-node--${n.type}" data-node="${esc(n.id)}"
      tabindex="0" role="listitem" aria-label="Шаг ${esc(b.num)}. ${esc(n.label)}">
      ${shape}${labelEl}${stepNumber(b)}</g>`;
  }).join('');

  return html`
    <svg class="bp-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"
         role="list" aria-label="Схема процесса: ${esc(diagram.title)}">
      <defs>
        <marker id="bp-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" class="bp-arrow-fill"/>
        </marker>
        <marker id="bp-arrow-open" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10" class="bp-arrow-open"/>
        </marker>
      </defs>
      ${laneShapes}${flowShapes}${nodeShapes}
    </svg>`;
}

export const LEGEND = [
  ['start', 'Начальное событие — что запускает процесс'],
  ['end', 'Конечное событие — чем процесс завершается'],
  ['timer', 'Таймер — ожидание срока по SLA'],
  ['message', 'Сообщение — уведомление или задача извне'],
  ['user', 'Задача участника — выполняется человеком'],
  ['service', 'Задача платформы — выполняется системой'],
  ['xor', 'Исключающий шлюз — выбирается одна ветвь'],
  ['and', 'Параллельный шлюз — ветви идут одновременно'],
];
