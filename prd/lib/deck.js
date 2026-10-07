// Product presentation (pitch) from the PRD: one slide model, two renderings —
// PDF (pdf.js) and editable PPTX (pptx.js). Server-only.
//
// The deck describes the product, not the database: no review counters, no user
// numbers, so it reads the same on demo and production data. "Current" comes from
// the model: modules, epics, stories, readiness from statuses, releases, and — when
// guided-process-docs is in the project — process diagrams drawn as native shapes.
//
//   import { buildDeck, buildDeckPdf, buildDeckPptx, loadScreens } from './deck.js';
//   const deck = buildDeck({ ...data, screens: loadScreens('prd/screens'), processes, bpmn });
//   buildDeckPdf(deck) → Buffer, buildDeckPptx(deck) → Buffer
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import * as core from './prd-core.js';
import { PdfDoc, Canvas, jpegInfo } from './pdf.js';
import { buildPptx, SLIDE } from './pptx.js';

const W = SLIDE.w, H = SLIDE.h, MX = 48;
const C = {
  ink: '#16161A', muted: '#6A6A75', line: '#DEDEE6', soft: '#F4F4F7', accent: '#6D4AFF', accentSoft: '#EFEAFF',
  white: '#FFFFFF', good: '#15803D', warn: '#D97706', bad: '#B91C1C', gray: '#A1A1AA',
};
const BAR = { verified: '#16A34A', manual: '#4ADE80', partial: '#F59E0B', missing: '#EF4444', failing: '#991B1B', unverified: '#A1A1AA' };
const fmtDate = (iso) => (iso ? new Date(String(iso).length === 10 ? `${iso}T00:00:00` : iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).replace(/\s*г\.$/, '') : '');

// ── Text fitting by estimate (shared by both renderers) ─────
const CHAR = 0.58; // средняя ширина знака в долях кегля, с запасом под широкие шрифты
const estLines = (text, size, w) => String(text ?? '').split('\n').reduce((n, p) => {
  const perLine = Math.max(4, Math.floor(w / (size * CHAR)));
  let lines = 0, cur = 0;
  for (const word of p.split(/\s+/)) {
    if (cur && cur + 1 + word.length > perLine) { lines += 1; cur = word.length; } else cur += (cur ? 1 : 0) + word.length;
  }
  return n + lines + 1;
}, 0);
/** Cut text so it fits maxLines at this size and width, ending with «…». */
export function fit(text, size, w, maxLines) {
  const s = String(text ?? '');
  if (estLines(s, size, w) <= maxLines) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estLines(`${s.slice(0, mid)}…`, size, w) <= maxLines) lo = mid; else hi = mid - 1;
  }
  return `${s.slice(0, lo).replace(/[\s,.;:—-]+$/, '')}…`;
}

// ── Primitive helpers ───────────────────────────────────────
const T = (x, y, w, h, text, o = {}) => ({ type: 'text', x, y, w, h, text: o.maxLines ? fit(text, o.size ?? 14, w, o.maxLines) : String(text ?? ''), size: 14, color: C.ink, ...o });
const R = (x, y, w, h, o = {}) => ({ type: 'rect', x, y, w, h, fill: C.soft, ...o });

function header(items, section, title, n, product) {
  items.push(T(MX, 30, W - 2 * MX, 16, section.toUpperCase(), { size: 10.5, color: C.accent, bold: true }));
  items.push(T(MX, 48, W - 2 * MX, 40, title, { size: 26, bold: true, maxLines: 1 }));
  items.push(T(MX, H - 28, 400, 14, product.title ?? '', { size: 9, color: C.muted }));
  items.push(T(W - MX - 100, H - 28, 100, 14, String(n), { size: 9, color: C.muted, align: 'right' }));
}

function statusBar(items, x, y, w, h, summary) {
  items.push(R(x, y, w, h, { fill: '#E9E9EF', radius: h / 2 }));
  let cx = x;
  for (const st of core.STATUS_ORDER) {
    const n = summary.byStatus[st];
    if (!n) continue;
    const sw = (n / summary.total) * w;
    items.push(R(cx, y, sw, h, { fill: BAR[st] }));
    cx += sw;
  }
}

function markerItems(status, cx, cy, r = 6) {
  const fillC = { verified: C.good, manual: C.good, partial: C.warn, missing: C.bad, failing: '#7F1D1D', unverified: '#9A9AA5' }[status];
  const out = [{ type: 'ellipse', x: cx - r, y: cy - r, w: 2 * r, h: 2 * r, fill: status === 'manual' ? C.white : fillC, stroke: status === 'manual' ? fillC : null, width: 1.2 }];
  const ink = status === 'manual' ? fillC : C.white;
  if (status === 'verified' || status === 'manual') out.push({ type: 'line', points: [[cx - r * 0.45, cy], [cx - r * 0.1, cy + r * 0.38], [cx + r * 0.5, cy - r * 0.4]], stroke: ink, width: 1.6 });
  else if (status === 'missing') out.push({ type: 'line', points: [[cx - r * 0.4, cy - r * 0.4], [cx + r * 0.4, cy + r * 0.4]], stroke: ink, width: 1.6 }, { type: 'line', points: [[cx - r * 0.4, cy + r * 0.4], [cx + r * 0.4, cy - r * 0.4]], stroke: ink, width: 1.6 });
  else if (status === 'partial') out.push({ type: 'line', points: [[cx - r * 0.45, cy], [cx + r * 0.45, cy]], stroke: ink, width: 1.6 });
  else if (status === 'failing') out.push({ type: 'line', points: [[cx, cy - r * 0.5], [cx, cy + r * 0.1]], stroke: ink, width: 1.6 }, { type: 'ellipse', x: cx - 0.9, y: cy + r * 0.32, w: 1.8, h: 1.8, fill: ink });
  else out.push(T(cx - r, cy - r * 0.95, 2 * r, 2 * r, '?', { size: r * 1.4, bold: true, color: ink, align: 'center' }));
  return out;
}

function imageSize(buf) {
  if (buf[0] === 0xFF) { const j = jpegInfo(buf); return { w: j.width, h: j.height }; }
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}
function imageFit(items, buf, x, y, w, h) {
  const s = imageSize(buf);
  const k = Math.min(w / s.w, h / s.h);
  const iw = s.w * k, ih = s.h * k;
  items.push(R(x, y, w, h, { fill: C.soft, radius: 10 }));
  items.push({ type: 'image', data: buf, x: x + (w - iw) / 2, y: y + (h - ih) / 2, w: iw, h: ih, stroke: C.line, width: 0.75 });
}

/** prd/screens/<id>.png|jpg → { id: Buffer }, id = module id, epic id or story id. */
export function loadScreens(dir) {
  if (!dir || !existsSync(dir)) return {};
  const out = {};
  for (const f of readdirSync(dir)) {
    if (/\.(png|jpe?g)$/i.test(f)) out[basename(f, extname(f))] = readFileSync(join(dir, f));
  }
  return out;
}

// ── BPMN diagram as primitives (guided-process-docs model + its bpmn-layout.js) ──
function diagramItems(items, process, bpmn, box, seq) {
  const lay = bpmn.layout(process, seq);
  // Названия дорожек на слайде — горизонтально в своей колонке: повёрнутый текст
  // часть просмотрщиков PPTX (Quick Look, превью в почте) рисует без поворота.
  const LABEL = 110, SKIP = bpmn.GEO?.LANE_LABEL ?? 42;
  const k = Math.min((box.w - LABEL) / (lay.width - SKIP), box.h / lay.height, 1.1);
  const ox = box.x + LABEL - SKIP * k, oy = box.y + (box.h - lay.height * k) / 2;
  const X = (v) => ox + v * k, Y = (v) => oy + v * k;
  const right = X(lay.width);
  for (const lane of lay.lanes) {
    items.push(R(box.x, Y(lane.top), right - box.x, lane.height * k, { fill: C.white, stroke: C.line, width: 0.75 }));
    items.push(R(box.x, Y(lane.top), LABEL - 8, lane.height * k, { fill: C.soft, stroke: C.line, width: 0.75 }));
    items.push(T(box.x + 8, Y(lane.top) + 4, LABEL - 24, lane.height * k - 8, lane.title, { size: 10, color: C.muted, bold: true, valign: 'middle', maxLines: 4 }));
  }
  for (const f of process.flows ?? []) {
    const a = lay.boxes[f.from], b = lay.boxes[f.to];
    if (!a || !b) continue;
    const route = bpmn.routeFlow(a, b);
    items.push({ type: 'line', points: route.d.map(([, x, y]) => [X(x), Y(y)]), stroke: f.kind === 'message' ? C.muted : C.ink, width: 1, dash: f.kind === 'message', arrow: true });
    if (f.label) items.push(T(X(route.mid.x) - 40, Y(route.mid.y) - 14, 80, 12, f.label, { size: Math.max(6, 8 * k), color: C.muted, align: 'center' }));
  }
  for (const id of lay.order) {
    const n = lay.boxes[id];
    const x = X(n.x), y = Y(n.y), w = n.w * k, h = n.h * k;
    if (n.shape === 'event') items.push({ type: 'ellipse', x, y, w, h, fill: C.white, stroke: n.type === 'end' ? C.ink : C.accent, width: n.type === 'end' ? 2.5 : 1.4 });
    else if (n.shape === 'gateway') items.push({ type: 'poly', points: [[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]], fill: C.white, stroke: C.warn, width: 1.4 });
    else items.push(R(x, y, w, h, { fill: n.shape === 'note' ? C.soft : C.white, stroke: n.shape === 'note' ? C.line : C.accent, width: 1.2, radius: n.shape === 'note' ? 0 : 8 * k, dash: n.shape === 'note' }));
    const inside = n.shape === 'task' || n.shape === 'note';
    items.push(T(inside ? x + 4 : x - 30 * k, inside ? y + 2 : y + h + 2, inside ? w - 8 : w + 60 * k, inside ? h - 4 : 22 * k, n.label, { size: Math.max(6, 9 * k), align: 'center', valign: inside ? 'middle' : 'top', maxLines: 3 }));
    items.push(T(x - 2, y - 11 * k, 40, 10, n.num, { size: Math.max(5.5, 7.5 * k), color: C.accent, bold: true }));
  }
}

// ── The deck ────────────────────────────────────────────────
/**
 * data: what prd-server.js passes to exporters (prd, index, statusOf, releases, generatedAt),
 * plus optional screens ({ id: Buffer }), processes (guided-process-docs models) and
 * bpmn (its bpmn-layout.js module: { layout, routeFlow }).
 */
export function buildDeck(data) {
  const { prd, statusOf, releases = [], screens = {}, processes = [], bpmn = null } = data;
  const index = data.index ?? core.indexPrd(prd);
  const product = prd.product ?? {};
  const slides = [];
  const all = core.selectEntries(index, { statusOf }, {});
  const total = core.summarize(core.entryKeys(all), statusOf);
  const epics = core.groupEntries(index, all, 'epic', statusOf).filter((g) => g.item);
  const modules = core.groupEntries(index, all, 'module', statusOf);
  const add = (items, background = C.white) => { slides.push({ background, items }); return slides.length; };
  const procById = new Map(processes.map((p, i) => [p.id, { p, seq: i + 1 }]));

  // 1. Титул
  {
    const items = [];
    items.push(R(0, 0, W, H, { fill: C.white }), R(0, 0, 10, H, { fill: C.accent }));
    items.push(T(MX, 52, 560, 18, product.owner ?? '', { size: 12, color: C.accent, bold: true, maxLines: 1 }));
    items.push(T(MX, 80, 560, 120, product.title ?? 'Продукт', { size: 40, bold: true, maxLines: 2 }));
    items.push(T(MX, 200, 540, 120, product.tagline ?? product.summary ?? '', { size: 17, color: C.muted, maxLines: 4 }));
    if (product.author?.name) {
      items.push(T(MX, 380, 520, 16, product.author.label ?? 'Автор', { size: 10, color: C.muted }));
      items.push(T(MX, 398, 520, 22, product.author.name, { size: 16, bold: true, maxLines: 1 }));
      if (product.author.position) items.push(T(MX, 422, 520, 40, product.author.position, { size: 11, color: C.muted, maxLines: 2 }));
    }
    items.push(T(MX, H - 44, 520, 16, [product.version ? `Версия ${product.version}` : null, fmtDate(data.generatedAt ?? new Date())].filter(Boolean).join(' · '), { size: 10.5, color: C.muted }));
    const list = modules.slice(0, 9);
    const top = 70, rowH = Math.min(46, (H - 140) / Math.max(1, list.length));
    items.push(T(640, top - 26, 280, 16, 'Компоненты продукта', { size: 11, color: C.muted, bold: true }));
    list.forEach((g, i) => {
      const y = top + i * rowH;
      items.push(R(640, y, 272, rowH - 8, { fill: C.soft, radius: 8 }));
      items.push(T(654, y + 6, 200, rowH - 20, g.title, { size: 12, bold: true, maxLines: 2, valign: 'middle' }));
      items.push(T(840, y + 6, 62, rowH - 20, `${g.summary.percent} %`, { size: 11, color: C.muted, align: 'right', valign: 'middle' }));
    });
    add(items);
  }

  // 2. О продукте и готовность
  {
    const items = [];
    header(items, 'О продукте', product.title ?? 'Продукт', slides.length + 1, product);
    items.push(T(MX, 110, 520, 200, product.summary ?? product.tagline ?? '', { size: 15, maxLines: 9, lineHeight: 1.2 }));
    const stats = [
      [String(modules.length), 'модулей'],
      [String(epics.length), 'эпиков'],
      [String(all.length), 'пользовательских историй'],
      [String(total.total), 'критериев приёмки'],
    ];
    stats.forEach(([n, label], i) => {
      const x = 610 + (i % 2) * 150, y = 110 + Math.floor(i / 2) * 92;
      items.push(R(x, y, 138, 80, { fill: C.soft, radius: 10 }));
      items.push(T(x + 14, y + 10, 110, 34, n, { size: 28, bold: true, color: C.accent }));
      items.push(T(x + 14, y + 46, 116, 30, label, { size: 10.5, color: C.muted, maxLines: 2 }));
    });
    items.push(T(MX, 360, W - 2 * MX, 22, `Готовность: реализовано ${total.implemented} из ${total.total} критериев — ${total.percent} %`, { size: 16, bold: true }));
    statusBar(items, MX, 392, W - 2 * MX, 14, total);
    let lx = MX;
    for (const st of core.STATUS_ORDER) {
      if (!total.byStatus[st]) continue;
      items.push(...markerItems(st, lx + 6, 428, 6));
      const label = `${core.STATUS[st].label}: ${total.byStatus[st]}`;
      items.push(T(lx + 16, 420, label.length * 6.3 + 10, 16, label, { size: 10.5, color: C.muted }));
      lx += label.length * 6.3 + 40;
    }
    items.push(T(MX, 456, W - 2 * MX, 30, 'Готовность считается по критериям приёмки: подтверждено автотестом или проверено вручную. Непроверенное не засчитывается.', { size: 10.5, color: C.muted, maxLines: 2 }));
    add(items);
  }

  // 3. Как работает продукт: эпики как путь ценности
  const flowGroups = epics.length ? epics : modules;
  if (flowGroups.length) {
    const items = [];
    header(items, 'Как это работает', epics.length ? 'Путь ценности: эпики продукта' : 'Модули продукта', slides.length + 1, product);
    const list = flowGroups.slice(0, 6);
    const gap = 14, bw = (W - 2 * MX - gap * (list.length - 1)) / list.length;
    list.forEach((g, i) => {
      const x = MX + i * (bw + gap), y = 130;
      items.push(R(x, y, bw, 250, { fill: i % 2 ? C.soft : C.accentSoft, radius: 12 }));
      items.push(T(x + 14, y + 14, bw - 28, 16, g.item?.id ?? `Шаг ${i + 1}`, { size: 11, color: C.accent, bold: true }));
      items.push(T(x + 14, y + 36, bw - 28, 60, g.item?.title ?? g.title, { size: 15, bold: true, maxLines: 3 }));
      items.push(T(x + 14, y + 100, bw - 28, 100, g.item?.goal ?? g.item?.summary ?? '', { size: 11, color: C.muted, maxLines: 7 }));
      statusBar(items, x + 14, y + 214, bw - 28, 8, g.summary);
      items.push(T(x + 14, y + 226, bw - 28, 16, `${g.summary.percent} % готово`, { size: 10, color: C.muted }));
      if (i < list.length - 1) items.push({ type: 'line', points: [[x + bw + 2, y + 125], [x + bw + gap - 2, y + 125]], stroke: C.accent, width: 1.5, arrow: true });
    });
    if (flowGroups.length > 6) items.push(T(MX, 400, 600, 16, `и ещё ${flowGroups.length - 6}`, { size: 11, color: C.muted }));
    add(items);
  }

  // 4. По эпикам (или модулям): обзор, истории, экран, схема
  for (const g of flowGroups) {
    const items = [];
    const it = g.item ?? {};
    header(items, epics.length ? `Эпик ${it.id}` : 'Модуль', it.title ?? g.title, slides.length + 1, product);
    const screen = screens[it.id] ?? g.entries.map(({ story }) => screens[story.module] ?? screens[story.id]).find(Boolean);
    const leftW = screen ? 420 : W - 2 * MX;
    let y = 100;
    if (it.goal || it.summary) { items.push(T(MX, y, leftW, 44, it.goal ?? it.summary, { size: 13, color: C.muted, maxLines: 3 })); y += 52; }
    statusBar(items, MX, y, Math.min(leftW, 360), 8, g.summary);
    items.push(T(MX + Math.min(leftW, 360) + 12, y - 4, 160, 16, `${g.summary.implemented}/${g.summary.total} · ${g.summary.percent} %`, { size: 10.5, color: C.muted }));
    y += 26;
    const stories = g.entries.slice(0, 7);
    for (const { story } of stories) {
      const sum = core.storySummary(story, statusOf);
      items.push(...markerItems(sum.status, MX + 7, y + 9, 6.5));
      items.push(T(MX + 22, y, leftW - 22, 34, `${story.title}`, { size: 12.5, bold: true, maxLines: 1 }));
      items.push(T(MX + 22, y + 17, leftW - 22, 16, story.as ? `Как ${story.as}, я хочу ${story.iWant}` : sum.text, { size: 10, color: C.muted, maxLines: 1 }));
      y += 42;
    }
    if (g.entries.length > stories.length) items.push(T(MX + 22, y, leftW, 16, `и ещё ${g.entries.length - stories.length} ист.`, { size: 10.5, color: C.muted }));
    if (screen) imageFit(items, screen, MX + leftW + 24, 100, W - 2 * MX - leftW - 24, 380);
    const mods = [...new Set(g.entries.map(({ story }) => index.modules.get(story.module)?.title).filter(Boolean))];
    if (epics.length && mods.length) items.push(T(MX, H - 58, leftW, 16, `Модули: ${mods.join(', ')}`, { size: 10.5, color: C.muted, maxLines: 1 }));
    add(items);

    const proc = it.process ? procById.get(it.process) : null;
    if (proc && bpmn) {
      const di = [];
      header(di, `Схема процесса · ${it.id ?? ''}`, proc.p.title ?? it.title, slides.length + 1, product);
      diagramItems(di, proc.p, bpmn, { x: MX, y: 100, w: W - 2 * MX, h: 380 }, proc.seq);
      add(di);
    }
  }

  // 5. Готовность по эпикам/модулям
  {
    const items = [];
    header(items, 'Готовность', epics.length ? 'Готовность по эпикам' : 'Готовность по модулям', slides.length + 1, product);
    const list = flowGroups.slice(0, 9);
    const rowH = Math.min(40, 360 / Math.max(1, list.length));
    list.forEach((g, i) => {
      const y = 110 + i * rowH;
      items.push(T(MX, y, 300, rowH - 6, g.item?.id ? `${g.item.id} ${g.item.title}` : g.title, { size: 12, maxLines: 1, valign: 'middle' }));
      statusBar(items, MX + 310, y + rowH / 2 - 7, 440, 12, g.summary);
      items.push(T(MX + 760, y, 104, rowH - 6, `${g.summary.percent} %`, { size: 12, bold: true, align: 'right', valign: 'middle' }));
    });
    let lx = MX;
    for (const st of core.STATUS_ORDER) {
      const label = core.STATUS[st].chip;
      const w = label.length * 9.5 * CHAR + 8;
      items.push(R(lx, H - 66, 10, 10, { fill: BAR[st] }));
      items.push(T(lx + 14, H - 68, w, 14, label, { size: 9.5, color: C.muted }));
      lx += w + 30;
    }
    add(items);
  }

  // 6. Что нового — последние релизы
  if (releases?.length) {
    const items = [];
    header(items, 'История изменений', 'Что нового', slides.length + 1, product);
    const list = releases.slice(0, 3);
    const cw = (W - 2 * MX - 24 * (list.length - 1)) / list.length;
    list.forEach((r, i) => {
      const x = MX + i * (cw + 24);
      items.push(R(x, 104, cw, 370, { fill: C.soft, radius: 12 }));
      items.push(T(x + 16, 118, cw - 32, 18, `${r.version} · ${fmtDate(r.date)}`, { size: 11, color: C.accent, bold: true }));
      items.push(T(x + 16, 140, cw - 32, 44, r.title, { size: 15, bold: true, maxLines: 2 }));
      let y = 192;
      for (const ch of (r.changes ?? []).slice(0, 5)) {
        const text = `${ch.area ? `${ch.area}: ` : ''}${ch.text}`;
        items.push(R(x + 16, y + 5, 5, 5, { fill: { feature: C.good, improvement: C.accent, fix: C.warn }[ch.type] ?? C.gray, radius: 2.5 }));
        items.push(T(x + 28, y, cw - 44, 50, text, { size: 10.5, maxLines: 3 }));
        y += 54;
      }
    });
    add(items);
  }

  // 7. Дорожная карта по релизам PRD
  const byRelease = new Map();
  for (const { story } of all) {
    const r = story.release ?? '—';
    if (!byRelease.has(r)) byRelease.set(r, []);
    byRelease.get(r).push(story);
  }
  if (byRelease.size > 1) {
    const items = [];
    header(items, 'План', 'Дорожная карта по релизам', slides.length + 1, product);
    const rels = [...byRelease.entries()].sort(([a], [b]) => String(a).localeCompare(String(b), 'ru', { numeric: true })).slice(0, 5);
    const cw = (W - 2 * MX - 16 * (rels.length - 1)) / rels.length;
    rels.forEach(([rel, stories], i) => {
      const x = MX + i * (cw + 16);
      const keys = stories.flatMap((s) => core.activeCriteria(s).map((ac) => core.acKey(s, ac)));
      const sum = core.summarize(keys, statusOf);
      items.push(R(x, 104, cw, 370, { fill: sum.percent === 100 ? '#E8F6EC' : C.soft, radius: 12 }));
      items.push(T(x + 14, 118, cw - 28, 22, `Релиз ${rel}`, { size: 16, bold: true }));
      statusBar(items, x + 14, 146, cw - 28, 8, sum);
      items.push(T(x + 14, 158, cw - 28, 14, `${sum.percent} % · ${stories.length} ист.`, { size: 10, color: C.muted }));
      let y = 184;
      for (const s of stories.slice(0, 7)) {
        const st = core.storySummary(s, statusOf);
        items.push(...markerItems(st.status, x + 20, y + 7, 5.5));
        items.push(T(x + 32, y, cw - 46, 30, s.title, { size: 10.5, maxLines: 2 }));
        y += 38;
      }
    });
    add(items);
  }

  // 8. Финал
  {
    const items = [];
    items.push(R(0, 0, W, H, { fill: C.accent }));
    items.push(T(MX, 170, W - 2 * MX, 60, product.title ?? '', { size: 36, bold: true, color: C.white, maxLines: 1 }));
    items.push(T(MX, 236, W - 2 * MX, 60, product.closing ?? 'Требования, статус реализации и рецензии — в разделе «Требования» продукта.', { size: 16, color: '#E9E3FF', maxLines: 2 }));
    if (product.url) items.push(T(MX, 300, W - 2 * MX, 22, product.url, { size: 14, color: C.white }));
    if (product.author?.name) items.push(T(MX, H - 70, W - 2 * MX, 20, [product.author.name, product.author.position].filter(Boolean).join(' · '), { size: 12, color: '#E9E3FF', maxLines: 1 }));
    add(items, C.accent);
  }

  return { title: `${product.title ?? 'Продукт'} — презентация`, author: product.author?.name ?? product.owner ?? '', slides };
}

// ── PDF renderer ────────────────────────────────────────────
function ellipse(cv, x, y, w, h, mode) {
  const rx = w / 2, ry = h / 2, cx = x + rx, cy = y + ry, k = 0.5523;
  cv.op(`${(cx + rx).toFixed(2)} ${cy.toFixed(2)} m`)
    .op(`${(cx + rx).toFixed(2)} ${(cy + ry * k).toFixed(2)} ${(cx + rx * k).toFixed(2)} ${(cy + ry).toFixed(2)} ${cx.toFixed(2)} ${(cy + ry).toFixed(2)} c`)
    .op(`${(cx - rx * k).toFixed(2)} ${(cy + ry).toFixed(2)} ${(cx - rx).toFixed(2)} ${(cy + ry * k).toFixed(2)} ${(cx - rx).toFixed(2)} ${cy.toFixed(2)} c`)
    .op(`${(cx - rx).toFixed(2)} ${(cy - ry * k).toFixed(2)} ${(cx - rx * k).toFixed(2)} ${(cy - ry).toFixed(2)} ${cx.toFixed(2)} ${(cy - ry).toFixed(2)} c`)
    .op(`${(cx + rx * k).toFixed(2)} ${(cy - ry).toFixed(2)} ${(cx + rx).toFixed(2)} ${(cy - ry * k).toFixed(2)} ${(cx + rx).toFixed(2)} ${cy.toFixed(2)} c`)
    .op(mode);
}

function drawText(cv, it) {
  const font = it.bold ? 'bold' : 'regular';
  const lh = (it.lineHeight ?? 1.18);
  if (it.rotate === 90 || it.rotate === 270) {
    const lines = cv.wrap(it.text, it.size, it.h - 4, font).slice(0, Math.max(1, Math.floor(it.w / (it.size * lh))));
    const total = lines.length * it.size * lh;
    lines.forEach((line, i) => {
      const x = it.x + (it.w - total) / 2 + (i + 0.8) * it.size * lh;
      cv.textRotated(line, H - (H - x), H - (it.y + it.h / 2), { font, size: it.size, color: it.color });
    });
    return;
  }
  let size = it.size;
  let lines = cv.wrap(it.text, size, it.w, font);
  // Шрифт PDF шире оценки — сначала уменьшаем кегль, и только потом режем текст.
  while (lines.length * size * lh > it.h + size * 0.3 && size > it.size * 0.72) {
    size -= 0.5;
    lines = cv.wrap(it.text, size, it.w, font);
  }
  const maxLines = Math.max(1, Math.floor((it.h + size * 0.3) / (size * lh)));
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    let last = lines[maxLines - 1];
    while (last.length > 1 && cv.textWidth(`${last}…`, size, font) > it.w) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last.replace(/[\s,.;:—-]+$/, '')}…`;
  }
  const blockH = lines.length * size * lh;
  const top = it.valign === 'middle' ? it.y + (it.h - blockH) / 2 : it.valign === 'bottom' ? it.y + it.h - blockH : it.y;
  lines.forEach((line, i) => {
    const baseline = top + i * size * lh + size * 0.86;
    const x = it.align === 'center' ? it.x + it.w / 2 : it.align === 'right' ? it.x + it.w : it.x;
    cv.text(line, x, H - baseline, { font, size, color: it.color, align: it.align ?? 'left' });
  });
}

export function buildDeckPdf(deck) {
  const doc = new PdfDoc({ title: deck.title, author: deck.author });
  const images = new Map();
  for (const slide of deck.slides) {
    const cv = new Canvas(doc);
    cv.rgb(slide.background ?? C.white).rect(0, 0, W, H, 'f');
    for (const it of slide.items) {
      const mode = it.fill && it.stroke ? 'B' : it.fill ? 'f' : 'S';
      if (it.fill) cv.rgb(it.fill);
      if (it.stroke) cv.rgb(it.stroke, true).lineWidth(it.width ?? 1);
      if (it.type === 'rect') {
        if (!it.fill && !it.stroke) continue;
        cv.dash(it.dash ? 3 : 0, it.dash ? 2 : 0);
        if (it.radius) cv.roundRect(it.x, H - it.y - it.h, it.w, it.h, Math.min(it.radius, it.w / 2, it.h / 2), mode);
        else cv.rect(it.x, H - it.y - it.h, it.w, it.h, mode);
        cv.dash(0, 0);
      } else if (it.type === 'ellipse') ellipse(cv, it.x, H - it.y - it.h, it.w, it.h, mode);
      else if (it.type === 'poly') cv.poly(it.points.map(([x, y]) => [x, H - y]), mode);
      else if (it.type === 'line') {
        cv.rgb(it.stroke ?? C.ink, true).lineWidth(it.width ?? 1).dash(it.dash ? 4 : 0, it.dash ? 3 : 0);
        const pts = it.points.map(([x, y]) => [x, H - y]);
        cv.polyline(pts, 'S');
        cv.dash(0, 0);
        if (it.arrow && pts.length > 1) {
          const [x2, y2] = pts.at(-1), [x1, y1] = pts.at(-2);
          const a = Math.atan2(y2 - y1, x2 - x1), s = 3 + (it.width ?? 1) * 2;
          cv.rgb(it.stroke ?? C.ink).poly([[x2, y2], [x2 - s * Math.cos(a - 0.45), y2 - s * Math.sin(a - 0.45)], [x2 - s * Math.cos(a + 0.45), y2 - s * Math.sin(a + 0.45)]], 'f');
        }
      } else if (it.type === 'image') {
        if (!images.has(it.data)) images.set(it.data, doc.addImage(it.data));
        cv.image(images.get(it.data), it.x, H - it.y - it.h, it.w, it.h);
        if (it.stroke) cv.rgb(it.stroke, true).lineWidth(it.width ?? 0.75).rect(it.x, H - it.y - it.h, it.w, it.h, 'S');
      } else if (it.type === 'text') drawText(cv, it);
    }
    doc.addPage(W, H, cv.toString());
  }
  return doc.build();
}

export const buildDeckPptx = (deck) => buildPptx(deck);
