// Dependency-free PPTX writer. Server-only (node:zlib for deflate and CRC-32).
//
// Takes slides made of the same primitives deck.js draws into PDF — rect, text,
// line, poly, ellipse, image — and writes native, editable PowerPoint shapes:
// a diagram stays a diagram the presenter can move, not a picture of one.
//
// Coordinates are points from the top-left of a 960×540 slide (16:9, 13.333×7.5 in).
// 1 pt = 12 700 EMU. Text boxes wrap natively in PowerPoint; deck.js keeps text
// within its box by estimate, so fonts with different metrics still fit.
import * as zlib from 'node:zlib';
const { deflateRawSync } = zlib;

export const SLIDE = { w: 960, h: 540 };
const EMU = 12700;
const e = (pt) => Math.round(pt * EMU);

// ── ZIP ─────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0; // Node ≥ 22.2
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

export function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  const time = 0, date = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const { name, data } of files) {
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    // Картинки уже сжаты — второй deflate только тратит время.
    const store = /\.(png|jpe?g)$/i.test(name);
    const body = store ? raw : deflateRawSync(raw);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(store ? 0 : 8, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(store ? 0 : 8, 10); central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ── XML helpers ─────────────────────────────────────────────
// eslint-disable-next-line no-control-regex
const xml = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hex = (c) => String(c ?? '000000').replace('#', '').toUpperCase().slice(0, 6);
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const fill = (c) => (c ? `<a:solidFill><a:srgbClr val="${hex(c)}"/></a:solidFill>` : '<a:noFill/>');
const line = (c, w = 1, dash = null, arrow = false) => (c
  ? `<a:ln w="${e(w)}">${fill(c)}${dash ? '<a:prstDash val="dash"/>' : ''}${arrow ? '<a:tailEnd type="triangle" w="med" len="med"/>' : ''}</a:ln>`
  : '<a:ln><a:noFill/></a:ln>');
const xfrm = (x, y, w, h) => `<a:xfrm><a:off x="${e(x)}" y="${e(y)}"/><a:ext cx="${Math.max(1, e(w))}" cy="${Math.max(1, e(h))}"/></a:xfrm>`;

function textBody(it) {
  const anchor = { top: 't', middle: 'ctr', bottom: 'b' }[it.valign ?? 'top'];
  const algn = { left: 'l', center: 'ctr', right: 'r' }[it.align ?? 'left'];
  const font = it.font ?? 'Arial';
  const paragraphs = String(it.text ?? '').split('\n').map((para) => {
    const runs = (it.runs && it.text === undefined ? it.runs : [{ text: para, bold: it.bold, color: it.color }]);
    const lnSpc = it.lineHeight ? `<a:lnSpc><a:spcPct val="${Math.round(it.lineHeight * 100000)}"/></a:lnSpc>` : '';
    return `<a:p><a:pPr algn="${algn}">${lnSpc}</a:pPr>${runs.map((r) => `<a:r><a:rPr lang="ru-RU" sz="${Math.round((r.size ?? it.size ?? 14) * 100)}"${r.bold ? ' b="1"' : ''} dirty="0">${fill(r.color ?? it.color ?? '#111111')}<a:latin typeface="${xml(font)}"/><a:cs typeface="${xml(font)}"/></a:rPr><a:t>${xml(r.text)}</a:t></a:r>`).join('')}</a:p>`;
  });
  const vert = it.rotate === 270 ? ' vert="vert270"' : it.rotate === 90 ? ' vert="vert"' : '';
  return `<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="${anchor}"${vert} rtlCol="0"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paragraphs.join('')}</p:txBody>`;
}

function geom(it) {
  if (it.type === 'ellipse') return '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>';
  if (it.type === 'rect' && it.radius) {
    const adj = Math.min(50000, Math.round((it.radius / Math.max(1, Math.min(it.w, it.h))) * 100000));
    return `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${adj}"/></a:avLst></a:prstGeom>`;
  }
  return '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
}

/** Polyline/polygon as a custom geometry, so arrows and diamonds stay editable shapes. */
function pathShape(id, it) {
  const xs = it.points.map((p) => p[0]), ys = it.points.map((p) => p[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  const w = Math.max(...xs) - x0, h = Math.max(...ys) - y0;
  const W = Math.max(1, e(w)), H = Math.max(1, e(h));
  const pts = it.points.map(([x, y], i) => `<a:${i ? 'lnTo' : 'moveTo'}><a:pt x="${e(x - x0)}" y="${e(y - y0)}"/></a:${i ? 'lnTo' : 'moveTo'}>`).join('');
  const closed = it.type === 'poly';
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Path ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(x0, y0, w, h)}
<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="${W}" h="${H}"${closed ? '' : ' fill="none"'}>${pts}${closed ? '<a:close/>' : ''}</a:path></a:pathLst></a:custGeom>
${closed ? fill(it.fill) : '<a:noFill/>'}${line(it.stroke ?? (closed ? null : '#333333'), it.width ?? 1, it.dash, it.arrow)}</p:spPr></p:sp>`;
}

function slideXml(slide, media) {
  let id = 2;
  const shapes = [];
  for (const it of slide.items) {
    id += 1;
    if (it.type === 'text') {
      // Повёрнутый текст — через vert270 у bodyPr, а не поворот рамки: поворот
      // рамки часть просмотрщиков (Quick Look, превью почты) игнорирует.
      const frame = xfrm(it.x, it.y, it.w, it.h);
      shapes.push(`<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${frame}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>${textBody(it)}</p:sp>`);
    } else if (it.type === 'rect' || it.type === 'ellipse') {
      shapes.push(`<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(it.x, it.y, it.w, it.h)}${geom(it)}${fill(it.fill)}${line(it.stroke, it.width ?? 1, it.dash)}</p:spPr>${it.text !== undefined ? textBody({ ...it, x: 0, y: 0 }) : ''}</p:sp>`);
    } else if (it.type === 'line' || it.type === 'poly') {
      shapes.push(pathShape(id, it));
    } else if (it.type === 'image') {
      const rid = media.add(it.data);
      shapes.push(`<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(it.x, it.y, it.w, it.h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${it.stroke ? line(it.stroke, it.width ?? 1) : ''}</p:spPr></p:pic>`);
    }
  }
  const bg = `<p:bg><p:bgPr>${fill(slide.background ?? '#FFFFFF')}<a:effectLst/></p:bgPr></p:bg>`;
  return `${HEAD}<p:sld ${NS}><p:cSld>${bg}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

const THEME = `${HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="PRD"><a:themeElements>
<a:clrScheme name="PRD"><a:dk1><a:srgbClr val="16161A"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="2B2B33"/></a:dk2><a:lt2><a:srgbClr val="F4F4F7"/></a:lt2>
<a:accent1><a:srgbClr val="6D4AFF"/></a:accent1><a:accent2><a:srgbClr val="15803D"/></a:accent2><a:accent3><a:srgbClr val="D97706"/></a:accent3><a:accent4><a:srgbClr val="B91C1C"/></a:accent4><a:accent5><a:srgbClr val="2563EB"/></a:accent5><a:accent6><a:srgbClr val="71717A"/></a:accent6>
<a:hlink><a:srgbClr val="6D4AFF"/></a:hlink><a:folHlink><a:srgbClr val="5B3FD6"/></a:folHlink></a:clrScheme>
<a:fontScheme name="PRD"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
<a:fmtScheme name="PRD"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;

const EMPTY_TREE = '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>';
const MASTER = `${HEAD}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>${EMPTY_TREE}</p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="3600"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;
const LAYOUT = `${HEAD}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank">${EMPTY_TREE}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
const rels = (list) => `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`).join('')}</Relationships>`;
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** deck: { title, author, slides: [{ background, items: [...] }] } → Buffer (.pptx) */
export function buildPptx(deck) {
  const files = [];
  const slides = deck.slides ?? [];
  const mediaFiles = [];
  const ct = [
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Default Extension="png" ContentType="image/png"/>',
    '<Default Extension="jpeg" ContentType="image/jpeg"/>',
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>',
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>',
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
    '<Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>',
    '<Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/>',
    '<Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
  ];

  slides.forEach((slide, i) => {
    const n = i + 1;
    const slideRels = [['rId1', `${R}/slideLayout`, '../slideLayouts/slideLayout1.xml']];
    const media = {
      add(data) {
        const ext = data[0] === 0x89 ? 'png' : 'jpeg';
        const name = `image${mediaFiles.length + 1}.${ext}`;
        mediaFiles.push({ name: `ppt/media/${name}`, data });
        const rid = `rId${slideRels.length + 1}`;
        slideRels.push([rid, `${R}/image`, `../media/${name}`]);
        return rid;
      },
    };
    files.push({ name: `ppt/slides/slide${n}.xml`, data: slideXml(slide, media) });
    files.push({ name: `ppt/slides/_rels/slide${n}.xml.rels`, data: rels(slideRels) });
    ct.push(`<Override PartName="/ppt/slides/slide${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`);
  });

  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  files.unshift(
    { name: '[Content_Types].xml', data: `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${ct.join('')}</Types>` },
    { name: '_rels/.rels', data: rels([
      ['rId1', `${R}/officeDocument`, 'ppt/presentation.xml'],
      ['rId2', 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'docProps/core.xml'],
      ['rId3', `${R}/extended-properties`, 'docProps/app.xml'],
    ]) },
    { name: 'docProps/core.xml', data: `${HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(deck.title)}</dc:title><dc:creator>${xml(deck.author ?? 'prd-review')}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>` },
    { name: 'docProps/app.xml', data: `${HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>prd-review</Application><Slides>${slides.length}</Slides></Properties>` },
    { name: 'ppt/presentation.xml', data: `${HEAD}<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${e(SLIDE.w)}" cy="${e(SLIDE.h)}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>` },
    { name: 'ppt/_rels/presentation.xml.rels', data: rels([
      ['rId1', `${R}/slideMaster`, 'slideMasters/slideMaster1.xml'],
      ...slides.map((_, i) => [`rId${i + 2}`, `${R}/slide`, `slides/slide${i + 1}.xml`]),
      [`rId${slides.length + 2}`, `${R}/presProps`, 'presProps.xml'],
      [`rId${slides.length + 3}`, `${R}/viewProps`, 'viewProps.xml'],
      [`rId${slides.length + 4}`, `${R}/theme`, 'theme/theme1.xml'],
      [`rId${slides.length + 5}`, `${R}/tableStyles`, 'tableStyles.xml'],
    ]) },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: MASTER },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: rels([['rId1', `${R}/slideLayout`, '../slideLayouts/slideLayout1.xml'], ['rId2', `${R}/theme`, '../theme/theme1.xml']]) },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: LAYOUT },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: rels([['rId1', `${R}/slideMaster`, '../slideMasters/slideMaster1.xml']]) },
    { name: 'ppt/theme/theme1.xml', data: THEME },
    { name: 'ppt/presProps.xml', data: `${HEAD}<p:presentationPr ${NS}/>` },
    { name: 'ppt/viewProps.xml', data: `${HEAD}<p:viewPr ${NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="72008" cy="72008"/></p:viewPr>` },
    { name: 'ppt/tableStyles.xml', data: `${HEAD}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>` },
  );
  files.push(...mediaFiles);
  return zip(files);
}
