// Dependency-free PDF writer: a small TrueType parser, a document builder, drawing
// helpers, word wrapping and JPEG/PNG images.
//
// This is the same writer guided-process-docs ships (assets/pdf.js), extended with
// wrap() and images. Keep ONE copy per project: if guided-process-docs already put a
// pdf.js into the project, replace it with this one — it is a superset, every old call
// keeps working.
//
// PDF's fourteen built-in fonts cover Latin only, so any other script needs its font
// embedded. This does that as CIDFontType2 with Identity-H encoding, and emits a
// ToUnicode CMap so the resulting text can still be searched and copied — without it
// the page renders correctly but the text is opaque to every reader and indexer.
//
// Point the fonts at files you have the right to embed (SIL OFL and Apache-2.0 both
// permit it): setFonts({ regular, bold }) or PDF_FONT_DIR with Regular.ttf / Bold.ttf.
// Emoji are not in text fonts: draw status markers as shapes (see report-pdf.js).
import { readFileSync, existsSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
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
    const groups = u32(o + 12);
    for (let g = 0; g < groups; g++) {
      const p = o + 16 + g * 12;
      const start = u32(p), end = u32(p + 4), gid0 = u32(p + 8);
      for (let c = start; c <= end; c++) map.set(c, gid0 + (c - start));
    }
  }

  return { buf, unitsPerEm, bbox, numGlyphs, widths, map, ascent, descent };
}

// Замены для символов, которых нет в шрифте. Урезанный (subset) шрифт часто теряет
// типографику — «ёлочки», «·», «…» — и без замены они молча становятся пробелами.
const FALLBACK = {
  '«': '"', '»': '"', '„': '"', '“': '"', '”': '"', '‘': "'", '’': "'", '·': '-', '•': '-', '…': '...',
  '—': '-', '–': '-', '−': '-', '№': 'No', '→': '->', '←': '<-', '×': 'x', '₽': 'руб.', ' ': ' ', ' ': ' ', ' ': ' ',
};

export class Font {
  constructor(file, name) {
    this.data = parseTtf(readFileSync(file));
    this.name = name;
    this.used = new Set([0]);
    this.toUnicode = new Map();   // глиф → символ, нужен для поиска и копирования текста
  }
  /** Символы строки, для которых в шрифте нет глифа, заменяются из FALLBACK. */
  chars(text) {
    const out = [];
    for (const ch of String(text)) {
      if (this.data.map.has(ch.codePointAt(0)) || !FALLBACK[ch]) out.push(ch);
      else out.push(...FALLBACK[ch]);
    }
    return out;
  }
  /** Строка → последовательность идентификаторов глифов для Identity-H. */
  encode(text) {
    let out = '';
    for (const ch of this.chars(text)) {
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
    for (const ch of this.chars(text)) {
      const gid = this.data.map.get(ch.codePointAt(0)) ?? 0;
      w += (this.data.widths[gid] || 0) * k;
    }
    return w;
  }
}

// Fonts: PDF_FONT_DIR/Regular.ttf and Bold.ttf by default, or setFonts() with paths.
// The PostScript name (second argument) only has to be unique within the document.
export const FONT_DIR = process.env.PDF_FONT_DIR || join(ROOT, 'assets/fonts');
const fontFiles = { regular: join(FONT_DIR, 'Regular.ttf'), bold: join(FONT_DIR, 'Bold.ttf') };
const fontCache = new Map();
export function setFonts(paths) { Object.assign(fontFiles, paths); fontCache.clear(); }
function loadFont(key) {
  const file = fontFiles[key] ?? fontFiles.regular;
  if (!existsSync(file)) {
    throw new Error(`Нет файла шрифта ${file}. Положите TTF с кириллицей (PT Sans, DejaVu Sans, Arimo) и укажите путь через setFonts() или PDF_FONT_DIR.`);
  }
  // Разбор TTF — самая дорогая часть; таблицы шрифта переиспользуем между документами.
  if (!fontCache.has(file)) fontCache.set(file, parseTtf(readFileSync(file)));
  const font = Object.create(Font.prototype);
  font.data = fontCache.get(file);
  font.name = key === 'bold' ? 'BodyBold' : key === 'regular' ? 'BodyRegular' : `Body${key}`;
  font.used = new Set([0]);
  font.toUnicode = new Map();
  return font;
}
export const FONTS = {
  regular: () => loadFont('regular'),
  bold: () => loadFont('bold'),
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

// ── Изображения ──────────────────────────────────────────────
/**
 * Размеры JPEG из маркера начала кадра. PDF встраивает JPEG как есть (DCTDecode),
 * поэтому перекодировать ничего не нужно — достаточно ширины, высоты и числа каналов.
 */
export function jpegInfo(buf) {
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) throw new Error('Не JPEG: нет маркера SOI');
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xFF) { i += 1; continue; }
    const m = buf[i + 1];
    // SOF0…SOF15, кроме DHT (C4), JPG (C8) и DAC (CC)
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), components: buf[i + 9] };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error('В JPEG не найден маркер начала кадра');
}

/**
 * PNG → сырые строки пикселей. Скриншоты из браузера почти всегда RGBA, а PDF
 * не умеет альфу внутри картинки: её нужно вынести в отдельную маску (SMask),
 * для чего строки приходится распаковать и снять PNG-фильтры.
 * Поддерживаются 8-битные неинтерлейсные PNG: серый, RGB, серый+α, RGBA.
 */
export function decodePng(buf) {
  const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  if (!sig.every((b, i) => buf[i] === b)) throw new Error('Не PNG: нет сигнатуры');
  let pos = 8, width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || ![0, 2, 4, 6].includes(colorType)) {
    throw new Error('PNG: поддерживаются только 8 бит без интерлейса (серый, RGB, RGBA). Пересохраните картинку или используйте JPEG.');
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 255;
    }
    prev = cur;
  }
  const colors = colorType === 0 || colorType === 4 ? 1 : 3;
  const hasAlpha = colorType === 4 || colorType === 6;
  const color = Buffer.alloc(width * height * colors);
  const alpha = hasAlpha ? Buffer.alloc(width * height) : null;
  for (let i = 0, j = 0, k = 0; i < out.length; i += channels) {
    for (let c = 0; c < colors; c++) color[j++] = out[i + c];
    if (alpha) alpha[k++] = out[i + colors];
  }
  return { width, height, colors, color, alpha };
}

// ── Сборка документа ─────────────────────────────────────────
const escText = (s) => String(s).replace(/([\\()])/g, '\\$1');
// Метаданные PDF — строка в UTF-16BE с BOM, иначе кириллица в заголовке окна ломается.
const pdfString = (s) => {
  const text = String(s ?? '');
  if (/^[\x20-\x7e]*$/.test(text)) return `(${escText(text)})`;
  const hex = ['FEFF'];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp > 0xFFFF) {
      hex.push((0xD800 + ((cp - 0x10000) >> 10)).toString(16), (0xDC00 + ((cp - 0x10000) & 0x3FF)).toString(16));
    } else hex.push(cp.toString(16).padStart(4, '0'));
  }
  return `<${hex.join('').toUpperCase()}>`;
};

export class PdfDoc {
  constructor({ title = '', author = '', subject = '', producer = 'pdf.js' } = {}) {
    this.objects = [null];
    this.pages = [];
    this.meta = { title, author, subject, producer };
    this.fonts = {};
    this.images = [];
  }

  add(content) { this.objects.push(content); return this.objects.length - 1; }

  useFont(key) {
    if (!this.fonts[key]) {
      this.fonts[key] = { font: FONTS[key](), id: `F${Object.keys(this.fonts).length + 1}` };
    }
    return this.fonts[key];
  }

  addPage(width, height, stream) { this.pages.push({ width, height, stream }); }

  /** Встраивает JPEG; возвращает ресурс с размерами в пикселях. */
  addJpeg(buf) {
    const { width, height, components } = jpegInfo(buf);
    const id = this.add({ dict: {
      Type: '/XObject', Subtype: '/Image', Width: width, Height: height,
      ColorSpace: components === 1 ? '/DeviceGray' : components === 4 ? '/DeviceCMYK' : '/DeviceRGB',
      BitsPerComponent: 8, Filter: '/DCTDecode',
    }, stream: buf });
    return this.registerImage(id, width, height);
  }

  /** Встраивает PNG; прозрачность уходит в SMask, иначе фон картинки станет чёрным. */
  addPng(buf) {
    const { width, height, colors, color, alpha } = decodePng(buf);
    let smask = '';
    if (alpha) {
      const maskId = this.add({ dict: {
        Type: '/XObject', Subtype: '/Image', Width: width, Height: height,
        ColorSpace: '/DeviceGray', BitsPerComponent: 8, Filter: '/FlateDecode',
      }, stream: deflateSync(alpha) });
      smask = `${maskId} 0 R`;
    }
    const dict = {
      Type: '/XObject', Subtype: '/Image', Width: width, Height: height,
      ColorSpace: colors === 1 ? '/DeviceGray' : '/DeviceRGB', BitsPerComponent: 8, Filter: '/FlateDecode',
    };
    if (smask) dict.SMask = smask;
    const id = this.add({ dict, stream: deflateSync(color) });
    return this.registerImage(id, width, height);
  }

  /** JPEG или PNG по сигнатуре файла. */
  addImage(buf) {
    if (buf[0] === 0xFF && buf[1] === 0xD8) return this.addJpeg(buf);
    if (buf[0] === 0x89 && buf[1] === 0x50) return this.addPng(buf);
    throw new Error('Изображение должно быть JPEG или PNG');
  }

  registerImage(id, width, height) {
    const image = { name: `Im${this.images.length + 1}`, id, width, height };
    this.images.push(image);
    return image;
  }

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
    const fontsDict = Object.entries(fontRefs).map(([id, ref]) => `/${id} ${ref} 0 R`).join(' ');
    const images = this.images.length
      ? ` /XObject << ${this.images.map((im) => `/${im.name} ${im.id} 0 R`).join(' ')} >>` : '';
    for (const p of this.pages) {
      const packed = deflateSync(Buffer.from(p.stream, 'latin1'));
      const contentId = this.add({ dict: { Filter: '/FlateDecode' }, stream: packed });
      kids.push(this.add({ dict: {
        Type: '/Page', Parent: `${pagesId} 0 R`,
        MediaBox: `[0 0 ${p.width.toFixed(2)} ${p.height.toFixed(2)}]`,
        Resources: `<< /Font << ${fontsDict} >>${images} >>`, Contents: `${contentId} 0 R`,
      } }));
    }
    this.objects[pagesId] = { dict: {
      Type: '/Pages', Count: kids.length, Kids: `[${kids.map((k) => `${k} 0 R`).join(' ')}]`,
    } };
    const infoId = this.add({ dict: {
      Title: pdfString(this.meta.title), Author: pdfString(this.meta.author),
      Subject: pdfString(this.meta.subject), Producer: pdfString(this.meta.producer),
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
// Координаты PDF: начало в левом нижнем углу, y растёт вверх, единица — пункт (1/72").
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
  /**
   * Разбивка текста по ширине полосы набора. Слово длиннее строки (артикул,
   * идентификатор) режется по символам — иначе оно выходит за поле.
   * Явные переводы строки сохраняются.
   */
  wrap(str, size, maxWidth, font = 'regular') {
    const lines = [];
    for (const paragraph of String(str ?? '').split('\n')) {
      if (!paragraph.trim()) { lines.push(''); continue; }
      let current = '';
      for (const word of paragraph.trim().split(/\s+/u)) {
        const candidate = current ? `${current} ${word}` : word;
        if (this.textWidth(candidate, size, font) <= maxWidth) { current = candidate; continue; }
        if (current) lines.push(current);
        let chunk = word;
        while (this.textWidth(chunk, size, font) > maxWidth && chunk.length > 1) {
          let cut = chunk.length - 1;
          while (cut > 1 && this.textWidth(chunk.slice(0, cut), size, font) > maxWidth) cut -= 1;
          lines.push(chunk.slice(0, cut));
          chunk = chunk.slice(cut);
        }
        current = chunk;
      }
      if (current) lines.push(current);
    }
    return lines.length ? lines : [''];
  }
  /** Изображение из doc.addJpeg/addPng/addImage в прямоугольник x, y (низ), w, h. */
  image(img, x, y, w, h) {
    return this.op('q').op(`${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm`)
      .op(`/${img.name} Do`).op('Q');
  }
  /** Вписать картинку в рамку с сохранением пропорций; возвращает занятый прямоугольник. */
  imageFit(img, x, y, w, h) {
    const k = Math.min(w / img.width, h / img.height);
    const iw = img.width * k, ih = img.height * k;
    const ix = x + (w - iw) / 2, iy = y + (h - ih) / 2;
    this.image(img, ix, iy, iw, ih);
    return { x: ix, y: iy, w: iw, h: ih };
  }
  toString() { return this.ops.join('\n'); }
}
