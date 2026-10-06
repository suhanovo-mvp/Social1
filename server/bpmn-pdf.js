// Отрисовка BPMN-схем в PDF. Геометрия берётся из того же модуля, что и в браузере,
// поэтому бумажная версия совпадает с экранной шаг в шаг.
import { PdfDoc, Canvas } from './pdf.js';
import { GEO, layout, routeFlow, wrapLabel, numberAnchor } from '../shared/bpmn/layout.js';
// Схемы берутся из репозитория: бумажная версия печатает то же, что действует
// на платформе, включая изменения, принятые сообществом и опубликованные.
import { album, SCENARIOS, scenarioOf } from './process-repo.js';

// Стандартные листы в альбомной ориентации, пункты
const SHEETS = {
  A3: { w: 1190.55, h: 841.89, name: 'A3' },
  A2: { w: 1683.78, h: 1190.55, name: 'A2' },
};
const A3 = SHEETS.A3;
const MARGIN = 34;
const HEADER_H = 62;
const FOOTER_H = 26;

const C = {
  text: '#141b28', text2: '#4a5568', text3: '#7c8798',
  surface: '#ffffff', surface2: '#f9fafc', surface3: '#eef1f6',
  border: '#dfe4ed', borderStrong: '#c4ccda',
  brand: '#24508f', brandLine: '#3d80d8', brandBg: '#eff5fd',
  ok: '#1a7f52', okBg: '#e3f5ec',
  warn: '#a8620a', warnBg: '#fdf0dd',
  info: '#24508f', infoBg: '#e6eefa',
  purple: '#6b3fa0', purpleBg: '#f0e9f9',
  neutral: '#5a6473', neutralBg: '#eef0f4',
};

const TONE = {
  start:   { stroke: C.ok, fill: C.okBg },
  end:     { stroke: C.neutral, fill: C.neutralBg },
  timer:   { stroke: C.warn, fill: C.warnBg },
  message: { stroke: C.info, fill: C.infoBg },
  service: { stroke: C.brandLine, fill: C.brandBg },
  xor:     { stroke: C.warn, fill: C.warnBg },
  and:     { stroke: C.purple, fill: C.purpleBg },
};

/** Рисует одну схему на текущей странице в заданной области. */
function drawDiagram(cv, diagram, seq, area) {
  const L = layout(diagram, seq);
  const s = Math.min(area.w / L.width, area.h / L.height, 1);
  const ox = area.x + (area.w - L.width * s) / 2;
  // Схема прижата к верху полосы: свободное место собирается в одном месте —
  // между схемой и её пошаговым описанием, а не разбивается на две щели
  const oy = area.y + area.h;
  const X = (x) => ox + x * s;
  const Y = (y) => oy - y * s;
  const S = (v) => v * s;

  // Дорожки
  L.lanes.forEach((lane, i) => {
    cv.rgb(i % 2 ? C.surface2 : C.surface);
    cv.rect(X(0), Y(lane.top + lane.height), S(L.width), S(lane.height), 'f');
    cv.rgb(C.surface3);
    cv.rect(X(0), Y(lane.top + lane.height), S(GEO.LANE_LABEL), S(lane.height), 'f');
    cv.rgb(C.border, true).lineWidth(Math.max(0.4, S(1)));
    cv.polyline([[X(0), Y(lane.top)], [X(L.width), Y(lane.top)]], 'S');

    const fs = Math.max(5, S(lane.titleFont));
    const lh = fs + 2;
    const startOff = -((lane.titleLines.length - 1) * lh) / 2;
    lane.titleLines.forEach((line, li) => {
      cv.textRotated(line, X(GEO.LANE_LABEL / 2) + startOff + li * lh + fs / 3,
        Y(lane.top + lane.height / 2), { size: fs, color: C.text2, font: 'bold' });
    });
  });
  cv.rgb(C.borderStrong, true).lineWidth(Math.max(0.5, S(1.2)));
  cv.rect(X(0), Y(L.lanes.at(-1).top + L.lanes.at(-1).height),
    S(L.width), S(L.lanes.at(-1).top + L.lanes.at(-1).height - L.lanes[0].top), 'S');

  // Соединения
  for (const f of diagram.flows || []) {
    const a = L.boxes[f.from], b = L.boxes[f.to];
    if (!a || !b) continue;
    const { d, mid } = routeFlow(a, b);
    const pts = d.map(([, x, y]) => [X(x), Y(y)]);
    cv.rgb(f.kind === 'message' ? C.info : C.text3, true).lineWidth(Math.max(0.5, S(1.5)));
    if (f.kind === 'message') cv.dash(Math.max(1.5, S(5)), Math.max(1.2, S(4))); else cv.dash(0);
    cv.polyline(pts, 'S');
    cv.dash(0);

    // Наконечник по направлению последнего отрезка
    const [p1, p2] = [pts.at(-2), pts.at(-1)];
    const ang = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
    const len = Math.max(3.5, S(7)), wid = Math.max(2, S(3.6));
    const tip = p2;
    const back = [tip[0] - Math.cos(ang) * len, tip[1] - Math.sin(ang) * len];
    const nx = -Math.sin(ang) * wid, ny = Math.cos(ang) * wid;
    cv.rgb(f.kind === 'message' ? C.info : C.text3);
    cv.poly([tip, [back[0] + nx, back[1] + ny], [back[0] - nx, back[1] - ny]], 'f');

    if (f.label) {
      const fs = Math.max(4.5, S(10));
      const w = cv.textWidth(f.label, fs, 'bold') + S(12);
      cv.rgb(C.surface).rgb(C.border, true).lineWidth(0.4);
      cv.rect(X(mid.x) - w / 2, Y(mid.y) - fs * 0.75, w, fs * 1.5, 'B');
      cv.text(f.label, X(mid.x), Y(mid.y) - fs * 0.32, { size: fs, align: 'center', color: C.text2, font: 'bold' });
    }
  }

  // Узлы
  for (const n of diagram.nodes) {
    const b = L.boxes[n.id];
    const tone = TONE[n.type] || { stroke: C.borderStrong, fill: C.surface };
    const fs = Math.max(5, S(11.5));

    if (b.shape === 'event') {
      cv.rgb(tone.fill).rgb(tone.stroke, true).lineWidth(Math.max(0.6, S(b.ring)));
      cv.circle(X(b.cx), Y(b.cy), S(GEO.EVENT_R), 'B');
      if (b.double) {
        cv.lineWidth(Math.max(0.4, S(1.4)));
        cv.circle(X(b.cx), Y(b.cy), S(GEO.EVENT_R - 3.5), 'S');
      }
      const lines = wrapLabel(n.label, 'event');
      lines.forEach((line, i) =>
        cv.text(line, X(b.cx), Y(b.cy + GEO.EVENT_R + 14) - i * fs * 1.15,
          { size: Math.max(4.5, S(10.5)), align: 'center', color: C.text2 }));
    } else if (b.shape === 'gateway') {
      const h = GEO.GW / 2;
      cv.rgb(tone.fill).rgb(tone.stroke, true).lineWidth(Math.max(0.5, S(1.5)));
      cv.poly([[X(b.cx), Y(b.cy - h)], [X(b.cx + h), Y(b.cy)], [X(b.cx), Y(b.cy + h)], [X(b.cx - h), Y(b.cy)]], 'B');
      // Знак шлюза
      cv.rgb(tone.stroke, true).lineWidth(Math.max(0.8, S(2.4)));
      const g = S(8);
      if (n.type === 'and') {
        cv.polyline([[X(b.cx), Y(b.cy) - g], [X(b.cx), Y(b.cy) + g]], 'S');
        cv.polyline([[X(b.cx) - g, Y(b.cy)], [X(b.cx) + g, Y(b.cy)]], 'S');
      } else {
        cv.polyline([[X(b.cx) - g * 0.8, Y(b.cy) - g * 0.8], [X(b.cx) + g * 0.8, Y(b.cy) + g * 0.8]], 'S');
        cv.polyline([[X(b.cx) + g * 0.8, Y(b.cy) - g * 0.8], [X(b.cx) - g * 0.8, Y(b.cy) + g * 0.8]], 'S');
      }
      const lines = wrapLabel(n.label, 'gateway');
      lines.forEach((line, i) =>
        cv.text(line, X(b.cx), Y(b.cy - h - 12) + (lines.length - 1 - i) * fs * 1.1,
          { size: Math.max(4.5, S(10.5)), align: 'center', color: C.text2 }));
    } else {
      cv.rgb(tone.fill === C.surface ? C.surface : tone.fill).rgb(tone.stroke, true);
      cv.lineWidth(Math.max(0.5, S(1.4)));
      cv.roundRect(X(b.x), Y(b.y + b.h), S(b.w), S(b.h), S(7), 'B');
      const lines = wrapLabel(n.label, 'task');
      const top = Y(b.cy) + ((lines.length - 1) * fs * 1.18) / 2 - fs * 0.35;
      lines.forEach((line, i) =>
        cv.text(line, X(b.cx), top - i * fs * 1.18, { size: fs, align: 'center', color: C.text }));
    }

    // Номер шага
    const nfs = Math.max(4.5, S(9.5));
    const nw = cv.textWidth(b.num, nfs, 'bold') + S(9);
    const a = numberAnchor(b);
    const nx = a.align === 'right' ? X(a.x) - nw : X(a.x);
    const ny = Y(a.y) - (a.side === 'left' ? nfs * 0.35 : 0);
    cv.rgb(C.brand);
    cv.rect(nx, ny - nfs * 0.35, nw, nfs * 1.45, 'f');
    cv.text(b.num, nx + nw / 2, ny, { size: nfs, align: 'center', color: '#ffffff', font: 'bold' });
  }

  return { scale: s, steps: L.order.map((id) => L.boxes[id]) };
}

/** Перенос текста по фактической ширине шрифта, а не по числу знаков. */
function wrapByWidth(cv, text, maxW, size, font = 'regular') {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (cv.textWidth(next, size, font) > maxW && line) { lines.push(line); line = w; }
    else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

const WT = { title: 9.5, body: 8.5, lh: 10.6, gap: 13, headH: 34, numW: 27, split: 3 };

/**
 * Раскладка пошагового описания в колонки. Возвращает высоту блока и разбиение,
 * чтобы вызывающий код заранее знал, сколько места остаётся схеме.
 */
function measureWalkthrough(cv, diagram, seq, width, cols) {
  const steps = diagram.walkthrough || [];
  if (!steps.length) return null;
  const L = layout(diagram, seq);
  const colW = (width - (cols - 1) * 22) / cols;
  const textW = colW - WT.numW;

  const items = steps.map((w) => {
    const titleLines = wrapByWidth(cv, w.title, textW, WT.title, 'bold');
    const bodyLines = wrapByWidth(cv, w.body, colW, WT.body);
    return {
      num: L.boxes[w.node]?.num || '', titleLines, bodyLines,
      height: titleLines.length * (WT.lh + 1) + WT.split + bodyLines.length * WT.lh + WT.gap,
    };
  });

  // Заполняем колонки по порядку, выравнивая их высоту
  const total = items.reduce((s, i) => s + i.height, 0);
  const target = total / cols;
  const columns = Array.from({ length: cols }, () => []);
  let ci = 0, acc = 0;
  for (const item of items) {
    // Переходим к следующей колонке, если элемент уводит текущую дальше от цели,
    // чем оставил бы её недобор — иначе последняя колонка получается полупустой
    if (ci < cols - 1 && acc > 0 && acc + item.height / 2 > target) { ci += 1; acc = 0; }
    columns[ci].push(item);
    acc += item.height;
  }
  const height = WT.headH + Math.max(...columns.map((c) => c.reduce((s, i) => s + i.height, 0)));
  return { columns, colW, textW, height, count: items.length };
}

/** Рисует пошаговое описание под схемой. */
function drawWalkthrough(cv, block, x, top, width) {
  cv.text('Пошаговое описание процесса', x, top - 11, { size: 11, font: 'bold', color: C.text });
  cv.text(`${block.count} ${block.count === 1 ? 'шаг' : block.count < 5 ? 'шага' : 'шагов'}`,
    x + width, top - 11, { size: 8.5, align: 'right', color: C.text3 });
  cv.rgb(C.border, true).lineWidth(0.6);
  cv.polyline([[x, top - 18], [x + width, top - 18]], 'S');

  block.columns.forEach((col, ci) => {
    let y = top - WT.headH;
    const cx = x + ci * (block.colW + 22);
    for (const item of col) {
      // Номер шага — на одной базовой линии с заголовком
      const nw = cv.textWidth(item.num, WT.body, 'bold') + 8;
      cv.rgb(C.brand);
      cv.rect(cx, y - 2.5, nw, WT.title + 2, 'f');
      cv.text(item.num, cx + nw / 2, y, { size: WT.body, align: 'center', color: '#ffffff', font: 'bold' });
      // Заголовок шага. Двузначный номер шага («22.10») шире плашки по умолчанию —
      // отступ растёт вместе с ним, иначе номер наезжает на заголовок
      const indent = Math.max(WT.numW, nw + 5);
      item.titleLines.forEach((line, i) =>
        cv.text(line, cx + indent, y - i * (WT.lh + 1), { size: WT.title, font: 'bold', color: C.text }));
      y -= item.titleLines.length * (WT.lh + 1) + WT.split;
      // Описание
      item.bodyLines.forEach((line, i) =>
        cv.text(line, cx, y - i * WT.lh, { size: WT.body, color: C.text2 }));
      y -= item.bodyLines.length * WT.lh + WT.gap;
    }
  });
}

/** Шапка и подвал страницы. */
function drawChrome(cv, { seq, title, sla, group, scenario, page, total, sheet = A3 }) {
  cv.rgb(C.brand).rect(0, sheet.h - 4, sheet.w, 4, 'f');
  cv.text(`Раздел ${seq}. ${title}`, MARGIN, sheet.h - 34, { size: 15, font: 'bold', color: C.text });
  const meta = [scenario, group, sla ? `SLA: ${sla}` : null].filter(Boolean).join('   ·   ');
  if (meta) cv.text(meta, MARGIN, sheet.h - 50, { size: 9, color: C.text3 });
  cv.text('Social1 — платформа системных инноваций ДТСЗН', sheet.w - MARGIN, sheet.h - 34,
    { size: 9, align: 'right', color: C.text3 });

  cv.rgb(C.border, true).lineWidth(0.6);
  cv.polyline([[MARGIN, FOOTER_H], [sheet.w - MARGIN, FOOTER_H]], 'S');
  cv.text(`Нотация BPMN. Номера шагов сквозные: раздел.шаг   ·   лист ${sheet.name}`,
    MARGIN, FOOTER_H - 13, { size: 8, color: C.text3 });
  cv.text(`${page} из ${total}`, sheet.w - MARGIN, FOOTER_H - 13,
    { size: 8, align: 'right', color: C.text3 });
}

/** Условные обозначения — компактной строкой под схемой. */
function drawLegend(cv, y, sheet = A3) {
  const items = [
    ['event', C.ok, 'начало'], ['event', C.neutral, 'конец'],
    ['event', C.warn, 'таймер'], ['event', C.info, 'сообщение'],
    ['task', C.borderStrong, 'задача участника'], ['task', C.brandLine, 'задача платформы'],
    ['gw', C.warn, 'исключающий шлюз'], ['gw', C.purple, 'параллельный шлюз'],
  ];
  let x = MARGIN;
  for (const [kind, color, label] of items) {
    if (kind === 'event') { cv.rgb('#ffffff').rgb(color, true).lineWidth(1.2); cv.circle(x + 5, y + 3, 5, 'B'); }
    else if (kind === 'task') { cv.rgb('#ffffff').rgb(color, true).lineWidth(1.2); cv.roundRect(x, y - 2, 16, 10, 2, 'B'); }
    else { cv.rgb('#ffffff').rgb(color, true).lineWidth(1.2); cv.poly([[x + 6, y + 9], [x + 12, y + 3], [x + 6, y - 3], [x, y + 3]], 'B'); }
    const tx = x + (kind === 'task' ? 20 : 16);
    cv.text(label, tx, y, { size: 8, color: C.text2 });
    x = tx + cv.textWidth(label, 8) + 18;
  }
}

/**
 * Компоновка страницы: схема сверху, пошаговое описание под ней.
 * Если описание займёт больше половины полосы, оно уходит на отдельную страницу —
 * иначе схема ужимается до нечитаемого.
 */
function planPage(cv, diagram, seq, sheet) {
  const contentW = sheet.w - MARGIN * 2;
  const contentTop = sheet.h - HEADER_H;
  const contentBottom = FOOTER_H + 26;              // место под легенду
  const avail = contentTop - contentBottom;
  const cols = sheet.w > 1400 ? 3 : 2;
  const wt = measureWalkthrough(cv, diagram, seq, contentW, cols);
  if (!wt) return { wt: null, separate: false, diagramArea: { x: MARGIN, y: contentBottom, w: contentW, h: avail } };

  const separate = wt.height > avail * 0.5;
  const h = separate ? avail : avail - wt.height - 16;
  return {
    wt, separate, cols,
    diagramArea: { x: MARGIN, y: contentBottom + (separate ? 0 : wt.height + 16), w: contentW, h },
    wtTop: contentBottom + wt.height,
  };
}

/**
 * Формат листа для одиночной выгрузки. Основной — A3: на нём читаемы почти все схемы.
 * A2 берётся только тогда, когда на A3 масштаб падает ниже порога разборчивости.
 */
function pickSheet(diagram) {
  const L = layout(diagram, 1);
  const fit = (sh) => Math.min((sh.w - MARGIN * 2) / L.width,
                               (sh.h - HEADER_H - FOOTER_H - 26) / L.height, 1);
  return fit(SHEETS.A3) >= 0.45 ? SHEETS.A3 : SHEETS.A2;
}

/**
 * Листы одной схемы для вставки в любой документ: сначала узнаём, сколько их будет,
 * потом рисуем с номерами страниц этого документа. Так инструкция печатает схему
 * тем же кодом, что и альбом, — номера шагов на бумаге не могут разойтись.
 */
export function diagramSheets(diagram, seq, { walkthrough = true } = {}) {
  const sheet = pickSheet(diagram);
  // Без разбора — когда документ печатает его сам, крупнее и в своей вёрстке
  const source = walkthrough ? diagram : { ...diagram, walkthrough: [] };
  const probe = new Canvas(new PdfDoc());
  const count = planPage(probe, source, seq, sheet).separate ? 2 : 1;
  const render = (doc, firstPage, total) => {
    const cv = new Canvas(doc);
    const plan = planPage(cv, source, seq, sheet);
    const chrome = { seq, title: diagram.title, sla: diagram.sla, group: diagram.group,
                     scenario: scenarioOf(diagram.scenario).short, total, sheet };
    drawChrome(cv, { ...chrome, page: firstPage });
    drawDiagram(cv, source, seq, plan.diagramArea);
    drawLegend(cv, FOOTER_H + 8, sheet);
    if (plan.wt && !plan.separate) drawWalkthrough(cv, plan.wt, MARGIN, plan.wtTop, sheet.w - MARGIN * 2);
    doc.addPage(sheet.w, sheet.h, cv.toString());
    if (plan.separate) {
      const cv2 = new Canvas(doc);
      drawChrome(cv2, { ...chrome, page: firstPage + 1 });
      drawWalkthrough(cv2, plan.wt, MARGIN, sheet.h - HEADER_H, sheet.w - MARGIN * 2);
      doc.addPage(sheet.w, sheet.h, cv2.toString());
    }
  };
  return { count, sheet, render };
}

/**
 * PDF одной схемы. Формат листа подбирается по размеру схемы.
 * @param seq номер раздела в сквозной нумерации альбома
 */
export function diagramPdf(diagram, seq) {
  const sheets = diagramSheets(diagram, seq);
  const doc = new PdfDoc({
    title: `Раздел ${seq}. ${diagram.title}`,
    subject: `Схема процесса в нотации BPMN — Social1, лист ${sheets.sheet.name}`,
  });
  sheets.render(doc, 1, sheets.count);
  return doc.build();
}

const TOC_TOP = A3.h - 84, TOC_BOTTOM = FOOTER_H + 24;

/**
 * Раскладка оглавления по страницам: заголовки путей, групп и строки схем.
 * Считается до отрисовки — от числа страниц оглавления зависят номера страниц
 * схем. Заголовок пути или группы не остаётся внизу листа без строк под ним.
 */
export function tocLayout(diagrams) {
  const items = [];
  let lastGroup = null;
  let lastScenario = null;
  diagrams.forEach((d, i) => {
    if (d.scenario !== lastScenario) {
      lastScenario = d.scenario;
      lastGroup = null;
      items.push({ kind: 'scenario', h: 34, title: scenarioOf(d.scenario).title });
    }
    if (d.group !== lastGroup) {
      lastGroup = d.group;
      items.push({ kind: 'group', h: 25, title: d.group });
    }
    items.push({ kind: 'row', h: 20, d, i });
  });
  const pages = [[]];
  let room = TOC_TOP - TOC_BOTTOM;
  items.forEach((it, k) => {
    const keep = it.kind === 'row' ? it.h
      : it.h + (items[k + 1]?.kind === 'group' ? items[k + 1].h : 0) + 20;
    if (keep > room && pages.at(-1).length) { pages.push([]); room = TOC_TOP - TOC_BOTTOM; }
    pages.at(-1).push(it);
    room -= it.h;
  });
  return pages;
}

export const TOC_HEIGHT = TOC_TOP - TOC_BOTTOM;

/** Альбом всех схем: титул, оглавление, по странице на схему. */
export function albumPdf() {
  const DIAGRAMS = album();
  const doc = new PdfDoc({
    title: 'Social1 — схемы процессов',
    subject: 'Модели процессов в нотации BPMN по ролям участников',
  });

  // Титульная страница
  const t = new Canvas(doc);
  t.rgb(C.brand).rect(0, A3.h - 150, A3.w, 150, 'f');
  t.text('Social1', MARGIN, A3.h - 70, { size: 30, font: 'bold', color: '#ffffff' });
  t.text('Платформа системных инноваций ДТСЗН', MARGIN, A3.h - 96, { size: 13, color: '#dde9f9' });
  t.text('Схемы процессов', MARGIN, A3.h - 230, { size: 40, font: 'bold', color: C.text });
  t.text(`Детализированные модели в нотации BPMN: пользовательских путей — ${SCENARIOS.length}`,
    MARGIN, A3.h - 262, { size: 14, color: C.text2 });
  let ty = A3.h - 306;
  SCENARIOS.forEach((sc, i) => {
    t.text(`${i + 1}. ${sc.title}`, MARGIN, ty, { size: 12.5, font: 'bold', color: C.text });
    ty -= 17;
    t.text(sc.lead, MARGIN + 16, ty, { size: 10.5, color: C.text2 });
    ty -= 15;
    const n = DIAGRAMS.filter((d) => d.scenario === sc.id).length;
    t.text(`Схем: ${n}   ·   Ролей: ${sc.roles.length}`, MARGIN + 16, ty, { size: 9.5, color: C.text3 });
    ty -= 26;
  });
  const facts = [
    `Всего схем: ${DIAGRAMS.length}`,
    `Шагов с разбором: ${DIAGRAMS.reduce((s, d) => s + (d.walkthrough?.length || 0), 0)}`,
    'Нумерация разделов и шагов — сквозная',
  ];
  facts.forEach((f, i) => t.text(f, MARGIN, ty - i * 18, { size: 11, color: C.text2 }));
  t.text(new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }),
    MARGIN, FOOTER_H + 4, { size: 9, color: C.text3 });
  doc.addPage(A3.w, A3.h, t.toString());

  // Оглавление раскладывается по страницам заранее: от числа его страниц зависят
  // номера страниц схем. Раньше оно рисовалось на одном листе, и всё, что не
  // помещалось, уходило за нижний край.
  const tocPages = tocLayout(DIAGRAMS);

  // Сколько страниц займёт каждая схема — нужно до отрисовки оглавления
  const probe = new Canvas(doc);
  const plans = DIAGRAMS.map((d, i) => planPage(probe, d, i + 1, A3));
  const startPage = [];
  let cursor = 2 + tocPages.length;
  plans.forEach((pl) => { startPage.push(cursor); cursor += pl.separate ? 2 : 1; });
  const totalPages = cursor - 1;

  // Оглавление
  tocPages.forEach((items, pi) => {
    const c = new Canvas(doc);
    c.rgb(C.brand).rect(0, A3.h - 4, A3.w, 4, 'f');
    c.text(pi ? 'Содержание (продолжение)' : 'Содержание', MARGIN, A3.h - 44, { size: 20, font: 'bold', color: C.text });
    let y = TOC_TOP;
    for (const it of items) {
      if (it.kind === 'scenario') {
        y -= 6;
        c.rgb(C.brand).rect(MARGIN, y - 4, A3.w - MARGIN * 2, 20, 'f');
        c.text(it.title, MARGIN + 8, y + 1, { size: 10.5, font: 'bold', color: '#ffffff' });
        y -= 28;
      } else if (it.kind === 'group') {
        y -= 8;
        c.text(it.title.toUpperCase(), MARGIN, y, { size: 8.5, font: 'bold', color: C.text3 });
        y -= 17;
      } else {
        const { d, i } = it;
        c.text(`${i + 1}.`, MARGIN + 12, y, { size: 11, font: 'bold', color: C.brand });
        c.text(d.title, MARGIN + 34, y, { size: 11, color: C.text });
        if (d.sla) c.text(`SLA: ${d.sla}`, MARGIN + 430, y, { size: 9, color: C.text3 });
        c.text(String(startPage[i]), A3.w - MARGIN, y, { size: 10, align: 'right', color: C.text3 });
        c.rgb(C.border, true).lineWidth(0.4);
        c.polyline([[MARGIN + 12, y - 5], [A3.w - MARGIN, y - 5]], 'S');
        y -= 20;
      }
    }
    c.text(`${2 + pi} из ${totalPages}`, A3.w - MARGIN, FOOTER_H - 13, { size: 8, align: 'right', color: C.text3 });
    doc.addPage(A3.w, A3.h, c.toString());
  });

  // Схемы
  DIAGRAMS.forEach((d, i) => {
    const pl = plans[i];
    const cv = new Canvas(doc);
    drawChrome(cv, { seq: i + 1, title: d.title, sla: d.sla, group: d.group,
                     scenario: scenarioOf(d.scenario).short, page: startPage[i], total: totalPages });
    drawDiagram(cv, d, i + 1, pl.diagramArea);
    drawLegend(cv, FOOTER_H + 8);
    if (pl.wt && !pl.separate) drawWalkthrough(cv, pl.wt, MARGIN, pl.wtTop, A3.w - MARGIN * 2);
    doc.addPage(A3.w, A3.h, cv.toString());

    if (pl.separate) {
      const cv2 = new Canvas(doc);
      drawChrome(cv2, { seq: i + 1, title: d.title, sla: d.sla, group: d.group,
                        scenario: scenarioOf(d.scenario).short, page: startPage[i] + 1, total: totalPages });
      drawWalkthrough(cv2, pl.wt, MARGIN, A3.h - HEADER_H, A3.w - MARGIN * 2);
      doc.addPage(A3.w, A3.h, cv2.toString());
    }
  });

  return doc.build();
}
