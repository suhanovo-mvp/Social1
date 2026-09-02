// Минимальный генератор PDF: разбор TrueType и сборка документа со встроенным шрифтом.
// Внешних библиотек нет — в PDF отсутствуют стандартные шрифты с кириллицей,
// поэтому шрифт встраивается как CIDFontType2 с кодировкой Identity-H.
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── Разбор TrueType ──────────────────────────────────────────
function parseTtf(buf) {
  const u16 = (o) => buf.readUInt16BE(o);
  const i16 = (o) => buf.readInt16BE(o);
  const u32 = (o) => buf.readUInt32BE(o);

  const numTables = u16(4);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const p = 12 + i * 16;
    tables[buf.toString('latin1', p, p + 4).trim()] = { offset: u32(p + 8), length: u32(p + 12) };
  }
  for (const t of ['head', 'hhea', 'hmtx', 'maxp', 'cmap']) {
    if (!tables[t]) throw new Error(`В шрифте нет таблицы ${t}`);
  }

  const head = tables.head.offset;
  const unitsPerEm = u16(head + 18);
  const bbox = [i16(head + 36), i16(head + 38), i16(head + 40), i16(head + 42)];
  const numGlyphs = u16(tables.maxp.offset + 4);
  const numHMetrics = u16(tables.hhea.offset + 34);
  const ascent = i16(tables.hhea.offset + 4);
  const descent = i16(tables.hhea.offset + 6);

  // Ширины глифов: после numHMetrics повторяется последнее значение
  const widths = new Array(numGlyphs).fill(0);
  const hmtx = tables.hmtx.offset;
  let last = 0;
  for (let g = 0; g < numGlyphs; g++) {
    if (g < numHMetrics) last = u16(hmtx + g * 4);
    widths[g] = last;
  }

  // Соответствие символов глифам: предпочитаем подтаблицу Windows Unicode
  const cmapOff = tables.cmap.offset;
  const nSub = u16(cmapOff + 2);
  let best = null;
  for (let i = 0; i < nSub; i++) {
    const p = cmapOff + 4 + i * 8;
    const platform = u16(p), encoding = u16(p + 2), off = cmapOff + u32(p + 4);
    const format = u16(off);
    const score = (platform === 3 && encoding === 10) ? 4
      : (platform === 3 && encoding === 1) ? 3
      : (platform === 0) ? 2 : 1;
    if ((format === 4 || format === 12) && (!best || score > best.score)) best = { off, format, score };
  }
  if (!best) throw new Error('В шрифте нет подходящей таблицы cmap');

  const map = new Map();
  if (best.format === 4) {
    const o = best.off;
    const segX2 = u16(o + 6), seg = segX2 / 2;
    const endO = o + 14, startO = endO + segX2 + 2, deltaO = startO + segX2, rangeO = deltaO + segX2;
    for (let s = 0; s < seg; s++) {
      const end = u16(endO + s * 2), start = u16(startO + s * 2);
      const delta = i16(deltaO + s * 2), range = u16(rangeO + s * 2);
      if (start === 0xFFFF) continue;
      for (let c = start; c <= end; c++) {
        let gid;
        if (range === 0) gid = (c + delta) & 0xFFFF;
        else {
          const gi = rangeO + s * 2 + range + (c - start) * 2;
          if (gi + 1 >= buf.length) continue;
          gid = u16(gi);
          if (gid !== 0) gid = (gid + delta) & 0xFFFF;
        }
        if (gid) map.set(c, gid);
      }
    }
  } else {
    const o = best.off;
    const nGroups = u32(o + 12);
    for (let g = 0; g < nGroups; g++) {
      const p = o + 16 + g * 12;
      const start = u32(p), end = u32(p + 4), gid = u32(p + 8);
      for (let c = start; c <= end; c++) map.set(c, gid + (c - start));
    }
  }

  return { buf, unitsPerEm, bbox, numGlyphs, widths, map, ascent, descent };
}

export class Font {
  constructor(file, name) {
    this.data = parseTtf(readFileSync(file));
    this.name = name;
    this.used = new Set([0]);
    this.toUnicode = new Map();   // глиф → символ, нужен для поиска и копирования текста
  }
  /** Строка → последовательность идентификаторов глифов для Identity-H. */
  encode(text) {
    let out = '';
    for (const ch of String(text)) {
      const cp = ch.codePointAt(0);
      const gid = this.data.map.get(cp) ?? this.data.map.get(0x20) ?? 0;
      this.used.add(gid);
      if (!this.toUnicode.has(gid)) this.toUnicode.set(gid, cp);
      out += gid.toString(16).padStart(4, '0');
    }
    return out;
  }
  /** Ширина строки в пунктах при заданном кегле. */
  width(text, size) {
    const k = size / this.data.unitsPerEm;
    let w = 0;
    for (const ch of String(text)) {
      const gid = this.data.map.get(ch.codePointAt(0)) ?? 0;
      w += (this.data.widths[gid] || 0) * k;
    }
    return w;
  }
}

export const FONTS = {
  regular: () => new Font(join(ROOT, 'assets/fonts/PT_Sans-Web-Regular.ttf'), 'PTSans'),
  bold: () => new Font(join(ROOT, 'assets/fonts/PT_Sans-Web-Bold.ttf'), 'PTSansBold'),
};

// ── Карта ToUnicode ──────────────────────────────────────────
// Без неё текст в PDF отображается верно, но не ищется и не копируется:
// Identity-H кодирует номера глифов, а не символы.
function buildToUnicode(font) {
  const entries = [...font.toUnicode.entries()].sort((a, b) => a[0] - b[0]);
  const hex = (n) => n.toString(16).padStart(4, '0').toUpperCase();
  const blocks = [];
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    blocks.push(`${chunk.length} beginbfchar\n` +
      chunk.map(([gid, cp]) => {
        // Символы вне основной плоскости кодируются суррогатной парой
        const u = cp > 0xFFFF
          ? hex(0xD800 + ((cp - 0x10000) >> 10)) + hex(0xDC00 + ((cp - 0x10000) & 0x3FF))
          : hex(cp);
        return `<${hex(gid)}> <${u}>`;
      }).join('\n') + '\nendbfchar');
  }
  return `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${blocks.join('\n')}
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
}

// ── Сборка документа ─────────────────────────────────────────
const escText = (s) => String(s).replace(/([\\()])/g, '\\$1');

export class PdfDoc {
  constructor({ title = '', author = 'Social1', subject = '' } = {}) {
    this.objects = [null];
    this.pages = [];
    this.meta = { title, author, subject };
    this.fonts = {};
  }

  add(content) { this.objects.push(content); return this.objects.length - 1; }

  useFont(key) {
    if (!this.fonts[key]) {
      this.fonts[key] = { font: FONTS[key](), id: `F${Object.keys(this.fonts).length + 1}` };
    }
    return this.fonts[key];
  }

  addPage(width, height, stream) { this.pages.push({ width, height, stream }); }

  embedFont(entry) {
    const { font } = entry;
    const d = font.data;
    const scale = 1000 / d.unitsPerEm;
    const fileId = this.add({
      dict: { Length1: d.buf.length, Filter: '/FlateDecode' },
      stream: deflateSync(d.buf),
    });
    // Ширины только использованных глифов
    const used = [...font.used].sort((a, b) => a - b);
    const w = used.map((gid) => `${gid}[${Math.round((d.widths[gid] || 0) * scale)}]`);
    const descId = this.add({ dict: {
      Type: '/FontDescriptor', FontName: `/${font.name}`, Flags: 4,
      FontBBox: `[${d.bbox.map((v) => Math.round(v * scale)).join(' ')}]`,
      ItalicAngle: 0, Ascent: Math.round(d.ascent * scale), Descent: Math.round(d.descent * scale),
      CapHeight: Math.round(d.ascent * scale * 0.72), StemV: 80, FontFile2: `${fileId} 0 R`,
    } });
    const cidId = this.add({ dict: {
      Type: '/Font', Subtype: '/CIDFontType2', BaseFont: `/${font.name}`,
      CIDSystemInfo: '<< /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>',
      FontDescriptor: `${descId} 0 R`, DW: 1000, W: `[${w.join(' ')}]`,
      CIDToGIDMap: '/Identity',
    } });
    const toUniId = this.add({
      dict: { Filter: '/FlateDecode' },
      stream: deflateSync(Buffer.from(buildToUnicode(font), 'latin1')),
    });
    return this.add({ dict: {
      Type: '/Font', Subtype: '/Type0', BaseFont: `/${font.name}`,
      Encoding: '/Identity-H', DescendantFonts: `[${cidId} 0 R]`,
      ToUnicode: `${toUniId} 0 R`,
    } });
  }

  build() {
    const fontRefs = {};
    for (const entry of Object.values(this.fonts)) fontRefs[entry.id] = this.embedFont(entry);

    const pagesId = this.add(null);
    const kids = [];
    for (const p of this.pages) {
      const packed = deflateSync(Buffer.from(p.stream, 'latin1'));
      const contentId = this.add({ dict: { Filter: '/FlateDecode' }, stream: packed });
      const fontsDict = Object.entries(fontRefs).map(([id, ref]) => `/${id} ${ref} 0 R`).join(' ');
      kids.push(this.add({ dict: {
        Type: '/Page', Parent: `${pagesId} 0 R`,
        MediaBox: `[0 0 ${p.width.toFixed(2)} ${p.height.toFixed(2)}]`,
        Resources: `<< /Font << ${fontsDict} >> >>`, Contents: `${contentId} 0 R`,
      } }));
    }
    this.objects[pagesId] = { dict: {
      Type: '/Pages', Count: kids.length, Kids: `[${kids.map((k) => `${k} 0 R`).join(' ')}]`,
    } };
    const infoId = this.add({ dict: {
      Title: `(${escText(this.meta.title)})`, Author: `(${escText(this.meta.author)})`,
      Subject: `(${escText(this.meta.subject)})`, Producer: '(Social1)',
    } });
    const catalogId = this.add({ dict: { Type: '/Catalog', Pages: `${pagesId} 0 R` } });

    const chunks = [];
    let pos = 0;
    const push = (b) => {
      const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1');
      chunks.push(buf); pos += buf.length;
    };
    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

    const offsets = [0];
    for (let i = 1; i < this.objects.length; i++) {
      offsets[i] = pos;
      const o = this.objects[i];
      const dict = Object.entries(o.dict || {}).map(([k, v]) => `/${k} ${v}`).join(' ');
      if (o.stream) {
        push(`${i} 0 obj\n<< ${dict} /Length ${o.stream.length} >>\nstream\n`);
        push(o.stream);
        push('\nendstream\nendobj\n');
      } else {
        push(`${i} 0 obj\n<< ${dict} >>\nendobj\n`);
      }
    }
    const xref = pos;
    push(`xref\n0 ${this.objects.length}\n0000000000 65535 f \n`);
    for (let i = 1; i < this.objects.length; i++) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
    push(`trailer\n<< /Size ${this.objects.length} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return Buffer.concat(chunks);
  }
}

// ── Помощники рисования ──────────────────────────────────────
export class Canvas {
  constructor(doc) { this.doc = doc; this.ops = []; }
  op(s) { this.ops.push(s); return this; }
  save() { return this.op('q'); }
  restore() { return this.op('Q'); }
  matrix(a, b, c, d, e, f) { return this.op(`${a} ${b} ${c} ${d} ${e} ${f} cm`); }
  rgb(hex, stroke = false) {
    const n = parseInt(String(hex).replace('#', ''), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => (v / 255).toFixed(3));
    return this.op(`${r} ${g} ${b} ${stroke ? 'RG' : 'rg'}`);
  }
  lineWidth(w) { return this.op(`${w.toFixed(2)} w`); }
  dash(on, off) { return this.op(on ? `[${on} ${off}] 0 d` : '[] 0 d'); }
  rect(x, y, w, h, mode = 'S') {
    return this.op(`${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re ${mode}`);
  }
  roundRect(x, y, w, h, r, mode = 'S') {
    const k = r * 0.5523;
    return this.op(`${(x + r).toFixed(2)} ${y.toFixed(2)} m`)
      .op(`${(x + w - r).toFixed(2)} ${y.toFixed(2)} l`)
      .op(`${(x + w - r + k).toFixed(2)} ${y.toFixed(2)} ${(x + w).toFixed(2)} ${(y + r - k).toFixed(2)} ${(x + w).toFixed(2)} ${(y + r).toFixed(2)} c`)
      .op(`${(x + w).toFixed(2)} ${(y + h - r).toFixed(2)} l`)
      .op(`${(x + w).toFixed(2)} ${(y + h - r + k).toFixed(2)} ${(x + w - r + k).toFixed(2)} ${(y + h).toFixed(2)} ${(x + w - r).toFixed(2)} ${(y + h).toFixed(2)} c`)
      .op(`${(x + r).toFixed(2)} ${(y + h).toFixed(2)} l`)
      .op(`${(x + r - k).toFixed(2)} ${(y + h).toFixed(2)} ${x.toFixed(2)} ${(y + h - r + k).toFixed(2)} ${x.toFixed(2)} ${(y + h - r).toFixed(2)} c`)
      .op(`${x.toFixed(2)} ${(y + r).toFixed(2)} l`)
      .op(`${x.toFixed(2)} ${(y + r - k).toFixed(2)} ${(x + r - k).toFixed(2)} ${y.toFixed(2)} ${(x + r).toFixed(2)} ${y.toFixed(2)} c`)
      .op(mode);
  }
  circle(cx, cy, r, mode = 'S') {
    const k = r * 0.5523;
    return this.op(`${(cx + r).toFixed(2)} ${cy.toFixed(2)} m`)
      .op(`${(cx + r).toFixed(2)} ${(cy + k).toFixed(2)} ${(cx + k).toFixed(2)} ${(cy + r).toFixed(2)} ${cx.toFixed(2)} ${(cy + r).toFixed(2)} c`)
      .op(`${(cx - k).toFixed(2)} ${(cy + r).toFixed(2)} ${(cx - r).toFixed(2)} ${(cy + k).toFixed(2)} ${(cx - r).toFixed(2)} ${cy.toFixed(2)} c`)
      .op(`${(cx - r).toFixed(2)} ${(cy - k).toFixed(2)} ${(cx - k).toFixed(2)} ${(cy - r).toFixed(2)} ${cx.toFixed(2)} ${(cy - r).toFixed(2)} c`)
      .op(`${(cx + k).toFixed(2)} ${(cy - r).toFixed(2)} ${(cx + r).toFixed(2)} ${(cy - k).toFixed(2)} ${(cx + r).toFixed(2)} ${cy.toFixed(2)} c`)
      .op(mode);
  }
  poly(points, mode = 'S') {
    points.forEach(([x, y], i) => this.op(`${x.toFixed(2)} ${y.toFixed(2)} ${i ? 'l' : 'm'}`));
    return this.op(`h ${mode}`);
  }
  polyline(points, mode = 'S') {
    points.forEach(([x, y], i) => this.op(`${x.toFixed(2)} ${y.toFixed(2)} ${i ? 'l' : 'm'}`));
    return this.op(mode);
  }
  text(str, x, y, { font = 'regular', size = 10, align = 'left', color = '#141b28' } = {}) {
    const entry = this.doc.useFont(font);
    const w = entry.font.width(str, size);
    const tx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    this.rgb(color);
    return this.op('BT').op(`/${entry.id} ${size} Tf`)
      .op(`1 0 0 1 ${tx.toFixed(2)} ${y.toFixed(2)} Tm`)
      .op(`<${entry.font.encode(str)}> Tj`).op('ET');
  }
  /** Повёрнутый на 90° текст — для названий дорожек. */
  textRotated(str, x, y, { font = 'regular', size = 10, color = '#141b28' } = {}) {
    const entry = this.doc.useFont(font);
    const w = entry.font.width(str, size);
    this.rgb(color);
    return this.op('BT').op(`/${entry.id} ${size} Tf`)
      .op(`0 1 -1 0 ${x.toFixed(2)} ${(y - w / 2).toFixed(2)} Tm`)
      .op(`<${entry.font.encode(str)}> Tj`).op('ET');
  }
  textWidth(str, size, font = 'regular') { return this.doc.useFont(font).font.width(str, size); }
  toString() { return this.ops.join('\n'); }
}
