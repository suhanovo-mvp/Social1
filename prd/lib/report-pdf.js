// PRD status report in PDF: the same selection the page shows (same filters, same
// counts — both come from prd-core.js), with every reviewer's verdict and comment.
// Server-only. Wire it as exporters.reportPdf in createPrdApi().
//
// Status markers are drawn as shapes: ✅❌⚠️ are emoji, text fonts do not contain
// them, and the PDF would silently show blanks where the verdicts should be.
import { PdfDoc, Canvas } from './pdf.js';
import * as core from './prd-core.js';

const A4 = { w: 595.28, h: 841.89 };
const M = 40;
const CW = A4.w - 2 * M;
const INK = '#16161a', MUTED = '#6a6a75', LINE = '#dcdce3', ACCENT = '#5b3fd6';
const TONE = { good: '#15803d', warn: '#b45309', bad: '#b91c1c', muted: '#8a8a94' };
const BAR = { verified: '#16a34a', manual: '#4ade80', partial: '#f59e0b', missing: '#ef4444', failing: '#991b1b', unverified: '#a1a1aa' };

const fmt = (d) => new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).replace(/\s*г\.$/, '');

/** Vector status marker centred at (cx, cy) in PDF coordinates. */
export function drawMarker(cv, status, cx, cy, r = 5.5) {
  const fill = { verified: '#15803d', manual: '#15803d', partial: '#d97706', missing: '#b91c1c', failing: '#7f1d1d', unverified: '#9a9aa5' }[status] ?? '#9a9aa5';
  cv.save();
  if (status === 'manual') { cv.rgb('#ffffff').circle(cx, cy, r, 'f'); cv.rgb(fill, true).lineWidth(1.2).circle(cx, cy, r - 0.6, 'S'); }
  else cv.rgb(fill).circle(cx, cy, r, 'f');
  const ink = status === 'manual' ? fill : '#ffffff';
  cv.rgb(ink, true).lineWidth(1.4);
  if (status === 'verified' || status === 'manual') cv.polyline([[cx - r * 0.45, cy], [cx - r * 0.1, cy - r * 0.38], [cx + r * 0.5, cy + r * 0.4]], 'S');
  else if (status === 'missing') { cv.polyline([[cx - r * 0.4, cy - r * 0.4], [cx + r * 0.4, cy + r * 0.4]], 'S'); cv.polyline([[cx - r * 0.4, cy + r * 0.4], [cx + r * 0.4, cy - r * 0.4]], 'S'); }
  else if (status === 'partial') cv.polyline([[cx - r * 0.45, cy], [cx + r * 0.45, cy]], 'S');
  else if (status === 'failing') { cv.polyline([[cx, cy + r * 0.5], [cx, cy - r * 0.1]], 'S'); cv.rgb('#ffffff').circle(cx, cy - r * 0.42, 0.7, 'f'); }
  else cv.text('?', cx, cy - r * 0.45, { size: r * 1.35, align: 'center', color: '#ffffff', font: 'bold' });
  cv.restore();
}

/** Page flow: a y cursor from the top and automatic page breaks. */
class Flow {
  constructor(doc, { title, generatedAt }) {
    this.doc = doc; this.pages = []; this.title = title; this.generatedAt = generatedAt;
    this.newPage();
  }
  newPage() {
    this.cv = new Canvas(this.doc);
    this.pages.push(this.cv);
    this.y = M;
  }
  ensure(h) { if (this.y + h > A4.h - M - 18) this.newPage(); }
  py(y = this.y) { return A4.h - y; }
  text(str, x, size, opts = {}) { this.cv.text(str, x, this.py(this.y + size), { size, ...opts }); }
  /** Wrapped paragraph; returns height used. */
  para(str, x, width, size, opts = {}, lead = 1.32) {
    const lines = this.cv.wrap(str, size, width, opts.font);
    for (const line of lines) {
      this.ensure(size * lead);
      this.text(line, x, size, opts);
      this.y += size * lead;
    }
    return lines.length * size * lead;
  }
  finish() {
    const total = this.pages.length;
    this.pages.forEach((cv, i) => {
      cv.rgb(LINE, true).lineWidth(0.5).polyline([[M, 30], [A4.w - M, 30]], 'S');
      cv.text(this.title, M, 18, { size: 7.5, color: MUTED });
      cv.text(`${fmt(this.generatedAt)} · стр. ${i + 1} из ${total}`, A4.w - M, 18, { size: 7.5, color: MUTED, align: 'right' });
      this.doc.addPage(A4.w, A4.h, cv.toString());
    });
  }
}

function names(list) { return list.map((x) => (typeof x === 'string' ? x : x.name)).join(', '); }

/**
 * data: { product, index, entries, statusOf, reviews, filterLabels, campaign, tests, generatedAt }
 * (exactly what prd-server.js passes to exporters.reportPdf)
 */
export function buildReportPdf(data) {
  const { product = {}, index, entries, statusOf, reviews, filterLabels = [], campaign = null, tests = null } = data;
  const generatedAt = data.generatedAt ?? new Date();
  const title = `${product.title ?? 'PRD'} — статус реализации требований`;
  const doc = new PdfDoc({ title, subject: 'Статус реализации PRD с учётом рецензий' });
  const f = new Flow(doc, { title, generatedAt });

  // ── Шапка ──
  f.text(product.title ?? 'PRD', M, 9, { color: ACCENT, font: 'bold' }); f.y += 14;
  f.para(campaign ? `Раунд рецензирования: ${campaign.title}` : 'Статус реализации требований', M, CW, 19, { font: 'bold' });
  f.y += 2;
  f.para([`Сформировано ${fmt(generatedAt)}`, product.version ? `версия ${product.version}` : null,
    tests?.generatedAt ? `автотесты от ${fmt(tests.generatedAt)}` : 'без результатов автотестов'].filter(Boolean).join(' · '), M, CW, 9, { color: MUTED });
  if (filterLabels.length) f.para(`Фильтры: ${filterLabels.join(' · ')}`, M, CW, 9, { color: MUTED });
  if (campaign) f.para(`Охват раунда: ${campaign.keys.length} критериев${campaign.deadline ? ` · срок ${fmt(campaign.deadline)}` : ''}${campaign.closedAt ? ` · закрыт ${fmt(campaign.closedAt)}` : ''}`, M, CW, 9, { color: MUTED });
  f.y += 10;

  // ── Сводка ──
  const keys = core.entryKeys(entries).filter((k) => !index.criteria.get(k)?.retired);
  const s = core.summarize(keys, statusOf);
  let agreed = 0, disagreed = 0, disputed = 0, none = 0;
  for (const k of keys) {
    if (core.matchesReview('agreed', k, reviews)) agreed += 1;
    if (core.matchesReview('disagreed', k, reviews)) disagreed += 1;
    if (core.matchesReview('disputed', k, reviews)) disputed += 1;
    if (core.matchesReview('none', k, reviews)) none += 1;
  }
  const boxTop = f.y;
  f.cv.rgb('#f6f6f9').roundRect(M, f.py(boxTop + 92), CW, 92, 8, 'f');
  f.y += 12;
  f.text(`Реализовано ${s.implemented} из ${s.total} критериев — ${s.percent} %`, M + 14, 13, { font: 'bold' });
  f.y += 22;
  let bx = M + 14;
  const bw = CW - 28;
  for (const st of core.STATUS_ORDER) {
    if (!s.byStatus[st]) continue;
    const w = (s.byStatus[st] / s.total) * bw;
    f.cv.rgb(BAR[st]).rect(bx, f.py(f.y + 7), w, 7, 'f');
    bx += w;
  }
  f.y += 18;
  const legend = core.STATUS_ORDER.filter((st) => s.byStatus[st]);
  let lx = M + 14;
  for (const st of legend) {
    drawMarker(f.cv, st, lx + 5, f.py(f.y + 5), 4.5);
    const label = `${core.STATUS[st].label}: ${s.byStatus[st]}`;
    f.cv.text(label, lx + 13, f.py(f.y + 8), { size: 8.5, color: INK });
    lx += 22 + f.cv.textWidth(label, 8.5);
    if (lx > A4.w - M - 120) { lx = M + 14; f.y += 13; }
  }
  f.y += 16;
  f.text(`Рецензии: согласовано ${agreed} · не согласовано ${disagreed} · оспорено ${disputed} · без рецензии ${none}`, M + 14, 9, { color: MUTED });
  f.y = boxTop + 104;

  // ── Истории по модулям ──
  const groups = core.groupEntries(index, entries, 'module', statusOf);
  for (const g of groups) {
    f.ensure(60);
    f.y += 6;
    f.text(g.title.toUpperCase(), M, 9.5, { font: 'bold', color: MUTED });
    if (g.summary) f.cv.text(`${g.summary.implemented}/${g.summary.total} · ${g.summary.percent} %`, A4.w - M, f.py(f.y + 9.5), { size: 9, color: MUTED, align: 'right' });
    f.y += 14;
    f.cv.rgb(LINE, true).lineWidth(0.6).polyline([[M, f.py()], [A4.w - M, f.py()]], 'S');
    f.y += 8;

    for (const { story, criteria } of g.entries) {
      f.ensure(70);
      const sum = core.storySummary(story, statusOf);
      const head = `${story.id}  ${story.title}`;
      const right = `${core.PRIORITY[story.priority] ?? ''} · ${sum.text}`;
      const rw = f.cv.textWidth(right, 8.5) + 4;
      const hy = f.y;
      f.para(head, M, CW - rw - 10, 11.5, { font: 'bold' });
      f.cv.text(right, A4.w - M, f.py(hy + 10), { size: 8.5, color: TONE[core.STATUS[sum.status].tone], align: 'right' });
      const meta = [story.epic ? `${story.epic} ${index.epics.get(story.epic)?.title ?? ''}` : null,
        story.origin && story.origin !== 'prd' ? core.ORIGIN[story.origin] : null, story.release ? `релиз ${story.release}` : null].filter(Boolean).join(' · ');
      if (meta) f.para(meta, M, CW, 8.5, { color: MUTED });
      if (story.as) f.para(`Как ${story.as}, я хочу ${story.iWant}${story.soThat ? `, чтобы ${story.soThat}` : ''}.`, M, CW, 9, { color: MUTED });
      f.y += 4;

      for (const ac of criteria) {
        const key = core.acKey(story, ac);
        const status = statusOf.get(key);
        const e = reviews?.byKey.get(key);
        f.ensure(26);
        const top = f.y;
        drawMarker(f.cv, status, M + 6, f.py(top + 6.5));
        f.para(`${ac.id}  ${ac.text}${ac.retired ? ' (выведен из PRD)' : ''}`, M + 18, CW - 18, 9.5);
        const sub = [];
        if (!core.STATUS[status].implemented || status === 'manual') sub.push(core.STATUS[status].label);
        const t = tests?.results?.[key];
        if (t?.failed) sub.push(`автотестов падает: ${t.failed}`); else if (t?.passed) sub.push(`автотестов проходит: ${t.passed}`);
        if (ac.note) sub.push(ac.note);
        if (sub.length) f.para(sub.join(' · '), M + 18, CW - 18, 8.5, { color: MUTED });
        if (e) {
          const lines = [];
          const ag = [...e.agree.email.map((x) => (typeof x === 'string' ? x : x.name)), ...e.agree.anon.map((x) => `${typeof x === 'string' ? x : x.name} (аноним)`)];
          const dg = [...e.disagree.email, ...e.disagree.anon.map((x) => ({ ...x, name: `${x.name} (аноним)` }))];
          if (ag.length) lines.push([`Согласны: ${ag.join(', ')}`, TONE.good]);
          if (dg.length) lines.push([`Не согласны: ${dg.map((x) => `${x.name}${x.reasons?.length ? ` — ${x.reasons.map((r) => core.REASONS[r] ?? r).join(', ')}` : ''}`).join('; ')}`, TONE.bad]);
          if (e.disputed) lines.push(['Оспорено: разработка считает критерий выполненным, рецензент не согласен', TONE.bad]);
          if (e.stale.length) lines.push([`Оценки к прежней формулировке: ${names(e.stale)}`, MUTED]);
          for (const [line, color] of lines) f.para(line, M + 18, CW - 18, 8.5, { color });
          const thread = [
            ...e.comments.map((c) => ({ at: c.at, text: `${c.name}${c.kind === 'anon' ? ' (аноним)' : ''}: ${c.text}${c.stale ? ' [к прежней формулировке]' : ''}` })),
            ...e.replies.map((r) => ({ at: r.at, text: `Ответ команды (${r.author})${r.resolution ? `, ${core.RESOLUTIONS[r.resolution] ?? r.resolution}` : ''}: ${r.text}` })),
          ].sort((a, b) => String(a.at).localeCompare(String(b.at)));
          for (const c of thread) {
            const y0 = f.y;
            f.para(c.text, M + 26, CW - 26, 8.5, { color: INK });
            f.cv.rgb(LINE, true).lineWidth(1).polyline([[M + 20, f.py(y0 + 1)], [M + 20, f.py(f.y - 2)]], 'S');
          }
        }
        f.y += 5;
      }
      f.y += 8;
    }
  }

  f.finish();
  return doc.build();
}
