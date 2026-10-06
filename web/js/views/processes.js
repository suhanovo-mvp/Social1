// Страница BPMN-схем: процессы каждой роли с пошаговым разбором прямо на схеме.
import { api, state, esc, html, can, navigate, toast, modal, confirmDialog, plural,
         fmtAgo, ROLE_TITLES } from '../core.js';
import { renderDiagram, LEGEND } from '../bpmn.js';
import { layout } from '/shared/bpmn/layout.js';

// Альбом приходит с сервера: схемы живут в репозитории версиями, а не в исходниках
// клиента. Загружается один раз за сеанс — схемы меняются публикацией, не поминутно.
let album = null;
async function loadAlbum() {
  if (!album) album = await api.get('/api/processes');
  return album;
}
/** Сбросить кэш альбома — после публикации новой версии. */
export function forgetAlbum() { album = null; }

// Сквозная нумерация проставлена сервером: номер раздела не зависит от фильтра ролей
const seqOf = (d) => d.seq;

// Внутри сценария «все» означает весь его набор схем, а не только сквозную
const ROLE_TAB = { all: 'Все схемы пути', ...ROLE_TITLES };

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
  const { diagrams: DIAGRAMS, scenarios: SCENARIOS, roleOrder: ROLE_ORDER } = await loadAlbum();
  const scenarioOf = (id) => SCENARIOS.find((s) => s.id === id) || SCENARIOS[0];

  const scenarioId = SCENARIOS.some((s) => s.id === query.get('s')) ? query.get('s') : SCENARIOS[0].id;
  const scenario = scenarioOf(scenarioId);
  const inScenario = DIAGRAMS.filter((d) => d.scenario === scenarioId);

  const role = query.get('role') || 'all';
  const id = query.get('d');
  const visible = role === 'all' ? inScenario : inScenario.filter((d) => d.role === role || d.role === 'all');
  const current = visible.find((d) => d.id === id) || visible[0];

  // Схемы сгруппированы по владельцу процесса
  const groups = [];
  for (const d of visible) {
    let g = groups.find((x) => x.title === d.group);
    if (!g) groups.push(g = { title: d.group, items: [] });
    g.items.push(d);
  }
  const link = (over = {}) => {
    const p = new URLSearchParams({ s: scenarioId, role, ...over });
    return `/processes?${p}`;
  };

  view.innerHTML = html`
    <div class="page-head">
      <div class="page-head__row">
        <div style="flex:1;min-width:280px">
          <h2>Схемы процессов</h2>
          <p>Детализированные модели в нотации BPMN: кто что делает, где проходят границы
             ответственности, какие сроки действуют и как принимаются решения. Альбом разделён
             на пользовательские пути: подача полноценной инициативы, обсуждение идей, работа
             с каталогом разработчиков ИИ-решений и совместная работа с процессами, знаниями и опросами.
             Разделы и шаги пронумерованы сквозным образом: на шаг «${seqOf(current)}.3» можно
             сослаться в регламенте, и он однозначно находится.</p>
        </div>
      </div>

      <div class="scen-switch" data-tour="proc-scenarios">
        ${SCENARIOS.map((s) => html`
          <button class="scen-switch__item ${s.id === scenarioId ? 'is-on' : ''}" data-scenario="${esc(s.id)}">
            <b>${esc(s.title)}</b>
            <span>${esc(s.lead)}</span>
            <small>${DIAGRAMS.filter((d) => d.scenario === s.id).length} ${plural(DIAGRAMS.filter((d) => d.scenario === s.id).length, 'схема', 'схемы', 'схем')}</small>
          </button>`)}
      </div>

      <div class="chip-row" style="margin-top:14px" data-tour="proc-roles">
        ${ROLE_ORDER.map((r) => {
          const n = r === 'all' ? inScenario.length : inScenario.filter((d) => d.role === r).length;
          if (!n) return '';
          return `<button class="chip ${role === r ? 'is-on' : ''}" data-role="${r}">${esc(ROLE_TAB[r])} · ${n}</button>`;
        })}
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card__head">
        <div>
          <h3>${esc(scenario.title)}</h3>
          <div class="card__hint">${esc(scenario.description)}</div>
        </div>
      </div>
      <div class="card__body">
        <div class="fs-12 fw-600 text-3" style="text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px">
          Кто что делает на этом пути</div>
        <div class="role-matrix">
          ${scenario.roles.map((r) => html`
            <div class="role-matrix__row">
              <div class="role-matrix__role">${esc(r.title)}</div>
              <div class="role-matrix__does">${esc(r.does)}</div>
            </div>`)}
        </div>
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
              ${can('process.propose') ? html`
                <button class="btn" data-propose-change title="Предложить изменение этого процесса">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                    stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg>
                  Предложить изменение
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
  view.querySelectorAll('[data-scenario]').forEach((b) => b.onclick = () =>
    navigate(`/processes?s=${b.dataset.scenario}`));
  view.querySelectorAll('[data-role]').forEach((b) => b.onclick = () => navigate(link({ role: b.dataset.role })));
  view.querySelectorAll('[data-diagram]').forEach((b) => b.onclick = () =>
    navigate(link({ d: b.dataset.diagram })));
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

  // ── Обсуждение шагов схемы ──
  // Замечание привязано к фигуре, а не к процессу целиком: разговор о конкретном
  // шаге не тонет в общей ленте, а на схеме видно, где именно жмёт.
  await mountComments(view, current);

  view.querySelector('[data-propose-change]')?.addEventListener('click', () => proposeChange(current));
}

/** Метки обсуждения на фигурах и панель замечаний по выбранному шагу. */
async function mountComments(view, diagram) {
  const svg = view.querySelector('.bp-svg');
  if (!svg) return;
  let data;
  try { data = await api.get(`/api/processes/${diagram.id}/comments`); }
  catch { return; }

  const { boxes } = layout(diagram, diagram.seq);
  const marks = Object.entries(data.counts)
    .filter(([id]) => boxes[id])
    .map(([id, n]) => {
      const b = boxes[id];
      const x = b.x + b.w - 4, y = b.y + 4;
      return `<g class="bp-comment" data-comment-node="${esc(id)}" role="button" tabindex="0"
                 aria-label="Замечаний к шагу: ${n}">
                <circle cx="${x}" cy="${y}" r="9"/>
                <text x="${x}" y="${y + 3.5}" text-anchor="middle">${n}</text>
              </g>`;
    }).join('');
  if (marks) svg.insertAdjacentHTML('beforeend', marks);

  // Шаг называется сквозным номером вида «1.8»: именно на него ссылаются регламенты
  const open = (nodeId) => openNodeComments(diagram, nodeId, boxes[nodeId]?.num,
    data.comments.filter((c) => c.node_id === nodeId));
  svg.querySelectorAll('[data-comment-node]').forEach((g) => {
    g.onclick = (e) => { e.stopPropagation(); open(g.dataset.commentNode); };
  });
  // Замечание можно оставить и на шаге, где их ещё нет
  if (can('process.comment')) {
    svg.querySelectorAll('.bp-node').forEach((el) => {
      el.ondblclick = () => open(el.dataset.node);
    });
  }
}

function openNodeComments(diagram, nodeId, stepNumber, list) {
  const node = diagram.nodes.find((n) => n.id === nodeId);
  const body = html`
    <p class="prose" style="margin-bottom:14px">Шаг <b>${esc(stepNumber || nodeId)}</b> —
       «${esc(node?.label || nodeId)}»</p>
    ${list.length ? html`
      <div class="list">
        ${list.map((c) => html`
          <div class="list__item">
            <div class="list__main">
              <div class="list__title">${esc(c.author_name)}
                <span class="text-3 fs-12">· ${esc(ROLE_TITLES[c.author_role] || c.author_role)}
                  · ${esc(fmtAgo(c.created_at))}</span></div>
              <div class="list__body">${esc(c.body)}</div>
              <div class="list__meta">
                <button class="btn btn--sm btn--ghost" data-useful="${c.id}">Полезно · ${c.useful}</button>
              </div>
            </div>
          </div>`)}
      </div>` : '<p class="prose text-3">Замечаний к этому шагу пока нет.</p>'}
    ${can('process.comment') ? html`
      <div style="margin-top:14px">
        <label class="field__label" for="node-comment">Что не так на этом шаге?</label>
        <textarea class="textarea" id="node-comment" rows="3"
          placeholder="Например: здесь теряется два дня — согласование идёт вне платформы."></textarea>
      </div>` : ''}`;

  modal({
    title: 'Обсуждение шага', body, wide: true,
    footer: can('process.comment')
      ? '<button class="btn" data-close>Закрыть</button><button class="btn btn--primary" data-send>Отправить замечание</button>'
      : '<button class="btn" data-close>Закрыть</button>',
    onMount: (el, close) => {
      el.querySelector('[data-send]')?.addEventListener('click', async () => {
        const text = el.querySelector('#node-comment').value.trim();
        if (!text) { toast('Напишите замечание', 'warn'); return; }
        try {
          await api.post(`/api/processes/${diagram.id}/comments`, { node_id: nodeId, body: text });
          close();
          toast('Замечание добавлено — оно видно всем на схеме', 'ok');
          navigate(`/processes?s=${diagram.scenario}&d=${diagram.id}`);
        } catch (e) { toast(e.message, 'danger'); }
      });
      el.querySelectorAll('[data-useful]').forEach((b) => b.onclick = async () => {
        try {
          const c = await api.post(`/api/process-comments/${b.dataset.useful}/useful`);
          b.textContent = `Полезно · ${c.useful}`;
          toast('Отмечено. Автору замечания начислены очки', 'ok');
        } catch (e) { toast(e.message, 'warn'); }
      });
    },
  });
}

/** Завести предложение об изменении процесса и уйти в редактор схемы. */
function proposeChange(diagram) {
  modal({
    title: 'Предложить изменение процесса',
    body: html`
      <p class="prose" style="margin-bottom:14px">
        Вы получите черновую копию действующей схемы «${esc(diagram.title)}» и сможете править её
        в редакторе. Действующая версия не изменится, пока предложение не пройдёт согласование.
      </p>
      <label class="field__label" for="pc-title">Что предлагаете изменить</label>
      <input class="input" id="pc-title" placeholder="Например: убрать отдельный шаг проверки дублей">
      <label class="field__label" for="pc-why" style="margin-top:12px">Обоснование</label>
      <textarea class="textarea" id="pc-why" rows="4"
        placeholder="Почему так работать нельзя и что изменится. Согласующие читают именно это."></textarea>
      <label class="field__label" for="pc-effect" style="margin-top:12px">Ожидаемый эффект — необязательно</label>
      <input class="input" id="pc-effect" placeholder="Например: путь подачи короче на один экран">`,
    footer: '<button class="btn" data-close>Отмена</button><button class="btn btn--primary" data-ok>Создать и открыть редактор</button>',
    onMount: (el, close) => {
      el.querySelector('[data-ok]').onclick = async () => {
        const title = el.querySelector('#pc-title').value.trim();
        const rationale = el.querySelector('#pc-why').value.trim();
        if (!title) { toast('Укажите, что предлагается изменить', 'warn'); return; }
        if (rationale.length < 20) { toast('Обоснование — не менее 20 символов', 'warn'); return; }
        try {
          const c = await api.post('/api/process-changes', {
            process: diagram.id, title, rationale,
            expected_effect: el.querySelector('#pc-effect').value.trim() || null,
          });
          close();
          navigate(`/changes/${c.id}/edit`);
        } catch (e) { toast(e.message, 'danger', 'Не получилось'); }
      };
    },
  });
}

/** Собирает обучающий сценарий из данных схемы и запускает его на самой схеме. */
async function startWalkthrough(view, diagram) {
  const { startTour } = await import('../tour.js');
  const svg = view.querySelector('.bp-svg');
  if (!svg) return;

  const nodeById = Object.fromEntries(diagram.nodes.map((n) => [n.id, n]));
  const { boxes } = layout(diagram, diagram.seq);
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
