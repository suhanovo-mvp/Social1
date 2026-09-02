// Одностраничная справка для топ-руководства ДТСЗН.
// Терминология русская: контрольные точки вместо Gate, решения — словами.
// Собирается тем же генератором, что и схемы процессов, — типографика единая.
import { PdfDoc, Canvas } from '../server/pdf.js';
import { writeFileSync } from 'node:fs';

const A4 = { w: 595.28, h: 841.89 };
const MX = 44, CW = A4.w - MX * 2;
const C = {
  navy: '12294C', brand: '1B3A6B', brand2: '24508F',
  f0: 'DDE9F9', f1: 'BCD6F4', f2: '8FB9EA', f3: '5B91D8', f4: '2F66B5',
  bg: 'EFF5FD', white: 'FFFFFF',
  text: '141B28', text2: '4A5568', text3: '7C8798',
  line: 'DFE4ED', surf: 'F9FAFC',
  ok: '1A7F52', okBg: 'E3F5EC', danger: 'B32B2B',
};

const doc = new PdfDoc({
  title: 'Social1 — экосистема системных инноваций ДТСЗН',
  author: 'ДТСЗН',
  subject: 'Краткая справка для руководства',
});
const cv = new Canvas(doc);

function wrap(text, maxW, size, font = 'regular') {
  const words = String(text).split(/\s+/).filter(Boolean);
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
function para(text, x, top, w, { size = 9.5, lh = 13, color = C.text2, font = 'regular' } = {}) {
  const lines = wrap(text, w, size, font);
  lines.forEach((l, i) => cv.text(l, x, top - i * lh, { size, color, font }));
  return top - (lines.length - 1) * lh - lh;
}

// ── Шапка ────────────────────────────────────────────────────
cv.rgb(C.navy).rect(0, A4.h - 5, A4.w, 5, 'f');
cv.rgb(C.navy).rect(0, A4.h - 116, A4.w, 111, 'f');
cv.rgb(C.white).rect(MX, A4.h - 57, 25, 25, 'f');
cv.text('S1', MX + 12.5, A4.h - 49, { size: 10.5, align: 'center', font: 'bold', color: C.navy });
cv.text('SOCIAL1', MX + 33, A4.h - 49, { size: 14.5, font: 'bold', color: C.white });
cv.text('Экосистема системных инноваций ДТСЗН', A4.w - MX, A4.h - 49,
  { size: 9, align: 'right', color: '8FA9C9' });
cv.text('От проблемы на рабочем месте — до внедрённого решения', MX, A4.h - 87,
  { size: 16.5, font: 'bold', color: C.white });
cv.text('Краткая справка для руководства Департамента', MX, A4.h - 104,
  { size: 9.5, color: 'A9BFDA' });

let y = A4.h - 142;
const GAP = 20, LH = 12.6;

// ── Суть ─────────────────────────────────────────────────────
y = para('Social1 превращает инициативы сотрудников учреждений в измеримые улучшения социальных услуг. '
  + 'Это прежде всего управленческая технология и только затем цифровая платформа: каждая инициатива '
  + 'проходит путь из шести этапов и пяти контрольных точек, где у каждой точки есть один ответственный, '
  + 'заранее заданные критерии и предельный срок. Конечный продукт — не база предложений, а поток '
  + 'реально внедрённых улучшений.', MX, y, CW, { size: 10.5, lh: 14.5, color: C.text });

y -= GAP;

// ── Проблема и что меняется ──────────────────────────────────
const colW = (CW - 16) / 2, PAD = 13;
const probLines = wrap('Сотрудник первым видит неэффективность, но путь от увиденной проблемы до '
  + 'изменения регламента или услуги не управляем: нет сроков, отказ приходит без объяснения, '
  + 'эффект не измеряется.', colW - PAD * 2, 8.8);
const solLines = wrap('У каждой инициативы есть номер, этап и ответственный, у каждого шага — срок под '
  + 'контролем системы, у каждого решения — обязательное обоснование. Эффект проверяется на пилоте.',
  colW - PAD * 2, 8.8);
const cardH = PAD * 2 + 12 + Math.max(probLines.length, solLines.length) * 12.2;
[[MX, C.surf, C.danger, 'ПРОБЛЕМА', probLines, C.text2],
 [MX + colW + 16, C.bg, C.ok, 'ЧТО МЕНЯЕТ SOCIAL1', solLines, C.brand2]].forEach(
  ([x, bg, accent, label, lines, col]) => {
    cv.rgb(bg).rect(x, y - cardH, colW, cardH, 'f');
    cv.rgb(accent).rect(x, y - cardH, 2.5, cardH, 'f');
    cv.text(label, x + PAD, y - PAD - 2, { size: 7.8, font: 'bold', color: accent });
    lines.forEach((l, i) => cv.text(l, x + PAD, y - PAD - 17 - i * 12.2, { size: 8.8, color: col }));
  });
y -= cardH + GAP;

// ── Воронка отбора ───────────────────────────────────────────
cv.text('ВОРОНКА ОТБОРА: ЧЕМ ПОЗЖЕ ОТКАЗ, ТЕМ ДОРОЖЕ', MX, y,
  { size: 8, font: 'bold', color: C.text3 });
y -= 12;

const LCOL = 128;                     // подписи слева
const FMAX = 226;                     // ширина горловины сверху
const FX = MX + LCOL + 6;             // левый край области воронки
const CXF = FX + FMAX / 2;            // ось воронки
const BAND = 23;
const levels = [
  ['Подано', '',                          1.00, C.f0, 'время автора'],
  ['Точка 1', 'руководитель · 3 раб. дня', 0.84, C.f1, '+ 3 дня руководителя'],
  ['Точка 2', 'эксперты · 5 раб. дней',    0.69, C.f2, '+ 5 дней экспертизы'],
  ['Точка 3', 'прототип · 4 спринта',      0.53, C.f3, '+ 2 месяца разработки'],
  ['Точка 4', 'пилот · 1 месяц',           0.37, C.f4, '+ месяц работы учреждения'],
  ['Внедрено', 'решение о тиражировании',  0.24, C.ok, ''],
];
const top0 = y;
levels.forEach(([name, sub, frac, fill, cost], i) => {
  const wTop = FMAX * frac;
  const wBot = FMAX * (levels[i + 1] ? levels[i + 1][2] : frac);
  const yTop = top0 - i * BAND;
  const yBot = yTop - BAND;
  // Полоса воронки — трапеция, сужающаяся к следующему уровню
  cv.rgb(fill).poly([
    [CXF - wTop / 2, yTop], [CXF + wTop / 2, yTop],
    [CXF + wBot / 2, yBot], [CXF - wBot / 2, yBot],
  ], 'f');
  // Подпись слева
  cv.text(name, MX, yTop - 11, { size: 9, font: 'bold', color: C.text });
  if (sub) cv.text(sub, MX, yTop - 20, { size: 7, color: C.text3 });
  // Стоимость справа
  if (cost) cv.text(cost, FX + FMAX + 14, yTop - 14.5, { size: 7.5, color: C.text3 });
});
y = top0 - levels.length * BAND - 20;   // запас под подпись нижнего уровня
y = para('Порядок выстроен так, чтобы отказ приходил на самом дешёвом этапе. Решение остановить '
  + 'инициативу не считается провалом: это сэкономленный ресурс, а обоснование пополняет архив '
  + 'опыта и возвращается автору.', MX, y, CW, { size: 9, lh: LH });

y -= GAP;

// ── Контрольные точки: назначение и результат ────────────────
cv.rgb(C.line, true).lineWidth(0.7);
cv.polyline([[MX, y + 8], [MX + CW, y + 8]], 'S');
cv.text('КОНТРОЛЬНЫЕ ТОЧКИ: ЧТО ПРОВЕРЯЕТСЯ И ЧТО НА ВЫХОДЕ', MX, y - 4,
  { size: 8, font: 'bold', color: C.text3 });
y -= 20;

const COLS = [26, 108, 172, CW - 26 - 108 - 172 - 24];   // № · кто и срок · проверяет · результат
const GX = [MX, MX + COLS[0], MX + COLS[0] + COLS[1] + 8, MX + COLS[0] + COLS[1] + COLS[2] + 16];
cv.text('№', GX[0], y, { size: 7.5, font: 'bold', color: C.text3 });
cv.text('РЕШАЕТ И В КАКОЙ СРОК', GX[1], y, { size: 7.5, font: 'bold', color: C.text3 });
cv.text('ЧТО ПРОВЕРЯЕТ', GX[2], y, { size: 7.5, font: 'bold', color: C.text3 });
cv.text('РЕЗУЛЬТАТ', GX[3], y, { size: 7.5, font: 'bold', color: C.text3 });
y -= 8;

const points = [
  ['1', 'Руководитель учреждения\n3 рабочих дня',
   'Соответствие регламентам, потенциал улучшения, реалистичность в бюджете',
   'Инициатива допущена к экспертизе Департамента'],
  ['2', 'Эксперты ДТСЗН\n5 рабочих дней',
   'Стратегическая значимость, масштабируемость, измеримость эффекта',
   'Заданы показатели оценки пилота; инициатива передана в разработку'],
  ['3', 'Продакт-менеджер\n4 спринта по 2 недели',
   'Цели спринтов достигнуты, прототип работает, пользователи подтвердили удобство',
   'Прототип допущен к проверке в реальной работе'],
  ['4', 'Координатор пилотов\n1 месяц + неделя анализа',
   'Эффект подтверждён фактическими данными, нет критических сбоев',
   'Эффект доказан данными учреждения, а не расчётом'],
  ['5', 'Департамент\n2 недели на запуск',
   'Подтверждённый эффект, готовность учреждений, наличие ресурсов',
   'Решение тиражируется по сети учреждений'],
];
const RS = 8.3, RLH = 10.5, RPAD = 6.5;
points.forEach(([n, who, what, res], i) => {
  const whoLines = who.split('\n');
  const whatLines = wrap(what, COLS[2] - 8, RS);
  const resLines = wrap(res, COLS[3], RS);
  const rows = Math.max(whoLines.length, whatLines.length, resLines.length);
  const h = rows * RLH + RPAD * 2;
  const top = y;
  if (i % 2 === 0) cv.rgb(C.surf).rect(MX - 6, top - h, CW + 12, h, 'f');
  cv.rgb(C.brand2).rect(MX - 6, top - h, 2, h, 'f');
  cv.text(n, GX[0], top - RPAD - 7, { size: 10, font: 'bold', color: C.brand2 });
  whoLines.forEach((l, j) => cv.text(l, GX[1], top - RPAD - 7 - j * RLH,
    { size: RS, font: j === 0 ? 'bold' : 'regular', color: j === 0 ? C.text : C.text3 }));
  whatLines.forEach((l, j) => cv.text(l, GX[2], top - RPAD - 7 - j * RLH, { size: RS, color: C.text2 }));
  resLines.forEach((l, j) => cv.text(l, GX[3], top - RPAD - 7 - j * RLH, { size: RS, color: C.brand2, font: 'bold' }));
  y = top - h - 2;
});

// ── Подвал ───────────────────────────────────────────────────
cv.rgb(C.line, true).lineWidth(0.7);
cv.polyline([[MX, 45], [MX + CW, 45]], 'S');
cv.text('Департамент труда и социальной защиты населения города Москвы', MX, 33,
  { size: 8, color: C.text3 });
cv.text('[ФИО, должность] · [контакт] · [дата]', A4.w - MX, 33,
  { size: 8, align: 'right', color: C.text3 });

doc.addPage(A4.w, A4.h, cv.toString());
writeFileSync('Social1-kratkaya-spravka.pdf', doc.build());
console.log('записано: Social1-kratkaya-spravka.pdf');
