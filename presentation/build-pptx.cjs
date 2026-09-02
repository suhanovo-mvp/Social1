// Сборка презентации Social1 для руководства ДТСЗН.
// Палитра взята из портала; шрифты — из поставки Office (кириллица без подстановки).
const pptxgen = require('pptxgenjs');

const C = {
  navy: '12294C', brand: '1B3A6B', brand2: '24508F', brand3: '2F66B5', brand4: '3D80D8',
  ice: 'DDE9F9', bg: 'EFF5FD', white: 'FFFFFF',
  text: '141B28', text2: '4A5568', text3: '7C8798',
  line: 'DFE4ED', surf: 'F9FAFC',
  ok: '1A7F52', okBg: 'E3F5EC', warn: 'A8620A', warnBg: 'FDF0DD',
  danger: 'B32B2B', dangerBg: 'FBE7E7', purple: '6B3FA0', purpleBg: 'F0E9F9',
};
const F = { head: 'Cambria', body: 'Calibri' };
const MX = 0.62, W = 13.333, CW = W - MX * 2;

const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE';
pres.author = 'ДТСЗН';
pres.title = 'Social1 — экосистема системных инноваций ДТСЗН';

// ── Общие элементы ───────────────────────────────────────────
function eyebrow(s, t, y = 0.5) {
  s.addText(t.toUpperCase(), { x: MX, y, w: CW, h: 0.26, isTextBox: true, margin: 0,
    fontFace: F.body, fontSize: 11, bold: true, charSpacing: 2, color: C.text3 });
}
function title(s, t, y = 0.8, size = 31) {
  s.addText(t, { x: MX, y, w: CW, h: size > 34 ? 1.35 : 1.0, isTextBox: true, margin: 0,
    fontFace: F.head, fontSize: size, bold: true, color: C.text, lineSpacing: size * 1.12 });
}
function lede(s, t, y, h = 0.7) {
  s.addText(t, { x: MX, y, w: CW * 0.78, h, isTextBox: true, margin: 0,
    fontFace: F.body, fontSize: 15, color: C.text2, lineSpacing: 21 });
}
function footer(s, n) {
  s.addText('Social1 · Экосистема системных инноваций ДТСЗН', { x: MX, y: 6.92, w: 8, h: 0.3,
    isTextBox: true, margin: 0, fontFace: F.body, fontSize: 10, color: 'A3ADBD' });
  s.addText(String(n), { x: W - MX - 1, y: 6.92, w: 1, h: 0.3, isTextBox: true, margin: 0,
    align: 'right', fontFace: F.body, fontSize: 10, color: 'A3ADBD' });
}
function card(s, { x, y, w, h, fill = C.white, line = C.line, radius = true }) {
  s.addShape(radius ? pres.ShapeType.roundRect : pres.ShapeType.rect, {
    x, y, w, h, fill: { color: fill }, line: { color: line, width: 1 }, rectRadius: 0.06 });
}

// ═══ 1. Титул ═══
{
  const s = pres.addSlide();
  s.background = { color: C.navy };
  s.addShape(pres.ShapeType.ellipse, { x: 9.6, y: -2.4, w: 6.6, h: 6.6,
    fill: { color: C.white, transparency: 95 }, line: { color: C.navy, width: 0 } });
  s.addShape(pres.ShapeType.roundRect, { x: MX, y: 0.55, w: 0.48, h: 0.48,
    fill: { color: C.white, transparency: 84 }, line: { color: C.navy, width: 0 }, rectRadius: 0.14 });
  s.addText('S1', { x: MX, y: 0.55, w: 0.48, h: 0.48, isTextBox: true, margin: 0, align: 'center',
    valign: 'middle', fontFace: F.body, fontSize: 14, bold: true, color: C.white });
  s.addText('Social1', { x: MX + 0.62, y: 0.55, w: 3, h: 0.48, isTextBox: true, margin: 0,
    valign: 'middle', fontFace: F.head, fontSize: 18, bold: true, color: C.white });

  s.addText('ЭКОСИСТЕМА СИСТЕМНЫХ ИННОВАЦИЙ', { x: MX, y: 2.15, w: CW, h: 0.3, isTextBox: true,
    margin: 0, fontFace: F.body, fontSize: 11.5, bold: true, charSpacing: 2.4, color: '7FA0C8' });
  s.addText('От проблемы на рабочем месте — до внедрённого решения',
    { x: MX, y: 2.55, w: 8.9, h: 1.9, isTextBox: true, margin: 0, fontFace: F.head, fontSize: 42,
      bold: true, color: C.white, lineSpacing: 48 });
  s.addText('Управленческая платформа для выявления, разработки, проверки и тиражирования инициатив сотрудников учреждений ДТСЗН',
    { x: MX, y: 4.6, w: 7.9, h: 0.9, isTextBox: true, margin: 0, fontFace: F.body, fontSize: 16,
      color: 'C3D3E8', lineSpacing: 23 });

  s.addText([{ text: 'Департамент труда и социальной защиты\n', options: { fontSize: 11, color: '7089AC' } },
             { text: 'населения города Москвы', options: { fontSize: 13, color: 'D3DFEE' } }],
    { x: MX, y: 6.35, w: 4, h: 0.75, isTextBox: true, margin: 0, fontFace: F.body, lineSpacing: 17 });
  s.addText([{ text: 'Докладчик и дата\n', options: { fontSize: 11, color: '7089AC' } },
             { text: '[ФИО, должность] · [дата]', options: { fontSize: 13, color: 'D3DFEE' } }],
    { x: 4.9, y: 6.35, w: 4.5, h: 0.75, isTextBox: true, margin: 0, fontFace: F.body, lineSpacing: 17 });
  s.addNotes('Титул. Представиться и обозначить: речь не о ещё одной информационной системе, а об управленческой технологии, у которой уже есть работающая платформа.');
}

// ═══ 2. Проблема ═══
{
  const s = pres.addSlide();
  eyebrow(s, 'Проблема');
  title(s, 'Сотрудник видит проблему первым. Изменение приходит последним');
  lede(s, 'Именно сотрудник учреждения ежедневно работает с гражданами, регламентами и социальными технологиями — и первым сталкивается с избыточной операцией или новой потребностью. Но путь от увиденной проблемы до изменения регламента или сервиса сегодня не управляем.', 2.15, 0.95);

  const cw = (CW - 0.4) / 2;
  card(s, { x: MX, y: 3.2, w: cw, h: 3.35, fill: C.surf });
  s.addText('КАК СЕЙЧАС', { x: MX + 0.3, y: 3.45, w: cw - 0.6, h: 0.3, isTextBox: true, margin: 0,
    fontFace: F.body, fontSize: 11, bold: true, charSpacing: 1.8, color: C.danger });
  s.addText([
    { text: 'Инициатива уходит «наверх» и теряется из виду', options: { breakLine: true } },
    { text: 'Нет сроков — решение может не приниматься месяцами', options: { breakLine: true } },
    { text: 'Отказ приходит без объяснения — мотивация падает', options: { breakLine: true } },
    { text: 'Эффект не измеряется, опыт не накапливается' },
  ], { x: MX + 0.3, y: 3.95, w: cw - 0.6, h: 2.3, isTextBox: true, margin: 0, bullet: { code: '2013' },
       fontFace: F.body, fontSize: 14.5, color: C.text2, paraSpaceAfter: 10, lineSpacing: 20 });

  card(s, { x: MX + cw + 0.4, y: 3.2, w: cw, h: 3.35, fill: C.bg, line: C.brand2 });
  s.addText('КАК В SOCIAL1', { x: MX + cw + 0.7, y: 3.45, w: cw - 0.6, h: 0.3, isTextBox: true,
    margin: 0, fontFace: F.body, fontSize: 11, bold: true, charSpacing: 1.8, color: C.ok });
  s.addText([
    { text: 'Каждая инициатива имеет номер, этап и ответственного', options: { breakLine: true } },
    { text: 'На каждом шаге — срок, который контролирует система', options: { breakLine: true } },
    { text: 'Любое решение сопровождается обоснованием', options: { breakLine: true } },
    { text: 'Эффект проверяется на пилоте до тиражирования' },
  ], { x: MX + cw + 0.7, y: 3.95, w: cw - 0.6, h: 2.3, isTextBox: true, margin: 0, bullet: { code: '2013' },
       fontFace: F.body, fontSize: 14.5, color: C.brand2, paraSpaceAfter: 10, lineSpacing: 20 });
  footer(s, 2);
  s.addNotes('Ключевая мысль: проблема не в отсутствии идей, а в отсутствии управляемого пути от идеи до изменения.');
}

// ═══ 3. Суть ═══
{
  const s = pres.addSlide();
  eyebrow(s, 'Суть');
  title(s, 'Social1 — не книга предложений, а конвейер изменений');

  const cols = [
    ['Управленческая технология', 'Сначала — правила игры: кто решает, по каким критериям и в какой срок. Цифровая платформа лишь автоматизирует эти правила и делает их прозрачными.'],
    ['Источник — сотрудник', 'Изменения не только спускаются сверху, но и системно поднимаются снизу — от тех, кто непосредственно работает с услугами и процессами.'],
    ['Продукт — поток внедрений', 'Конечный результат экосистемы — не количество поданных идей, а поток реально внедрённых улучшений социальных услуг и процессов.'],
  ];
  const cw = (CW - 0.7) / 3;
  cols.forEach(([h, b], i) => {
    const x = MX + i * (cw + 0.35);
    s.addShape(pres.ShapeType.rect, { x, y: 2.35, w: cw, h: 0.045, fill: { color: C.brand }, line: { width: 0 } });
    s.addText(h, { x, y: 2.6, w: cw, h: 0.75, isTextBox: true, margin: 0, fontFace: F.head,
      fontSize: 19, bold: true, color: C.text, lineSpacing: 23 });
    s.addText(b, { x, y: 3.45, w: cw, h: 1.6, isTextBox: true, margin: 0, fontFace: F.body,
      fontSize: 14, color: C.text2, lineSpacing: 20 });
  });

  s.addShape(pres.ShapeType.roundRect, { x: MX, y: 5.35, w: CW, h: 1.2,
    fill: { color: C.navy }, line: { width: 0 }, rectRadius: 0.06 });
  s.addText('КОРОТКИЙ ЦИКЛ', { x: MX + 0.42, y: 5.62, w: 2.1, h: 0.3, isTextBox: true, margin: 0,
    fontFace: F.body, fontSize: 10.5, bold: true, charSpacing: 1.8, color: '7089AC' });
  const steps = ['Проблема', 'Инициатива', 'Экспертиза', 'Прототип', 'Пилот', 'Эффект', 'Масштабирование'];
  const runs = [];
  steps.forEach((t, i) => {
    runs.push({ text: t, options: { color: i === 6 ? '7FD9AC' : C.white, bold: true } });
    if (i < 6) runs.push({ text: '   →   ', options: { color: '5A7295' } });
  });
  s.addText(runs, { x: MX + 2.6, y: 5.6, w: CW - 3, h: 0.7, isTextBox: true, margin: 0,
    valign: 'middle', fontFace: F.body, fontSize: 14.5 });
  footer(s, 3);
  s.addNotes('Отличие от классической книги предложений: у каждой инициативы есть путь, а у пути — сроки и ответственные.');
}

// ═══ 4. Воронка отбора ═══
{
  const s = pres.addSlide();
  eyebrow(s, 'Логика отбора');
  title(s, 'Отсеивать рано и дёшево — цена отказа растёт с каждым этапом', 0.8, 29);
  lede(s, 'Ворота устроены так, чтобы отказ приходил на самом дешёвом из возможных этапов. Инициатива, остановленная за 3 дня, стоит времени одного руководителя; та же инициатива после пилота — двух месяцев разработки и месяца работы учреждения.', 2.1, 0.75);

  const bars = [
    ['Подано инициатив', 'вложено: время автора', 9.4, C.ice, C.navy, 'форма из четырёх вопросов'],
    ['Прошли Gate 1', '+ 3 рабочих дня руководителя', 7.8, 'BCD6F4', C.navy, 'отсев: не соответствует регламентам или бюджету'],
    ['Прошли Gate 2', '+ 5 рабочих дней экспертизы', 6.2, '8FB9EA', C.navy, 'отсев: нет стратегической значимости'],
    ['Прошли Gate 3', '+ 2 месяца разработки', 4.6, '5B91D8', C.white, 'отсев: прототип не подтвердил замысел'],
    ['Прошли Gate 4', '+ месяц работы пилотного учреждения', 3.1, C.brand3, C.white, 'отсев: эффект не доказан'],
    ['Внедрено', '', 1.9, C.ok, C.white, 'решение с подтверждённым эффектом уходит в тиражирование'],
  ];
  bars.forEach(([label, cost, w, fill, fg, note], i) => {
    const y = 3.05 + i * 0.55;
    s.addShape(pres.ShapeType.roundRect, { x: MX, y, w, h: 0.42, fill: { color: fill },
      line: { width: 0 }, rectRadius: 0.04 });
    // Стоимость печатается внутри полосы только там, где она помещается рядом с названием
    const inside = cost && w >= 5.5;
    s.addText(label, { x: MX + 0.22, y, w: Math.min(2.6, w - 0.44), h: 0.42, isTextBox: true,
      margin: 0, valign: 'middle', fontFace: F.body, fontSize: 13, bold: true, color: fg });
    if (inside) s.addText(cost, { x: MX + w - 3.3, y, w: 3.08, h: 0.42, isTextBox: true, margin: 0,
      align: 'right', valign: 'middle', fontFace: F.body, fontSize: 11.5,
      color: fg === C.white ? 'DCE9F8' : C.brand2 });
    const tail = inside ? note : (cost ? `${cost} · ${note}` : note);
    s.addText(tail, { x: MX + w + 0.2, y, w: CW - w - 0.2, h: 0.42, isTextBox: true, margin: 0,
      valign: 'middle', fontFace: F.body, fontSize: 11, color: C.text3 });
  });

  const notes = [[C.brand, 'Узкое место видно сразу.', ' Если большинство инициатив останавливается на одних воротах — там не хватает экспертизы, ресурсов или норматив занижен.'],
                 [C.ok, 'Отказ — это результат.', ' Он экономит ресурс и попадает в архив опыта, а автор получает объяснение, а не молчание.']];
  const nw = (CW - 0.3) / 2;
  notes.forEach(([col, b, t], i) => {
    const x = MX + i * (nw + 0.3);
    s.addShape(pres.ShapeType.rect, { x, y: 6.35, w: 0.045, h: 0.6, fill: { color: col }, line: { width: 0 } });
    s.addText([{ text: b, options: { bold: true, color: C.text } }, { text: t, options: { color: C.text2 } }],
      { x: x + 0.18, y: 6.35, w: nw - 0.25, h: 0.6, isTextBox: true, margin: 0, valign: 'middle',
        fontFace: F.body, fontSize: 11.5, lineSpacing: 14 });
  });
  footer(s, 4);
  s.addNotes('Главный управленческий тезис всей презентации: строгий и быстрый отбор на первых воротах — это не бюрократия, а экономия месяцев работы.');
}

// ═══ 5. Конвейер и устройство ворот ═══
{
  const s = pres.addSlide();
  eyebrow(s, 'Жизненный цикл');
  title(s, 'Шесть стадий, пять точек принятия решений, срок на каждой');
  lede(s, 'Модель «этап — ворота»: работы отделены от решений. На каждой точке решает один ответственный участник.', 2.15, 0.6);

  const stages = [
    ['ЭТАП 1', 'Фиксация проблемы', 'без ворот', false],
    ['ЭТАП 2', 'Оценка руководителем', 'Gate 1 · 3 раб. дня', false],
    ['ЭТАП 2', 'Экспертиза ДТСЗН', 'Gate 2 · 5 раб. дней', false],
    ['ЭТАП 3', 'Разработка прототипа', 'Gate 3 · 4 спринта', false],
    ['ЭТАП 4', 'Пилотирование', 'Gate 4 · 1 месяц', false],
    ['ЭТАП 5', 'Масштабирование', 'Gate 5 · 2 недели', true],
  ];
  const bw = (CW - 0.5) / 6;
  stages.forEach(([e, n, g, dark], i) => {
    const x = MX + i * (bw + 0.1);
    s.addShape(pres.ShapeType.roundRect, { x, y: 2.85, w: bw, h: 1.35,
      fill: { color: dark ? C.navy : C.surf }, line: { color: dark ? C.navy : C.line, width: 1 }, rectRadius: 0.05 });
    s.addText(e, { x: x + 0.16, y: 2.97, w: bw - 0.32, h: 0.24, isTextBox: true, margin: 0,
      fontFace: F.body, fontSize: 9.5, bold: true, charSpacing: 1.2, color: dark ? '7089AC' : C.text3 });
    s.addText(n, { x: x + 0.16, y: 3.22, w: bw - 0.32, h: 0.56, isTextBox: true, margin: 0,
      fontFace: F.body, fontSize: 13, bold: true, color: dark ? C.white : C.text, lineSpacing: 16 });
    s.addText(g, { x: x + 0.16, y: 3.82, w: bw - 0.32, h: 0.3, isTextBox: true, margin: 0,
      fontFace: F.body, fontSize: 10.5, bold: !g.startsWith('без'),
      color: dark ? '9DC4F5' : (g.startsWith('без') ? C.text3 : C.brand2) });
  });

  s.addShape(pres.ShapeType.roundRect, { x: MX, y: 4.35, w: CW, h: 1.85, fill: { color: C.white },
    line: { color: C.line, width: 1 }, rectRadius: 0.05 });
  s.addText('УСТРОЙСТВО ЛЮБЫХ ВОРОТ', { x: MX + 0.32, y: 4.57, w: 4, h: 0.26, isTextBox: true,
    margin: 0, fontFace: F.body, fontSize: 10.5, bold: true, charSpacing: 1.6, color: C.text3 });
  const anat = [['Триггер', 'Что запускает рассмотрение и когда начинается отсчёт'],
                ['Ответственный', 'Одна роль, а не коллегиальное «мы подумаем»'],
                ['Критерии', 'Заданы заранее, оцениваются по каждому отдельно'],
                ['Срок', 'Контролируется системой, просрочка эскалируется'],
                ['Решение', 'Из заданного перечня, с обязательным обоснованием']];
  const aw = (CW - 0.64 - 0.6) / 5;
  anat.forEach(([h, d], i) => {
    const x = MX + 0.32 + i * (aw + 0.15);
    s.addText(h, { x, y: 4.93, w: aw, h: 0.3, isTextBox: true, margin: 0, fontFace: F.body,
      fontSize: 13.5, bold: true, color: C.text });
    s.addText(d, { x, y: 5.25, w: aw, h: 0.8, isTextBox: true, margin: 0, fontFace: F.body,
      fontSize: 11.5, color: C.text2, lineSpacing: 14.5 });
  });
  s.addText('Дальше — что именно оценивается на каждых воротах и какими доказательствами это подтверждается.',
    { x: MX, y: 6.38, w: CW, h: 0.35, isTextBox: true, margin: 0, fontFace: F.body,
      fontSize: 13, color: C.text2 });
  footer(s, 5);
  s.addNotes('Здесь важно проговорить: ворота — не согласование, а точка с заранее известными критериями и одним ответственным.');
}

// ═══ 6. Ворота 1–2 ═══
{
  const s = pres.addSlide();
  eyebrow(s, 'Отбор идей');
  title(s, 'Ворота 1 и 2: от «есть идея» до «беремся разрабатывать»');

  const gates = [
    [C.brand, 'Gate 1 — руководитель учреждения', '3 рабочих дня',
     ['Соответствие внутренним политикам и регламентам', 'Наличие потенциала для локального улучшения',
      'Реалистичность в рамках бюджетных ограничений'],
     'Описание проблемы с фактическими данными автора, количественная оценка эффекта, поддержка коллег на доске идей, подсказка о похожих инициативах',
     'ВОЗМОЖНЫЕ РЕШЕНИЯ', null],
    [C.brand2, 'Gate 2 — комитет экспертов ДТСЗН', '5 рабочих дней',
     ['Стратегическая совместимость с целями Департамента', 'Потенциал масштабирования на другие учреждения',
      'Ожидаемый эффект и его измеримость', 'Техническая осуществимость на уровне идеи'],
     'Решение и обоснование руководителя, оценка похожих инициатив в системе, заключение команды цифровой трансформации о выполнимости',
     'ЧТО ФИКСИРУЕТСЯ ПРИ GO', 'Показатели, по которым позже будет оцениваться пилот'],
  ];
  const cw = (CW - 0.4) / 2;
  gates.forEach(([col, head, sla, crit, basis, lastLabel, lastText], i) => {
    const x = MX + i * (cw + 0.4);
    s.addShape(pres.ShapeType.roundRect, { x, y: 2.3, w: cw, h: 3.95, fill: { color: C.white },
      line: { color: C.line, width: 1 }, rectRadius: 0.05 });
    s.addShape(pres.ShapeType.rect, { x, y: 2.3, w: cw, h: 0.55, fill: { color: col }, line: { width: 0 } });
    s.addText(head, { x: x + 0.26, y: 2.3, w: cw - 2.2, h: 0.55, isTextBox: true, margin: 0,
      valign: 'middle', fontFace: F.body, fontSize: 14, bold: true, color: C.white });
    s.addText(sla, { x: x + cw - 1.85, y: 2.3, w: 1.6, h: 0.55, isTextBox: true, margin: 0,
      align: 'right', valign: 'middle', fontFace: F.body, fontSize: 11.5, bold: true, color: '9DC4F5' });

    let y = 3.02;
    s.addText('ЧТО ОЦЕНИВАЕТ', { x: x + 0.26, y, w: cw - 0.52, h: 0.24, isTextBox: true, margin: 0,
      fontFace: F.body, fontSize: 10, bold: true, charSpacing: 1.5, color: C.text3 });
    y += 0.28;
    s.addText(crit.map((t, j) => ({ text: t, options: { breakLine: j < crit.length - 1 } })),
      { x: x + 0.26, y, w: cw - 0.52, h: crit.length * 0.26, isTextBox: true, margin: 0,
        fontFace: F.body, fontSize: 12.5, color: C.text2, paraSpaceAfter: 4, lineSpacing: 16 });
    y += crit.length * 0.26 + 0.16;
    s.addText('НА ЧЁМ ОСНОВАНО РЕШЕНИЕ', { x: x + 0.26, y, w: cw - 0.52, h: 0.24, isTextBox: true,
      margin: 0, fontFace: F.body, fontSize: 10, bold: true, charSpacing: 1.5, color: C.text3 });
    s.addText(basis, { x: x + 0.26, y: y + 0.28, w: cw - 0.52, h: 0.8, isTextBox: true, margin: 0,
      fontFace: F.body, fontSize: 12.5, color: C.text2, lineSpacing: 16 });
    y += 1.18;
    s.addText(lastLabel, { x: x + 0.26, y, w: cw - 0.52, h: 0.24, isTextBox: true, margin: 0,
      fontFace: F.body, fontSize: 10, bold: true, charSpacing: 1.5, color: C.text3 });
    if (lastText) {
      s.addText(lastText, { x: x + 0.26, y: y + 0.28, w: cw - 0.52, h: 0.4, isTextBox: true,
        margin: 0, fontFace: F.body, fontSize: 12.5, bold: true, color: C.brand2, lineSpacing: 16 });
    } else {
      const chips = [['Go', C.ok, C.okBg], ['Kill', C.danger, C.dangerBg],
                     ['Hold', C.warn, C.warnBg], ['Redirect', C.purple, C.purpleBg]];
      let cx = x + 0.26;
      chips.forEach(([t, fg, bgc]) => {
        const w = 0.32 + t.length * 0.085;
        s.addShape(pres.ShapeType.roundRect, { x: cx, y: y + 0.3, w, h: 0.28,
          fill: { color: bgc }, line: { width: 0 }, rectRadius: 0.14 });
        s.addText(t, { x: cx, y: y + 0.3, w, h: 0.28, isTextBox: true, margin: 0, align: 'center',
          valign: 'middle', fontFace: F.body, fontSize: 11, bold: true, color: fg });
        cx += w + 0.1;
      });
    }
  });

  s.addShape(pres.ShapeType.roundRect, { x: MX, y: 6.4, w: CW, h: 0.45, fill: { color: C.bg },
    line: { width: 0 }, rectRadius: 0.05 });
  s.addText([{ text: 'Оценка ведётся по каждому критерию отдельно, баллами. ', options: { bold: true } },
             { text: 'Оценки сохраняются в карточке инициативы вместе с обоснованием — решение нельзя свести к «не подходит».' }],
    { x: MX + 0.3, y: 6.4, w: CW - 0.6, h: 0.45, isTextBox: true, margin: 0, valign: 'middle',
      fontFace: F.body, fontSize: 12, color: C.brand2 });
  footer(s, 6);
  s.addNotes('Ключ к слайду: критерии известны автору заранее — он может подготовить инициативу так, чтобы её было можно оценить.');
}

// ═══ 7. Ворота 3–5 ═══
{
  const s = pres.addSlide();
  eyebrow(s, 'Отбор решений');
  title(s, 'Ворота 3, 4 и 5: от прототипа до тиражирования');
  lede(s, 'Дальше отбор идёт не по замыслу, а по доказательствам: работает ли решение, подтвердился ли обещанный эффект, готова ли сеть учреждений его принять.', 2.15, 0.6);

  const gates = [
    [C.brand3, 'Gate 3 — готовность прототипа', 'продакт-менеджер ДТСЗН · 4 спринта',
     ['Достигнуты цели спринтов', 'Есть работающий MVP', 'Положительная обратная связь на демонстрациях'],
     'ДОКАЗАТЕЛЬСТВО', 'Демонстрация будущим пользователям до пилота, а не после'],
    [C.brand2, 'Gate 4 — результаты пилота', 'координатор пилотов · 1 месяц + неделя',
     ['Заявленный эффект подтверждён фактическими данными', 'Высокая удовлетворённость пользователей',
      'Нет критических технических и организационных проблем', 'Соблюдены требования к защите данных'],
     'ДОКАЗАТЕЛЬСТВО', 'Показатели «до» и «после», опросы сотрудников и граждан'],
    [C.navy, 'Gate 5 — решение о тиражировании', 'ДТСЗН · начало в течение 2 недель',
     ['Подтверждённый эффект пилота', 'Готовность других учреждений к внедрению',
      'Наличие финансовых и кадровых ресурсов'],
     'ЕСЛИ KILL', 'Решение остаётся в библиотеке практик для добровольного внедрения'],
  ];
  const cw = (CW - 0.5) / 3;
  gates.forEach(([col, head, who, crit, lbl, txt], i) => {
    const x = MX + i * (cw + 0.25);
    s.addShape(pres.ShapeType.roundRect, { x, y: 2.85, w: cw, h: 3.55, fill: { color: C.white },
      line: { color: col === C.navy ? C.navy : C.line, width: 1 }, rectRadius: 0.05 });
    s.addShape(pres.ShapeType.rect, { x, y: 2.85, w: cw, h: 0.72, fill: { color: col }, line: { width: 0 } });
    s.addText(head, { x: x + 0.24, y: 2.95, w: cw - 0.48, h: 0.3, isTextBox: true, margin: 0,
      fontFace: F.body, fontSize: 13, bold: true, color: C.white });
    s.addText(who, { x: x + 0.24, y: 3.25, w: cw - 0.48, h: 0.26, isTextBox: true, margin: 0,
      fontFace: F.body, fontSize: 10.5, color: col === C.navy ? '9DC4F5' : 'CFE0F7' });
    s.addText('КРИТЕРИИ', { x: x + 0.24, y: 3.72, w: cw - 0.48, h: 0.22, isTextBox: true, margin: 0,
      fontFace: F.body, fontSize: 9.5, bold: true, charSpacing: 1.4, color: C.text3 });
    s.addText(crit.map((t, j) => ({ text: t, options: { breakLine: j < crit.length - 1 } })),
      { x: x + 0.24, y: 3.98, w: cw - 0.48, h: 1.4, isTextBox: true, margin: 0, fontFace: F.body,
        fontSize: 12, color: C.text2, paraSpaceAfter: 4, lineSpacing: 15.5 });
    s.addText(lbl, { x: x + 0.24, y: 5.5, w: cw - 0.48, h: 0.22, isTextBox: true, margin: 0,
      fontFace: F.body, fontSize: 9.5, bold: true, charSpacing: 1.4, color: C.text3 });
    s.addText(txt, { x: x + 0.24, y: 5.76, w: cw - 0.48, h: 0.55, isTextBox: true, margin: 0,
      fontFace: F.body, fontSize: 12, color: C.text2, lineSpacing: 15.5 });
  });

  s.addShape(pres.ShapeType.rect, { x: MX, y: 6.45, w: 0.045, h: 0.42, fill: { color: C.danger }, line: { width: 0 } });
  s.addText([{ text: 'Здесь отсеиваются решения, которые хорошо выглядели на бумаге. ', options: { bold: true, color: C.text } },
             { text: 'Именно поэтому эффект заявляется числом уже при подаче: на Gate 4 прогноз сравнивается с фактом.', options: { color: C.text2 } }],
    { x: MX + 0.2, y: 6.45, w: CW - 0.25, h: 0.42, isTextBox: true, margin: 0, valign: 'middle',
      fontFace: F.body, fontSize: 12 });
  footer(s, 7);
  s.addNotes('Gate 4 — самая важная точка: она отделяет решения, которые действительно работают, от тех, что казались удачными.');
}

// ═══ 8. Четыре решения и маршруты ═══
{
  const s = pres.addSlide();
  eyebrow(s, 'Механика решения');
  title(s, 'Четыре решения — и у каждого свой маршрут');
  lede(s, 'На любых воротах доступен один и тот же набор. Отличается только то, куда инициатива уходит дальше и что происходит с вложенным в неё ресурсом.', 2.15, 0.6);

  const rows = [
    ['Go', 'продолжить', C.ok, C.okBg,
     'Инициатива переходит на следующий этап. Система назначает нового ответственного, создаёт ему задачу и запускает отсчёт срока',
     'Автор получает уведомление о продвижении'],
    ['Kill', 'остановить', C.danger, C.dangerBg,
     'Работа прекращается, ресурс освобождается. Обоснование сохраняется в архиве и доступно при рассмотрении похожих инициатив',
     'Автор получает отказ с объяснением причины'],
    ['Hold', 'приостановить', C.warn, C.warnBg,
     'Инициатива остаётся на этапе, отсчёт срока останавливается. Возобновить может автор, ответственный или координатор',
     'Автор видит, каких именно сведений не хватает'],
    ['Redirect', 'на доработку', C.purple, C.purpleBg,
     'Возвращается на выбранный предыдущий этап с замечаниями. Частый случай — объединение с похожей инициативой',
     'Автор получает перечень того, что доработать'],
  ];
  const rh = 0.85;
  rows.forEach(([n, sub, col, bgc, what, who], i) => {
    const y = 2.75 + i * (rh + 0.12);
    s.addShape(pres.ShapeType.roundRect, { x: MX, y, w: CW, h: rh, fill: { color: C.white },
      line: { color: C.line, width: 1 }, rectRadius: 0.05 });
    s.addShape(pres.ShapeType.rect, { x: MX + 0.01, y: y + 0.01, w: 1.75, h: rh - 0.02,
      fill: { color: bgc }, line: { width: 0 } });
    s.addText(n, { x: MX + 0.26, y: y + 0.12, w: 1.4, h: 0.32, isTextBox: true, margin: 0,
      fontFace: F.head, fontSize: 18, bold: true, color: col });
    s.addText(sub, { x: MX + 0.26, y: y + 0.47, w: 1.4, h: 0.26, isTextBox: true, margin: 0,
      fontFace: F.body, fontSize: 11, color: C.text2 });
    s.addText(what, { x: MX + 2.0, y: y + 0.11, w: 6.5, h: 0.63, isTextBox: true, margin: 0,
      valign: 'middle', fontFace: F.body, fontSize: 12.5, color: C.text2, lineSpacing: 16 });
    s.addShape(pres.ShapeType.rect, { x: MX + 8.7, y: y + 0.11, w: 0.008, h: rh - 0.22,
      fill: { color: C.line }, line: { width: 0 } });
    s.addText(who, { x: MX + 8.9, y: y + 0.11, w: CW - 9.15, h: 0.63, isTextBox: true, margin: 0,
      valign: 'middle', fontFace: F.body, fontSize: 12, color: C.text3, lineSpacing: 15 });
  });

  s.addText('Перечень допустимых решений задаётся для каждых ворот отдельно: например, на Gate 5 доступны только Go и Kill — возвращать на доработку решение, прошедшее пилот, поздно.',
    { x: MX, y: 6.45, w: CW, h: 0.44, isTextBox: true, margin: 0, fontFace: F.body,
      fontSize: 11.5, color: C.text2, lineSpacing: 14 });
  footer(s, 8);
  s.addNotes('Hold и Redirect — то, чего нет в обычной практике: инициатива не отклоняется, а возвращается с конкретным перечнем недостающего.');
}

// ═══ 9. Честность отбора ═══
{
  const s = pres.addSlide();
  eyebrow(s, 'Честность отбора');
  title(s, 'Четыре правила, которые не дают отбору стать формальностью');

  const items = [
    ['Решение без обоснования не принимается', 'Система отклоняет решение на воротах без аргументации. Автор всегда узнаёт, почему получил именно такой ответ, а не остаётся без объяснения.'],
    ['Оценка идёт по заданным критериям', 'Перечень критериев для каждых ворот определён заранее. Оценка ставится по каждому отдельно и сохраняется в карточке — решение нельзя свести к «не подходит».'],
    ['Срок нельзя проигнорировать', 'Отсчёт идёт в рабочих днях и виден всем участникам. Просроченная задача автоматически эскалируется координатору экосистемы.'],
    ['Журнал действий неизменяем', 'Записи связаны криптографической цепочкой: изменение или удаление задним числом ломает цепочку и выявляется проверкой целостности.'],
  ];
  const cw = (CW - 0.35) / 2, ch = 1.5;
  items.forEach(([h, d], i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = MX + col * (cw + 0.35), y = 2.35 + row * (ch + 0.3);
    s.addShape(pres.ShapeType.roundRect, { x, y, w: cw, h: ch, fill: { color: C.white },
      line: { color: C.line, width: 1 }, rectRadius: 0.05 });
    s.addText(h, { x: x + 0.28, y: y + 0.22, w: cw - 0.56, h: 0.35, isTextBox: true, margin: 0,
      fontFace: F.body, fontSize: 14.5, bold: true, color: C.text });
    s.addText(d, { x: x + 0.28, y: y + 0.62, w: cw - 0.56, h: 0.75, isTextBox: true, margin: 0,
      fontFace: F.body, fontSize: 12.5, color: C.text2, lineSpacing: 16 });
  });

  s.addShape(pres.ShapeType.roundRect, { x: MX, y: 5.75, w: CW, h: 0.95, fill: { color: C.navy },
    line: { width: 0 }, rectRadius: 0.05 });
  s.addText('Сами правила настраиваются без участия разработчиков: сроки, критерии, ответственные роли и перечень допустимых решений меняются в интерфейсе и вступают в силу немедленно.',
    { x: MX + 0.35, y: 5.75, w: CW - 3.4, h: 0.95, isTextBox: true, margin: 0, valign: 'middle',
      fontFace: F.body, fontSize: 13.5, color: 'C3D3E8', lineSpacing: 18 });
  s.addText('АДАПТИВНОСТЬ ОТБОРА', { x: W - MX - 2.9, y: 5.75, w: 2.55, h: 0.95, isTextBox: true,
    margin: 0, align: 'right', valign: 'middle', fontFace: F.body, fontSize: 10.5, bold: true,
    charSpacing: 1.4, color: '7FA0C8' });
  footer(s, 9);
  s.addNotes('Ответ на вопрос «а если сроки или критерии окажутся неудачными» — они меняются в интерфейсе, без обращения к разработчикам.');
}

// ═══ 10. Участники ═══
{
  const s = pres.addSlide();
  eyebrow(s, 'Участники');
  title(s, 'Семь ролей, у каждой — своя зона ответственности');
  const roles = [
    ['Сотрудник учреждения', 'Находит проблему, формулирует инициативу, работает на пилоте', null],
    ['Руководитель учреждения', 'Владелец процессов, первый уровень отбора', 'Gate 1'],
    ['Эксперт ДТСЗН', 'Оценивает стратегическую значимость и масштабируемость', 'Gate 2'],
    ['Команда разработки и ЦТ', 'Превращает идею в работающий прототип', 'Gate 3'],
    ['Координатор пилотов', 'Ведёт проверку в реальных условиях и сбор доказательств', 'Gate 4'],
    ['Пилотное учреждение', 'Площадка проверки: внедряет прототип и даёт обратную связь', null],
    ['Поставщик технологий', 'Даёт готовые компоненты и компетенции', null],
    ['ДТСЗН', 'Координатор экосистемы: портфель, приоритеты, ресурсы', 'Gate 5'],
  ];
  const cw = (CW - 0.75) / 4, ch = 1.75;
  roles.forEach(([n, d, g], i) => {
    const col = i % 4, row = Math.floor(i / 4);
    const x = MX + col * (cw + 0.25), y = 2.4 + row * (ch + 0.3);
    const dark = i === 7;
    s.addShape(pres.ShapeType.roundRect, { x, y, w: cw, h: ch,
      fill: { color: dark ? C.navy : C.white }, line: { color: dark ? C.navy : C.line, width: 1 }, rectRadius: 0.05 });
    s.addText(n, { x: x + 0.22, y: y + 0.2, w: cw - 0.44, h: 0.5, isTextBox: true, margin: 0,
      fontFace: F.body, fontSize: 14, bold: true, color: dark ? C.white : C.text, lineSpacing: 17 });
    s.addText(d, { x: x + 0.22, y: y + 0.72, w: cw - 0.44, h: 0.65, isTextBox: true, margin: 0,
      fontFace: F.body, fontSize: 12, color: dark ? 'B8C9DE' : C.text2, lineSpacing: 15.5 });
    if (g) {
      s.addShape(pres.ShapeType.roundRect, { x: x + 0.22, y: y + ch - 0.42, w: 0.72, h: 0.26,
        fill: { color: dark ? '2E4A72' : C.bg }, line: { width: 0 }, rectRadius: 0.04 });
      s.addText(g, { x: x + 0.22, y: y + ch - 0.42, w: 0.72, h: 0.26, isTextBox: true, margin: 0,
        align: 'center', valign: 'middle', fontFace: F.body, fontSize: 10, bold: true,
        color: dark ? C.white : C.brand2 });
    }
  });
  footer(s, 10);
  s.addNotes('Отбор не работает, если ворота не закреплены за конкретными людьми. Это подводка к слайду с решениями руководства.');
}

// ═══ 11. Что уже работает ═══
{
  const s = pres.addSlide();
  eyebrow(s, 'Состояние');
  title(s, 'Платформа построена и работает');
  lede(s, 'Реализованы все функциональные модули технического задания. Портал запускается одной командой, работает офлайн и не требует внешних сервисов.', 2.15, 0.7);
  const mods = [
    ['Управление инициативами', 'Простая форма подачи, номер, полная карточка жизненного цикла, поиск и фильтры'],
    ['Движок отбора', 'Автоматическая маршрутизация по воротам, задачи в кабинетах, таймеры и эскалация'],
    ['Доска идей', 'Витрина инициатив с голосованием: поддержка коллег как сигнал приоритета'],
    ['Разработка и пилоты', 'Agile-доски и спринты, заявки площадок, KPI пилота, опросы участников'],
    ['Аналитика и КПЭ', 'Три группы показателей, воронка отбора, сравнение учреждений, выгрузка отчётов'],
    ['Сообщество и обучение', 'Форум, библиотека практик, схемы процессов, встроенное обучение по ролям'],
  ];
  const cw = (CW - 0.5) / 3, ch = 1.35;
  mods.forEach(([n, d], i) => {
    const col = i % 3, row = Math.floor(i / 3);
    const x = MX + col * (cw + 0.25), y = 2.9 + row * (ch + 0.25);
    s.addShape(pres.ShapeType.roundRect, { x, y, w: cw, h: ch, fill: { color: C.surf },
      line: { width: 0 }, rectRadius: 0.05 });
    s.addText(n, { x: x + 0.25, y: y + 0.18, w: cw - 0.5, h: 0.32, isTextBox: true, margin: 0,
      fontFace: F.body, fontSize: 14, bold: true, color: C.text });
    s.addText(d, { x: x + 0.25, y: y + 0.54, w: cw - 0.5, h: 0.68, isTextBox: true, margin: 0,
      fontFace: F.body, fontSize: 12, color: C.text2, lineSpacing: 15.5 });
  });
  const stats = [['14', 'схем процессов BPMN'], ['6', 'сценариев обучения'],
                 ['7', 'ролей с разграничением прав'], ['0', 'внешних зависимостей']];
  stats.forEach(([v, l], i) => {
    const x = MX + i * 3.0;
    s.addText(v, { x, y: 5.95, w: 0.95, h: 0.6, isTextBox: true, margin: 0, fontFace: F.head,
      fontSize: 30, bold: true, color: C.brand });
    s.addText(l, { x: x + 1.0, y: 6.12, w: 1.8, h: 0.5, isTextBox: true, margin: 0,
      fontFace: F.body, fontSize: 11.5, color: C.text3, lineSpacing: 14 });
  });
  footer(s, 11);
  s.addNotes('Портал можно показать вживую после доклада — он запускается локально.');
}

// ═══ 12. КПЭ и приборная панель ═══
{
  const s = pres.addSlide();
  eyebrow(s, 'Измеримость');
  title(s, 'Три группы показателей и приборная панель руководителя');

  const groups = [
    [C.brand, 'Вовлечённость и культура', ['Зарегистрировано и внедрено инициатив',
      'Доля сотрудников, подавших инициативу', 'Прохождение каждых ворот',
      'Участники пилотов', 'Масштабирование «снизу» — без директив', 'Валоризация: измеренный эффект']],
    [C.brand2, 'Скорость и эффективность', ['Полный цикл «проблема → масштабирование»',
      'Фактическое время каждого этапа', 'Соблюдение срока по каждым воротам',
      'Коэффициент успешности пилотирования', 'Время до первого решения']],
    [C.brand3, 'Качество и риски', ['Решения Kill — сколько и на каких воротах',
      'Решения Redirect и Hold', 'Риск «заморозки»: застряли дольше срока',
      'Где именно останавливаются инициативы']],
  ];
  const cw = (CW - 0.6) / 3;
  groups.forEach(([col, head, items], i) => {
    const x = MX + i * (cw + 0.3);
    s.addShape(pres.ShapeType.roundRect, { x, y: 2.35, w: cw, h: 2.7, fill: { color: C.white },
      line: { color: C.line, width: 1 }, rectRadius: 0.05 });
    s.addShape(pres.ShapeType.rect, { x, y: 2.35, w: cw, h: 0.5, fill: { color: col }, line: { width: 0 } });
    s.addText(head, { x: x + 0.22, y: 2.35, w: cw - 0.44, h: 0.5, isTextBox: true, margin: 0,
      valign: 'middle', fontFace: F.body, fontSize: 13, bold: true, color: C.white });
    s.addText(items.map((t, j) => ({ text: t, options: { breakLine: j < items.length - 1 } })),
      { x: x + 0.22, y: 2.98, w: cw - 0.44, h: 1.95, isTextBox: true, margin: 0,
        fontFace: F.body, fontSize: 11.5, color: C.text2, paraSpaceAfter: 5, lineSpacing: 15 });
  });

  const kpi = [['Соблюдение SLA', '62', '%', C.warn, 0.62], ['Полный цикл, медиана', '124', ' дн.', C.brand, 0.70],
               ['Успешность пилотов', '50', '%', C.ok, 0.50], ['Риск «заморозки»', '25', '%', C.danger, 0.25]];
  const kw = (CW - 0.6) / 4;
  kpi.forEach(([l, v, u, col, frac], i) => {
    const x = MX + i * (kw + 0.2);
    s.addShape(pres.ShapeType.roundRect, { x, y: 5.25, w: kw, h: 1.15, fill: { color: C.white },
      line: { color: C.line, width: 1 }, rectRadius: 0.05 });
    s.addText(l, { x: x + 0.22, y: 5.38, w: kw - 0.44, h: 0.26, isTextBox: true, margin: 0,
      fontFace: F.body, fontSize: 11, color: C.text3 });
    s.addText([{ text: v, options: { fontSize: 24, bold: true, color: col } },
               { text: u, options: { fontSize: 13, bold: true, color: col } }],
      { x: x + 0.22, y: 5.63, w: kw - 0.44, h: 0.45, isTextBox: true, margin: 0, fontFace: F.head });
    s.addShape(pres.ShapeType.rect, { x: x + 0.22, y: 6.14, w: kw - 0.44, h: 0.06,
      fill: { color: 'EEF1F6' }, line: { width: 0 } });
    s.addShape(pres.ShapeType.rect, { x: x + 0.22, y: 6.14, w: (kw - 0.44) * frac, h: 0.06,
      fill: { color: col }, line: { width: 0 } });
  });
  s.addText('Значения демонстрационные — показывают, какие показатели платформа считает сама, а не результаты Департамента. Решения Kill среди них не негативный показатель: они означают, что отбор работает.',
    { x: MX, y: 6.55, w: CW, h: 0.42, isTextBox: true, margin: 0, fontFace: F.body,
      fontSize: 11.5, color: C.text3, lineSpacing: 14 });
  footer(s, 12);
  s.addNotes('Обязательно оговорить вслух: цифры демонстрационные. Они показывают состав показателей, а не результат Департамента.');
}

// ═══ 13. Риски ═══
{
  const s = pres.addSlide();
  eyebrow(s, 'Риски');
  title(s, 'Главные риски — организационные, и они сняты механизмами');
  const risks = [
    ['Бюрократический застой', 'Сроки игнорируются из-за загрузки персонала',
     'Контроль сроков встроен в систему и работает без участия человека: просрочка эскалируется автоматически, публичная отчётность по скорости, персональная ответственность руководителей'],
    ['Страх ошибки', 'Сотрудник боится, что идею раскритикуют',
     'Закрепляется явная политика: участие в Social1 не влияет на аттестацию, а неудачная, но продуманная инициатива считается частью учебного процесса'],
    ['Информационная изоляция', 'Учреждения вне пилота остаются в стороне',
     'Библиотека проверенных практик открыта всем: любое учреждение берёт готовое решение с методическими материалами самостоятельно'],
    ['Зависимость от поставщика', 'Привязка к одному исполнителю',
     'Платформа построена на открытых стандартах, без внешних зависимостей, с открытым программным интерфейсом для интеграции'],
  ];
  const rh = 1.05, lw = 3.5;
  risks.forEach(([h, sub, fix], i) => {
    const y = 2.3 + i * (rh + 0.14);
    s.addShape(pres.ShapeType.roundRect, { x: MX, y, w: CW, h: rh, fill: { color: C.white },
      line: { color: C.line, width: 1 }, rectRadius: 0.05 });
    s.addShape(pres.ShapeType.rect, { x: MX + 0.01, y: y + 0.01, w: lw, h: rh - 0.02,
      fill: { color: C.surf }, line: { width: 0 } });
    s.addText(h, { x: MX + 0.28, y: y + 0.18, w: lw - 0.5, h: 0.32, isTextBox: true, margin: 0,
      fontFace: F.body, fontSize: 14, bold: true, color: C.text });
    s.addText(sub, { x: MX + 0.28, y: y + 0.53, w: lw - 0.5, h: 0.4, isTextBox: true, margin: 0,
      fontFace: F.body, fontSize: 11.5, color: C.text3, lineSpacing: 14 });
    s.addText(fix, { x: MX + lw + 0.32, y: y + 0.2, w: CW - lw - 0.62, h: 0.72, isTextBox: true,
      margin: 0, fontFace: F.body, fontSize: 12.5, color: C.text2, lineSpacing: 16 });
  });
  footer(s, 13);
  s.addNotes('Если процесс отбора не закреплён нормативно, платформа не спасёт — отсюда следующие слайды.');
}

// ═══ 14. Внедрение ═══
{
  const s = pres.addSlide();
  eyebrow(s, 'Внедрение');
  title(s, 'Поэтапно: сначала несколько учреждений, потом сеть');
  lede(s, 'Внедрение — прежде всего организационный проект. Технология готова; предмет работы — изменение практики руководителей и сотрудников.', 2.15, 0.65);
  const steps = [
    [C.brand, 'ЭТАП 1', 'Пилотная группа', '3–5 мотивированных учреждений. Отрабатываются не только платформа, но и процессы, коммуникация, мотивация'],
    [C.brand2, 'ЭТАП 2', 'Коммуникация', 'Объяснить суть и пользу, снять опасение «ещё одна форма отчётности». Сообщение идёт от руководства'],
    [C.brand3, 'ЭТАП 3', 'Обучение', 'Сотрудникам — как формулировать инициативу, руководителям — как решать, экспертам — как оценивать быстро'],
    [C.brand4, 'ЭТАП 4', 'Итеративный запуск', 'Расширение волнами, с обратной связью и корректировкой процесса после каждой волны'],
    [C.ok, 'ЭТАП 5', 'Рынок практик', 'Внедрённые решения собираются в библиотеку и распространяются между учреждениями по их инициативе'],
  ];
  const cw = (CW - 0.6) / 5;
  steps.forEach(([col, e, h, d], i) => {
    const x = MX + i * (cw + 0.15);
    s.addShape(pres.ShapeType.rect, { x, y: 2.95, w: cw, h: 0.055, fill: { color: col }, line: { width: 0 } });
    s.addText(e, { x, y: 3.14, w: cw, h: 0.26, isTextBox: true, margin: 0, fontFace: F.body,
      fontSize: 10.5, bold: true, charSpacing: 1.2, color: col });
    s.addText(h, { x, y: 3.44, w: cw, h: 0.6, isTextBox: true, margin: 0, fontFace: F.body,
      fontSize: 14.5, bold: true, color: C.text, lineSpacing: 18 });
    s.addText(d, { x, y: 4.06, w: cw, h: 1.5, isTextBox: true, margin: 0, fontFace: F.body,
      fontSize: 12, color: C.text2, lineSpacing: 15.5 });
  });
  s.addShape(pres.ShapeType.roundRect, { x: MX, y: 5.75, w: CW, h: 0.85, fill: { color: C.surf },
    line: { width: 0 }, rectRadius: 0.05 });
  s.addText([{ text: 'Сроки этапов определяются после утверждения состава пилотной группы — ', options: { color: C.text2 } },
             { text: '[уточнить на защите]', options: { bold: true, color: C.text } },
             { text: '. Обучение и методические материалы для всех ролей уже встроены в платформу.', options: { color: C.text2 } }],
    { x: MX + 0.32, y: 5.75, w: CW - 0.64, h: 0.85, isTextBox: true, margin: 0, valign: 'middle',
      fontFace: F.body, fontSize: 13, lineSpacing: 17 });
  footer(s, 14);
  s.addNotes('Календарь намеренно не проставлен: он зависит от состава пилотной группы, который утверждает руководство.');
}

// ═══ 15. Решения руководства ═══
{
  const s = pres.addSlide();
  s.background = { color: C.navy };
  s.addShape(pres.ShapeType.ellipse, { x: 10.2, y: 4.2, w: 6.2, h: 6.2,
    fill: { color: C.white, transparency: 96 }, line: { color: C.navy, width: 0 } });
  s.addText('РЕШЕНИЯ', { x: MX, y: 0.5, w: CW, h: 0.26, isTextBox: true, margin: 0,
    fontFace: F.body, fontSize: 11, bold: true, charSpacing: 2, color: '7089AC' });
  s.addText('Что требуется от руководства Департамента', { x: MX, y: 0.82, w: 10.5, h: 1.3,
    isTextBox: true, margin: 0, fontFace: F.head, fontSize: 33, bold: true, color: C.white, lineSpacing: 38 });
  const asks = [
    ['01', 'Утвердить пилотную группу', 'Определить 3–5 учреждений, готовых работать по-новому, и закрепить их руководителей как участников отбора'],
    ['02', 'Назначить владельцев ворот', 'Комитет экспертов, продакт-менеджер от Департамента, координатор пилотных площадок — без них конвейер не работает'],
    ['03', 'Закрепить сроки в регламенте', 'Придать срокам нормативный статус: 3 рабочих дня руководителю, 5 — экспертам. Без этого они останутся рекомендацией'],
    ['04', 'Выделить ресурс на прототипы', 'Мощность команды цифровой трансформации на 3–4 параллельных прототипа — иначе инициативы встанут после Gate 2'],
  ];
  const cw = (CW - 0.35) / 2, ch = 1.6;
  asks.forEach(([n, h, d], i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = MX + col * (cw + 0.35), y = 2.3 + row * (ch + 0.28);
    s.addShape(pres.ShapeType.roundRect, { x, y, w: cw, h: ch,
      fill: { color: C.white, transparency: 92 }, line: { width: 0 }, rectRadius: 0.05 });
    s.addText(n, { x: x + 0.3, y: y + 0.24, w: 0.5, h: 0.3, isTextBox: true, margin: 0,
      fontFace: F.body, fontSize: 13, bold: true, color: '9DC4F5' });
    s.addText(h, { x: x + 0.85, y: y + 0.22, w: cw - 1.15, h: 0.35, isTextBox: true, margin: 0,
      fontFace: F.body, fontSize: 15, bold: true, color: C.white });
    s.addText(d, { x: x + 0.85, y: y + 0.63, w: cw - 1.15, h: 0.85, isTextBox: true, margin: 0,
      fontFace: F.body, fontSize: 12.5, color: 'B8C9DE', lineSpacing: 16 });
  });
  s.addText('Каждая перспективная инициатива должна иметь понятный путь от идеи до внедрения',
    { x: MX, y: 5.95, w: 10.5, h: 0.6, isTextBox: true, margin: 0, fontFace: F.head,
      fontSize: 19, bold: true, color: C.white });
  s.addText('Social1 · Экосистема системных инноваций ДТСЗН', { x: MX, y: 6.92, w: 8, h: 0.3,
    isTextBox: true, margin: 0, fontFace: F.body, fontSize: 10, color: '5A7295' });
  s.addText('15', { x: W - MX - 1, y: 6.92, w: 1, h: 0.3, isTextBox: true, margin: 0,
    align: 'right', fontFace: F.body, fontSize: 10, color: '5A7295' });
  s.addNotes('Финальный слайд — предмет обсуждения. Четыре решения, без которых отбор не запустится.');
}

pres.writeFile({ fileName: 'Social1-prezentaciya-rukovodstvu-DTSZN.pptx' })
  .then((f) => console.log('записано:', f));
