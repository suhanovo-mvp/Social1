// Быстрое ревью предложений: колода карточек, свайпы на телефоне,
// кнопки для клавиатуры и доступности, фильтры очереди.
//
// Лайк здесь — триаж, а не признание вклада: он поднимает полезность
// предложения и его место в очереди модератора, но очков автору не начисляет.
import { api, esc, html, avatar, can, navigate, toast, modal, nl2br, num,
         fmtAgo } from '../core.js';

// Метка устройства нужна антифроду: несколько учётных записей с одного
// устройства — сигнал модератору. Хранится локально и не содержит персональных данных.
const DEVICE_KEY = 's1-review-device';
function deviceId() {
  try {
    let d = localStorage.getItem(DEVICE_KEY);
    if (!d) { d = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem(DEVICE_KEY, d); }
    return d;
  } catch { return null; }
}

const ICON = {
  like: '<path d="M9 11H5v10h4V11zM14 21h4.3a2 2 0 002-1.6l1.4-7a2 2 0 00-2-2.4H15l.6-3.4A2 2 0 0013.6 4L9 11v10h5z"/>',
  skip: '<path d="M18 6L6 18M6 6l12 12"/>',
  favorite: '<path d="M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3-5.8 3 1.1-6.5L2.6 9.8l6.5-.9L12 3z"/>',
  details: '<path d="M12 16v-4M12 8h.01M12 22a10 10 0 100-20 10 10 0 000 20z"/>',
  undo: '<path d="M3 7v6h6M3.5 13a9 9 0 103-7.7L3 8"/>',
};
const icon = (k, size = 20) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON[k]}</svg>`;

const FILTER_KEYS = ['idea', 'category', 'kind', 'status', 'priority', 'period'];

export async function reviewView(view, query) {
  if (!can('idea.review')) {
    view.innerHTML = '<div class="card"><div class="empty"><h4>Недостаточно прав</h4><p>Ваша роль не участвует в ревью предложений.</p></div></div>';
    return;
  }

  const params = new URLSearchParams();
  for (const k of FILTER_KEYS) if (query.get(k)) params.set(k, query.get(k));

  view.innerHTML = '<div class="card"><div class="card__body"><div class="skeleton" style="height:420px"></div></div></div>';
  const [meta, data] = await Promise.all([
    api.get('/api/review/filters'),
    api.get(`/api/review/queue?${params}`),
  ]);

  const activeFilters = FILTER_KEYS.filter((k) => query.get(k)).length;

  view.innerHTML = html`
    <div class="page-head">
      <div class="page-head__row">
        <div style="flex:1;min-width:250px">
          <h2>Ревью предложений</h2>
          <p>Пролистайте решения коллег и отметьте те, что кажутся рабочими. Одно движение
             на карточку — этого достаточно, чтобы полезное поднялось наверх и попало
             к модератору первым.</p>
        </div>
        <div class="row">
          <button class="btn ${activeFilters ? 'btn--primary' : ''}" data-filters>
            Фильтры${activeFilters ? ` · ${activeFilters}` : ''}
          </button>
          ${can('idea.moderate') ? '<a href="/moderation?tab=top" class="btn">Топ предложений</a>' : ''}
        </div>
      </div>
    </div>

    <div class="review" data-tour="review">
      <div class="review__stage" id="stage"></div>
      <div class="review__side stack">
        <div class="card">
          <div class="card__head"><h3>Что означают оценки</h3></div>
          <div class="card__body">
            <dl class="review__legend">
              <dt class="is-like">${icon('like', 15)} Полезно</dt>
              <dd>Решение выглядит рабочим. Повышает полезность предложения.</dd>
              <dt class="is-skip">${icon('skip', 15)} Пропустить</dt>
              <dd>Не поддерживаю. Можно указать причину — она поможет автору доработать.</dd>
              <dt class="is-fav">${icon('favorite', 15)} В избранное</dt>
              <dd>Требует внимания модератора. Поднимает предложение в его очереди.</dd>
            </dl>
            <div class="review__note">
              Оценки здесь не начисляют очки автору. Очки начисляются только после
              модерации, отметки автором идеи или внедрения — так лайки невозможно накрутить.
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card__head"><h3>Ваша сессия</h3></div>
          <div class="card__body">
            <dl class="def">
              <dt>Оценено сегодня</dt><dd id="stat-today">${num(data.reviewed_today)}</dd>
              <dt>Осталось в очереди</dt><dd id="stat-left">${num(data.remaining)}</dd>
            </dl>
            <div class="review__hint">
              На телефоне карточку можно тянуть: вправо — полезно, влево — пропустить,
              вверх — в избранное. На компьютере работают стрелки ← → ↑ и клавиша Enter.
            </div>
          </div>
        </div>
      </div>
    </div>`;

  const stage = view.querySelector('#stage');
  view.querySelector('[data-filters]').onclick = () => filtersModal(meta, query);
  mountDeck(stage, view, data, meta, () => reviewView(view, query));
}

// ══ Колода карточек ══════════════════════════════════════════
function mountDeck(stage, view, data, meta, reload) {
  const queue = [...data.items];
  let remaining = data.remaining;
  let today = data.reviewed_today;
  const history = [];        // для возврата к предыдущей карточке
  let shownAt = Date.now();
  let busy = false;

  const statToday = view.querySelector('#stat-today');
  const statLeft = view.querySelector('#stat-left');

  function render() {
    if (!queue.length) {
      stage.innerHTML = html`
        <div class="card"><div class="empty">
          <h4>Очередь пройдена</h4>
          <p>${remaining > 0
            ? 'Загрузите следующую партию — предложения ещё остались.'
            : 'Все доступные предложения оценены. Загляните позже: коллеги предлагают решения каждый день.'}</p>
          <div class="row" style="justify-content:center;margin-top:14px">
            ${history.length && data.undo_enabled ? '<button class="btn" data-undo>Вернуть предыдущую</button>' : ''}
            ${remaining > 0 ? '<button class="btn btn--primary" data-more>Показать ещё</button>' : ''}
            <a href="/ideas" class="btn">К идеям</a>
          </div>
        </div></div>`;
      stage.querySelector('[data-more]')?.addEventListener('click', reload);
      stage.querySelector('[data-undo]')?.addEventListener('click', undo);
      return;
    }

    // Показываем текущую карточку и край следующей — так видно, что колода не кончилась
    stage.innerHTML = html`
      <div class="deck">
        ${queue[1] ? '<div class="deck__peek"></div>' : ''}
        ${card(queue[0])}
      </div>
      <div class="deck__actions">
        <button class="rev-btn rev-btn--skip" data-act="skip" title="Пропустить — стрелка влево" aria-label="Пропустить">
          ${icon('skip', 22)}<span>Пропустить</span></button>
        <button class="rev-btn rev-btn--fav" data-act="favorite" title="В избранное — стрелка вверх" aria-label="В избранное">
          ${icon('favorite', 20)}<span>В избранное</span></button>
        <button class="rev-btn rev-btn--details" data-act="details" title="Подробнее — Enter" aria-label="Подробнее">
          ${icon('details', 20)}<span>Подробнее</span></button>
        <button class="rev-btn rev-btn--like" data-act="like" title="Полезно — стрелка вправо" aria-label="Полезно">
          ${icon('like', 22)}<span>Полезно</span></button>
      </div>
      <div class="deck__foot">
        <span class="fs-12 text-3">Осталось: ${num(remaining)}</span>
        ${history.length && data.undo_enabled
          ? `<button class="btn btn--sm btn--ghost" data-act="undo">${icon('undo', 14)} Вернуть предыдущую</button>` : ''}
      </div>`;

    shownAt = Date.now();
    bindCard();
  }

  function card(c) {
    return html`
      <article class="rev-card" id="top-card" tabindex="0" role="group"
               aria-label="Предложение по идее ${esc(c.idea_number)}">
        <div class="rev-card__stamp rev-card__stamp--like">Полезно</div>
        <div class="rev-card__stamp rev-card__stamp--skip">Пропуск</div>
        <div class="rev-card__stamp rev-card__stamp--fav">В избранное</div>

        <div class="rev-card__head">
          <span class="badge ${c.kind === 'experience' ? 'badge--purple' : 'badge--info'}">${esc(c.kind_title)}</span>
          ${c.category ? `<span class="badge badge--outline">${esc(c.category)}</span>` : ''}
          ${c.priority === 'high' ? '<span class="badge badge--warn">Срочно</span>' : ''}
          <span class="spacer fs-12 text-3 mono">${esc(c.idea_number)}</span>
        </div>

        <div class="rev-card__idea">
          <span>Идея</span>
          <b>${esc(c.idea_title)}</b>
        </div>

        <div class="rev-card__body">
          <div class="rev-card__summary">${esc(c.summary)}</div>
          ${c.expected_effect ? html`
            <div class="rev-card__effect"><span>Ожидаемый эффект</span>${esc(c.expected_effect)}</div>` : ''}
        </div>

        <div class="rev-card__foot">
          ${avatar(c.author_name, 'avatar--sm')}
          <div style="min-width:0;flex:1">
            <div class="fs-13 fw-600 truncate">${esc(c.author_name)}</div>
            <div class="fs-12 text-3 truncate">${esc(c.author_institution || '')} · ${fmtAgo(c.created_at)}</div>
          </div>
          <div class="rev-card__score" title="Полезность: лайки и избранное">
            ${icon('like', 13)}<b data-likes>${c.likes}</b>
          </div>
        </div>
      </article>`;
  }

  // ── Ввод: свайпы, кнопки, клавиатура ───────────────────────
  function bindCard() {
    const el = stage.querySelector('#top-card');
    stage.querySelectorAll('[data-act]').forEach((b) => b.onclick = () => {
      const a = b.dataset.act;
      if (a === 'details') return openDetails(queue[0]);
      if (a === 'undo') return undo();
      fly(a);
    });
    if (!el) return;
    el.focus({ preventScroll: true });

    let startX = 0, startY = 0, dx = 0, dy = 0, dragging = false;
    const THRESHOLD = 90;

    const down = (e) => {
      if (busy || e.target.closest('button')) return;
      dragging = true; dx = dy = 0;
      startX = e.clientX; startY = e.clientY;
      el.setPointerCapture?.(e.pointerId);
      el.classList.add('is-dragging');
    };
    const move = (e) => {
      if (!dragging) return;
      dx = e.clientX - startX; dy = e.clientY - startY;
      // Вверх засчитывается, только когда движение действительно вертикальное
      const up = dy < -THRESHOLD && Math.abs(dy) > Math.abs(dx);
      el.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 22}deg)`;
      el.classList.toggle('show-like', !up && dx > 40);
      el.classList.toggle('show-skip', !up && dx < -40);
      el.classList.toggle('show-fav', up);
    };
    const up = () => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('is-dragging', 'show-like', 'show-skip', 'show-fav');
      const vertical = dy < -THRESHOLD && Math.abs(dy) > Math.abs(dx);
      if (vertical) return fly('favorite');
      if (dx > THRESHOLD) return fly('like');
      if (dx < -THRESHOLD) return fly('skip');
      el.style.transform = '';   // не дотянули — карточка возвращается на место
    };

    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('click', (e) => {
      // Тап по карточке открывает подробности, но не после перетаскивания
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6 && !e.target.closest('button')) openDetails(queue[0]);
    });
  }

  const onKey = (e) => {
    if (!stage.isConnected) { document.removeEventListener('keydown', onKey); return; }
    if (busy || !queue.length || e.target.matches('input, textarea, select')) return;
    if (document.querySelector('.modal-backdrop')) return;
    const map = { ArrowRight: 'like', ArrowLeft: 'skip', ArrowUp: 'favorite' };
    if (map[e.key]) { e.preventDefault(); fly(map[e.key]); }
    else if (e.key === 'Enter') { e.preventDefault(); openDetails(queue[0]); }
  };
  document.addEventListener('keydown', onKey);

  // ── Отправка оценки ────────────────────────────────────────
  async function fly(verdict) {
    if (busy || !queue.length) return;
    const current = queue[0];
    // Причина пропуска — необязательный шаг: спрашиваем, но не задерживаем
    if (verdict === 'skip') {
      const reason = await askReason(meta.reasons);
      if (reason === false) return;          // закрыли окно — оценка не ставится
      return send(current, verdict, reason || null);
    }
    send(current, verdict, null);
  }

  async function send(current, verdict, reason) {
    busy = true;
    const el = stage.querySelector('#top-card');
    const dir = verdict === 'like' ? 'right' : verdict === 'skip' ? 'left' : 'up';
    el?.classList.add(`fly-${dir}`);
    try {
      const r = await api.post(`/api/review/${current.id}`, {
        verdict, reason,
        dwell_ms: Date.now() - shownAt,
        device: deviceId(),
      });
      history.unshift({ id: current.id, card: current });
      queue.shift();
      remaining = Math.max(0, remaining - 1);
      today += 1;
      statToday.textContent = num(today);
      statLeft.textContent = num(remaining);
      if (r.flagged) {
        toast('Оценки идут слишком быстро — активность передана модератору на проверку', 'error');
      }
      setTimeout(() => { busy = false; render(); }, 160);
    } catch (err) {
      busy = false;
      el?.classList.remove(`fly-${dir}`);
      toast(err.message, 'error');
      if (err.status === 409) { queue.shift(); render(); }   // уже оценено в другой вкладке
    }
  }

  async function undo() {
    const last = history[0];
    if (!last) return;
    try {
      await api.del(`/api/review/${last.id}`);
      history.shift();
      queue.unshift(last.card);
      remaining += 1;
      today = Math.max(0, today - 1);
      statToday.textContent = num(today);
      statLeft.textContent = num(remaining);
      render();
      toast('Карточка возвращена', 'ok');
    } catch (err) { toast(err.message, 'error'); }
  }

  render();
}

// ── Причина пропуска ─────────────────────────────────────────
function askReason(reasons) {
  return new Promise((resolve) => {
    let answered = false;
    const close = modal({
      title: 'Что не так с решением?',
      body: html`
        <p class="prose" style="margin-bottom:14px">Необязательный шаг. Причина не видна автору
           по отдельности — модератор смотрит на неё сводно, когда решает, что доработать.</p>
        <div class="chip-row" id="reasons">
          ${Object.entries(reasons).map(([k, t]) => `<button class="chip" data-reason="${k}">${esc(t)}</button>`)}
        </div>`,
      footer: '<button class="btn" data-skip-reason>Пропустить без причины</button>',
      onMount: (el, done) => {
        el.querySelectorAll('[data-reason]').forEach((b) => b.onclick = () => {
          answered = true; done(); resolve(b.dataset.reason);
        });
        el.querySelector('[data-skip-reason]').onclick = () => { answered = true; done(); resolve(null); };
        el.addEventListener('click', (e) => {
          if ((e.target === el || e.target.closest('[data-close]')) && !answered) resolve(false);
        });
      },
    });
  });
}

// ── Подробности предложения ──────────────────────────────────
function openDetails(c) {
  if (!c) return;
  modal({
    title: `Предложение по идее ${c.idea_number}`, wide: true,
    body: html`
      <div class="rev-details">
        <div class="rev-details__idea">
          <div class="fs-12 fw-600 text-3" style="text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px">Идея</div>
          <b class="fs-14">${esc(c.idea_title)}</b>
          <div class="prose" style="margin-top:7px">${nl2br(c.idea_problem)}</div>
        </div>
        <div class="row" style="margin:16px 0 12px">
          <span class="badge ${c.kind === 'experience' ? 'badge--purple' : 'badge--info'}">${esc(c.kind_title)}</span>
          <span class="badge badge--outline">${esc(c.status_title || '')}</span>
          <span class="fs-12 text-3 spacer">${esc(c.author_name)}${c.author_institution ? ' · ' + esc(c.author_institution) : ''}</span>
        </div>
        <div class="prose" style="margin-bottom:14px">${nl2br(c.summary)}</div>
        ${c.how_to_apply ? `<div class="prop__field"><span>Как применить</span><div class="prose">${nl2br(c.how_to_apply)}</div></div>` : ''}
        ${c.expected_effect ? `<div class="prop__field"><span>Ожидаемый эффект</span><div class="prose">${nl2br(c.expected_effect)}</div></div>` : ''}
        ${c.risks ? `<div class="prop__field"><span>Риски и ограничения</span><div class="prose">${nl2br(c.risks)}</div></div>` : ''}
        ${c.needs_approval ? '<div class="prop__flag">Требуется одобрение руководителя</div>' : ''}
        <div class="row fs-12 text-3" style="margin-top:16px">
          <span>Полезно: ${c.likes}</span><span>В избранном: ${c.favorites}</span>
          <span>Подтверждений на странице идеи: ${c.endorsements}</span>
        </div>
      </div>`,
    footer: `<a class="btn" href="/ideas/${c.idea_id}">Открыть идею целиком</a>
             <button class="btn btn--primary" data-close>Вернуться к ревью</button>`,
  });
}

// ── Фильтры очереди ──────────────────────────────────────────
function filtersModal(meta, query) {
  const sel = (name, label, options, empty) => html`
    <div class="field">
      <label class="field__label" for="f-${name}">${esc(label)}</label>
      <select class="select" id="f-${name}">
        <option value="">${esc(empty)}</option>
        ${options.map(([v, t]) => `<option value="${esc(v)}" ${query.get(name) === String(v) ? 'selected' : ''}>${esc(t)}</option>`)}
      </select>
    </div>`;

  modal({
    title: 'Фильтры очереди', wide: true,
    body: html`
      ${sel('idea', 'Идея или задача',
        meta.ideas.map((i) => [i.id, `${i.number} — ${i.title.slice(0, 60)} (${i.proposals})`]),
        'Любая идея')}
      <div class="grid grid--2">
        ${sel('category', 'Категория', meta.categories.map((c) => [c.name, `${c.name} (${c.count})`]), 'Все направления')}
        ${sel('kind', 'Тип предложения', Object.entries(meta.kinds), 'Любой тип')}
        ${sel('status', 'Статус предложения', Object.entries(meta.statuses).map(([k, v]) => [k, v.title]), 'Любой статус')}
        ${sel('priority', 'Приоритет идеи', Object.entries(meta.priorities), 'Любой приоритет')}
      </div>
      ${sel('period', 'Период публикации', Object.entries(meta.periods).filter(([k]) => k !== 'all'), 'За всё время')}`,
    footer: `<button class="btn" data-reset>Сбросить</button>
             <button class="btn btn--primary" data-ok>Применить</button>`,
    onMount: (el, close) => {
      el.querySelector('[data-reset]').onclick = () => { close(); navigate('/review'); };
      el.querySelector('[data-ok]').onclick = () => {
        const p = new URLSearchParams();
        for (const k of FILTER_KEYS) {
          const v = el.querySelector(`#f-${k}`)?.value;
          if (v) p.set(k, v);
        }
        close();
        navigate(`/review${p.toString() ? '?' + p : ''}`);
      };
    },
  });
}
