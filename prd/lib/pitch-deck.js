// Pitch deck: a product story for people who have never seen the product — no
// development status, no readiness bars. Same primitives as deck.js, so the same
// two renderers give PDF and editable PPTX.
//
// Content comes from a pitch model (prd/pitch.js), not from the PRD: requirements
// say what the product must do, a pitch says why it exists and how people use it.
//
//   import { buildPitchDeck } from './pitch-deck.js';
//   const deck = buildPitchDeck(PITCH, { product: prd.product, screens: loadScreens('prd/screens/pitch') });
//   buildDeckPdf(deck) / buildDeckPptx(deck)
//
// Slide order: title · how components work together · goals · who works together ·
// composition · for each component: overview with a screenshot, key screens (optional),
// collaboration swimlane (optional) · summary. Every section is optional: a small
// product with four components and no flow slide gives a short deck.
// Model shape and how to write it: references/pitch.md.
import { fit } from './deck.js';
import { SLIDE } from './pptx.js';
import { jpegInfo } from './pdf.js';

const W = SLIDE.w, H = SLIDE.h, MX = 44;
export const PITCH_THEME = {
  navy: '#172B54', navy2: '#1E3666', ink: '#1A1D24', muted: '#5A6170', line: '#DDE3EC',
  soft: '#F3F5F9', blue: '#2B5797', bright: '#3B7DD8', pale: '#DCE8F7', paler: '#EEF3FA',
  white: '#FFFFFF', good: '#1F7A4D', goodSoft: '#E3F3EA', orange: '#F08A4B', onNavy: '#C9D6EA', onNavyMuted: '#8FB4E8',
  arrow: '#7A8394',
};

const fmtDate = (d) => new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).replace(/\s*г\.$/, '');

export function buildPitchDeck(pitch, { product = {}, screens = {}, date = new Date(), theme = {} } = {}) {
  const C = { ...PITCH_THEME, ...(pitch.theme ?? {}), ...theme };
  const T = (x, y, w, h, text, o = {}) => ({ type: 'text', x, y, w, h, text: o.maxLines ? fit(text, o.size ?? 10, w, o.maxLines) : String(text ?? ''), size: 10, color: C.ink, ...o });
  const R = (x, y, w, h, o = {}) => ({ type: 'rect', x, y, w, h, fill: C.soft, ...o });
  const dot = (cx, cy, r, fill) => ({ type: 'ellipse', x: cx - r, y: cy - r, w: 2 * r, h: 2 * r, fill });
  const numDot = (cx, cy, r, n, fill = C.blue) => [dot(cx, cy, r, fill), T(cx - r, cy - r * 0.78, 2 * r, 2 * r, String(n), { size: r * 1.05, bold: true, color: C.white, align: 'center' })];
  const roles = Object.fromEntries((pitch.roles?.items ?? []).map((r) => [r.id, r]));
  const comps = pitch.components ?? [];
  const compByN = Object.fromEntries(comps.map((c) => [c.n, c]));
  const footer = pitch.footer ?? product.title ?? '';
  const slides = [];
  const pageNums = [];

  const add = (items, background = C.white) => { slides.push({ background, items }); return slides.length; };
  function frame(items, eyebrow, title, lead) {
    items.push(R(0, 0, W, 4, { fill: C.blue }));
    items.push(T(MX, 22, W - 2 * MX, 12, eyebrow.toUpperCase(), { size: 7.5, bold: true, color: C.bright }));
    items.push(T(MX, 34, W - 2 * MX, 30, title, { size: 22, bold: true, maxLines: 1 }));
    if (lead) items.push(T(MX, 62, W - 2 * MX, 28, lead, { size: 9.5, color: C.muted, maxLines: 2, lineHeight: 1.25 }));
    items.push({ type: 'line', points: [[MX, 508], [W - MX, 508]], stroke: C.line, width: 0.6 });
    items.push(T(MX, 514, 600, 10, footer, { size: 7, color: C.muted }));
    const num = T(W - MX - 80, 514, 80, 10, '', { size: 7, color: C.muted, align: 'right' });
    items.push(num);
    pageNums.push(num);
  }
  function screen(items, file, x, y, w, h) {
    const buf = screens[file];
    if (!buf) {
      items.push(R(x, y, w, h, { fill: C.soft, stroke: C.line, width: 0.8, radius: 6 }));
      items.push(T(x, y + h / 2 - 8, w, 16, `Снимок экрана: ${file}`, { size: 9, color: C.muted, align: 'center' }));
      return;
    }
    const s = buf[0] === 0xFF ? (({ width, height }) => ({ w: width, h: height }))(jpegInfo(buf)) : { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    const k = Math.min(w / s.w, h / s.h), iw = s.w * k, ih = s.h * k;
    const ix = x + (w - iw) / 2, iy = y;
    items.push(R(ix + 1.5, iy + 2.5, iw, ih, { fill: '#E4E8EF', radius: 6 }));
    items.push({ type: 'image', data: buf, x: ix, y: iy, w: iw, h: ih });
    items.push(R(ix, iy, iw, ih, { fill: null, stroke: '#C9D1DE', width: 0.8, radius: 6 }));
    return ih;
  }
  const bullets = (items, list, x, y, w, size = 8.8, maxY = 400) => {
    for (const b of list) {
      const perLine = Math.max(8, Math.floor((w - 12) / (size * 0.45)));
      const lines = Math.min(3, Math.ceil(String(b).length / perLine));
      const h = lines * size * 1.25;
      if (y + h > maxY) break;
      items.push(dot(x + 2.5, y + size * 0.6, 2.2, C.bright));
      items.push(T(x + 12, y, w - 12, h + 2, b, { size, maxLines: 3, lineHeight: 1.2 }));
      y += h + 7;
    }
    return y;
  };

  // 1. Титул
  {
    const items = [];
    items.push(dot(W - 30, 60, 230, C.navy2), dot(W - 120, H + 90, 170, C.navy2));
    items.push(R(MX, 34, 34, 34, { fill: C.white, radius: 7 }));
    items.push(T(MX, 44, 34, 16, pitch.brand?.mark ?? '', { size: 11, bold: true, color: C.navy, align: 'center' }));
    items.push(T(MX + 46, 42, 300, 20, pitch.brand?.name ?? product.title ?? '', { size: 14, bold: true, color: C.white }));
    items.push(T(MX, 92, 760, 12, (pitch.eyebrow ?? product.owner ?? '').toUpperCase(), { size: 7.5, bold: true, color: C.onNavyMuted }));
    items.push(T(MX, 108, 790, 70, pitch.headline ?? product.title, { size: 25, bold: true, color: C.white, maxLines: 2, lineHeight: 1.15 }));
    items.push(T(MX, 180, 780, 44, pitch.subtitle ?? product.tagline ?? '', { size: 10.5, color: C.onNavy, maxLines: 3, lineHeight: 1.3 }));
    // Чипы компонентов: «n · название», перенос по ширине
    let cx = MX, cy = 236;
    for (const c of comps) {
      const label = `${c.n} · ${c.title}`;
      const w = label.length * 7.5 * 0.5 + 18;
      if (cx + w > W - MX) { cx = MX; cy += 22; }
      items.push(R(cx, cy, w, 16, { fill: '#26427A', radius: 8 }));
      items.push(T(cx, cy + 4, w, 10, label, { size: 7.5, bold: true, color: C.white, align: 'center' }));
      cx += w + 6;
    }
    items.push({ type: 'line', points: [[MX, 388], [W - MX, 388]], stroke: '#2E4775', width: 0.7 });
    const a = pitch.author;
    if (a?.name) {
      items.push(dot(MX + 35, 437, 36, C.white), dot(MX + 35, 437, 33, C.pale));
      items.push(T(MX, 425, 70, 24, a.initials ?? a.name.split(/\s+/).map((s) => s[0]).join('').slice(0, 2), { size: 19, bold: true, color: C.navy, align: 'center' }));
      items.push(T(MX + 86, 408, 600, 10, (a.label ?? 'Автор').toUpperCase(), { size: 7, bold: true, color: C.orange }));
      items.push(T(MX + 86, 420, 600, 20, a.name, { size: 14, bold: true, color: C.white }));
      (a.lines ?? []).forEach((l, i) => items.push(T(MX + 86, 444 + i * 12, 700, 12, l, { size: 8, color: C.onNavy, maxLines: 1 })));
    }
    items.push(T(W - MX - 300, 514, 300, 12, `Версия от ${fmtDate(date)} г.`, { size: 7.5, color: C.onNavyMuted, align: 'right' }));
    add(items, C.navy);
  }

  // 2. Как компоненты работают вместе
  if (pitch.flow) {
    const f = pitch.flow;
    const items = [];
    frame(items, 'Принцип работы', f.title, f.lead);
    const n = f.stages.length, sw = (W - 2 * MX) / n, sy = 206, sh = 50;
    const card = (c, y, o) => {
      const comp = compByN[c.component] ?? { n: c.component, title: '' };
      const x = MX + c.from * sw + 3, w = (c.to - c.from + 1) * sw - 6, h = 62;
      const dark = Boolean(c.dark);
      items.push(R(x, y, w, h, { fill: dark ? C.navy : C.white, stroke: dark ? null : C.line, width: 0.8, radius: 6 }));
      items.push(...numDot(x + 15, y + 15, 7, comp.n, dark ? C.bright : C.blue));
      items.push(T(x + 28, y + 9, w - 36, 24, comp.title, { size: 9, bold: true, color: dark ? C.white : C.ink, maxLines: 2 }));
      items.push(T(x + 12, y + 40, w - 20, 14, c.note, { size: 7.5, color: dark ? C.onNavy : C.muted, maxLines: 1 }));
      const ax = x + w / 2;
      items.push({ type: 'line', points: o === 'down' ? [[ax, y + h], [ax, sy]] : [[ax, sy + sh], [ax, y]], stroke: C.bright, width: 1, arrow: true });
      return { x, y, w, h };
    };
    for (const c of f.above ?? []) card(c, 102, 'down');
    let darkBox = null;
    for (const c of f.below ?? []) { const b = card(c, 288, 'up'); if (c.dark) darkBox = b; }
    f.stages.forEach((s, i) => {
      const x = MX + i * sw, last = i === n - 1, tip = 12;
      const pts = [[x, sy], [x + sw + (last ? 0 : tip), sy], ...(last ? [] : [[x + sw + tip, sy], [x + sw + tip * 2, sy + sh / 2], [x + sw + tip, sy + sh]]), [x + sw + (last ? 0 : tip), sy + sh], [x, sy + sh], ...(i ? [[x + tip, sy + sh / 2]] : [])];
      items.push({ type: 'poly', points: last ? [[x, sy], [x + sw, sy], [x + sw, sy + sh], [x, sy + sh], [x + tip, sy + sh / 2]] : pts, fill: last ? C.blue : C.pale, stroke: C.white, width: 1.5 });
      items.push(T(x + (i ? 22 : 12), sy + 10, sw - 30, 14, s.title, { size: 10.5, bold: true, color: last ? C.white : C.ink, maxLines: 1 }));
      items.push(T(x + (i ? 22 : 12), sy + 28, sw - 30, 12, s.sub, { size: 7.5, color: last ? C.onNavy : C.muted, maxLines: 1 }));
    });
    if (darkBox && f.loop) {
      const ax = darkBox.x + darkBox.w / 2, by = darkBox.y + darkBox.h;
      items.push({ type: 'line', points: [[ax, by], [ax, by + 10], [MX - 14, by + 10], [MX - 14, sy + sh / 2], [MX, sy + sh / 2]], stroke: C.blue, width: 1, arrow: true });
      items.push(T(MX + 4, by + 14, 700, 12, f.loop, { size: 7.5, bold: true, color: C.blue }));
    }
    if (f.everyone?.length) {
      const py = 404, ph = 76;
      items.push(R(MX, py, W - 2 * MX, ph, { fill: C.paler, radius: 6 }));
      items.push(T(MX + 14, py + 10, 300, 10, 'У КАЖДОГО УЧАСТНИКА', { size: 7, bold: true, color: C.blue }));
      const m = f.everyone.length, gap = 8, cw = (W - 2 * MX - 28 - gap * (m - 1)) / m;
      f.everyone.forEach((num, i) => {
        const comp = compByN[num] ?? { n: num, title: '' };
        const x = MX + 14 + i * (cw + gap), y = py + 28;
        items.push(R(x, y, cw, 34, { fill: C.white, radius: 4 }));
        items.push(...numDot(x + 13, y + 17, 7, comp.n));
        items.push(T(x + 25, y + 6, cw - 30, 24, comp.title, { size: 8, bold: true, maxLines: 2, valign: 'middle' }));
      });
    }
    add(items);
  }

  // 3. Цели
  if (pitch.goals) {
    const g = pitch.goals, items = [];
    frame(items, 'Цели', g.title);
    const gap = 13, cw = (W - 2 * MX - 2 * gap) / 3, ch = 142;
    g.items.slice(0, 6).forEach((it, i) => {
      const x = MX + (i % 3) * (cw + gap), y = 70 + Math.floor(i / 3) * (ch + gap);
      items.push(R(x, y, cw, ch, { fill: C.soft, radius: 6 }));
      items.push(T(x + 16, y + 14, 60, 22, String(i + 1).padStart(2, '0'), { size: 17, bold: true, color: C.bright }));
      items.push(T(x + 16, y + 46, cw - 32, 28, it.title, { size: 11, bold: true, maxLines: 2, lineHeight: 1.15 }));
      items.push(T(x + 16, y + 78, cw - 32, 56, it.text, { size: 8.5, color: C.muted, maxLines: 4, lineHeight: 1.3 }));
    });
    if (g.punchline) {
      const py = Math.min(386, 70 + Math.ceil(Math.min(6, g.items.length) / 3) * (ch + gap) + 4);
      items.push(R(MX, py, W - 2 * MX, 84, { fill: C.navy, radius: 6 }));
      items.push(T(MX + 26, py + 18, W - 2 * MX - 52, 22, g.punchline[0], { size: 16, bold: true, color: C.white }));
      items.push(T(MX + 26, py + 44, W - 2 * MX - 52, 22, g.punchline[1] ?? '', { size: 16, bold: true, color: C.onNavyMuted }));
    }
    add(items);
  }

  // 4. Кто работает вместе
  if (pitch.roles) {
    const r = pitch.roles, items = [];
    frame(items, 'Совместная работа', r.title, r.lead);
    const people = r.items.filter((x) => !x.platform);
    const cols = people.length === 4 ? 4 : Math.min(3, people.length), gap = 13, cw = (W - 2 * MX - gap * (cols - 1)) / cols, ch = 118;
    people.forEach((p, i) => {
      const x = MX + (i % cols) * (cw + gap), y = 108 + Math.floor(i / cols) * (ch + gap);
      items.push(R(x, y, cw, ch, { fill: C.white, stroke: C.line, width: 0.8, radius: 6 }));
      items.push(dot(x + 20, y + 22, 7, p.color));
      items.push(T(x + 34, y + 15, cw - 46, 16, p.title, { size: 11.5, bold: true, maxLines: 1 }));
      items.push(T(x + 34, y + 32, cw - 46, 10, (p.group ?? '').toUpperCase(), { size: 6.8, bold: true, color: p.color }));
      items.push(T(x + 16, y + 52, cw - 32, 58, p.text, { size: 8.8, color: C.muted, maxLines: 4, lineHeight: 1.3 }));
    });
    const plat = r.items.find((x) => x.platform);
    const ny = 108 + Math.ceil(people.length / cols) * (ch + gap) + 4;
    if (plat || r.note) {
      items.push(dot(MX + 6, ny + 6, 5, plat?.color ?? C.arrow));
      items.push(T(MX + 18, ny, W - 2 * MX - 18, 24, r.note ?? plat.text, { size: 8.5, color: C.muted, maxLines: 2 }));
    }
    add(items);
  }

  // 5. Состав
  if (comps.length) {
    const items = [];
    frame(items, pitch.compositionEyebrow ?? 'Состав продукта', pitch.compositionTitle ?? `Компоненты продукта: ${comps.length}`);
    const cols = comps.length <= 4 ? comps.length : comps.length <= 6 ? 3 : 4, rows = Math.ceil(comps.length / cols), gap = 12;
    const cw = (W - 2 * MX - gap * (cols - 1)) / cols, ch = Math.min(130, (440 - 66 - gap * (rows - 1)) / rows);
    const everyone = new Set(pitch.flow?.everyone ?? []);
    comps.forEach((c, i) => {
      const x = MX + (i % cols) * (cw + gap), y = 66 + Math.floor(i / cols) * (ch + gap);
      const plain = everyone.has(c.n);
      items.push(R(x, y, cw, ch, plain ? { fill: C.white, stroke: C.line, width: 0.8, radius: 6 } : { fill: C.soft, radius: 6 }));
      items.push(T(x + 14, y + 12, 40, 18, String(c.n).padStart(2, '0'), { size: 13, bold: true, color: C.bright }));
      items.push(T(x + 14, y + 36, cw - 28, 26, c.title, { size: 10, bold: true, maxLines: 2, lineHeight: 1.15 }));
      items.push(T(x + 14, y + 64, cw - 28, ch - 70, c.short, { size: 7.8, color: C.muted, maxLines: 4, lineHeight: 1.28 }));
    });
    add(items);
  }

  // 6. Компоненты
  comps.forEach((c) => {
    const tag = `Компонент ${c.n} из ${comps.length}`;
    // 6.1 Обзор со снимком экрана
    {
      const items = [];
      frame(items, tag, c.title);
      const lw = 272;
      items.push(T(MX, 64, lw, 64, c.lead, { size: 11, maxLines: 5, lineHeight: 1.3 }));
      items.push(T(MX, 136, lw, 10, 'ВОЗМОЖНОСТИ', { size: 7.5, bold: true, color: C.bright }));
      bullets(items, c.capabilities ?? [], MX, 152, lw, 8.6, 420);
      items.push(T(MX, 432, lw, 10, 'КТО РАБОТАЕТ', { size: 7.5, bold: true, color: C.bright }));
      items.push(T(MX, 446, lw, 24, c.who ?? '', { size: 8.8, maxLines: 2 }));
      const sx = MX + lw + 26, sw = W - MX - sx;
      const ih = screen(items, c.screen?.file, sx, 66, sw, sw / 1.6) ?? sw / 1.6;
      if (c.screen?.caption) items.push(T(sx, 66 + ih + 8, sw, 12, c.screen.caption, { size: 8.5, color: C.muted, maxLines: 1 }));
      if (c.sections) items.push(T(sx, 490, sw, 12, `Разделы портала: ${c.sections}`, { size: 7.5, color: C.muted, align: 'right', maxLines: 1 }));
      add(items);
    }
    // 6.2 Ключевые экраны
    if (c.keys?.length) {
      const items = [];
      frame(items, `${tag} · ключевые экраны`, c.title);
      if (c.keys.length >= 2) {
        const gap = 22, w = (W - 2 * MX - gap) / 2;
        c.keys.slice(0, 2).forEach((k, i) => {
          const x = MX + i * (w + gap);
          const ih = screen(items, k.file, x, 112, w, w / 1.6) ?? w / 1.6;
          items.push(...numDot(x + 8, 112 + ih + 18, 8, i + 1));
          items.push(T(x + 24, 112 + ih + 12, w - 26, 26, k.caption, { size: 9.5, bold: true, maxLines: 2 }));
        });
      } else {
        const w = 610;
        screen(items, c.keys[0].file, MX, 66, w, w / 1.6);
        const rx = MX + w + 24, rw = W - MX - rx;
        items.push(T(rx, 72, rw, 10, 'НА ЭКРАНЕ', { size: 7.5, bold: true, color: C.bright }));
        items.push(T(rx, 88, rw, 80, c.onScreen ?? c.keys[0].caption, { size: 12, bold: true, maxLines: 4, lineHeight: 1.2 }));
        items.push(T(rx, 250, rw, 10, 'КТО РАБОТАЕТ', { size: 7.5, bold: true, color: C.bright }));
        items.push(T(rx, 264, rw, 30, c.who ?? '', { size: 9, maxLines: 2 }));
      }
      add(items);
    }
    // 6.3 Схема совместной работы
    if (c.flow?.steps?.length) {
      const f = c.flow, items = [];
      frame(items, `${tag} · схема совместной работы`, f.title);
      const lanes = f.lanes ?? [...new Set(f.steps.map((s) => s.lane))];
      const top = 64, bottom = 418, lh = (bottom - top) / lanes.length, labelW = 148;
      const laneY = Object.fromEntries(lanes.map((id, i) => [id, top + i * lh]));
      lanes.forEach((id, i) => {
        const role = roles[id] ?? { title: id, color: C.arrow };
        const y = laneY[id];
        items.push(R(MX, y + 2, W - 2 * MX, lh - 4, { fill: i % 2 ? C.white : C.soft }));
        items.push(R(MX, y + 2, 3, lh - 4, { fill: role.color }));
        items.push(T(MX + 14, y + lh / 2 - 12, labelW - 20, 14, role.title, { size: 10, bold: true, color: role.platform ? C.arrow : role.color, maxLines: 1 }));
        items.push(T(MX + 14, y + lh / 2 + 4, labelW - 20, 20, role.lane ?? '', { size: 7, color: C.muted, maxLines: 2 }));
      });
      const n = f.steps.length, area = W - 2 * MX - labelW - 10, colW = area / n;
      const bw = Math.min(118, colW - 16), bh = Math.min(50, lh - 22);
      const boxes = f.steps.map((s, i) => {
        const x = MX + labelW + i * colW + (colW - bw) / 2, y = laneY[s.lane] + (lh - bh) / 2;
        return { x, y, w: bw, h: bh, color: (roles[s.lane] ?? {}).color ?? C.arrow };
      });
      for (let i = 0; i < n - 1; i += 1) {
        const a = boxes[i], b = boxes[i + 1];
        const ya = a.y + a.h / 2, yb = b.y + b.h / 2;
        const mx = (a.x + a.w + b.x) / 2;
        const pts = Math.abs(ya - yb) < 1 ? [[a.x + a.w, ya], [b.x, yb]] : [[a.x + a.w, ya], [mx, ya], [mx, yb], [b.x, yb]];
        items.push({ type: 'line', points: pts, stroke: C.arrow, width: 0.8, arrow: true });
      }
      boxes.forEach((b, i) => {
        items.push(R(b.x, b.y, b.w, b.h, { fill: C.white, stroke: b.color, width: 1.2, radius: 4 }));
        items.push(T(b.x + 6, b.y + 4, b.w - 12, b.h - 8, f.steps[i].text, { size: 7.8, align: 'center', valign: 'middle', maxLines: 3, lineHeight: 1.2 }));
        items.push(...numDot(b.x + 2, b.y, 7, i + 1, b.color));
      });
      if (f.result) {
        items.push(R(MX, 432, W - 2 * MX, 58, { fill: C.goodSoft, radius: 6 }));
        items.push(T(MX + 16, 446, 100, 10, 'РЕЗУЛЬТАТ', { size: 7.5, bold: true, color: C.good }));
        items.push(T(MX + 120, 442, W - 2 * MX - 140, 40, f.result, { size: 10.5, maxLines: 2, lineHeight: 1.3 }));
      }
      add(items);
    }
  });

  // 7. Итог
  if (pitch.final) {
    const f = pitch.final, items = [];
    frame(items, 'Итог', f.title);
    items.push(T(MX, 64, W - 2 * MX, 30, f.lead ?? '', { size: 10.5, color: C.muted, maxLines: 2, lineHeight: 1.3 }));
    const pts = (f.points ?? []).slice(0, 4), gap = 12, cw = (W - 2 * MX - gap * (pts.length - 1)) / Math.max(1, pts.length);
    pts.forEach((p, i) => {
      const x = MX + i * (cw + gap);
      items.push(R(x, 112, cw, 150, { fill: C.soft, radius: 6 }));
      items.push(T(x + 16, 126, 60, 22, String(i + 1).padStart(2, '0'), { size: 17, bold: true, color: C.bright }));
      items.push(T(x + 16, 158, cw - 32, 30, p.title, { size: 11, bold: true, maxLines: 2 }));
      items.push(T(x + 16, 192, cw - 32, 62, p.text, { size: 8.8, color: C.muted, maxLines: 4, lineHeight: 1.3 }));
    });
    if (f.punchline) {
      items.push(R(MX, 290, W - 2 * MX, 84, { fill: C.navy, radius: 6 }));
      items.push(T(MX + 26, 308, W - 2 * MX - 52, 22, f.punchline[0], { size: 16, bold: true, color: C.white }));
      items.push(T(MX + 26, 334, W - 2 * MX - 52, 22, f.punchline[1] ?? '', { size: 16, bold: true, color: C.onNavyMuted }));
    }
    if (product.url) items.push(T(MX, 400, W - 2 * MX, 16, product.url, { size: 11, bold: true, color: C.blue }));
    items.push(T(W - MX - 400, 490, 400, 12, `${pitch.brand?.name ?? product.title ?? ''} · версия от ${fmtDate(date)} г.`, { size: 8, color: C.muted, align: 'right' }));
    add(items);
  }

  pageNums.forEach((it) => { it.text = ''; });
  slides.forEach((s, i) => {
    const num = s.items.find((it) => pageNums.includes(it));
    if (num) num.text = `${i + 1} / ${slides.length}`;
  });
  return { title: `${product.title ?? pitch.brand?.name ?? 'Продукт'} — ${pitch.title ?? 'питч-презентация'}`, author: pitch.author?.name ?? product.owner ?? '', slides };
}

/**
 * Check a pitch model before rendering: references between sections, lanes, screenshots.
 * Returns [{ level: 'error'|'warn', id, msg }] — the same shape validate-prd prints.
 */
export function validatePitch(pitch, { screens = null } = {}) {
  const out = [];
  const err = (id, msg) => out.push({ level: 'error', id, msg });
  const warn = (id, msg) => out.push({ level: 'warn', id, msg });
  if (!pitch?.headline) err('pitch', 'нет headline — заголовка титульного слайда');
  const comps = pitch?.components ?? [];
  if (!comps.length) err('pitch', 'нет components — питч держится на компонентах продукта');
  const nums = new Set();
  for (const c of comps) {
    const id = `pitch:component ${c.n}`;
    if (!Number.isInteger(c.n)) err(id, 'n — порядковый номер компонента, целое число');
    if (nums.has(c.n)) err(id, 'номер компонента повторяется');
    nums.add(c.n);
    if (!c.title || !c.short) err(id, 'нужны title и short (строка для слайда «Состав»)');
    if (!c.capabilities?.length) warn(id, 'нет capabilities — слайд компонента будет пустым слева');
    if (screens) for (const s of [c.screen, ...(c.keys ?? [])].filter(Boolean)) if (!screens[s.file]) warn(id, `нет снимка ${s.file} — на слайде будет заглушка`);
  }
  const roles = new Set((pitch?.roles?.items ?? []).map((r) => r.id));
  for (const c of comps) {
    if (!c.flow) continue;
    const lanes = c.flow.lanes ?? [];
    for (const l of lanes) if (!roles.has(l)) err(`pitch:component ${c.n}`, `дорожка ${l} не описана в roles.items`);
    for (const st of c.flow.steps ?? []) if (lanes.length && !lanes.includes(st.lane)) err(`pitch:component ${c.n}`, `шаг «${st.text}» на дорожке ${st.lane}, которой нет в flow.lanes`);
    if ((c.flow.steps ?? []).length > 8) warn(`pitch:component ${c.n}`, 'больше 8 шагов на схеме — блоки станут узкими');
  }
  const f = pitch?.flow;
  if (f) {
    for (const x of [...(f.above ?? []), ...(f.below ?? [])]) {
      if (!nums.has(x.component)) err('pitch:flow', `компонент ${x.component} не описан в components`);
      if (x.from < 0 || x.to >= (f.stages ?? []).length || x.from > x.to) err('pitch:flow', `компонент ${x.component}: from/to вне этапов`);
    }
    for (const n of f.everyone ?? []) if (!nums.has(n)) err('pitch:flow', `everyone: компонент ${n} не описан`);
  }
  // Символы, которых нет в обычных шрифтах, в PDF превращаются в пробел или «?»
  const odd = JSON.stringify(pitch ?? {}).match(/[↔⇄→←✓✔★☆•]/g);
  if (odd) warn('pitch', `символы ${[...new Set(odd)].join(' ')} могут отсутствовать в шрифте PDF — замените словами или тире`);
  return out;
}
