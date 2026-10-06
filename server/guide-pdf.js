// Инструкции в PDF: текст на листах A4, схемы процессов — листами A3 из альбома.
//
// Содержание — данные из server/guides, схемы и разбор их шагов — из репозитория
// процессов, справочники — из кода каталога. Инструкция ничего не пересказывает
// своими словами, поэтому номер шага в ней совпадает с номером на схеме в портале,
// в туре и в альбоме.
import { PdfDoc, Canvas } from './pdf.js';
import { layout } from '../shared/bpmn/layout.js';
import { album } from './process-repo.js';
import { diagramSheets } from './bpmn-pdf.js';
import { roleTitle, DEFAULT_PERMISSIONS } from './auth.js';
import * as pr from './providers.js';
import { GUIDES } from './guides/providers-guide.js';

const A4 = { w: 595.28, h: 841.89 };
const M = { left: 56, right: 56, top: 64, bottom: 58 };
const W = A4.w - M.left - M.right;

const C = {
  text: '#141b28', text2: '#4a5568', text3: '#7c8798', brand: '#24508f', brandBg: '#eff5fd',
  border: '#dfe4ed', surface2: '#f4f6fa', warnBg: '#fdf0dd', warn: '#a8620a',
};
const T = { h1: 17, h2: 12.5, body: 10, small: 8.5, lh: 14.2 };

const DICTS = {
  statuses: () => Object.fromEntries(Object.entries(pr.PROVIDER_STATUS).map(([k, v]) => [k, v.title])),
  competencies: () => pr.COMPETENCIES,
  compliance: () => pr.COMPLIANCE,
  solution_kinds: () => pr.SOLUTION_KINDS,
  maturity: () => pr.MATURITY,
  note_kinds: () => pr.NOTE_KINDS,
};

// Пояснения к справочникам, которых нет в коде каталога: код хранит названия,
// а инструкции нужен ещё и смысл
const EXPLAIN = {
  statuses: {
    new: 'Упомянут, сведения только собираются.',
    screening: 'Идёт проверка: запрос информации, демонстрация, документы.',
    qualified: 'Проверен и может привлекаться к работе.',
    engaged: 'Выполняет или выполнял работу для ДТСЗН.',
    not_recommended: 'Проверка или совместная работа выявили риски.',
    archived: 'Неактуален; скрыт из списка, пока архив не выбран в фильтре.',
  },
  maturity: {
    prototype: 'Работает на тестовых данных, до внедрения нужна доработка.',
    pilot: 'Опробовано у одного или нескольких заказчиков.',
    production: 'Эксплуатируется, можно брать в работу без разработки.',
  },
};

const ROLE_TEXT = {
  provider_viewer: 'Смотрит карточки, портфолио, решения и технологии; подбирает, сравнивает, выгружает подборки.',
  provider_editor: 'Добавляет разработчиков, ведёт базовые сведения и журнал, оценивает работу, привязывает представителей и подтверждает их правки.',
  provider_manager: 'Всё то же, что модератор, а также выдаёт и отзывает доступ к каталогу и удаляет карточки.',
};

// ─────────────────────────────────────────────────────────────
// Вёрстка текста
// ─────────────────────────────────────────────────────────────
class Flow {
  constructor(doc) {
    this.doc = doc;
    this.pages = [];      // { kind: 'text', cv } | { kind: 'diagram', sheets }
    this.toc = [];        // { title, page }
    this.pending = [];    // листы схем, ждущие конца текущей страницы
    this.newPage();
  }
  get pageNo() { return this.pages.length; }
  newPage() {
    // Отложенные листы схем встают сразу за заполненной страницей текста
    for (const sheets of this.pending.splice(0)) {
      this.pages.push({ kind: 'diagram', sheets });
      for (let i = 1; i < sheets.count; i++) this.pages.push({ kind: 'skip' });
    }
    this.cv = new Canvas(this.doc);
    this.pages.push({ kind: 'text', cv: this.cv });
    this.y = A4.h - M.top;
  }
  ensure(h) { if (this.y - h < M.bottom) this.newPage(); }
  wrap(text, width, size, font = 'regular') {
    const out = [];
    for (const para of String(text).split('\n')) {
      let line = '';
      for (const w of para.split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${w}` : w;
        if (this.cv.textWidth(next, size, font) > width && line) { out.push(line); line = w; }
        else line = next;
      }
      out.push(line);
    }
    return out;
  }
  lines(lines, x, { size = T.body, font = 'regular', color = C.text, lh = T.lh } = {}) {
    for (const l of lines) {
      this.ensure(lh);
      this.cv.text(l, x, this.y - size, { size, font, color });
      this.y -= lh;
    }
  }

  h1(text, num) {
    // Раздел начинается с новой страницы, если от текущей осталось меньше трети
    if (this.y < A4.h * 0.36) this.newPage();
    else this.y -= 10;
    this.toc.push({ title: `${num}. ${text}`, page: this.pageNo });
    const lines = this.wrap(`${num}. ${text}`, W, T.h1, 'bold');
    this.ensure(lines.length * 22 + 20);
    this.cv.rgb(C.brand).rect(M.left, this.y - 3, 28, 3, 'f');
    this.y -= 12;
    this.lines(lines, M.left, { size: T.h1, font: 'bold', lh: 22 });
    this.y -= 6;
  }
  h2(text) {
    this.ensure(40);
    this.y -= 6;
    this.lines(this.wrap(text, W, T.h2, 'bold'), M.left, { size: T.h2, font: 'bold', lh: 17 });
    this.y -= 3;
  }
  p(text) {
    this.lines(this.wrap(text, W, T.body), M.left, { color: C.text2 });
    this.y -= 7;
  }
  list(items) {
    for (const it of items) {
      const lines = this.wrap(it, W - 16, T.body);
      this.ensure(Math.min(lines.length, 2) * T.lh);
      this.cv.text('•', M.left + 3, this.y - T.body, { size: T.body, color: C.brand, font: 'bold' });
      this.lines(lines, M.left + 16, { color: C.text2 });
      this.y -= 3;
    }
    this.y -= 5;
  }
  howto(items) {
    items.forEach((it, i) => {
      const lines = this.wrap(it, W - 26, T.body);
      this.ensure(Math.min(lines.length, 2) * T.lh + 2);
      this.cv.rgb(C.brandBg).circle(M.left + 8, this.y - T.body + 3.5, 8, 'f');
      this.cv.text(String(i + 1), M.left + 8, this.y - T.body + 0.5, { size: 8.5, font: 'bold', color: C.brand, align: 'center' });
      this.lines(lines, M.left + 26, { color: C.text });
      this.y -= 4;
    });
    this.y -= 5;
  }
  /** Шаг схемы: номер на плашке — тот же, что на фигуре схемы. */
  step(num, title, body) {
    const tl = this.wrap(title, W - 46, T.body, 'bold');
    const bl = this.wrap(body, W - 46, T.body - 0.5);
    this.ensure(tl.length * T.lh + Math.min(bl.length, 3) * 13);
    const nw = this.cv.textWidth(num, 8.5, 'bold') + 10;
    this.cv.rgb(C.brand).roundRect(M.left, this.y - T.body - 2.5, nw, 13, 2.5, 'f');
    this.cv.text(num, M.left + nw / 2, this.y - T.body + 0.5, { size: 8.5, font: 'bold', color: '#ffffff', align: 'center' });
    this.lines(tl, M.left + 46, { font: 'bold' });
    this.lines(bl, M.left + 46, { size: T.body - 0.5, color: C.text2, lh: 13 });
    this.y -= 7;
  }
  table(rows, { keyW = 150 } = {}) {
    for (const [k, v] of rows) {
      const kl = this.wrap(k, keyW - 10, T.body - 0.5, 'bold');
      const vl = this.wrap(v, W - keyW - 10, T.body - 0.5);
      const h = Math.max(kl.length, vl.length) * 13 + 10;
      this.ensure(h);
      this.cv.rgb(C.border, true).lineWidth(0.5);
      this.cv.polyline([[M.left, this.y], [M.left + W, this.y]], 'S');
      const top = this.y - 5;
      kl.forEach((l, i) => this.cv.text(l, M.left + 4, top - 9.5 - i * 13, { size: T.body - 0.5, font: 'bold', color: C.text }));
      vl.forEach((l, i) => this.cv.text(l, M.left + keyW, top - 9.5 - i * 13, { size: T.body - 0.5, color: C.text2 }));
      this.y -= h;
    }
    this.cv.rgb(C.border, true).lineWidth(0.5);
    this.cv.polyline([[M.left, this.y], [M.left + W, this.y]], 'S');
    this.y -= 12;
  }
  note(text) {
    const lines = this.wrap(text, W - 24, T.body - 0.5);
    const h = lines.length * 13 + 14;
    this.ensure(h);
    this.cv.rgb(C.warnBg).rect(M.left, this.y - h, W, h, 'f');
    this.cv.rgb(C.warn).rect(M.left, this.y - h, 3, h, 'f');
    lines.forEach((l, i) => this.cv.text(l, M.left + 14, this.y - 16 - i * 13, { size: T.body - 0.5, color: C.text }));
    this.y -= h + 12;
  }
  /**
   * Лист схемы встаёт после текущей страницы, а текст продолжается без разрыва —
   * иначе перед каждой схемой оставалась бы полупустая страница.
   */
  diagram(sheets, caption) {
    this.p(caption);
    this.pending.push(sheets);
  }
  /** Закрыть документ: дописать схемы, ждущие конца последней страницы. */
  finish() {
    const last = this.pages[this.pages.length - 1];
    this.newPage();
    // Пустая страница, открытая только ради сброса схем, не нужна
    this.pages.splice(this.pages.lastIndexOf(this.pages.find((p) => p.cv === this.cv)), 1);
    return last;
  }
}

// ─────────────────────────────────────────────────────────────
// Сборка
// ─────────────────────────────────────────────────────────────
export const guideFiles = () => Object.values(GUIDES).map((g) => ({ file: g.file, title: g.title, perm: g.perm }));
export const guideByFile = (file) => Object.values(GUIDES).find((g) => g.file === file) || null;

export function guidePdf(file) {
  const guide = guideByFile(file);
  if (!guide) return null;
  const all = album();
  const seqOf = (id) => all.findIndex((d) => d.id === id) + 1;
  const diagramOf = (id) => {
    const d = all.find((x) => x.id === id);
    if (!d) throw new Error(`Схема «${id}» отсутствует в альбоме процессов`);
    return d;
  };

  const doc = new PdfDoc({
    title: `Каталог разработчиков ИИ-решений. ${guide.title}`,
    subject: guide.audience,
  });

  // Титульная страница рисуется последней — ей нужны номера страниц разделов
  const flow = new Flow(doc);
  const titlePage = flow.cv;
  flow.newPage();

  guide.sections.forEach((section, si) => {
    flow.h1(section.h, si + 1);
    for (const b of section.blocks) {
      if (b.p) flow.p(b.p);
      else if (b.sub) flow.h2(b.sub);
      else if (b.list) flow.list(b.list);
      else if (b.howto) flow.howto(b.howto);
      else if (b.note) flow.note(b.note);
      else if (b.table) flow.table(b.table);
      else if (b.dict) {
        const dict = DICTS[b.dict]();
        const ex = EXPLAIN[b.dict] || {};
        flow.table(Object.entries(dict).map(([k, v]) => [v, ex[k] || '']).filter(([, v]) => v !== '' || !EXPLAIN[b.dict]),
          { keyW: EXPLAIN[b.dict] ? 170 : W });
      } else if (b.roles) {
        const rows = Object.entries(ROLE_TEXT).map(([code, text]) => {
          const perms = DEFAULT_PERMISSIONS[code] || [];
          return [roleTitle(code), `${text} Права: ${perms.join(', ')}.`];
        });
        if (b.withRepresentative) {
          rows.push(['Представитель разработчика', 'Учётная запись компании-поставщика, привязанная к её карточке. Заполняет технологический профиль, портфолио и решения своей компании; видит только её. Права: provider.self.']);
        }
        flow.table(rows, { keyW: 170 });
      } else if (b.completeness) {
        flow.table(pr.COMPLETENESS.map(([, weight, title]) => [title, `${weight}%`]), { keyW: 250 });
      } else if (b.diagram) {
        const d = diagramOf(b.diagram);
        const seq = seqOf(b.diagram);
        flow.diagram(diagramSheets(d, seq, { walkthrough: false }),
          `Схема процесса «${d.title}» (раздел ${seq} альбома процессов) приведена на отдельном листе формата A3 после этой страницы. Номера шагов ниже совпадают с номерами на схеме.`);
      } else if (b.walk) {
        const d = diagramOf(b.walk);
        const seq = seqOf(b.walk);
        const L = layout(d, seq);
        flow.h2(`Шаги процесса (раздел ${seq} альбома)`);
        for (const w of d.walkthrough || []) flow.step(L.boxes[w.node]?.num ?? '', w.title, w.body);
      }
    }
  });

  flow.finish();
  drawTitle(titlePage, guide, flow.toc);

  const total = flow.pages.length;
  flow.pages.forEach((pg, i) => {
    if (pg.kind === 'skip') return;
    if (pg.kind === 'diagram') { pg.sheets.render(doc, i + 1, total); return; }
    if (i > 0) drawChrome(pg.cv, guide, i + 1, total);
    doc.addPage(A4.w, A4.h, pg.cv.toString());
  });
  return doc.build();
}

function drawChrome(cv, guide, page, total) {
  cv.rgb(C.brand).rect(0, A4.h - 3, A4.w, 3, 'f');
  cv.text(`Каталог разработчиков ИИ-решений · ${guide.title}`, M.left, A4.h - 34, { size: 8, color: C.text3 });
  cv.rgb(C.border, true).lineWidth(0.5);
  cv.polyline([[M.left, 36], [A4.w - M.right, 36]], 'S');
  cv.text('Social1 — платформа системных инноваций ДТСЗН', M.left, 24, { size: 8, color: C.text3 });
  cv.text(`${page} из ${total}`, A4.w - M.right, 24, { size: 8, align: 'right', color: C.text3 });
}

function drawTitle(cv, guide, toc) {
  cv.rgb(C.brand).rect(0, A4.h - 190, A4.w, 190, 'f');
  cv.text('Social1', M.left, A4.h - 62, { size: 22, font: 'bold', color: '#ffffff' });
  cv.text('Платформа системных инноваций ДТСЗН', M.left, A4.h - 82, { size: 10.5, color: '#dde9f9' });
  cv.text('Каталог разработчиков ИИ-решений', M.left, A4.h - 138, { size: 22, font: 'bold', color: '#ffffff' });
  cv.text(guide.title, M.left, A4.h - 164, { size: 14, color: '#dde9f9' });

  let y = A4.h - 232;
  cv.text(guide.audience, M.left, y, { size: 11, color: C.text2 });
  y -= 40;
  cv.text('Содержание', M.left, y, { size: 13, font: 'bold', color: C.text });
  y -= 24;
  for (const t of toc) {
    cv.text(t.title, M.left, y, { size: 10.5, color: C.text });
    cv.text(String(t.page), A4.w - M.right, y, { size: 10.5, align: 'right', color: C.text3 });
    cv.rgb(C.border, true).lineWidth(0.4);
    cv.polyline([[M.left, y - 6], [A4.w - M.right, y - 6]], 'S');
    y -= 22;
  }
  y -= 16;
  const notes = [
    'Номера шагов вида «22.5» совпадают с номерами на схемах в разделе «Схемы процессов»',
    'портала, в интерактивном обучении и в альбоме схем — на них можно ссылаться в регламентах.',
  ];
  notes.forEach((n, i) => cv.text(n, M.left, y - i * 14, { size: 9, color: C.text3 }));
  cv.text(new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }),
    M.left, 40, { size: 9, color: C.text3 });
}
