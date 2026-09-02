// Страница BPMN-схем: процессы каждой роли с пошаговым разбором прямо на схеме.
import { api, state, esc, html, can, navigate, toast, modal, ROLE_TITLES } from '../core.js';
import { renderDiagram, LEGEND } from '../bpmn.js';
import { layout } from '../bpmn-layout.js';
import { DIAGRAMS, ROLE_ORDER } from '../processes-data.js';

// Сквозная нумерация: номер схемы не зависит от выбранного фильтра ролей
const seqOf = (d) => DIAGRAMS.indexOf(d) + 1;

const ROLE_TAB = { all: 'Сквозной процесс', ...ROLE_TITLES };

// Мини-фигуры для условных обозначений — те же, что на схеме
function legendIcon(type) {
  const box = 'width="30" height="26" viewBox="0 0 30 26"';
  const shapes = {
    start: '<circle cx="15" cy="13" r="9" class="bp-event" style="stroke:var(--ok);fill:var(--ok-bg)"/>',
    end: '<circle cx="15" cy="13" r="9" class="bp-event" style="stroke:var(--neutral);fill:var(--neutral-bg);stroke-width:3.4"/>',
    timer: '<circle cx="15" cy="13" r="9" class="bp-event" style="stroke:var(--warn);fill:var(--warn-bg)"/><circle cx="15" cy="13" r="4.6" fill="none" style="stroke:var(--warn);stroke-width:1.3"/><path d="M15 10v3l2.2 1.6" fill="none" style="stroke:var(--warn);stroke-width:1.3;stroke-linecap:round"/>',
    message: '<circle cx="15" cy="13" r="9" class="bp-event" style="stroke:var(--info);fill:var(--info-bg)"/><rect x="10.5" y="10" width="9" height="6.4" rx=".8" fill="none" style="stroke:var(--info);stroke-width:1.2"/><path d="M10.5 10.3l4.5 3.4 4.5-3.4" fill="none" style="stroke:var(--info);stroke-width:1.2"/>',
    user: '<rect x="3" y="4" width="24" height="18" rx="4" class="bp-task"/><circle cx="9" cy="10" r="1.9" class="bp-glyph-stroke"/><path d="M6 14.6a3.4 3.4 0 016.1 0" class="bp-glyph-stroke"/>',
    service: '<rect x="3" y="4" width="24" height="18" rx="4" class="bp-task" style="fill:var(--brand-50);stroke:var(--brand-500)"/><circle cx="9" cy="11" r="1.8" fill="none" style="stroke:var(--brand-600);stroke-width:1.3"/><circle cx="9" cy="11" r="3.6" fill="none" style="stroke:var(--brand-600);stroke-width:1.3;stroke-dasharray:2 2"/>',
    xor: '<path d="M15 3l10 10-10 10L5 13z" class="bp-gateway"/><path d="M11.5 9.5l7 7M18.5 9.5l-7 7" style="stroke:var(--warn);stroke-width:2.2;fill:none;stroke-linecap:round"/>',
    and: '<path d="M15 3l10 10-10 10L5 13z" class="bp-gateway" style="fill:var(--purple-bg);stroke:var(--purple)"/><path d="M15 7v12M9 13h12" style="stroke:var(--purple);stroke-width:2.2;fill:none;stroke-linecap:round"/>',
  };
  return `<svg ${box} aria-hidden="true">${shapes[type] || ''}</svg>`;
}

export async function processesView(view, query) {
  const role = query.get('role') || (state.user.role === 'dtszn' ? 'all' : state.user.role);
  const id = query.get('d');
  const visible = role === 'all' ? DIAGRAMS : DIAGRAMS.filter((d) => d.role === role || d.role === 'all');
  const current = visible.find((d) => d.id === id) || visible[0];

  // Схемы сгруппированы по владельцу процесса
  const groups = [];
  for (const d of visible) {
    let g = groups.find((x) => x.title === d.group);
    if (!g) groups.push(g = { title: d.group, items: [] });
    g.items.push(d);
  }

  view.innerHTML = html`
    <div class="page-head">
      <div class="page-head__row">
        <div style="flex:1;min-width:280px">
          <h2>Схемы процессов</h2>
          <p>Детализированные модели в нотации BPMN: кто что делает, где проходят границы
             ответственности, какие сроки действуют и как принимаются решения. Каждую схему
             можно разобрать по шагам — с подсказками прямо на элементах.
             Разделы и шаги пронумерованы сквозным образом: на шаг «${seqOf(current)}.3» можно
             сослаться в регламенте, и он однозначно находится.</p>
        </div>
      </div>
      <div class="chip-row" style="margin-top:14px" data-tour="proc-roles">
        ${ROLE_ORDER.map((r) => {
          const n = r === 'all' ? DIAGRAMS.length : DIAGRAMS.filter((d) => d.role === r).length;
          if (!n) return '';
          return `<button class="chip ${role === r ? 'is-on' : ''}" data-role="${r}">${esc(ROLE_TAB[r])} · ${n}</button>`;
        })}
      </div>
    </div>

    <div class="proc-layout">
      <aside class="proc-side card" data-tour="proc-list">
        <div class="card__body" style="padding:12px">
          ${groups.map((g) => html`
            <div class="proc-group">
              <div class="proc-group__title">${esc(g.title)}</div>
              ${g.items.map((d) => html`
                <button class="proc-item ${d.id === current.id ? 'is-on' : ''}" data-diagram="${d.id}">
                  <b class="proc-item__num">${seqOf(d)}.</b> ${esc(d.title)}
                  ${d.sla ? `<small>SLA: ${esc(d.sla)}</small>` : ''}
                </button>`)}
            </div>`)}
        </div>
      </aside>

      <div class="stack">
        <div class="card">
          <div class="proc-head" data-tour="proc-header">
            <div style="flex:1;min-width:260px">
              <h3>Раздел ${seqOf(current)}. ${esc(current.title)}</h3>
              <p>${esc(current.description)}</p>
              ${current.sla ? `<div style="margin-top:9px"><span class="badge badge--warn">Стандарт обслуживания: ${esc(current.sla)}</span></div>` : ''}
            </div>
            <div class="row" style="gap:8px">
              <div class="proc-zoom" role="group" aria-label="Масштаб схемы">
                <button data-zoom="-" aria-label="Уменьшить">−</button>
                <span data-zoom-value>100%</span>
                <button data-zoom="+" aria-label="Увеличить">+</button>
              </div>
              ${current.walkthrough?.length ? html`
                <button class="btn btn--primary" data-walk>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                    stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
                  Разобрать по шагам
                </button>` : ''}
              <a class="btn" href="/api/processes/${esc(current.id)}/pdf" data-native download
                 title="Скачать схему в PDF, лист A3">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                  stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
                PDF
              </a>
            </div>
          </div>
          <div class="bp-canvas" data-tour="proc-canvas">
            <div class="bp-canvas__inner" data-zoom-target>${renderDiagram(current, seqOf(current))}</div>
          </div>
        </div>

        <div class="card">
          <div class="card__head"><h3>Условные обозначения</h3>
            <span class="card__hint spacer">Нотация BPMN</span></div>
          <div class="proc-legend">
            ${LEGEND.map(([type, text]) => html`
              <div class="proc-legend__item">${legendIcon(type)}<span>${esc(text)}</span></div>`)}
            <div class="proc-legend__item">
              <svg width="30" height="26" viewBox="0 0 30 26" aria-hidden="true">
                <path d="M3 13h20" class="bp-flow" marker-end="url(#bp-arrow)"/></svg>
              <span>Поток управления — последовательность шагов</span>
            </div>
            <div class="proc-legend__item">
              <svg width="30" height="26" viewBox="0 0 30 26" aria-hidden="true">
                <path d="M3 13h20" class="bp-flow bp-flow--message" marker-end="url(#bp-arrow-open)"/></svg>
              <span>Поток сообщений — передача между участниками</span>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card__head"><h3>Обучение по этому процессу</h3></div>
          <div class="card__body">
            <p class="prose" style="margin-bottom:14px">
              Разбор схемы объясняет модель процесса. Обучение по интерфейсу показывает,
              где выполнять эти шаги в самом портале.
            </p>
            <div class="row" style="gap:9px">
              ${current.walkthrough?.length
                ? '<button class="btn btn--primary" data-walk>Разобрать схему по шагам</button>' : ''}
              <button class="btn" data-tours>Обучение по интерфейсу</button>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card__head"><h3>Выгрузка в PDF</h3>
            <span class="card__hint spacer">Лист A3, альбомная ориентация</span></div>
          <div class="card__body">
            <p class="prose" style="margin-bottom:14px">
              Схемы выгружаются векторным PDF: текст в файле ищется и копируется,
              нумерация разделов и шагов сохраняется. Под схемой печатается
              пошаговое описание процесса — то же, что и в разборе на экране.
              Альбом всех схем собирается с титульным листом и содержанием.
            </p>
            <div class="row" style="gap:9px">
              <a class="btn btn--primary" href="/api/processes/${esc(current.id)}/pdf" data-native download>
                Скачать раздел ${seqOf(current)}${current.walkthrough?.length
                  ? ` — схема и ${current.walkthrough.length} ${current.walkthrough.length < 5 ? 'шага' : 'шагов'}` : ''}
              </a>
              <a class="btn" href="/api/processes/album/pdf" data-native download>
                Скачать альбом всех схем — ${DIAGRAMS.length + 2} ${DIAGRAMS.length + 2 > 4 ? 'страниц' : 'страницы'}
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  // ── Навигация ──
  view.querySelectorAll('[data-role]').forEach((b) => b.onclick = () => navigate(`/processes?role=${b.dataset.role}`));
  view.querySelectorAll('[data-diagram]').forEach((b) => b.onclick = () =>
    navigate(`/processes?role=${role}&d=${b.dataset.diagram}`));
  view.querySelector('[data-tours]')?.addEventListener('click', async () =>
    (await import('../tour.js')).openTourCatalog());

  // ── Масштаб ──
  let zoom = 1;
  const target = view.querySelector('[data-zoom-target]');
  const label = view.querySelector('[data-zoom-value]');
  const applyZoom = () => {
    target.style.transform = `scale(${zoom})`;
    target.style.transformOrigin = 'top left';
    target.style.width = `${100 / zoom}%`;
    label.textContent = `${Math.round(zoom * 100)}%`;
  };
  view.querySelectorAll('[data-zoom]').forEach((b) => b.onclick = () => {
    zoom = Math.max(0.5, Math.min(1.6, zoom + (b.dataset.zoom === '+' ? 0.1 : -0.1)));
    applyZoom();
  });

  // ── Пошаговый разбор схемы ──
  view.querySelectorAll('[data-walk]').forEach((b) => b.onclick = () => startWalkthrough(view, current));
}

/** Собирает обучающий сценарий из данных схемы и запускает его на самой схеме. */
async function startWalkthrough(view, diagram) {
  const { startTour } = await import('../tour.js');
  const svg = view.querySelector('.bp-svg');
  if (!svg) return;

  const nodeById = Object.fromEntries(diagram.nodes.map((n) => [n.id, n]));
  const { boxes } = layout(diagram, DIAGRAMS.indexOf(diagram) + 1);
  const highlight = (id, visited) => {
    svg.classList.add('is-walking');
    svg.querySelectorAll('.bp-node').forEach((el) => {
      el.classList.toggle('is-current', el.dataset.node === id);
      el.classList.toggle('is-visited', visited.includes(el.dataset.node) && el.dataset.node !== id);
    });
  };

  const visited = [];
  const steps = diagram.walkthrough.map((w, i) => ({
    target: `.bp-svg [data-node="${w.node}"]`,
    placement: 'bottom',
    title: w.title,
    body: `${w.body}<p style="margin-top:9px;font-size:12.5px;color:var(--text-3)">
             Шаг <b>${esc(boxes[w.node]?.num || '')}</b> — ${esc(nodeById[w.node]?.label || w.node)}</p>`,
    action: () => { highlight(w.node, visited); if (!visited.includes(w.node)) visited.push(w.node); },
  }));

  startTour({
    id: `walk-${diagram.id}`,
    ephemeral: true,
    title: diagram.title,
    steps,
    onEnd: () => {
      svg.classList.remove('is-walking');
      svg.querySelectorAll('.bp-node').forEach((el) => el.classList.remove('is-current', 'is-visited'));
    },
  });
}
