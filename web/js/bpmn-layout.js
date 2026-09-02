// Чистая модель раскладки BPMN: геометрия, сквозная нумерация, перенос подписей.
// Модуль не зависит от DOM — им пользуется и отрисовка в SVG, и генерация PDF на сервере.

export const GEO = {
  COL: 196,        // шаг колонки
  ROW: 96,         // шаг строки внутри дорожки
  TASK_W: 152, TASK_H: 62,
  EVENT_R: 19,
  GW: 46,
  LANE_LABEL: 42,  // ширина полосы с названием дорожки
  PAD_X: 34, PAD_Y: 16,
  LANE_FONT: 10.5, // кегль названия дорожки
  CHAR_W: 0.63,    // средняя ширина знака кириллицы в долях кегля (замерено в браузере)
};

export const SHAPES = {
  start:   { shape: 'event', ring: 1.7 },
  end:     { shape: 'event', ring: 4 },
  timer:   { shape: 'event', ring: 1.7, double: true, glyph: 'clock' },
  message: { shape: 'event', ring: 1.7, glyph: 'envelope' },
  task:    { shape: 'task' },
  user:    { shape: 'task', glyph: 'user' },
  service: { shape: 'task', glyph: 'gear' },
  manual:  { shape: 'task', glyph: 'hand' },
  xor:     { shape: 'gateway', glyph: 'x' },
  and:     { shape: 'gateway', glyph: 'plus' },
  note:    { shape: 'note' },
};

/** Перенос текста по числу знаков с многоточием при переполнении. */
export function wrapText(text, maxChars, maxLines = 3) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length > maxChars && line) { lines.push(line); line = w; }
    else line = next;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].slice(0, Math.max(1, maxChars - 1)) + '…';
    return kept;
  }
  return lines;
}

/**
 * Название дорожки повёрнуто на 90°, поэтому ограничено её высотой, а не шириной.
 * Длинные названия переносятся на две строки — иначе текст выходит за границы дорожки.
 */
export function wrapLaneTitle(title, laneHeight, fontSize = GEO.LANE_FONT) {
  const avail = laneHeight - 14;
  const fits = (size, maxLines) => {
    const perLine = Math.max(6, Math.floor(avail / (size * GEO.CHAR_W)));
    if (title.length <= perLine) return { lines: [title], fontSize: size };
    const lines = wrapText(title, perLine, 99);           // без усечения — проверяем, влезает ли целиком
    return lines.length <= maxLines && lines.every((l) => l.length <= perLine)
      ? { lines, fontSize: size } : null;
  };
  // Сначала две строки на убывающем кегле, затем три — и только потом усечение
  for (const size of [fontSize, fontSize - 1, fontSize - 2]) {
    const r = fits(size, 2);
    if (r) return r;
  }
  const r3 = fits(fontSize - 2, 3);
  if (r3) return r3;
  const size = fontSize - 2;
  const perLine = Math.max(6, Math.floor(avail / (size * GEO.CHAR_W)));
  return { lines: wrapText(title, perLine, 3), fontSize: size };
}

/**
 * Раскладка схемы. Возвращает дорожки с координатами, узлы с прямоугольниками
 * и сквозными номерами шагов, а также итоговые размеры полотна.
 *
 * @param diagram модель схемы
 * @param seq     номер схемы в сквозной нумерации (для номеров шагов вида «3.5»)
 */
export function layout(diagram, seq = null) {
  const lanes = diagram.lanes.map((l) => ({ ...l, rows: 1 }));
  const laneIndex = Object.fromEntries(lanes.map((l, i) => [l.id, i]));

  for (const n of diagram.nodes) {
    const li = laneIndex[n.lane] ?? 0;
    lanes[li].rows = Math.max(lanes[li].rows, (n.row || 0) + 1);
  }

  let y = GEO.PAD_Y;
  for (const l of lanes) {
    l.top = y;
    l.height = l.rows * GEO.ROW + GEO.PAD_Y;
    const wrapped = wrapLaneTitle(l.title, l.height);
    l.titleLines = wrapped.lines;
    l.titleFont = wrapped.fontSize;
    y += l.height;
  }
  const height = y + GEO.PAD_Y;
  const maxCol = Math.max(...diagram.nodes.map((n) => n.col)) + 1;
  const width = GEO.LANE_LABEL + GEO.PAD_X + maxCol * GEO.COL;

  // Сквозная нумерация шагов: слева направо, сверху вниз
  const ordered = [...diagram.nodes].sort((a, b) =>
    (a.col - b.col) || ((a.row || 0) - (b.row || 0)) || (laneIndex[a.lane] - laneIndex[b.lane]));
  const numbers = Object.fromEntries(ordered.map((n, i) => [n.id, seq ? `${seq}.${i + 1}` : String(i + 1)]));

  const boxes = {};
  for (const n of diagram.nodes) {
    const lane = lanes[laneIndex[n.lane] ?? 0];
    const cx = GEO.LANE_LABEL + GEO.PAD_X + n.col * GEO.COL + GEO.COL / 2 - GEO.PAD_X;
    const cy = lane.top + GEO.PAD_Y / 2 + (n.row || 0) * GEO.ROW + GEO.ROW / 2;
    const t = SHAPES[n.type] || SHAPES.task;
    let w, h;
    if (t.shape === 'event') { w = h = GEO.EVENT_R * 2; }
    else if (t.shape === 'gateway') { w = h = GEO.GW; }
    else if (t.shape === 'note') { w = GEO.TASK_W; h = 46; }
    else { w = GEO.TASK_W; h = GEO.TASK_H; }
    boxes[n.id] = {
      ...n, cx, cy, w, h, x: cx - w / 2, y: cy - h / 2,
      shape: t.shape, glyph: t.glyph, ring: t.ring, double: t.double,
      num: numbers[n.id],
    };
  }
  return { lanes, boxes, order: ordered.map((n) => n.id), numbers, width, height };
}

/** Ортогональный маршрут между двумя узлами. */
export function routeFlow(a, b) {
  const gap = 14;
  const sameRow = Math.abs(a.cy - b.cy) < 3;

  if (b.cx > a.cx) {
    const x1 = a.x + a.w, x2 = b.x;
    if (sameRow) return { d: [['M', x1, a.cy], ['L', x2, b.cy]], mid: { x: (x1 + x2) / 2, y: a.cy } };
    const mx = x1 + Math.max(gap, (x2 - x1) / 2);
    return {
      d: [['M', x1, a.cy], ['L', mx, a.cy], ['L', mx, b.cy], ['L', x2, b.cy]],
      mid: { x: mx, y: (a.cy + b.cy) / 2 },
    };
  }
  if (Math.abs(b.cx - a.cx) < 3) {
    const down = b.cy > a.cy;
    const y1 = down ? a.y + a.h : a.y;
    const y2 = down ? b.y : b.y + b.h;
    return { d: [['M', a.cx, y1], ['L', b.cx, y2]], mid: { x: a.cx, y: (y1 + y2) / 2 } };
  }
  const yb = Math.max(a.y + a.h, b.y + b.h) + 30;
  return {
    d: [['M', a.cx, a.y + a.h], ['L', a.cx, yb], ['L', b.cx, yb], ['L', b.cx, b.y + b.h]],
    mid: { x: (a.cx + b.cx) / 2, y: yb },
  };
}

export const pathToSvg = (segs) => segs.map(([c, x, y]) => `${c}${x} ${y}`).join(' ');

/**
 * Где размещать номер шага. У шлюза подпись идёт сверху, поэтому номер
 * уводится влево — иначе метка накрывает текст подписи.
 */
export function numberAnchor(box) {
  if (box.shape === 'gateway') return { x: box.x - 6, y: box.cy, align: 'right', side: 'left' };
  return { x: box.shape === 'task' ? box.x : box.cx - box.w / 2 - 2, y: box.y - 7, align: 'left', side: 'top' };
}
