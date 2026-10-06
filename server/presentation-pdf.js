// Презентация о платформе в PDF: слайды 16:9, собираются в момент скачивания.
//
// Логика презентации: сначала — как компоненты работают вместе и чего с их
// помощью достигают, затем каждый компонент тремя слайдами: обзор со скриншотом,
// ключевые экраны, верхнеуровневая схема коллективной работы учреждений.
// Счётчиков записей из базы здесь нет намеренно — презентация о функциональности.
//
// Содержание — в presentation-deck.js, скриншоты — в assets/presentation.
// Типографика та же, что у схем процессов и инструкций: PT Sans, цвета портала.
import { readFileSync } from 'node:fs';
import { PdfDoc, Canvas } from './pdf.js';
import {
  PRODUCT, FLOW, GOALS, GOAL_STATEMENT, STAKEHOLDERS, PRINCIPLES, PARTIES, SECTIONS, COMPONENTS,
} from './presentation-deck.js';

const W = 960, H = 540;
const MX = 44;
const CW = W - MX * 2;
const C = {
  navy: '#12294c', brand: '#1b3a6b', brand2: '#24508f', brand3: '#2f66b5', brandLine: '#3d80d8',
  bg: '#eff5fd', tint: '#dde9f9', white: '#ffffff', onDark: '#a9bfda', onDark2: '#8fb9ea',
  text: '#141b28', text2: '#4a5568', text3: '#7c8798',
  line: '#dfe4ed', lineStrong: '#c4ccda', surf: '#f4f6fa', ok: '#1a7f52', okBg: '#e3f5ec',
};
const FOOT = 'Social1 — единая цифровая платформа управления реинжинирингом социальных процессов';

const today = () => new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const imagePath = (file) => new URL(`../assets/presentation/${file}.jpg`, import.meta.url);
const sectionTitle = (path) => SECTIONS.flatMap((g) => g.items).find((i) => i.path === path)?.title;

// ─────────────────────────────────────────────────────────────
// Помощники вёрстки. Координата top отсчитывается от верха слайда — так читать
// раскладку проще, чем в системе координат PDF с началом внизу.
// ─────────────────────────────────────────────────────────────
class Slide {
  constructor(doc) { this.doc = doc; this.cv = new Canvas(doc); }
  text(str, x, top, { size = 11, font = 'regular', color = C.text, align = 'left' } = {}) {
    this.cv.text(str, x, H - top - size * 0.8, { size, font, color, align });
  }
  box(x, top, w, h, color, radius = 0) {
    this.cv.rgb(color);
    if (radius) this.cv.roundRect(x, H - top - h, w, h, radius, 'f');
    else this.cv.rect(x, H - top - h, w, h, 'f');
  }
  frame(x, top, w, h, color, radius = 0, width = 0.8) {
    this.cv.rgb(color, true).lineWidth(width);
    if (radius) this.cv.roundRect(x, H - top - h, w, h, radius, 'S');
    else this.cv.rect(x, H - top - h, w, h, 'S');
  }
  line(x1, top1, x2, top2, color = C.line, width = 0.6) {
    this.cv.rgb(color, true).lineWidth(width);
    this.cv.polyline([[x1, H - top1], [x2, H - top2]], 'S');
  }
  poly(points, color) {
    this.cv.rgb(color);
    this.cv.poly(points.map(([x, t]) => [x, H - t]), 'f');
  }
  circle(cx, ctop, r, color) {
    this.cv.rgb(color);
    this.cv.circle(cx, H - ctop, r, 'f');
  }
  /** Ломаная со стрелкой на конце. Точки — [x, top]. */
  arrow(points, color = C.text3, width = 1) {
    this.cv.rgb(color, true).lineWidth(width);
    this.cv.polyline(points.map(([x, t]) => [x, H - t]), 'S');
    const [x2, t2] = points[points.length - 1];
    const [x1, t1] = points[points.length - 2];
    const a = Math.atan2(t2 - t1, x2 - x1), s = 5.5;
    this.poly([[x2, t2],
      [x2 - s * Math.cos(a - 0.45), t2 - s * Math.sin(a - 0.45)],
      [x2 - s * Math.cos(a + 0.45), t2 - s * Math.sin(a + 0.45)]], color);
  }
  wrap(text, width, size, font = 'regular') {
    const lines = [];
    let line = '';
    for (const w of String(text).split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${w}` : w;
      if (this.cv.textWidth(next, size, font) > width && line) { lines.push(line); line = w; }
      else line = next;
    }
    if (line) lines.push(line);
    return lines;
  }
  /**
   * Абзац, который обязан уместиться в maxLines: кегль уменьшается, пока текст не
   * влезет. Возвращает нижнюю границу абзаца.
   */
  para(text, x, top, width, { size = 11, lh = 1.38, maxLines = 99, font = 'regular', color = C.text2,
    min = 7.5, align = 'left' } = {}) {
    let s = size;
    let lines = this.wrap(text, width, s, font);
    while (lines.length > maxLines && s > min) { s -= 0.5; lines = this.wrap(text, width, s, font); }
    const ax = align === 'center' ? x + width / 2 : x;
    lines.slice(0, maxLines).forEach((l, i) => this.text(l, ax, top + i * s * lh, { size: s, font, color, align }));
    return top + Math.min(lines.length, maxLines) * s * lh;
  }
  /** Кегль, при котором строка помещается в ширину. */
  fit(str, width, size, font = 'bold', min = 12) {
    let s = size;
    while (s > min && this.cv.textWidth(str, s, font) > width) s -= 0.5;
    return s;
  }
  label(str, x, top, color = C.brand2, align = 'left') {
    this.text(str.toUpperCase(), x, top, { size: 8, font: 'bold', color, align });
  }
  /** Круглая фотография с центром (cx, ctop) и радиусом r; без файла — пропускается. */
  photo(file, cx, ctop, r) {
    let img;
    try {
      const cache = this.doc.shotCache || (this.doc.shotCache = new Map());
      if (!cache.has(file)) cache.set(file, this.doc.addJpeg(readFileSync(imagePath(file))));
      img = cache.get(file);
    } catch { return false; }
    this.circle(cx, ctop, r + 2, C.white);
    this.cv.save();
    this.cv.circle(cx, H - ctop, r, 'W n');
    this.cv.image(img, cx - r, H - ctop - r, r * 2, r * 2);
    this.cv.restore();
    return true;
  }
  /** Скриншот в скруглённой рамке с тенью; кадр вписывается по ширине. */
  screenshot(file, x, top, w, h) {
    const cache = this.doc.shotCache || (this.doc.shotCache = new Map());
    if (!cache.has(file)) cache.set(file, this.doc.addJpeg(readFileSync(imagePath(file))));
    const img = cache.get(file);
    // Кадр вписывается целиком: пропорции исходника сохраняются
    const k = Math.min(w / img.width, h / img.height);
    const iw = img.width * k, ih = img.height * k;
    const ix = x + (w - iw) / 2, itop = top;
    this.box(ix + 1.5, itop + 2.5, iw, ih, '#d7deea', 7);
    this.cv.save();
    this.cv.roundRect(ix, H - itop - ih, iw, ih, 6, 'W n');
    this.cv.image(img, ix, H - itop - ih, iw, ih);
    this.cv.restore();
    this.frame(ix, itop, iw, ih, C.lineStrong, 6, 0.7);
    return { x: ix, top: itop, w: iw, h: ih };
  }
}

/** Шапка и подвал обычного слайда. */
function chrome(sl, { title, kicker, page, total }) {
  sl.box(0, 0, W, 4, C.brand2);
  sl.label(kicker, MX, 24, C.brandLine);
  sl.text(title, MX, 38, { size: sl.fit(title, CW, 22, 'bold', 15), font: 'bold', color: C.text });
  sl.line(MX, H - 30, W - MX, H - 30);
  sl.text(FOOT, MX, H - 22, { size: 8, color: C.text3 });
  sl.text(`${page} / ${total}`, W - MX, H - 22, { size: 8, color: C.text3, align: 'right' });
}

const componentNo = (c) => COMPONENTS.indexOf(c) + 1;

// ─────────────────────────────────────────────────────────────
// Вводная часть
// ─────────────────────────────────────────────────────────────
function cover(sl) {
  sl.box(0, 0, W, H, C.navy);
  sl.circle(W - 70, 40, 250, '#1a3358');
  sl.circle(W - 190, H + 40, 170, '#162f53');
  sl.box(MX, 36, 34, 34, C.white, 7);
  sl.text('S1', MX + 17, 46, { size: 13, font: 'bold', color: C.navy, align: 'center' });
  sl.text(PRODUCT.name, MX + 46, 44, { size: 18, font: 'bold', color: C.white });
  sl.label(PRODUCT.owner, MX, 88, C.onDark2);

  // Название концепции
  const t = sl.wrap(PRODUCT.title, 760, 27, 'bold');
  t.forEach((l, i) => sl.text(l, MX, 112 + i * 34, { size: 27, font: 'bold', color: C.white }));
  const leadTop = 112 + t.length * 34 + 10;
  const leadEnd = sl.para(PRODUCT.lead, MX, leadTop, 720, { size: 11.5, lh: 1.45, color: '#c3d3e8', maxLines: 3 });

  // Компоненты — строка «плашек», переносится по ширине
  let x = MX, top = leadEnd + 14;
  for (const c of COMPONENTS) {
    const label = `${componentNo(c)} · ${c.title}`;
    const w = sl.cv.textWidth(label, 8.5, 'bold') + 16;
    if (x + w > W - MX) { x = MX; top += 23; }
    sl.box(x, top, w, 18, '#244069', 9);
    sl.text(label, x + 8, top + 5, { size: 8.5, font: 'bold', color: '#dfe8f5' });
    x += w + 5;
  }

  // Автор концепции — всегда на титуле
  const a = PRODUCT.author, at = 404, r = 34;
  sl.line(MX, at - 14, W - MX, at - 14, '#2d4a74', 0.8);
  const photo = sl.photo(a.photo, MX + r, at + r, r);
  const tx = photo ? MX + r * 2 + 18 : MX;
  sl.label(a.label, tx, at + 2, '#f08a6c');
  sl.text(a.name, tx, at + 16, { size: 17, font: 'bold', color: C.white });
  sl.para(a.position, tx, at + 42, W - MX - tx, { size: 9.5, color: '#c3d3e8', maxLines: 1, min: 8 });
  sl.para(a.credentials, tx, at + 56, W - MX - tx, { size: 9.5, color: '#c3d3e8', maxLines: 2, min: 8 });
  sl.text(`Версия от ${today()}`, W - MX, H - 22, { size: 8.5, color: C.onDark, align: 'right' });
}

/** Как компоненты работают вместе: конвейер в центре, над ним — входы, под ним — закрепление результата. */
function interaction(sl) {
  sl.para('Компоненты передают работу друг другу. В центре — путь проблемы до внедрённого решения; '
    + 'сверху — то, что его питает, снизу — то, что закрепляет результат для всех учреждений.',
  MX, 62, CW, { size: 10.5, maxLines: 2 });

  const gap = 10, sw = (CW - gap * 4) / 5, rowTop = 214, rowH = 58;
  const colX = (i) => MX + i * (sw + gap);
  // Конвейер шевронами
  FLOW.forEach(([name, hint], i) => {
    const x = colX(i), tip = 12, last = i === FLOW.length - 1;
    const pts = [[x, rowTop], [x + sw + (last ? 0 : tip - 2), rowTop], [x + sw + (last ? 0 : tip + 8), rowTop + rowH / 2],
      [x + sw + (last ? 0 : tip - 2), rowTop + rowH], [x, rowTop + rowH]];
    if (i) pts.push([x + tip, rowTop + rowH / 2]);
    sl.poly(pts, last ? C.brand2 : C.tint);
    sl.text(name, x + (i ? 22 : 12), rowTop + 13, { size: 12, font: 'bold', color: last ? C.white : C.navy });
    sl.text(hint, x + (i ? 22 : 12), rowTop + 32, { size: 8.5, color: last ? C.tint : C.text2 });
  });

  const byId = (id) => COMPONENTS.find((c) => c.id === id);
  const card = (id, from, to, top, h, note, dark = false) => {
    const c = byId(id);
    const x = colX(from), w = colX(to) + sw - x;
    sl.box(x, top, w, h, dark ? C.navy : C.white, 6);
    if (!dark) sl.frame(x, top, w, h, C.line, 6);
    sl.circle(x + 15, top + 15, 8, dark ? C.onDark2 : C.brand3);
    sl.text(String(componentNo(c)), x + 15, top + 11, { size: 8.5, font: 'bold', color: dark ? C.navy : C.white, align: 'center' });
    sl.para(c.title, x + 29, top + 9, w - 38, { size: 10.5, font: 'bold', color: dark ? C.white : C.text, maxLines: 2, min: 8.5, lh: 1.2 });
    sl.para(note, x + 10, top + h - 26, w - 20, { size: 8.5, color: dark ? C.onDark : C.text2, maxLines: 2, lh: 1.25 });
    return { x, w, top, h };
  };
  // Сверху — входы
  const up = [
    card('ideas', 0, 1, 100, 72, 'Проблемы и решения коллег со всех учреждений'),
    card('forms', 2, 2, 100, 72, 'Сведения от учреждений'),
    card('catalog', 3, 3, 100, 72, 'Исполнители и готовые практики'),
    card('knowledge', 4, 4, 100, 72, 'Решения с обоснованием'),
  ];
  const into = [[0.5, 0], [2, 2], [3, 3], [4, 4]];
  up.forEach((u, i) => {
    const cx = u.x + u.w / 2;
    sl.arrow([[cx, u.top + u.h + 2], [cx, rowTop - 4]], C.brandLine, 1.1);
    void into[i];
  });
  // Снизу — закрепление
  const down = [
    card('rating', 0, 1, 300, 66, 'Признание вклада советников'),
    card('lifecycle', 2, 3, 300, 66, 'Точки решений, прототип, пилот, масштаб'),
    card('processes', 4, 4, 300, 66, 'Новый регламент для всех', true),
  ];
  down.forEach((d) => {
    const cx = d.x + d.w / 2;
    sl.arrow([[cx, rowTop + rowH + 4], [cx, d.top - 2]], C.brandLine, 1.1);
  });
  // Контур замыкается: новый регламент возвращается в начало конвейера
  const pr = down[2], loopTop = pr.top + pr.h + 12;
  sl.cv.rgb(C.brand2, true).lineWidth(1.2);
  sl.cv.polyline([[pr.x + pr.w / 2, H - (pr.top + pr.h + 2)], [pr.x + pr.w / 2, H - loopTop],
    [MX - 14, H - loopTop], [MX - 14, H - (rowTop + rowH / 2)]], 'S');
  sl.arrow([[MX - 14, rowTop + rowH / 2], [MX - 2, rowTop + rowH / 2]], C.brand2, 1.2);
  sl.text('Опубликованный регламент пересобирает конвейер — контур замыкается', MX + 6, loopTop + 5,
    { size: 8.5, font: 'bold', color: C.brand2 });

  // Основание — у каждого участника
  const bt = 408;
  sl.box(MX, bt, CW, 64, C.bg, 6);
  sl.label('У каждого участника', MX + 14, bt + 11, C.brand2);
  const base = ['workspace', 'tours', 'album', 'analytics', 'admin'].map(byId);
  const bw = (CW - 28 - 4 * 8) / 5;
  base.forEach((c, i) => {
    const x = MX + 14 + i * (bw + 8);
    sl.box(x, bt + 26, bw, 28, C.white, 5);
    sl.circle(x + 12, bt + 40, 7, C.brand3);
    sl.text(String(componentNo(c)), x + 12, bt + 36.5, { size: 8, font: 'bold', color: C.white, align: 'center' });
    sl.para(c.title, x + 24, bt + 31, bw - 30, { size: 8.5, font: 'bold', color: C.text, maxLines: 2, min: 7, lh: 1.15 });
  });
}

function goals(sl) {
  const cols = 3, gap = 14, cw = (CW - gap * (cols - 1)) / cols, ch = 142;
  GOALS.forEach(([title, body], i) => {
    const x = MX + (i % cols) * (cw + gap), top = 70 + Math.floor(i / cols) * (ch + 12);
    sl.box(x, top, cw, ch, C.surf, 6);
    sl.text(String(i + 1).padStart(2, '0'), x + 16, top + 16, { size: 20, font: 'bold', color: C.brandLine });
    const bt = sl.para(title, x + 16, top + 48, cw - 32, { size: 13, font: 'bold', color: C.text, maxLines: 2, lh: 1.22 });
    sl.para(body, x + 16, bt + 8, cw - 32, { size: 10, maxLines: 4, lh: 1.38 });
  });
  sl.box(MX, 386, CW, 84, C.navy, 6);
  sl.text(GOAL_STATEMENT[0], MX + 26, 406, { size: 19, font: 'bold', color: C.white });
  sl.text(GOAL_STATEMENT[1], MX + 26, 434, { size: 19, font: 'bold', color: C.onDark2 });
}

function participants(sl) {
  sl.para('Платформа соединяет учреждения между собой и с Департаментом: проблему замечают в одном месте, '
    + 'решение находят в другом, проверяют в третьем и тиражируют во все. На схемах компонентов участники '
    + 'обозначены этими цветами.', MX, 64, CW, { size: 11, maxLines: 2 });
  const cols = 3, gap = 14, cw = (CW - gap * (cols - 1)) / cols, ch = 118;
  STAKEHOLDERS.forEach(([title, party, body], i) => {
    const p = PARTIES[party];
    const x = MX + (i % cols) * (cw + gap), top = 112 + Math.floor(i / cols) * (ch + 14);
    sl.box(x, top, cw, ch, C.white, 6);
    sl.frame(x, top, cw, ch, C.line, 6);
    sl.circle(x + 20, top + 22, 7, p.color);
    sl.text(title, x + 34, top + 16, { size: 12.5, font: 'bold', color: C.text });
    sl.label(p.title, x + 34, top + 34, p.color);
    sl.para(body, x + 16, top + 56, cw - 32, { size: 10.5, maxLines: 4, lh: 1.4 });
  });
  // Легенда платформы — единственный «участник» без людей
  const pf = PARTIES.platform;
  sl.circle(MX + 7, 386, 5, pf.color);
  sl.para(`${pf.title} — ${pf.sub}: маршрутизация, сроки, уведомления, подсказки. `
    + 'Роли и права каждого участника настраиваются в данных, без изменения кода.', MX + 18, 381, CW - 18, { size: 10, maxLines: 2 });
}

function componentsMap(sl) {
  const cols = 4, gap = 12, cw = (CW - gap * (cols - 1)) / cols, ch = 128;
  COMPONENTS.forEach((c, i) => {
    const x = MX + (i % cols) * (cw + gap), top = 62 + Math.floor(i / cols) * (ch + 10);
    sl.box(x, top, cw, ch, i < 9 ? C.surf : C.white, 6);
    if (i >= 9) sl.frame(x, top, cw, ch, C.line, 6);
    sl.text(String(i + 1).padStart(2, '0'), x + 14, top + 13, { size: 15, font: 'bold', color: C.brandLine });
    const bt = sl.para(c.title, x + 14, top + 38, cw - 28, { size: 11, font: 'bold', color: C.text, maxLines: 2, lh: 1.2, min: 9 });
    sl.para(c.lead, x + 14, bt + 6, cw - 28, { size: 8.5, maxLines: 5, lh: 1.32, min: 7.5 });
  });
}

// ─────────────────────────────────────────────────────────────
// Компонент: обзор, ключевые экраны, схема
// ─────────────────────────────────────────────────────────────
function componentOverview(sl, c) {
  const LW = 276;
  let top = sl.para(c.lead, MX, 66, LW, { size: 12, lh: 1.4, color: C.text, maxLines: 6 });
  top += 16;
  sl.label('Возможности', MX, top);
  top += 16;
  for (const f of c.features) {
    sl.box(MX, top + 4, 4, 4, C.brandLine, 2);
    top = sl.para(f, MX + 12, top, LW - 12, { size: 9.5, maxLines: 2, lh: 1.32, min: 8 }) + 6;
  }
  const rt = Math.max(top + 8, 430);
  sl.label('Кто работает', MX, rt);
  sl.para(c.roles, MX, rt + 14, LW, { size: 9, maxLines: 2, color: C.text });

  const x = MX + LW + 22, w = W - MX - x;
  const s = c.screens[0];
  const box = sl.screenshot(s.file, x, 66, w, 372);
  sl.para(s.caption, box.x, box.top + box.h + 10, box.w, { size: 9.5, color: C.text3, maxLines: 2 });
  const sections = [...new Set(c.paths.map(sectionTitle).filter(Boolean))];
  if (sections.length) {
    sl.text(`Разделы портала: ${sections.join(' · ')}`, W - MX, H - 44, { size: 8.5, color: C.text3, align: 'right' });
  }
}

function componentScreens(sl, c) {
  const shots = c.screens.slice(1, 3);
  if (shots.length === 1) {
    const s = shots[0];
    const box = sl.screenshot(s.file, MX, 66, 610, 390);
    const rx = box.x + box.w + 24, rw = W - MX - rx;
    sl.label('На экране', rx, 72);
    sl.para(s.caption, rx, 90, rw, { size: 14, font: 'bold', color: C.text, maxLines: 5, lh: 1.3 });
    sl.label('Кто работает', rx, 250);
    sl.para(c.roles, rx, 266, rw, { size: 10, maxLines: 4, color: C.text2 });
    return;
  }
  const gap = 20, w = (CW - gap) / 2, ih = w / 1.6;
  const top0 = 62 + Math.max(0, (H - 44 - 62 - ih - 60) / 2);
  shots.forEach((s, i) => {
    const x = MX + i * (w + gap);
    const box = sl.screenshot(s.file, x, top0, w, ih);
    sl.circle(x + 9, box.top + box.h + 22, 9, C.brand3);
    sl.text(String(i + 1), x + 9, box.top + box.h + 17.5, { size: 9, font: 'bold', color: C.white, align: 'center' });
    sl.para(s.caption, x + 26, box.top + box.h + 15, w - 26, { size: 11.5, font: 'bold', color: C.text, maxLines: 3, lh: 1.3 });
  });
}

/**
 * Верхнеуровневая схема: дорожки участников по строкам, шаги по колонкам.
 * Связи идут ортогонально через промежутки между колонками; излом выбирается так,
 * чтобы линия не проходила через чужие шаги.
 */
function componentScheme(sl, c) {
  const sc = c.scheme;
  const lanes = sc.lanes;
  const areaTop = 60, areaBottom = 426, labelW = 132;
  const laneH = Math.min(120, (areaBottom - areaTop) / lanes.length);
  const cols = Math.max(...sc.steps.map((s) => s.col)) + 1;
  const gx = MX + labelW + 8, colW = (W - MX - gx) / cols, pad = Math.min(12, colW * 0.1);
  const boxH = Math.min(66, laneH - 18);

  lanes.forEach((key, i) => {
    const p = PARTIES[key], top = areaTop + i * laneH;
    sl.box(MX, top, CW, laneH - 4, i % 2 ? C.white : C.surf, 4);
    sl.box(MX, top, 3, laneH - 4, p.color);
    sl.para(p.title, MX + 12, top + laneH / 2 - 16, labelW - 16, { size: 10.5, font: 'bold', color: p.color, maxLines: 1, min: 8 });
    sl.para(p.sub, MX + 12, top + laneH / 2 - 1, labelW - 16, { size: 8, color: C.text3, maxLines: 2, lh: 1.2 });
  });

  const geo = new Map();
  sc.steps.forEach((s) => {
    const li = lanes.indexOf(s.lane);
    const x = gx + s.col * colW + pad / 2, w = colW - pad;
    const top = areaTop + li * laneH + (laneH - 4 - boxH) / 2;
    geo.set(s.id, { x, w, top, h: boxH, lane: li, col: s.col, cy: top + boxH / 2 });
  });
  const hits = (x1, x2, t, except) => [...geo.entries()].some(([id, g]) => !except.includes(id)
    && t > g.top - 2 && t < g.top + g.h + 2 && Math.max(x1, x2) > g.x && Math.min(x1, x2) < g.x + g.w);

  // Сначала связи — под шагами
  for (const [from, to] of sc.links) {
    const a = geo.get(from), b = geo.get(to);
    if (a.col === b.col) {
      const cx = a.x + a.w / 2 + (a.lane < b.lane ? 8 : -8);
      const [t1, t2] = a.lane < b.lane ? [a.top + a.h, b.top] : [a.top, b.top + b.h];
      sl.arrow([[cx, t1], [cx, t2 + (a.lane < b.lane ? -1 : 1)]], C.text3, 0.9);
      continue;
    }
    const x1 = a.x + a.w, x2 = b.x - 1;
    if (a.lane === b.lane) { sl.arrow([[x1, a.cy], [x2, b.cy]], C.text3, 0.9); continue; }
    const early = x1 + pad / 2, late = x2 - pad / 2 + 1;
    const xm = !hits(early, x2, b.cy, [from, to]) ? early : late;
    sl.arrow([[x1, a.cy], [xm, a.cy], [xm, b.cy], [x2, b.cy]], C.text3, 0.9);
  }
  sc.steps.forEach((s, i) => {
    const g = geo.get(s.id), color = PARTIES[s.lane].color;
    sl.box(g.x, g.top, g.w, g.h, C.white, 5);
    sl.frame(g.x, g.top, g.w, g.h, color, 5, 1);
    const lines = sl.wrap(s.text, g.w - 14, 8.8);
    const size = lines.length > 4 ? 8 : 8.8;
    const ls = sl.wrap(s.text, g.w - 14, size).slice(0, 4);
    const lh = size * 1.24, t0 = g.cy - (ls.length * lh) / 2 + 1;
    ls.forEach((l, k) => sl.text(l, g.x + g.w / 2, t0 + k * lh, { size, color: C.text, align: 'center' }));
    sl.circle(g.x + 2, g.top + 2, 7.5, color);
    sl.text(String(i + 1), g.x + 2, g.top - 1.5, { size: 7.5, font: 'bold', color: C.white, align: 'center' });
  });

  const rt = 438;
  sl.box(MX, rt, CW, 50, C.okBg, 6);
  sl.label('Результат', MX + 14, rt + 12, C.ok);
  sl.para(sc.result, MX + 100, rt + 10, CW - 116, { size: 11, color: C.text, maxLines: 2, lh: 1.35 });
}

function finale(sl) {
  sl.box(0, 0, W, H, C.navy);
  sl.circle(W - 60, H - 30, 230, '#1a3358');
  sl.label('Итог', MX, 60, C.onDark2);
  sl.text('Один контур вместо переписки', MX, 78, { size: 30, font: 'bold', color: C.white });
  sl.para(PRODUCT.lead, MX, 124, 640, { size: 12, color: '#c3d3e8', maxLines: 3, lh: 1.45 });
  const gap = 16, cw = (CW - gap * 3) / 4;
  PRINCIPLES.forEach(([title, body], i) => {
    const x = MX + i * (cw + gap), top = 228;
    sl.box(x, top, cw, 150, '#1c355c', 6);
    sl.text(String(i + 1).padStart(2, '0'), x + 16, top + 16, { size: 18, font: 'bold', color: C.onDark2 });
    const bt = sl.para(title, x + 16, top + 48, cw - 32, { size: 13, font: 'bold', color: C.white, maxLines: 2, lh: 1.2 });
    sl.para(body, x + 16, bt + 8, cw - 32, { size: 10, color: C.onDark, maxLines: 4, lh: 1.4 });
  });
  sl.text(GOAL_STATEMENT[0], MX, 414, { size: 16, font: 'bold', color: C.white });
  sl.text(GOAL_STATEMENT[1], MX, 438, { size: 16, font: 'bold', color: C.onDark2 });
  sl.text(`Social1 · версия от ${today()}`, W - MX, H - 28, { size: 9, color: C.onDark, align: 'right' });
}

// ─────────────────────────────────────────────────────────────
// Порядок слайдов. Проверяется тестом: вводные слайды идут первыми, у каждого
// компонента — обзор, ключевые экраны и схема именно в этом порядке.
// ─────────────────────────────────────────────────────────────
export const SLIDES = [
  { id: 'cover', bare: true, render: cover },
  { id: 'interaction', kicker: 'Принцип работы', title: 'Как компоненты работают вместе', render: interaction },
  { id: 'goals', kicker: 'Цели', title: 'Чего достигаем с помощью платформы', render: goals },
  { id: 'participants', kicker: 'Совместная работа', title: 'Кто работает на платформе вместе', render: participants },
  { id: 'components', kicker: 'Состав платформы', title: `${COMPONENTS.length} компонентов платформы`, render: componentsMap },
  ...COMPONENTS.flatMap((c, i) => {
    const kick = `Компонент ${i + 1} из ${COMPONENTS.length}`;
    return [
      { id: `c-${c.id}`, kicker: kick, title: c.title, render: (sl) => componentOverview(sl, c) },
      { id: `c-${c.id}-screens`, kicker: `${kick} · ключевые экраны`, title: c.title, render: (sl) => componentScreens(sl, c) },
      { id: `c-${c.id}-scheme`, kicker: `${kick} · схема совместной работы`, title: c.scheme.title,
        render: (sl) => componentScheme(sl, c) },
    ];
  }),
  { id: 'finale', bare: true, render: finale },
];

export function presentationPdf() {
  const doc = new PdfDoc({
    title: `Social1 — ${PRODUCT.title}`,
    author: PRODUCT.author.name,
    subject: `Автор концепции — ${PRODUCT.author.name}. Принципы, цели и компоненты платформы. Версия от ${today()}`,
  });
  const total = SLIDES.length;
  SLIDES.forEach((s, i) => {
    const sl = new Slide(doc);
    if (!s.bare) chrome(sl, { title: s.title, kicker: s.kicker, page: i + 1, total });
    s.render(sl);
    doc.addPage(W, H, sl.cv.toString());
  });
  return doc.build();
}
