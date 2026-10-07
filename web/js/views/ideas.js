// Модуль «Идеи и решения»: доска идей, быстрая подача, карточка идеи с решениями.
// Сотрудник фиксирует проблему за минуту, коллеги предлагают решения и делятся
// проверенным опытом, модератор проверяет вклад, за который начисляются очки.
import { api, esc, html, avatar, can, navigate, toast, modal, confirmDialog,
         nl2br, num, fmtDate, fmtAgo, plural, debounce } from '../core.js';

// ── Словари ──────────────────────────────────────────────────
export const IDEA_STATUS = {
  new:         { title: 'Новая',                tone: 'info' },
  review:      { title: 'На рассмотрении',      tone: 'warn' },
  accepted:    { title: 'Принята к обсуждению', tone: 'accent' },
  in_progress: { title: 'В работе',             tone: 'purple' },
  done:        { title: 'Реализована',          tone: 'ok' },
  rejected:    { title: 'Отклонена',            tone: 'muted' },
  archived:    { title: 'Архив',                tone: 'muted' },
};
const FLOW = ['new', 'review', 'accepted', 'in_progress', 'done'];

const PROPOSAL_STATUS = {
  published:   { title: 'Опубликовано',     tone: 'info' },
  useful:      { title: 'Полезное',         tone: 'accent' },
  verified:    { title: 'Проверенный опыт', tone: 'ok' },
  implemented: { title: 'Внедрено',         tone: 'ok' },
  rejected:    { title: 'Отклонено',        tone: 'muted' },
};

const REACTIONS = [
  ['useful',  'Полезно',           'M9 11H5v10h4V11zM14 21h4.3a2 2 0 002-1.6l1.4-7a2 2 0 00-2-2.4H15l.6-3.4A2 2 0 0013.6 4L9 11v10h5z'],
  ['support', 'Поддерживаю',       'M12 21s-7.5-4.6-9.5-9A5.2 5.2 0 0112 5.6 5.2 5.2 0 0121.5 12c-2 4.4-9.5 9-9.5 9z'],
  ['join',    'Готов участвовать', 'M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM19 8v6M22 11h-6'],
];

const SORTS = [
  ['new', 'Новые'],
  ['support', 'Поддержанные'],
  ['trending', 'Набирают поддержку'],
  ['discussed', 'С решениями'],
];

const ICON_BULB = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 22h4M12 2a7 7 0 00-4 12.7V17h8v-2.3A7 7 0 0012 2z"/></svg>';
const ICON_COMMENT = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.4 8.4 0 01-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.4 8.4 0 013.8-.9h.5a8.5 8.5 0 018 8v.5z"/></svg>';
const ICON_CHECK = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';

const reactionIcon = (path) =>
  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;

export const statusChip = (status) => {
  const m = IDEA_STATUS[status] || IDEA_STATUS.new;
  return html`<span class="st st--${m.tone}"><i></i>${esc(m.title)}</span>`;
};

// ══════════════════════════════════════════════════════════════
// Доска идей
// ══════════════════════════════════════════════════════════════
export async function ideasBoard(view, query) {
  const sort = query.get('sort') || 'new';
  const status = query.get('status') || '';
  const category = query.get('category') || '';
  const search = query.get('q') || '';
  const mine = query.get('mine') || '';

  view.innerHTML = '<div class="ideas">' + '<div class="skeleton" style="height:112px"></div>'.repeat(4) + '</div>';

  const params = new URLSearchParams({ sort, limit: '100' });
  for (const [k, v] of [['status', status], ['category', category], ['q', search], ['mine', mine]]) {
    if (v) params.set(k, v);
  }
  const [data, categories] = await Promise.all([
    api.get(`/api/ideas?${params}`),
    api.get('/api/ideas/categories'),
  ]);
  const items = data.items;
  const c = data.counts || {};

  view.innerHTML = html`
    <div class="page-head">
      <div class="page-head__row">
        <div style="flex:1;min-width:260px">
          <h2>Идеи и решения</h2>
          <p>Быстрый вход в экосистему: сформулируйте проблему за минуту — коллеги предложат
             решения и поделятся опытом, который у них уже сработал. За полезный вклад
             социальные советники получают очки, а идея с найденным решением поднимается в инициативу.</p>
        </div>
        ${can('idea.create') ? '<a href="/ideas/new" class="btn btn--primary" data-tour="new-idea">Подать идею за минуту</a>' : ''}
      </div>
      <div class="status-flow" style="margin-top:14px">
        ${FLOW.map((k, n) => html`
          ${n ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 6l6 6-6 6"/></svg>' : ''}
          ${statusChip(k)}`)}
      </div>
    </div>

    <div class="idea-toolbar" data-tour="idea-filters">
      <div class="seg" id="sorts">
        ${SORTS.map(([k, t]) => `<button data-sort="${k}" class="${sort === k ? 'is-on' : ''}">${t}</button>`)}
      </div>
      <input class="input" type="search" id="idea-q" placeholder="Поиск по идеям…" value="${esc(search)}"
             style="min-width:180px;flex:1;max-width:290px">
      <select data-ac="US-IDEA-003/AC6" class="select" id="idea-status">
        <option value="">Любой статус</option>
        ${Object.entries(IDEA_STATUS).map(([k, m]) =>
          `<option value="${k}" ${status === k ? 'selected' : ''}>${esc(m.title)}${c[k] ? ` (${c[k]})` : ''}</option>`)}
      </select>
      <select class="select" id="idea-category">
        <option value="">Все направления</option>
        ${categories.map((x) => `<option value="${esc(x.name)}" ${category === x.name ? 'selected' : ''}>${esc(x.name)} (${x.count})</option>`)}
      </select>
      <button class="chip ${mine ? 'is-on' : ''}" id="idea-mine">Мои идеи</button>
      <span class="spacer fs-12 text-3">${num(data.total)} ${plural(data.total, 'идея', 'идеи', 'идей')}</span>
    </div>

    ${items.length ? html`
      <div class="ideas" data-tour="idea-list">${items.map(ideaCard)}</div>` : html`
      <div class="card"><div class="empty">
        <h4>Ничего не найдено</h4>
        <p>Измените условия отбора или предложите свою идею — на её решение
           откликнутся коллеги из других учреждений.</p>
        ${can('idea.create') ? '<a href="/ideas/new" class="btn btn--primary" style="margin-top:14px">Подать идею</a>' : ''}
      </div></div>`}`;

  const setParam = (key, value) => {
    const p = new URLSearchParams(location.search);
    if (value) p.set(key, value); else p.delete(key);
    navigate(`/ideas${p.toString() ? '?' + p : ''}`);
  };
  view.querySelectorAll('[data-sort]').forEach((b) => b.onclick = () => setParam('sort', b.dataset.sort));
  view.querySelector('#idea-status').onchange = (e) => setParam('status', e.target.value);
  view.querySelector('#idea-category').onchange = (e) => setParam('category', e.target.value);
  view.querySelector('#idea-mine').onclick = () => setParam('mine', mine ? '' : '1');
  view.querySelector('#idea-q').addEventListener('input', debounce((e) => setParam('q', e.target.value.trim()), 400));
  view.querySelectorAll('[data-open]').forEach((el) => el.onclick = () => navigate(`/ideas/${el.dataset.open}`));
  bindReactions(view, items);
}

function ideaCard(i) {
  return html`
    <article data-ac="US-IDEA-001/AC4" class="idea" data-idea="${i.id}">
      <div class="idea__rail">
        <div class="idea__rail-value">${i.support_total}</div>
        <div class="idea__rail-label">${plural(i.support_total, 'отметка', 'отметки', 'отметок')}</div>
        ${i.proposals_count ? html`
          <div class="idea__rail-sub" title="Предложено решений">${ICON_BULB}${i.proposals_count}</div>` : ''}
      </div>
      <div class="idea__body">
        <div class="idea__head">
          <div class="idea__title" data-open="${i.id}">${esc(i.title)}</div>
          ${statusChip(i.status)}
        </div>
        <div class="idea__excerpt">${esc(i.problem)}</div>
        <div class="idea__meta">
          <span class="mono">${esc(i.number)}</span>
          ${i.category ? `<span>${esc(i.category)}</span>` : ''}
          <span>${esc(i.author_name)}${i.institution_short ? ' · ' + esc(i.institution_short) : ''}</span>
          ${i.comments_count ? `<span class="idea__stat">${ICON_COMMENT}${i.comments_count}</span>` : ''}
          ${i.experience_count ? `<span class="idea__stat" title="Подтверждённый опыт">${ICON_CHECK}${i.experience_count}</span>` : ''}
          <span>${fmtAgo(i.created_at)}</span>
        </div>
        ${reactionBar(i)}
      </div>
    </article>`;
}

function reactionBar(i, size = 'sm') {
  const closed = ['rejected', 'archived'].includes(i.status);
  return html`
    <div class="react-bar ${size === 'lg' ? 'react-bar--lg' : ''}" data-react-for="${i.id}">
      ${REACTIONS.map(([kind, title, path]) => {
        const on = (i.my_reactions || []).includes(kind);
        const count = i[`r_${kind}`] || 0;
        return html`
          <button class="react ${on ? 'is-on' : ''}" data-kind="${kind}" ${closed ? 'disabled' : ''}
                  title="${closed ? 'Идея закрыта' : title}" aria-pressed="${on}">
            ${reactionIcon(path)}<span>${esc(title)}</span>
            <b data-count="${kind}">${count || ''}</b>
          </button>`;
      })}
    </div>`;
}

/** Отметки ставятся без перезагрузки списка — карточка обновляется на месте. */
function bindReactions(root, items) {
  root.querySelectorAll('[data-react-for]').forEach((bar) => {
    const id = Number(bar.dataset.reactFor);
    bar.querySelectorAll('.react').forEach((btn) => btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (btn.disabled) return;
      bar.classList.add('is-busy');
      try {
        const r = await api.post(`/api/ideas/${id}/reactions`, { kind: btn.dataset.kind });
        for (const [kind] of REACTIONS) {
          const el = bar.querySelector(`[data-count="${kind}"]`);
          if (el) el.textContent = r[`r_${kind}`] || '';
          bar.querySelector(`.react[data-kind="${kind}"]`)?.classList.toggle('is-on', r.my_reactions.includes(kind));
        }
        const item = items?.find((x) => x.id === id);
        if (item) { Object.assign(item, r); }
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        bar.classList.remove('is-busy');
      }
    }));
  });
}

// ══════════════════════════════════════════════════════════════
// Быстрая подача идеи
// ══════════════════════════════════════════════════════════════
export async function ideaCreate(view) {
  if (!can('idea.create')) {
    view.innerHTML = '<div class="card"><div class="empty"><h4>Недостаточно прав</h4><p>Ваша роль не подаёт идеи, но может предлагать решения по идеям коллег.</p></div></div>';
    return;
  }
  const [meta, draft] = await Promise.all([
    api.get('/api/ideas/templates'),
    api.get('/api/ideas/draft').catch(() => null),
  ]);
  const startedAt = Date.now();

  view.innerHTML = html`
    <div class="crumb"><a href="/ideas">Идеи и решения</a> <span>/</span> <span>Новая идея</span></div>
    <div class="quick" data-tour="quick-form">
      <form data-ac="US-IDEA-001/AC1" class="card" id="idea-form">
        <div class="card__head">
          <div>
            <h3>Опишите проблему — решение найдут коллеги</h3>
            <div class="card__hint">Три поля, одна минута. Остальное можно не заполнять.</div>
          </div>
          <div class="quick__timer spacer" id="quick-timer" title="Сколько времени занимает подача">0:00</div>
        </div>
        <div class="card__body">
          <div class="field">
            <label class="field__label">С чего начать — выберите шаблон</label>
            <div data-ac="US-IDEA-001/AC2" class="chip-row" id="templates">
              ${meta.templates.map((t) => `<button type="button" class="chip" data-tpl="${esc(t.code)}">${esc(t.title)}</button>`)}
            </div>
          </div>

          <div class="field">
            <label class="field__label" for="q-title">Коротко о чём идея <span class="req">*</span></label>
            <input class="input" id="q-title" name="title" maxlength="160" autocomplete="off"
                   placeholder="Например: приём заявлений занимает слишком много времени">
          </div>

          <div class="field">
            <label class="field__label" for="q-problem">В чём проблема <span class="req">*</span></label>
            <textarea class="textarea" id="q-problem" name="problem" style="min-height:88px"
              placeholder="Что мешает в работе, как часто это происходит и кого затрагивает"></textarea>
            <div class="field__hint">Цифры помогают: «по 15 минут на каждое из 40 заявлений в день».</div>
          </div>

          <div class="field">
            <label class="field__label" for="q-result">Какой результат нужен <span class="req">*</span></label>
            <textarea class="textarea" id="q-result" name="desired_result" style="min-height:66px"
              placeholder="Как должно быть, если проблему решить"></textarea>
          </div>

          <div data-ac="US-IDEA-001/AC3 US-IDEA-001/AC5" id="similar-box"></div>

          <details class="quick__more">
            <summary>Уточнения — необязательно</summary>
            <div class="grid grid--2" style="margin-top:14px">
              <div class="field">
                <label class="field__label" for="q-category">Направление</label>
                <input class="input" id="q-category" name="category" list="cat-list" placeholder="Определится автоматически">
                <datalist id="cat-list"></datalist>
              </div>
              <div class="field">
                <label class="field__label" for="q-priority">Насколько срочно</label>
                <select class="select" id="q-priority" name="priority">
                  <option value="normal">Обычная ситуация</option>
                  <option value="high">Мешает каждый день</option>
                  <option value="low">Можно не спешить</option>
                </select>
              </div>
            </div>
            <div class="field">
              <label class="field__label" for="q-link">Где в системе возникает проблема</label>
              <input class="input" id="q-link" name="source_link" placeholder="Раздел, экран или ссылка">
            </div>
            <div class="field">
              <label class="field__label" for="q-links">Файлы и ссылки — по одной в строке</label>
              <textarea class="textarea" id="q-links" name="links" style="min-height:60px"
                placeholder="Ссылка на скриншот, документ или пример"></textarea>
              <div class="field__hint">Скриншот удобно положить в общее хранилище и приложить ссылку.</div>
            </div>
          </details>
        </div>
        <div class="card__foot row">
          <span data-ac="US-IDEA-001/AC2" class="fs-12 text-3" id="draft-state">${draft ? 'Найден черновик' : 'Черновик сохраняется автоматически'}</span>
          <div class="row spacer">
            ${draft ? '<button type="button" class="btn btn--sm" id="restore-draft">Восстановить черновик</button>' : ''}
            <a href="/ideas" class="btn">Отмена</a>
            <button class="btn btn--primary" type="submit">Опубликовать идею</button>
          </div>
        </div>
      </form>

      <aside class="stack">
        <div class="card">
          <div class="card__head"><h3>Что будет дальше</h3></div>
          <div class="card__body">
            <ol class="steps">
              <li><b>Проверка.</b> ${meta.moderation_required
                ? 'Модератор убедится, что идея понятна и не дублирует уже поданную.'
                : 'Идея публикуется сразу и открыта для решений.'}</li>
              <li><b>Решения.</b> Коллеги предложат варианты и поделятся опытом, который у них уже сработал.</li>
              <li><b>Полезное решение.</b> Вы отмечаете то, что помогло, — социальный советник получает очки.</li>
              <li><b>Инициатива.</b> Если решение требует проекта, идея поднимается в конвейер Stage-Gate.</li>
            </ol>
          </div>
        </div>
        <div class="card">
          <div class="card__head"><h3>Как описать понятно</h3></div>
          <div class="card__body prose">
            <p>Начните с проблемы, а не с готового решения — так предложений будет больше
               и они будут разнообразнее.</p>
            <p>Один текст — одна проблема. Если их две, подайте две идеи: их проще
               обсуждать и решать по отдельности.</p>
          </div>
        </div>
      </aside>
    </div>`;

  const form = view.querySelector('#idea-form');
  const fields = {
    title: form.querySelector('#q-title'), problem: form.querySelector('#q-problem'),
    desired_result: form.querySelector('#q-result'), category: form.querySelector('#q-category'),
    priority: form.querySelector('#q-priority'), source_link: form.querySelector('#q-link'),
    links: form.querySelector('#q-links'),
  };
  const collect = () => Object.fromEntries(Object.entries(fields).map(([k, el]) => [k, el.value]));

  // Таймер подачи: критерий «идея за 60 секунд» виден автору прямо в форме
  const timer = view.querySelector('#quick-timer');
  const tick = setInterval(() => {
    // Раздел перерисовывается целиком, поэтому уход со страницы виден по потере узла
    if (!timer.isConnected) { clearInterval(tick); return; }
    const s = Math.floor((Date.now() - startedAt) / 1000);
    timer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    timer.classList.toggle('is-over', s > 60);
  }, 1000);

  api.get('/api/ideas/categories').then((cats) => {
    view.querySelector('#cat-list').innerHTML = cats.map((c) => `<option value="${esc(c.name)}">`).join('');
  }).catch(() => {});

  // Шаблоны заполняют форму типовыми формулировками
  view.querySelectorAll('[data-tpl]').forEach((b) => b.onclick = () => {
    const t = meta.templates.find((x) => x.code === b.dataset.tpl);
    view.querySelectorAll('[data-tpl]').forEach((x) => x.classList.toggle('is-on', x === b));
    if (!t) return;
    if (t.problem && !fields.problem.value.trim()) fields.problem.value = t.problem;
    if (t.desired_result && !fields.desired_result.value.trim()) fields.desired_result.value = t.desired_result;
    if (t.category && !fields.category.value.trim()) fields.category.value = t.category;
    fields.title.focus();
  });

  view.querySelector('#restore-draft')?.addEventListener('click', () => {
    for (const [k, el] of Object.entries(fields)) if (draft.payload[k] !== undefined) el.value = draft.payload[k];
    toast('Черновик восстановлен', 'ok');
  });

  // Автосохранение черновика: данные не теряются при сбое или случайном уходе
  const state$ = view.querySelector('#draft-state');
  const saveDraft = debounce(async () => {
    const payload = collect();
    if (!payload.title && !payload.problem) return;
    try {
      await api.put('/api/ideas/draft', { payload });
      state$.textContent = `Черновик сохранён в ${new Date().toLocaleTimeString('ru-RU').slice(0, 5)}`;
    } catch {}
  }, 1200);

  // Подсказка о похожих идеях: возможно, кто-то уже занимается тем же
  const box = view.querySelector('#similar-box');
  const checkSimilar = debounce(async () => {
    const text = `${fields.title.value} ${fields.problem.value}`.trim();
    if (text.length < 15) { box.innerHTML = ''; return; }
    try {
      const found = await api.post('/api/ideas/similar', { text });
      box.innerHTML = found.length ? html`
        <div class="hint-box">
          <div class="hint-box__head">Похожие идеи уже есть</div>
          <div class="fs-12 text-2" style="margin-bottom:8px">
            Присоединитесь к обсуждению — так решение найдётся быстрее, чем по двум отдельным идеям.
          </div>
          ${found.map((f) => html`
            <a class="hint-box__row" href="/ideas/${f.id}">
              <span class="mono fs-12">${esc(f.number)}</span>
              <span class="truncate">${esc(f.title)}</span>
              <span class="badge badge--outline">${f.score}%</span>
            </a>`)}
        </div>` : '';
    } catch {}
  }, 700);

  for (const el of Object.values(fields)) {
    el.addEventListener('input', () => { saveDraft(); });
  }
  fields.title.addEventListener('input', checkSimilar);
  fields.problem.addEventListener('input', checkSimilar);
  fields.title.focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    const payload = collect();
    payload.links = payload.links.split('\n').map((s) => s.trim()).filter(Boolean);
    btn.disabled = true; btn.textContent = 'Публикуем…';
    try {
      const idea = await api.post('/api/ideas', payload);
      clearInterval(tick);
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      toast(`Идея ${idea.number} опубликована за ${seconds} ${plural(seconds, 'секунду', 'секунды', 'секунд')}`, 'ok');
      navigate(`/ideas/${idea.id}`);
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false; btn.textContent = 'Опубликовать идею';
    }
  });
}

// ══════════════════════════════════════════════════════════════
// Карточка идеи
// ══════════════════════════════════════════════════════════════
export async function ideaDetail(view, id) {
  const idea = await api.get(`/api/ideas/${id}`);
  const useful = idea.proposals.filter((p) => ['useful', 'verified', 'implemented'].includes(p.status));

  view.innerHTML = html`
    <div class="crumb"><a href="/ideas">Идеи и решения</a> <span>/</span> <span class="mono">${esc(idea.number)}</span></div>

    <div class="page-head">
      <div class="page-head__row">
        <div style="flex:1;min-width:280px">
          <div class="row" style="margin-bottom:8px">
            ${statusChip(idea.status)}
            ${idea.category ? `<span class="badge badge--outline">${esc(idea.category)}</span>` : ''}
            ${idea.priority === 'high' ? '<span class="badge badge--warn">Мешает каждый день</span>' : ''}
            ${idea.initiative_number ? `<a class="badge badge--purple" href="/initiatives/${idea.initiative_id}">Инициатива ${esc(idea.initiative_number)}</a>` : ''}
          </div>
          <h2>${esc(idea.title)}</h2>
          <p>${esc(idea.author_name)}${idea.institution_short ? ' · ' + esc(idea.institution_short) : ''} ·
             ${fmtDate(idea.created_at)}</p>
        </div>
        <div class="row">
          ${idea.can_moderate ? '<button class="btn" data-moderate>Модерация</button>' : ''}
          ${idea.can_moderate && !idea.initiative_id && ['accepted', 'in_progress', 'done'].includes(idea.status)
            ? '<button data-ac="US-IDEA-004/AC1 US-IDEA-004/AC2" class="btn btn--primary" data-promote>Поднять до инициативы</button>' : ''}
        </div>
      </div>
    </div>

    ${idea.moderation_note ? html`
      <div class="card" style="margin-bottom:16px;border-left:3px solid var(--${IDEA_STATUS[idea.status]?.tone === 'muted' ? 'neutral' : 'warn'})">
        <div class="card__body">
          <div class="fs-12 fw-600 text-3" style="text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px">
            Решение модератора${idea.moderator_name ? ' · ' + esc(idea.moderator_name) : ''}</div>
          <div class="prose">${nl2br(idea.moderation_note)}</div>
          ${idea.duplicate_number ? `<div class="fs-13" style="margin-top:8px">Объединена с идеей
            <a href="/ideas/${idea.duplicate_of_id}" class="mono">${esc(idea.duplicate_number)}</a></div>` : ''}
        </div>
      </div>` : ''}

    <div class="idea-layout">
      <div class="stack">
        <div class="card">
          <div class="card__body">
            <div class="fs-12 fw-600 text-3" style="text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Проблема</div>
            <div class="prose" style="margin-bottom:16px">${nl2br(idea.problem)}</div>
            <div class="fs-12 fw-600 text-3" style="text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Желаемый результат</div>
            <div class="prose">${nl2br(idea.desired_result)}</div>
            ${idea.source_link ? html`
              <div class="fs-13 text-3" style="margin-top:14px">Где возникает: ${esc(idea.source_link)}</div>` : ''}
            ${idea.attachments.filter((a) => !a.proposal_id).length ? html`
              <div class="chip-row" style="margin-top:14px">
                ${idea.attachments.filter((a) => !a.proposal_id).map((a) =>
                  `<a class="chip" href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.filename)}</a>`)}
              </div>` : ''}
          </div>
          <div class="card__foot">${reactionBar(idea, 'lg')}</div>
        </div>

        <div class="card" data-tour="proposals">
          <div class="card__head">
            <div>
              <h3 data-ac="US-IDEA-002/AC1 US-IDEA-002/AC4">Решения и опыт коллег</h3>
              <div class="card__hint">${idea.proposals.length
                ? `${idea.proposals.length} ${plural(idea.proposals.length, 'предложение', 'предложения', 'предложений')}${useful.length ? `, полезных — ${useful.length}` : ''}`
                : 'Пока никто не предложил решение'}</div>
            </div>
            ${idea.can_propose ? '<button class="btn btn--sm btn--primary spacer" data-propose>Предложить решение</button>' : ''}
          </div>
          <div class="card__body--flush">
            ${idea.proposals.length
              ? `<div class="props">${idea.proposals.map((p) => proposalCard(p, idea)).join('')}</div>`
              : html`<div class="empty" style="padding:34px">
                  <h4>Решений пока нет</h4>
                  <p>${idea.can_propose
                    ? 'Если вы сталкивались с этой задачей — расскажите, что помогло. Это займёт пару минут.'
                    : 'Идея откроется для предложений после проверки модератором.'}</p>
                  ${idea.can_propose ? '<button class="btn btn--primary" data-propose style="margin-top:14px">Предложить решение</button>' : ''}
                </div>`}
          </div>
        </div>

        <div class="card">
          <div class="card__head"><h3>Обсуждение</h3>
            <span class="card__hint spacer">${idea.comments.length} ${plural(idea.comments.length, 'сообщение', 'сообщения', 'сообщений')}</span></div>
          <div class="card__body--flush">
            ${idea.comments.length ? html`<div class="list">
              ${idea.comments.map((cm) => html`
                <div class="list__item">
                  ${avatar(cm.author_name)}
                  <div class="list__main">
                    <div class="list__title">${esc(cm.author_name)}</div>
                    <div class="list__body">${nl2br(cm.body)}</div>
                    <div class="list__meta">${fmtAgo(cm.created_at)}</div>
                  </div>
                </div>`)}
            </div>` : '<div class="empty" style="padding:26px"><p>Сообщений пока нет</p></div>'}
          </div>
          <div class="card__foot">
            <form id="comment-form">
              <textarea class="textarea" name="body" style="min-height:70px;margin-bottom:9px"
                placeholder="Уточните детали, задайте вопрос автору или поддержите предложение коллеги…" required></textarea>
              <button class="btn btn--primary btn--sm" type="submit">Отправить</button>
            </form>
          </div>
        </div>
      </div>

      <aside class="stack">
        <div class="card">
          <div class="card__head"><h3>Как продвигается идея</h3></div>
          <div class="card__body">
            <div class="track">
              ${FLOW.map((k) => {
                const done = FLOW.indexOf(idea.status) >= FLOW.indexOf(k) && FLOW.includes(idea.status);
                const cur = idea.status === k;
                return html`<div class="track__item ${cur ? 'is-current' : done ? 'is-done' : ''}">
                  <i></i><span>${esc(IDEA_STATUS[k].title)}</span></div>`;
              })}
              ${['rejected', 'archived'].includes(idea.status)
                ? `<div class="track__item is-stopped"><i></i><span>${esc(IDEA_STATUS[idea.status].title)}</span></div>` : ''}
            </div>
            <dl class="def" style="margin-top:16px">
              <dt>Отметок поддержки</dt><dd>${idea.support_total}</dd>
              <dt>Предложено решений</dt><dd>${idea.proposals_count}</dd>
              ${idea.experience_count ? `<dt>Проверенный опыт</dt><dd>${idea.experience_count}</dd>` : ''}
              <dt>Обновлена</dt><dd class="fs-12 text-3">${fmtAgo(idea.updated_at)}</dd>
            </dl>
          </div>
          <div class="card__foot row">
            ${idea.is_author && ['new', 'review'].includes(idea.status)
              ? '<button class="btn btn--sm" data-edit>Изменить идею</button>' : ''}
            <button class="btn btn--sm btn--ghost spacer" data-report>Пожаловаться</button>
          </div>
        </div>

        ${idea.similar.length ? html`
          <div class="card">
            <div class="card__head"><h3>Похожие идеи</h3></div>
            <div class="card__body--flush"><div class="list">
              ${idea.similar.map((s) => html`
                <a class="list__item is-clickable" href="/ideas/${s.id}" style="text-decoration:none;color:inherit">
                  <div class="list__main">
                    <div class="list__title">${esc(s.title)}</div>
                    <div class="list__meta"><span class="mono">${esc(s.number)}</span>
                      <span>${esc(IDEA_STATUS[s.status]?.title || '')}</span>
                      <span>совпадение ${s.score}%</span></div>
                  </div>
                </a>`)}
            </div></div>
          </div>` : ''}

        <div class="card">
          <div class="card__head"><h3>Как начисляются очки</h3></div>
          <div class="card__body prose">
            <p>Социальный советник получает очки за предложенное решение, за отметку «полезно» от автора идеи
               и за подтверждение опыта модератором.</p>
            <p>Очки не начисляются за оценку собственных предложений и за дубли уже
               предложенных решений. <a href="/rating">Рейтинг социальных советников</a></p>
          </div>
        </div>
      </aside>
    </div>`;

  const reload = () => ideaDetail(view, id);
  bindReactions(view, [idea]);

  view.querySelectorAll('[data-propose]').forEach((b) => b.onclick = () => proposalModal(idea, reload));
  view.querySelector('[data-moderate]')?.addEventListener('click', () => moderationModal(idea, reload));
  view.querySelector('[data-promote]')?.addEventListener('click', () => promoteIdea(idea));
  view.querySelector('[data-edit]')?.addEventListener('click', () => editIdeaModal(idea, reload));
  view.querySelector('[data-report]')?.addEventListener('click', () => reportModal('idea', idea.id));

  view.querySelectorAll('[data-endorse]').forEach((b) => b.onclick = async () => {
    b.disabled = true;
    try {
      const r = await api.post(`/api/proposals/${b.dataset.endorse}/endorse`);
      b.classList.toggle('is-on', r.my_endorsement);
      b.querySelector('b').textContent = r.endorsements || '';
      if (r.points?.awarded) toast(`Социальному советнику начислено ${r.points.points}`, 'ok');
    } catch (err) { toast(err.message, 'error'); }
    finally { b.disabled = false; }
  });

  view.querySelectorAll('[data-useful]').forEach((b) => b.onclick = async () => {
    if (!await confirmDialog('Отметить решение полезным',
      'Автор решения получит очки за полезный вклад. Отметку нельзя снять.', 'Отметить')) return;
    try {
      const r = await api.post(`/api/proposals/${b.dataset.useful}/useful`);
      toast(r.points?.awarded ? `Социальному советнику начислено ${r.points.points} за полезное решение`
                              : 'Решение отмечено как полезное', 'ok');
      reload();
    } catch (err) { toast(err.message, 'error'); }
  });

  view.querySelectorAll('[data-decide]').forEach((b) => b.onclick = () =>
    proposalDecisionModal(Number(b.dataset.decide), b.dataset.action, reload));

  view.querySelectorAll('[data-report-proposal]').forEach((b) => b.onclick = () =>
    reportModal('proposal', Number(b.dataset.reportProposal)));

  view.querySelector('#comment-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.post(`/api/ideas/${id}/comments`, { body: e.target.body.value.trim() });
      reload();
    } catch (err) { toast(err.message, 'error'); }
  });
}

function proposalCard(p, idea) {
  const m = PROPOSAL_STATUS[p.status] || PROPOSAL_STATUS.published;
  const canMarkUseful = idea.is_author && !p.is_mine && !['useful', 'implemented'].includes(p.status);
  return html`
    <article class="prop prop--${p.status}">
      <div class="prop__head">
        ${avatar(p.author_name, 'avatar--sm')}
        <div style="min-width:0;flex:1">
          <div class="fs-13 fw-600">${esc(p.author_name)}</div>
          <div class="fs-12 text-3">${esc(p.author_position || '')}${p.author_institution ? ' · ' + esc(p.author_institution) : ''}</div>
        </div>
        ${p.kind === 'experience' ? '<span class="badge badge--purple">Проверенный опыт</span>' : ''}
        <span class="st st--${m.tone}"><i></i>${esc(m.title)}</span>
      </div>

      <div class="prop__body">
        <div class="prose">${nl2br(p.summary)}</div>
        ${p.how_to_apply ? html`
          <div class="prop__field"><span>Как применить</span><div class="prose">${nl2br(p.how_to_apply)}</div></div>` : ''}
        ${p.expected_effect ? html`
          <div class="prop__field"><span>Ожидаемый эффект</span><div class="prose">${nl2br(p.expected_effect)}</div></div>` : ''}
        ${p.risks ? html`
          <div class="prop__field"><span>Риски и ограничения</span><div class="prose">${nl2br(p.risks)}</div></div>` : ''}
        ${p.needs_approval ? '<div class="prop__flag">Требуется одобрение руководителя</div>' : ''}
        ${p.moderation_note ? html`
          <div class="prop__field"><span>Комментарий модератора</span><div class="prose">${nl2br(p.moderation_note)}</div></div>` : ''}
        ${p.verified_by_name ? html`
          <div class="fs-12 text-3" style="margin-top:10px">Опыт подтвердил: ${esc(p.verified_by_name)}, ${fmtDate(p.verified_at)}</div>` : ''}
      </div>

      <div class="prop__foot">
        <button class="react ${p.my_endorsement ? 'is-on' : ''}" data-endorse="${p.id}" ${p.is_mine ? 'disabled' : ''}
                title="${p.is_mine ? 'Своё предложение поддержать нельзя' : 'Подтвердить, что решение рабочее'}">
          ${reactionIcon('M20 6L9 17l-5-5')}<span>Подтверждаю</span><b>${p.endorsements || ''}</b>
        </button>
        ${canMarkUseful ? `<button class="btn btn--sm btn--ok" data-useful="${p.id}">Полезное решение</button>` : ''}
        ${idea.can_moderate ? html`
          ${p.kind === 'experience' && p.status === 'published'
            ? `<button class="btn btn--sm" data-decide="${p.id}" data-action="verify">Подтвердить опыт</button>` : ''}
          ${!['implemented', 'rejected'].includes(p.status)
            ? `<button class="btn btn--sm" data-decide="${p.id}" data-action="accept">Принять в работу</button>` : ''}
          ${p.status !== 'implemented'
            ? `<button class="btn btn--sm" data-decide="${p.id}" data-action="implement">Внедрено</button>` : ''}
          ${p.status !== 'rejected'
            ? `<button class="btn btn--sm" data-decide="${p.id}" data-action="reject">Отклонить</button>` : ''}` : ''}
        <button class="btn btn--sm btn--ghost spacer" data-report-proposal="${p.id}" title="Сообщить о нарушении">!</button>
        ${p.likes || p.favorites ? html`
          <span class="score-pill score-pill--like" title="Оценок «полезно» в быстром ревью">${p.likes}</span>
          ${p.favorites ? `<span class="score-pill score-pill--fav" title="В избранном у коллег">${p.favorites}</span>` : ''}` : ''}
        <span class="fs-12 text-3">${fmtAgo(p.created_at)}</span>
      </div>
    </article>`;
}

// ── Форма предложения решения ────────────────────────────────
function proposalModal(idea, onDone) {
  modal({
    title: `Решение для идеи ${idea.number}`, wide: true,
    body: html`
      <div class="fs-13 text-2" style="margin-bottom:16px;padding:11px 13px;background:var(--surface-2);
           border:1px solid var(--border);border-radius:var(--radius-sm)">
        <b>${esc(idea.title)}</b><div style="margin-top:5px">${esc(idea.problem.slice(0, 220))}</div>
      </div>
      <div class="field">
        <label class="field__label">Что это <span class="req">*</span></label>
        <div class="chip-row" id="p-kind">
          <button type="button" class="chip is-on" data-kind="proposal">Предложение — так можно сделать</button>
          <button type="button" class="chip" data-kind="experience">Проверенный опыт — у нас это уже работает</button>
        </div>
        <div class="field__hint" id="kind-hint">Гипотеза или вариант решения. Очки начисляются сразу после публикации.</div>
      </div>
      <div class="field">
        <label class="field__label" for="p-summary">Кратко о решении <span class="req">*</span></label>
        <textarea class="textarea" id="p-summary" style="min-height:78px"
          placeholder="В чём суть решения"></textarea>
      </div>
      <div class="field">
        <label class="field__label" for="p-apply">Как применить</label>
        <textarea class="textarea" id="p-apply" style="min-height:66px"
          placeholder="Какие шаги нужно сделать и кто их выполняет"></textarea>
      </div>
      <div class="grid grid--2">
        <div class="field">
          <label class="field__label" for="p-effect">Ожидаемый эффект</label>
          <textarea class="textarea" id="p-effect" style="min-height:60px"
            placeholder="Что изменится и насколько"></textarea>
        </div>
        <div class="field">
          <label class="field__label" for="p-risks">Риски и ограничения</label>
          <textarea class="textarea" id="p-risks" style="min-height:60px"
            placeholder="Что может помешать"></textarea>
        </div>
      </div>
      <label class="checkbox"><input type="checkbox" id="p-approval">
        <span>Для применения нужно одобрение руководителя</span></label>
      <div class="field" style="margin-top:14px">
        <label class="field__label" for="p-links">Ссылки и примеры — по одной в строке</label>
        <textarea class="textarea" id="p-links" style="min-height:54px"></textarea>
      </div>`,
    footer: '<button class="btn" data-close>Отмена</button><button class="btn btn--primary" data-ok>Опубликовать решение</button>',
    onMount: (el, close) => {
      let kind = 'proposal';
      const hint = el.querySelector('#kind-hint');
      el.querySelectorAll('#p-kind .chip').forEach((c) => c.onclick = () => {
        el.querySelectorAll('#p-kind .chip').forEach((x) => x.classList.toggle('is-on', x === c));
        kind = c.dataset.kind;
        hint.textContent = kind === 'experience'
          ? 'Опыт подтверждает модератор — после подтверждения начисляются очки и знак отличия. Обязательно опишите достигнутый результат.'
          : 'Гипотеза или вариант решения. Очки начисляются сразу после публикации.';
      });
      el.querySelector('[data-ok]').onclick = async () => {
        const btn = el.querySelector('[data-ok]');
        btn.disabled = true;
        try {
          const r = await api.post(`/api/ideas/${idea.id}/proposals`, {
            kind,
            summary: el.querySelector('#p-summary').value.trim(),
            how_to_apply: el.querySelector('#p-apply').value.trim(),
            expected_effect: el.querySelector('#p-effect').value.trim(),
            risks: el.querySelector('#p-risks').value.trim(),
            needs_approval: el.querySelector('#p-approval').checked,
            links: el.querySelector('#p-links').value.split('\n').map((s) => s.trim()).filter(Boolean),
          });
          toast(r.points?.awarded
            ? `Решение опубликовано, начислено ${r.points.points} ${plural(r.points.points, 'очко', 'очка', 'очков')}`
            : `Решение опубликовано. ${r.points?.reason || ''}`, 'ok');
          close(); onDone();
        } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
      };
    },
  });
}

// ── Решения модератора по предложению ────────────────────────
const DECISION_TITLES = {
  verify: ['Подтвердить проверенный опыт', 'Подтверждаю, что опыт применялся и дал результат. Социальному советнику начисляются очки.'],
  accept: ['Принять решение в работу', 'Идея переходит в статус «В работе», социальный советник получает очки.'],
  implement: ['Отметить решение внедрённым', 'Идея переходит в статус «Реализована». Начисляются очки за внедрение с эффектом.'],
  reject: ['Отклонить предложение', 'Автор увидит причину отклонения. Очки за предложение будут отменены отдельно, если это требуется.'],
};

function proposalDecisionModal(proposalId, action, onDone) {
  const [title, hint] = DECISION_TITLES[action] || ['Решение', ''];
  modal({
    title,
    body: html`
      <p class="prose" style="margin-bottom:14px">${esc(hint)}</p>
      <div class="field">
        <label class="field__label" for="d-note">Комментарий${action === 'reject' ? ' <span class="req">*</span>' : ''}</label>
        <textarea class="textarea" id="d-note" style="min-height:84px"
          placeholder="${action === 'reject' ? 'Причина отклонения — будет видна автору' : 'Необязательно'}"></textarea>
      </div>`,
    footer: '<button class="btn" data-close>Отмена</button><button class="btn btn--primary" data-ok>Подтвердить</button>',
    onMount: (el, close) => {
      el.querySelector('[data-ok]').onclick = async () => {
        try {
          const r = await api.post(`/api/proposals/${proposalId}/decide`,
            { action, note: el.querySelector('#d-note').value.trim() });
          toast(r.points?.awarded ? `Решение принято, начислено ${r.points.points}` : 'Решение зафиксировано', 'ok');
          close(); onDone();
        } catch (err) { toast(err.message, 'error'); }
      };
    },
  });
}

// ── Модерация идеи ───────────────────────────────────────────
const MODERATION_ACTIONS = [
  ['approve', 'Принять к обсуждению', 'Идея открывается для предложений, автору начисляются очки.'],
  ['clarify', 'Запросить уточнение', 'Автор получит вопрос и сможет дополнить идею.'],
  ['progress', 'Взять в работу', 'По идее найдено решение и началась реализация.'],
  ['complete', 'Отметить реализованной', 'Проблема решена — идея закрывается с результатом.'],
  ['merge', 'Объединить с дублем', 'Идея уходит в архив со ссылкой на основную.'],
  ['reject', 'Отклонить', 'Идея закрывается с указанием причины.'],
  ['archive', 'В архив', 'Идея скрывается из общего списка.'],
];

function moderationModal(idea, onDone) {
  modal({
    title: `Модерация идеи ${idea.number}`, wide: true,
    body: html`
      <div class="field">
        <label class="field__label">Действие</label>
        <div class="chip-row" id="m-action">
          ${MODERATION_ACTIONS.map(([code, title], i) =>
            `<button type="button" class="chip ${i === 0 ? 'is-on' : ''}" data-action="${code}">${esc(title)}</button>`)}
        </div>
        <div class="field__hint" id="m-hint">${esc(MODERATION_ACTIONS[0][2])}</div>
      </div>
      <div class="field" id="m-dup" style="display:none">
        <label class="field__label" for="m-dup-id">Номер основной идеи</label>
        <input class="input" id="m-dup-id" placeholder="Идентификатор идеи, с которой объединяем">
        ${idea.similar.length ? html`
          <div class="chip-row" style="margin-top:8px">
            ${idea.similar.map((s) => `<button type="button" class="chip" data-dup="${s.id}">${esc(s.number)} · ${esc(s.title.slice(0, 40))}</button>`)}
          </div>` : ''}
      </div>
      <div class="field">
        <label class="field__label" for="m-note">Комментарий для автора</label>
        <textarea class="textarea" id="m-note" style="min-height:92px"
          placeholder="Обязателен при отклонении и запросе уточнения"></textarea>
        <div class="field__hint">Действие фиксируется в журнале аудита и видно автору идеи.</div>
      </div>`,
    footer: '<button class="btn" data-close>Отмена</button><button class="btn btn--primary" data-ok>Применить</button>',
    onMount: (el, close) => {
      let action = 'approve';
      const dup = el.querySelector('#m-dup');
      el.querySelectorAll('#m-action .chip').forEach((c) => c.onclick = () => {
        el.querySelectorAll('#m-action .chip').forEach((x) => x.classList.toggle('is-on', x === c));
        action = c.dataset.action;
        el.querySelector('#m-hint').textContent = MODERATION_ACTIONS.find(([a]) => a === action)[2];
        dup.style.display = action === 'merge' ? '' : 'none';
      });
      el.querySelectorAll('[data-dup]').forEach((b) => b.onclick = () => {
        el.querySelector('#m-dup-id').value = b.dataset.dup;
      });
      el.querySelector('[data-ok]').onclick = async () => {
        try {
          await api.post(`/api/ideas/${idea.id}/moderate`, {
            action, note: el.querySelector('#m-note').value.trim(),
            duplicate_of_id: el.querySelector('#m-dup-id').value || null,
          });
          toast('Решение модератора сохранено', 'ok'); close(); onDone();
        } catch (err) { toast(err.message, 'error'); }
      };
    },
  });
}

async function promoteIdea(idea) {
  if (!await confirmDialog('Поднять идею до инициативы',
    'Идея войдёт в конвейер Stage-Gate: у неё появятся этапы, сроки и точки принятия решений. ' +
    'Основой станет решение, отмеченное полезным или подтверждённое.', 'Поднять')) return;
  try {
    const r = await api.post(`/api/ideas/${idea.id}/promote`, {});
    toast(`Создана инициатива ${r.number}`, 'ok');
    navigate(`/initiatives/${r.initiative_id}`);
  } catch (err) { toast(err.message, 'error'); }
}

function editIdeaModal(idea, onDone) {
  modal({
    title: 'Изменить идею', wide: true,
    body: html`
      <div class="field"><label class="field__label" for="e-title">Название</label>
        <input class="input" id="e-title" value="${esc(idea.title)}"></div>
      <div class="field"><label class="field__label" for="e-problem">Проблема</label>
        <textarea class="textarea" id="e-problem" style="min-height:88px">${esc(idea.problem)}</textarea></div>
      <div class="field"><label class="field__label" for="e-result">Желаемый результат</label>
        <textarea class="textarea" id="e-result" style="min-height:66px">${esc(idea.desired_result)}</textarea></div>
      <div class="field"><label class="field__label" for="e-category">Направление</label>
        <input class="input" id="e-category" value="${esc(idea.category || '')}"></div>`,
    footer: '<button class="btn" data-close>Отмена</button><button class="btn btn--primary" data-ok>Сохранить</button>',
    onMount: (el, close) => {
      el.querySelector('[data-ok]').onclick = async () => {
        try {
          await api.patch(`/api/ideas/${idea.id}`, {
            title: el.querySelector('#e-title').value.trim(),
            problem: el.querySelector('#e-problem').value.trim(),
            desired_result: el.querySelector('#e-result').value.trim(),
            category: el.querySelector('#e-category').value.trim(),
          });
          toast('Идея обновлена', 'ok'); close(); onDone();
        } catch (err) { toast(err.message, 'error'); }
      };
    },
  });
}

export function reportModal(targetType, targetId) {
  modal({
    title: 'Сообщить о нарушении',
    body: html`
      <p class="prose" style="margin-bottom:14px">Обращение получит модератор модуля.
         Укажите, что именно вызывает вопрос: дубль, некорректная формулировка,
         персональные данные или попытка накрутки очков.</p>
      <div class="field">
        <label class="field__label" for="r-reason">Причина <span class="req">*</span></label>
        <textarea class="textarea" id="r-reason" style="min-height:88px"></textarea>
      </div>`,
    footer: '<button class="btn" data-close>Отмена</button><button class="btn btn--danger" data-ok>Отправить</button>',
    onMount: (el, close) => {
      el.querySelector('[data-ok]').onclick = async () => {
        try {
          const path = targetType === 'idea' ? `/api/ideas/${targetId}/report` : `/api/proposals/${targetId}/report`;
          await api.post(path, { reason: el.querySelector('#r-reason').value.trim() });
          toast('Обращение направлено модератору', 'ok'); close();
        } catch (err) { toast(err.message, 'error'); }
      };
    },
  });
}
