// Модуль управления проектами разработки: Agile-доски, спринты, бэклог, документы.
import { api, state, esc, html, avatar, can, navigate, toast, modal, num, fmtDate, fmtShort,
         nl2br, ITEM_STATUS, plural } from '../core.js';

const COLUMNS = ['backlog', 'todo', 'in_progress', 'review', 'done'];
const TYPE_BADGE = { story: ['info', 'История'], task: ['', 'Задача'], bug: ['danger', 'Дефект'] };

export async function projectsList(view) {
  const projects = await api.get('/api/projects');
  view.innerHTML = html`
    <div class="page-head">
      <h2>Разработка прототипов</h2>
      <p>Инициативы, прошедшие Gate 2, превращаются в минимально жизнеспособный продукт по Agile.
         План разработки — 4 спринта по 2 недели; приоритеты каждого спринта утверждает продакт-менеджер ДТСЗН.</p>
    </div>
    ${projects.length ? html`
    <div class="grid grid--3">
      ${projects.map((p) => {
        const pct = p.items_total ? Math.round((p.items_done / p.items_total) * 100) : 0;
        return html`
        <div class="card is-clickable" data-goto="/projects/${p.id}" style="cursor:pointer">
          <div class="card__body">
            <div class="row fs-12 text-3" style="margin-bottom:8px">
              <span class="mono">${esc(p.number)}</span>
              <span class="spacer badge badge--${p.initiative_status === 'scaled' ? 'ok' : 'info'}">Этап ${p.stage === 4 ? '3' : p.stage === 5 ? '4' : '5'}</span>
            </div>
            <div class="fw-600" style="font-size:14px;line-height:1.4;margin-bottom:10px">${esc(p.initiative_title)}</div>
            <div class="row fs-12 text-3" style="justify-content:space-between;margin-bottom:5px">
              <span>Задач выполнено</span><b>${p.items_done} из ${p.items_total}</b>
            </div>
            <div class="progress ${pct === 100 ? 'progress--ok' : ''}"><i style="width:${pct}%"></i></div>
            <div class="row fs-12 text-3" style="margin-top:11px;gap:8px">
              ${p.product_owner_name ? `<span>PO: ${esc(p.product_owner_name.split(' ')[0])}</span>` : ''}
              ${p.team_lead_name ? `<span>· ${esc(p.team_lead_name.split(' ')[0])}</span>` : ''}
            </div>
          </div>
        </div>`;
      })}
    </div>` : '<div class="card"><div class="empty"><h4>Проектов нет</h4><p>Проект создаётся, когда инициатива получает решение Go на Gate 2 и передаётся команде разработки.</p></div></div>'}`;
  view.querySelectorAll('[data-goto]').forEach((el) => el.onclick = () => navigate(el.dataset.goto));
}

export async function projectDetail(view, id) {
  view.innerHTML = '<div class="card"><div class="card__body"><div class="skeleton" style="height:320px"></div></div></div>';
  const p = await api.get(`/api/projects/${id}`);
  const editable = can('board.manage');
  const activeSprint = p.sprints.find((s) => s.status === 'active') || p.sprints.at(-1);
  let currentSprint = activeSprint?.id ?? null;

  const render = () => {
    const items = p.items.filter((i) => currentSprint === 'backlog' ? !i.sprint_id : i.sprint_id === currentSprint);
    const byStatus = Object.fromEntries(COLUMNS.map((c) => [c, items.filter((i) => i.status === c)]));
    const done = items.filter((i) => i.status === 'done').length;
    const points = items.reduce((s, i) => s + (i.estimate || 0), 0);
    const donePoints = items.filter((i) => i.status === 'done').reduce((s, i) => s + (i.estimate || 0), 0);

    view.querySelector('#board-area').innerHTML = html`
      <div class="row" style="margin-bottom:14px">
        <div class="chip-row">
          ${p.sprints.map((s) => html`
            <button class="chip ${currentSprint === s.id ? 'is-on' : ''}" data-sprint="${s.id}">
              ${esc(s.name)}${s.status === 'active' ? ' •' : ''}
            </button>`)}
          <button class="chip ${currentSprint === 'backlog' ? 'is-on' : ''}" data-sprint="backlog">Бэклог продукта</button>
        </div>
        ${editable ? '<button class="btn btn--sm btn--primary spacer" data-add-item>Добавить задачу</button>' : ''}
      </div>

      ${currentSprint !== 'backlog' && activeSprint ? html`
      <div class="card" style="margin-bottom:14px">
        <div class="card__body row" style="gap:26px;flex-wrap:wrap">
          <div>
            <div class="fs-12 text-3">Цель спринта</div>
            <div class="fw-600 fs-13">${esc(p.sprints.find((s) => s.id === currentSprint)?.goal || '—')}</div>
          </div>
          <div class="spacer row" style="gap:26px">
            <div><div class="fs-12 text-3">Задач готово</div><div class="fw-600">${done} из ${items.length}</div></div>
            <div><div class="fs-12 text-3">Оценка (story points)</div><div class="fw-600">${donePoints} из ${points}</div></div>
            <div><div class="fs-12 text-3">Сроки</div><div class="fw-600 fs-13">
              ${fmtShort(p.sprints.find((s) => s.id === currentSprint)?.starts_at)} — ${fmtShort(p.sprints.find((s) => s.id === currentSprint)?.ends_at)}</div></div>
          </div>
        </div>
      </div>` : ''}

      <div class="board">
        ${COLUMNS.map((col) => html`
          <div class="board__col" data-col="${col}">
            <div class="board__col-head">
              ${esc(ITEM_STATUS[col])}
              <span class="board__col-count">${byStatus[col].length}</span>
            </div>
            <div class="board__items">
              ${byStatus[col].map((i) => html`
                <div class="board__item" draggable="${editable}" data-item="${i.id}">
                  <div class="board__item-title">${esc(i.title)}</div>
                  <div class="board__item-meta">
                    <span class="badge badge--${TYPE_BADGE[i.type]?.[0] || ''}">${TYPE_BADGE[i.type]?.[1] || i.type}</span>
                    ${i.estimate ? `<span class="badge badge--outline">${i.estimate}</span>` : ''}
                    ${i.priority === 'high' ? '<span class="badge badge--warn">Высокий</span>' : ''}
                    ${i.assignee_name ? avatar(i.assignee_name, 'avatar--sm') : ''}
                  </div>
                </div>`)}
            </div>
          </div>`)}
      </div>`;

    // Переключение спринтов
    view.querySelectorAll('[data-sprint]').forEach((b) => b.onclick = () => {
      currentSprint = b.dataset.sprint === 'backlog' ? 'backlog' : Number(b.dataset.sprint);
      render();
    });
    view.querySelector('[data-add-item]')?.addEventListener('click', () => addItemModal(p, currentSprint, async () => {
      const fresh = await api.get(`/api/projects/${id}`);
      p.items = fresh.items; render();
    }));

    if (!editable) return;
    // Перетаскивание задач между колонками
    let dragged = null;
    view.querySelectorAll('.board__item').forEach((el) => {
      el.addEventListener('dragstart', () => { dragged = el; el.classList.add('is-dragging'); });
      el.addEventListener('dragend', () => { el.classList.remove('is-dragging'); dragged = null; });
    });
    view.querySelectorAll('.board__col').forEach((col) => {
      col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('is-over'); });
      col.addEventListener('dragleave', () => col.classList.remove('is-over'));
      col.addEventListener('drop', async (e) => {
        e.preventDefault(); col.classList.remove('is-over');
        if (!dragged) return;
        const itemId = Number(dragged.dataset.item);
        const status = col.dataset.col;
        const item = p.items.find((i) => i.id === itemId);
        if (!item || item.status === status) return;
        const prev = item.status;
        item.status = status;
        render();
        try { await api.patch(`/api/board-items/${itemId}`, { status }); }
        catch (err) { item.status = prev; render(); toast(err.message, 'error'); }
      });
    });
  };

  view.innerHTML = html`
    <div class="crumb"><a href="/projects">Разработка</a> <span>/</span> <span class="mono">${esc(p.number)}</span></div>
    <div class="page-head">
      <div class="page-head__row">
        <div style="flex:1;min-width:250px">
          <h2>${esc(p.initiative_title)}</h2>
          <p>Продакт-менеджер: ${esc(p.product_owner_name || '—')} · Руководитель команды: ${esc(p.team_lead_name || '—')}</p>
        </div>
        <a href="/initiatives/${p.initiative_id}" class="btn">Карточка инициативы</a>
      </div>
    </div>
    <div id="board-area"></div>

    ${p.documents.length ? html`
    <div class="card" style="margin-top:18px">
      <div class="card__head"><h3>Хранилище документов</h3>
        <span class="card__hint spacer">Техническая документация, архитектура, результаты тестирования</span></div>
      <div class="card__body--flush"><div class="list">
        ${p.documents.map((d) => html`
          <div class="list__item">
            <div class="list__main">
              <div class="list__title">${esc(d.title)}</div>
              <div class="list__body">${esc(d.body || '')}</div>
              <div class="list__meta">
                <span class="badge badge--outline">${esc({ arch: 'Архитектура', test: 'Тестирование', manual: 'Инструкция', doc: 'Документ' }[d.kind] || d.kind)}</span>
                <span>${esc(d.author_name)}</span><span>${fmtDate(d.created_at)}</span>
              </div>
            </div>
          </div>`)}
      </div></div>
    </div>` : ''}`;

  render();
}

function addItemModal(project, sprintId, onDone) {
  modal({
    title: 'Новая задача',
    body: html`
      <div class="field">
        <label class="field__label" for="i-title">Название <span class="req">*</span></label>
        <input class="input" id="i-title" required placeholder="Что нужно сделать">
      </div>
      <div class="field">
        <label class="field__label" for="i-desc">Описание</label>
        <textarea class="textarea" id="i-desc" style="min-height:80px"></textarea>
      </div>
      <div class="row" style="gap:12px;align-items:flex-start">
        <div class="field" style="flex:1">
          <label class="field__label" for="i-type">Тип</label>
          <select class="select" id="i-type">
            <option value="task">Задача</option><option value="story">История</option><option value="bug">Дефект</option>
          </select>
        </div>
        <div class="field" style="flex:1">
          <label class="field__label" for="i-priority">Приоритет</label>
          <select class="select" id="i-priority">
            <option value="normal">Обычный</option><option value="high">Высокий</option><option value="low">Низкий</option>
          </select>
        </div>
        <div class="field" style="width:110px">
          <label class="field__label" for="i-estimate">Оценка</label>
          <input class="input" id="i-estimate" type="number" min="0" value="3">
        </div>
      </div>`,
    footer: '<button class="btn" data-close>Отмена</button><button class="btn btn--primary" data-ok>Создать</button>',
    onMount: (el, close) => {
      el.querySelector('[data-ok]').onclick = async () => {
        const title = el.querySelector('#i-title').value.trim();
        if (!title) { toast('Укажите название задачи', 'error'); return; }
        try {
          await api.post(`/api/projects/${project.id}/items`, {
            title, description: el.querySelector('#i-desc').value.trim(),
            type: el.querySelector('#i-type').value, priority: el.querySelector('#i-priority').value,
            estimate: Number(el.querySelector('#i-estimate').value) || 0,
            sprint_id: sprintId === 'backlog' ? null : sprintId,
            status: sprintId === 'backlog' ? 'backlog' : 'todo',
          });
          toast('Задача создана', 'ok'); close(); onDone();
        } catch (err) { toast(err.message, 'error'); }
      };
    },
  });
}
