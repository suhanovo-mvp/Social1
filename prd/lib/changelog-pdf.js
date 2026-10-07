// Release history in PDF — the same releases as the "Релизы" tab. Server-only.
// Wire it as exporters.changelogPdf in createPrdApi().
import { PdfDoc, Canvas } from './pdf.js';
import { CHANGE_TYPES } from './changelog.js';

const A4 = { w: 595.28, h: 841.89 };
const M = 42, CW = A4.w - 2 * M;
const INK = '#16161a', MUTED = '#6a6a75', LINE = '#dcdce3', ACCENT = '#5b3fd6';
const TONE = { good: '#15803d', accent: '#5b3fd6', warn: '#a15c07' };
const COL_TYPE = 74, COL_AREA = 112;
const fmt = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).replace(/\s*г\.$/, '');

/** data: { product, releases, index?, generatedAt } */
export function buildChangelogPdf({ product = {}, releases = [], generatedAt = new Date() }) {
  const title = `${product.title ?? 'Продукт'} — история релизов`;
  const doc = new PdfDoc({ title, subject: 'История релизов' });
  const pages = [];
  let cv, y;
  const newPage = () => { cv = new Canvas(doc); pages.push(cv); y = M; };
  const ensure = (h) => { if (y + h > A4.h - M - 16) newPage(); };
  const text = (s, x, size, o = {}) => cv.text(s, x, A4.h - y - size, { size, ...o });
  newPage();

  text(product.title ?? '', M, 9, { color: ACCENT, font: 'bold' }); y += 16;
  text('История релизов', M, 20, { font: 'bold' }); y += 30;
  text(`Версия ${releases[0]?.version ?? '—'} · ${releases.length} релизов · сформировано ${fmt(new Date(generatedAt).toISOString().slice(0, 10))}`, M, 9, { color: MUTED }); y += 22;

  for (const r of releases) {
    ensure(70);
    cv.rgb(ACCENT).rect(M, A4.h - y - 16, 3, 16, 'f');
    text(r.version, M + 10, 13, { font: 'bold', color: ACCENT });
    const vw = cv.textWidth(r.version, 13, 'bold');
    text(fmt(r.date), A4.w - M, 9, { color: MUTED, align: 'right' });
    cv.wrap(r.title, 13, CW - vw - 120, 'bold').forEach((line, i) => { if (i) y += 16; text(line, M + 20 + vw, 13, { font: 'bold' }); });
    y += 22;
    if (r.summary) for (const line of cv.wrap(r.summary, 9.5, CW)) { ensure(14); text(line, M, 9.5, { color: MUTED }); y += 13; }
    y += 4;
    for (const ch of r.changes ?? []) {
      const t = CHANGE_TYPES[ch.type] ?? { label: ch.type, tone: 'accent' };
      const body = cv.wrap(`${ch.text}${ch.refs?.length ? `  (${ch.refs.join(', ')})` : ''}`, 9, CW - COL_TYPE - COL_AREA);
      const area = cv.wrap(ch.area ?? '', 8.5, COL_AREA - 8, 'bold');
      const h = Math.max(body.length, area.length) * 12.5 + 6;
      ensure(h);
      cv.rgb(TONE[t.tone]).roundRect(M, A4.h - y - 12, COL_TYPE - 10, 13, 3, 'f');
      cv.text(t.label, M + (COL_TYPE - 10) / 2, A4.h - y - 9, { size: 7.5, color: '#ffffff', align: 'center', font: 'bold' });
      area.forEach((line, i) => cv.text(line, M + COL_TYPE, A4.h - y - 9 - i * 12.5, { size: 8.5, font: 'bold', color: INK }));
      body.forEach((line, i) => cv.text(line, M + COL_TYPE + COL_AREA, A4.h - y - 9 - i * 12.5, { size: 9, color: INK }));
      y += h;
    }
    y += 6;
    cv.rgb(LINE, true).lineWidth(0.5).polyline([[M, A4.h - y], [A4.w - M, A4.h - y]], 'S');
    y += 16;
  }

  pages.forEach((p, i) => {
    p.text(title, M, 20, { size: 7.5, color: MUTED });
    p.text(`стр. ${i + 1} из ${pages.length}`, A4.w - M, 20, { size: 7.5, color: MUTED, align: 'right' });
    doc.addPage(A4.w, A4.h, p.toString());
  });
  return doc.build();
}
