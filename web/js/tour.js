// Обучающий режим: пошаговые подсказки с подсветкой элементов интерфейса.
// Сценарии подбираются под роль участника — каждый учится своей части процесса.
import { state, esc, html, navigate, currentRoute, toast } from './core.js';

const DONE_KEY = 's1-tours-done';
const SEEN_KEY = 's1-tours-seen';

const read = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
};
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };

export const completedTours = () => read(DONE_KEY, []);
const markDone = (id) => {
  const done = completedTours();
  if (!done.includes(id)) write(DONE_KEY, [...done, id]);
};

// ── Сценарии ─────────────────────────────────────────────────
// roles: '*' — для всех ролей, иначе перечень ролей, которым сценарий полезен.
export const SCENARIOS = [
  {
    id: 'intro',
    title: 'Знакомство с порталом',
    description: 'Общая карта разделов: где что находится и с чего начинать работу.',
    duration: '2 мин', roles: '*', icon: 'map',
    steps: [
      {
        route: '/', target: null,
        title: 'Добро пожаловать в Social1',
        body: `Это не электронная книга предложений, а конвейер превращения инициатив
               сотрудников в работающие изменения. Покажу за пару минут, как здесь всё устроено.`,
      },
      {
        target: '.nav', placement: 'right',
        title: 'Разделы платформы',
        body: `Навигация повторяет путь инициативы: сначала работа с идеями, затем их жизненный
               цикл — разработка, пилот, тиражирование, — и в конце анализ результатов.`,
      },
      {
        target: '[data-nav="/ideas"]', placement: 'right',
        title: 'Доска идей',
        body: `Витрина всех инициатив с голосованием. Здесь видно, что предлагают коллеги
               и что уже поддержано. Начинать удобнее отсюда.`,
      },
      {
        target: '[data-nav="/tasks"]', placement: 'right',
        title: 'Мои задачи',
        body: `Когда от вас требуется решение или действие, задача появляется здесь автоматически —
               со сроком по стандарту обслуживания. Просроченные задачи эскалируются.`,
      },
      {
        target: '.pipeline', placement: 'bottom', optional: true,
        title: 'Конвейер Stage-Gate',
        body: `Шесть стадий и пять точек принятия решений. Цифра на каждой стадии — сколько
               инициатив находится там прямо сейчас. Узкие места видны сразу.`,
      },
      {
        target: '.header__search', placement: 'bottom', optional: true,
        title: 'Быстрый поиск',
        body: `Ищите по названию, номеру или тексту инициативы из любого раздела.`,
      },
      {
        target: '[data-tour-launch]', placement: 'bottom',
        title: 'Обучение всегда под рукой',
        body: `Эта кнопка открывает список сценариев. Их несколько — под разные задачи
               и роли. Возвращайтесь, когда понадобится.`,
      },
    ],
  },
  {
    id: 'ideas',
    title: 'Доска идей и голосование',
    description: 'Как читать карточки инициатив, поддерживать коллег и следить за статусом.',
    duration: '2 мин', roles: '*', icon: 'vote',
    steps: [
      {
        route: '/ideas', target: '.status-flow', placement: 'bottom',
        title: 'Путь идеи в пяти статусах',
        body: `Это тот же процесс Stage-Gate, но словами, понятными без погружения в методологию.
               Статус каждой карточки показывает, где идея находится сейчас.`,
      },
      {
        target: '.ideas .idea:first-child .vote', placement: 'right',
        title: 'Голосование',
        body: `Стрелка вверх — «сталкиваюсь с той же проблемой, поддерживаю». Стрелка вниз —
               «считаю, что решать не нужно». Повторный клик снимает ваш голос.`,
      },
      {
        target: '.ideas .idea:first-child .st', placement: 'left',
        title: 'Статус на карточке',
        body: `Показывает продвижение идеи. По завершённым инициативам — внедрённым
               и отклонённым — голосование закрывается.`,
      },
      {
        target: '#sorts', placement: 'bottom',
        title: 'Как отобрать нужное',
        body: `«Популярные» — по сумме голосов. «Набирают поддержку» — свежие идеи с быстрым
               ростом поддержки, их легко пропустить в общем списке.`,
      },
      {
        target: '[data-tour="idea-filters"]', placement: 'bottom',
        title: 'Поиск и фильтры',
        body: `Отберите идеи по статусу или тематическому направлению, прежде чем предлагать
               своё — возможно, кто-то уже занимается той же проблемой.`,
      },
    ],
  },
  {
    id: 'submit',
    title: 'Как подать инициативу',
    description: 'Разбор формы: что писать в каждом поле и как помогает ИИ-подсказчик.',
    duration: '3 мин', roles: ['employee', 'head', 'expert', 'dtszn'], icon: 'idea',
    steps: [
      {
        route: '/initiatives/new', target: '#n-problem', placement: 'right',
        title: 'Начните с проблемы, а не с решения',
        body: `Опишите, что мешает в работе, как часто это происходит и кого затрагивает.
               Цифры решают: «40–60 минут в день у 68 сотрудников» убеждает сильнее,
               чем «уходит много времени».`,
      },
      {
        target: '#n-solution', placement: 'right',
        title: 'Предложите решение своими словами',
        body: `Технических формулировок не требуется. Опишите, как вы видите решение —
               команда разработки переведёт это в требования.`,
      },
      {
        target: '#n-effect', placement: 'right',
        title: 'Назовите эффект',
        body: `Экономия времени, снижение затрат, качество услуги или удовлетворённость.
               Это поле эксперты читают внимательнее всего.`,
      },
      {
        target: '#n-evalue', placement: 'top',
        title: 'Измерьте эффект числом',
        body: `Даже приблизительная оценка работает: она позволит на пилоте сравнить
               прогноз с фактом и доказать результат.`,
      },
      {
        target: '#ai-hint', placement: 'left',
        title: 'ИИ-подсказчик',
        body: `По мере заполнения система определяет тематическое направление и показывает
               похожие инициативы. Если совпадение высокое — присоединяйтесь к существующей,
               так решение быстрее дойдёт до внедрения.`,
      },
      {
        target: null,
        title: 'Что будет дальше',
        body: `После отправки инициатива автоматически уйдёт руководителю вашего учреждения:
               у него 3 рабочих дня на решение. Вы получите уведомление о каждом шаге —
               и о положительном решении, и об отказе с обоснованием.`,
      },
    ],
  },
  {
    id: 'gate',
    title: 'Принятие решения на Gate',
    description: 'Для тех, кто пропускает инициативы дальше: критерии, сроки, аргументация.',
    duration: '3 мин', roles: ['head', 'expert', 'developer', 'pilot_coordinator', 'dtszn'], icon: 'gate',
    steps: [
      {
        route: '/tasks', target: '.list__item', placement: 'bottom', optional: true,
        title: 'Задачи приходят сами',
        body: `Движок процесса создаёт задачу, когда инициатива доходит до вашей точки принятия
               решения. У задачи есть срок — он рассчитан в рабочих днях по стандарту обслуживания.`,
      },
      {
        route: '/process', target: '.pipeline', placement: 'bottom',
        title: 'Ваше место в конвейере',
        body: `Работы отделены от решений. На каждой точке решает один ответственный:
               Gate 1 — руководитель учреждения, Gate 2 — эксперты, Gate 5 — ДТСЗН.`,
      },
      {
        target: '.card:nth-of-type(3)', placement: 'top', optional: true,
        title: 'Критерии заданы заранее',
        body: `Для каждой точки определён перечень критериев и допустимых решений.
               Их можно изменить в настройках платформы — без правки кода.`,
      },
      {
        target: null,
        title: 'Четыре возможных решения',
        body: `<b>Go</b> — продолжить. <b>Kill</b> — остановить: это не провал, а экономия
               ресурсов на нежизнеспособном проекте. <b>Hold</b> — приостановить до получения
               недостающих данных. <b>Redirect</b> — вернуть на доработку.`,
      },
      {
        target: null,
        title: 'Аргументация обязательна',
        body: `Система не примет решение без обоснования. Это не формальность: из решений
               складывается архив опыта, и автор инициативы всегда понимает, почему
               получил именно такой ответ.`,
      },
    ],
  },
  {
    id: 'analytics',
    title: 'Аналитика и КПЭ',
    description: 'Три группы показателей и как по ним находить узкие места процесса.',
    duration: '3 мин', roles: ['head', 'expert', 'dtszn', 'pilot_coordinator'], icon: 'chart',
    steps: [
      {
        route: '/analytics', target: '.tabs', placement: 'bottom',
        title: 'Три группы показателей',
        body: `Вовлечённость и культура; скорость и эффективность; качество и риски.
               Первая отвечает на вопрос «участвуют ли», вторая — «быстро ли», третья — «надёжно ли».`,
      },
      {
        target: '.grid--kpi', placement: 'bottom',
        title: 'Ключевые значения',
        body: `Главный показатель экосистемы — количество внедрённых инициатив.
               Именно поток внедрённых улучшений, а не число поданных идей, является
               конечным продуктом платформы.`,
      },
      {
        target: '[data-panel="g1"] .grid--2 .card:nth-child(2)', placement: 'left', optional: true,
        title: 'Где «умирают» идеи',
        body: `Разбивка решений по каждой точке показывает узкие места. Если большинство
               инициатив останавливается на одном Gate — там не хватает экспертизы или ресурсов.`,
      },
      {
        target: '.tabs .tab:nth-child(2)', placement: 'bottom',
        title: 'Скорость и соблюдение сроков',
        body: `На этой вкладке — фактическое время каждого этапа в сравнении со стандартом
               обслуживания. Именно отсюда видно, где процесс буксует.`,
        action: (root) => root.querySelector('.tabs .tab:nth-child(2)')?.click(),
      },
      {
        target: '[data-panel="g2"] .card', placement: 'top', optional: true,
        title: 'SLA по каждому этапу',
        body: `Столбец «Соблюдение SLA» — доля решений, принятых в срок. Падение по конкретному
               этапу означает перегрузку ответственных или заниженный норматив.`,
      },
    ],
  },
  {
    id: 'admin',
    title: 'Настройка процесса',
    description: 'Как менять этапы, сроки и критерии Gate без участия разработчиков.',
    duration: '2 мин', roles: ['dtszn'], icon: 'gear',
    steps: [
      {
        route: '/admin', target: '.tabs', placement: 'bottom',
        title: 'Разделы администрирования',
        body: `Конфигурация процесса, участники, журнал аудита и состояние системы.`,
      },
      {
        target: '#admin-panel .card:first-child', placement: 'top', optional: true,
        title: 'Этап настраивается как данные',
        body: `Название точки принятия решения, ответственная роль, срок в рабочих или
               календарных днях, перечень критериев и допустимых решений — всё меняется
               здесь и вступает в силу немедленно.`,
      },
      {
        target: null,
        title: 'Каждое изменение фиксируется',
        body: `Правка конфигурации попадает в журнал аудита наравне с решениями на Gate.
               Журнал неизменяем: записи связаны цепочкой хэшей, и подмена задним числом
               выявляется проверкой целостности.`,
      },
      {
        route: '/sla', target: '.grid--kpi', placement: 'bottom',
        title: 'Контроль сроков',
        body: `Отдельный раздел сводит просроченные решения и те, по которым срок истекает
               в ближайшие сутки. Фоновая проверка эскалирует просрочки автоматически.`,
      },
    ],
  },
];

export function toursForRole(role) {
  return SCENARIOS.filter((s) => s.roles === '*' || s.roles.includes(role));
}

// ── Движок ───────────────────────────────────────────────────
let active = null;   // { scenario, index, els, cleanup }

const ICONS = {
  map: '<path d="M9 4L3 7v13l6-3 6 3 6-3V4l-6 3-6-3zM9 4v13M15 7v13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  vote: '<path d="M7 10l5-5 5 5M12 5v9M5 19h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  idea: '<path d="M9 18h6M10 21h4M12 3a6 6 0 00-3.5 10.9V16h7v-2.1A6 6 0 0012 3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  gate: '<path d="M4 4v16M20 4v16M4 9h16M4 15h16M9 9v6M15 9v6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  chart: '<path d="M4 4v16h16M8 15l3-4 3 3 4-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  gear: '<circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 3v2M12 19v2M21 12h-2M5 12H3M18.4 5.6l-1.4 1.4M7 17l-1.4 1.4M18.4 18.4L17 17M7 7L5.6 5.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
};

/** Ожидание появления элемента после перерисовки раздела. */
function waitFor(selector, timeout = 4000) {
  return new Promise((resolve) => {
    if (!selector) return resolve(null);
    const found = document.querySelector(selector);
    if (found) return resolve(found);
    const started = Date.now();
    const tick = () => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      if (Date.now() - started > timeout) return resolve(null);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

function removeOverlay() {
  document.querySelectorAll('.tour-veil,.tour-hole,.tour-tip,.tour-tip__arrow').forEach((el) => el.remove());
}

/** Размещает тултип рядом с подсвеченным элементом, не выходя за пределы экрана. */
function place(tip, arrow, rect, placement) {
  const gap = 14, pad = 12;
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  const vw = innerWidth, vh = innerHeight;
  const fits = {
    bottom: rect.bottom + gap + th < vh - pad,
    top: rect.top - gap - th > pad,
    right: rect.right + gap + tw < vw - pad,
    left: rect.left - gap - tw > pad,
  };
  let side = placement && fits[placement] ? placement
    : ['bottom', 'right', 'top', 'left'].find((s) => fits[s]) || 'bottom';

  let top, left;
  if (side === 'bottom' || side === 'top') {
    left = rect.left + rect.width / 2 - tw / 2;
    top = side === 'bottom' ? rect.bottom + gap : rect.top - gap - th;
  } else {
    top = rect.top + rect.height / 2 - th / 2;
    left = side === 'right' ? rect.right + gap : rect.left - gap - tw;
  }
  left = Math.max(pad, Math.min(left, vw - tw - pad));
  top = Math.max(pad, Math.min(top, vh - th - pad));
  tip.style.top = `${top}px`;
  tip.style.left = `${left}px`;

  // Стрелка указывает на подсвеченный элемент
  const dir = { bottom: 'up', top: 'down', right: 'left', left: 'right' }[side];
  arrow.className = `tour-tip__arrow tour-tip__arrow--${dir}`;
  if (side === 'bottom' || side === 'top') {
    const x = Math.max(left + 14, Math.min(rect.left + rect.width / 2, left + tw - 14));
    arrow.style.left = `${x - 6}px`;
    arrow.style.top = side === 'bottom' ? `${top - 6}px` : `${top + th - 6}px`;
  } else {
    const y = Math.max(top + 14, Math.min(rect.top + rect.height / 2, top + th - 14));
    arrow.style.top = `${y - 6}px`;
    arrow.style.left = side === 'right' ? `${left - 6}px` : `${left + tw - 6}px`;
  }
  arrow.style.display = '';
}

async function renderStep(idx) {
  if (!active) return;
  const { scenario } = active;
  if (idx < 0 || idx >= scenario.steps.length) return finishTour();
  active.index = idx;
  const step = scenario.steps[idx];

  // Переход в нужный раздел
  if (step.route && currentRoute().path !== step.route) {
    navigate(step.route);
    await new Promise((r) => setTimeout(r, 260));
  }
  if (step.action) { try { step.action(document); } catch {} await new Promise((r) => setTimeout(r, 220)); }

  const target = await waitFor(step.target, step.route ? 4500 : 2500);
  if (target) {
    // Мгновенная прокрутка: при плавной Chrome доводит до цели только внешний
    // контейнер, и узел широкой схемы остаётся за краем. Непрерывность даёт
    // анимация самой подсветки.
    target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
    await new Promise((r) => setTimeout(r, 340));
  }

  removeOverlay();
  const veil = document.createElement('div');
  veil.className = 'tour-veil';
  const hole = document.createElement('div');
  const tip = document.createElement('div');
  tip.className = 'tour-tip';
  tip.setAttribute('role', 'dialog');
  tip.setAttribute('aria-live', 'polite');
  const arrow = document.createElement('div');
  arrow.style.display = 'none';

  const last = idx === scenario.steps.length - 1;
  tip.innerHTML = html`
    <div class="tour-tip__bar"><i style="width:${((idx + 1) / scenario.steps.length) * 100}%"></i></div>
    <div class="tour-tip__body">
      <div class="tour-tip__step">Шаг ${idx + 1} из ${scenario.steps.length}<span>${esc(scenario.title)}</span></div>
      <h4>${esc(step.title)}</h4>
      <p>${step.body}</p>
    </div>
    <div class="tour-tip__foot">
      <button class="tour-tip__skip" data-exit>Завершить обучение</button>
      <span class="spacer"></span>
      ${idx > 0 ? '<button class="btn btn--sm" data-prev>Назад</button>' : ''}
      <button class="btn btn--sm btn--primary" data-next>${last ? 'Готово' : 'Далее'}</button>
    </div>`;

  document.body.append(veil, hole, tip, arrow);

  const paint = () => {
    if (!document.body.contains(tip)) return;
    if (target && target.isConnected) {
      const r = target.getBoundingClientRect();
      if (r.width || r.height) {
        veil.classList.add('tour-veil--clear');
        hole.className = 'tour-hole';
        hole.style.cssText += `top:${r.top - 5}px;left:${r.left - 5}px;width:${r.width + 10}px;height:${r.height + 10}px`;
        place(tip, arrow, r, step.placement);
        return;
      }
    }
    // Цели нет — показываем подсказку по центру, затемняя экран целиком
    veil.classList.remove('tour-veil--clear');
    hole.className = 'tour-hole tour-hole--center';
    hole.style.cssText += 'top:50%;left:50%;width:0;height:0';
    tip.style.top = `${Math.max(12, innerHeight / 2 - tip.offsetHeight / 2)}px`;
    tip.style.left = `${Math.max(12, innerWidth / 2 - tip.offsetWidth / 2)}px`;
    arrow.style.display = 'none';
  };
  paint();

  const onScroll = () => paint();
  addEventListener('scroll', onScroll, true);
  addEventListener('resize', onScroll);
  active.cleanup = () => {
    removeEventListener('scroll', onScroll, true);
    removeEventListener('resize', onScroll);
  };

  tip.querySelector('[data-next]').onclick = () => renderStep(idx + 1);
  tip.querySelector('[data-prev]')?.addEventListener('click', () => renderStep(idx - 1));
  tip.querySelector('[data-exit]').onclick = () => stopTour();
  veil.onclick = (e) => { if (e.target === veil) tip.animate?.(
    [{ transform: 'translateX(0)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(0)' }],
    { duration: 180 }); };
}

function onKey(e) {
  if (!active) return;
  if (e.key === 'Escape') { e.preventDefault(); stopTour(); }
  if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); renderStep(active.index + 1); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); renderStep(active.index - 1); }
}

/**
 * Запуск обучения. Принимает идентификатор готового сценария либо сценарий-объект —
 * так страница процессов собирает разбор схемы прямо из её данных.
 */
export function startTour(idOrScenario) {
  const scenario = typeof idOrScenario === 'string'
    ? SCENARIOS.find((s) => s.id === idOrScenario)
    : idOrScenario;
  if (!scenario?.steps?.length) return;
  stopTour(true);
  active = { scenario, index: 0, cleanup: null };
  addEventListener('keydown', onKey);
  renderStep(0);
}

export function stopTour(silent = false) {
  if (!active) return;
  active.cleanup?.();
  removeOverlay();
  removeEventListener('keydown', onKey);
  const { scenario, index } = active;
  try { scenario.onEnd?.(); } catch {}
  active = null;
  if (!silent && !scenario.ephemeral && index < scenario.steps.length - 1) {
    toast('Обучение прервано. Вернуться к нему можно кнопкой со знаком вопроса в шапке.', '', 'Готово');
  }
}

function finishTour() {
  if (!active) return;
  const { scenario } = active;
  active.cleanup?.();
  removeOverlay();
  removeEventListener('keydown', onKey);
  try { scenario.onEnd?.(); } catch {}
  active = null;
  if (scenario.ephemeral) {
    toast(`Разбор «${scenario.title}» пройден.`, 'ok', 'Готово');
    return;
  }
  markDone(scenario.id);
  document.querySelector('[data-tour-launch]')?.classList
    .toggle('has-new', toursForRole(state.user?.role).some((s) => !completedTours().includes(s.id)));
  toast(`Сценарий «${scenario.title}» пройден.`, 'ok', 'Обучение завершено');
}

// ── Каталог сценариев ────────────────────────────────────────
export async function openTourCatalog() {
  const { modal } = await import('./core.js');
  const done = completedTours();
  const list = toursForRole(state.user.role);
  modal({
    title: 'Интерактивное обучение',
    body: html`
      <p class="prose" style="margin-bottom:16px">
        Каждый сценарий проведёт вас по интерфейсу с подсказками на шагах. Обучение можно
        прервать в любой момент клавишей Esc и вернуться к нему позже.
      </p>
      <div class="tour-list">
        ${list.map((s) => html`
          <button class="tour-card" data-start="${s.id}">
            <span class="tour-card__icon">
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">${ICONS[s.icon] || ICONS.map}</svg>
            </span>
            <span class="tour-card__main">
              <b>${esc(s.title)}</b>
              <span>${esc(s.description)}</span>
              <span class="tour-card__meta">
                <span>${s.steps.length} ${s.steps.length === 1 ? 'шаг' : s.steps.length < 5 ? 'шага' : 'шагов'}</span>
                <span>${esc(s.duration)}</span>
                ${done.includes(s.id) ? '<span class="tour-card__done">✓ пройден</span>' : ''}
              </span>
            </span>
          </button>`)}
      </div>`,
    onMount: (el, close) => {
      el.querySelectorAll('[data-start]').forEach((b) => b.onclick = () => {
        close();
        setTimeout(() => startTour(b.dataset.start), 120);
      });
    },
  });
}

/** Предложение пройти обучение при первом входе. */
export function offerFirstRun() {
  if (read(SEEN_KEY, false)) return;
  write(SEEN_KEY, true);
  setTimeout(() => {
    if (completedTours().includes('intro')) return;
    import('./core.js').then(({ modal }) => modal({
      title: 'Первый вход в Social1',
      body: html`
        <p class="prose">Портал охватывает весь путь инициативы — от проблемы на рабочем месте
        до внедрённого решения. Чтобы не разбираться самостоятельно, пройдите короткое
        обучение: две минуты, семь подсказок.</p>`,
      footer: html`<button class="btn" data-close>Позже</button>
                   <button class="btn btn--primary" data-go>Начать обучение</button>`,
      onMount: (el, close) => {
        el.querySelector('[data-go]').onclick = () => { close(); setTimeout(() => startTour('intro'), 120); };
      },
    }));
  }, 900);
}
