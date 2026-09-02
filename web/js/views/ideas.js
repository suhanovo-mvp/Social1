// Доска идей: карточки инициатив, голосование и наглядный статус продвижения.
// Дополняет реестр инициатив — здесь виден не процесс, а поддержка коллег.
import { api, state, esc, html, avatar, can, navigate, toast, num, fmtAgo, plural, debounce } from '../core.js';

const SORTS = [
  ['votes', 'Популярные'],
  ['trending', 'Набирают поддержку'],
  ['new', 'Новые'],
  ['discussed', 'Обсуждаемые'],
];

// Публичный маршрут статуса — тот же путь Stage-Gate, но словами, понятными всем
const FLOW = [
  ['review', 'На рассмотрении'],
  ['development', 'В разработке'],
  ['pilot', 'Пилотируется'],
  ['scaling', 'Готовится к тиражированию'],
  ['scaled', 'Внедрено'],
];

const ICON_UP = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
const ICON_DOWN = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>';
const ICON_COMMENT = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.4 8.4 0 01-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.4 8.4 0 013.8-.9h.5a8.5 8.5 0 018 8v.5z"/></svg>';
const ICON_EYE = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/></svg>';

/** Блок голосования одной карточки. */
export function voteBlock(i) {
  const closed = i.status === 'scaled' || i.status === 'killed';
  const tone = i.votes_score > 0 ? 'pos' : i.votes_score < 0 ? 'neg' : '';
  return html`
    <div class="vote" data-vote-for="${i.id}">
      <button class="vote__btn ${i.my_vote === 1 ? 'is-on' : ''}" data-v="1" ${closed ? 'disabled' : ''}
              title="${closed ? 'Голосование завершено' : 'Поддержать инициативу'}"
              aria-label="Поддержать">${ICON_UP}</button>
      <div class="vote__score vote__score--${tone}" data-score>${i.votes_score > 0 ? '+' : ''}${i.votes_score}</div>
      <div class="vote__label">${plural(Math.abs(i.votes_score), 'голос', 'голоса', 'голосов')}</div>
      <button class="vote__btn vote__btn--down ${i.my_vote === -1 ? 'is-on' : ''}" data-v="-1" ${closed ? 'disabled' : ''}
              title="${closed ? 'Голосование завершено' : 'Не поддерживаю'}"
              aria-label="Не поддерживаю">${ICON_DOWN}</button>
    </div>`;
}

function ideaCard(i, idx, sort) {
  const ps = i.public_status;
  const top = sort === 'votes' && idx < 3 && i.votes_score > 0;
  return html`
    <article class="idea ${top ? 'idea--top' : ''}" data-idea="${i.id}">
      ${voteBlock(i)}
      <div class="idea__body">
        <div class="idea__head">
          <div class="idea__title" data-open="${i.id}">${esc(i.title)}</div>
          <span class="st st--${ps.tone}"><i></i>${esc(ps.title)}</span>
        </div>
        <div class="idea__excerpt">${esc(i.problem)}</div>
        <div class="idea__meta">
          <span class="mono">${esc(i.number)}</span>
          ${i.category ? `<span>${esc(i.category)}</span>` : ''}
          <span>${esc(i.author_name)} · ${esc(i.institution_short)}</span>
          <span class="idea__stat">${ICON_COMMENT}${i.comments_count}</span>
          ${i.followers ? `<span class="idea__stat">${ICON_EYE}${i.followers}</span>` : ''}
          <span>${fmtAgo(i.created_at)}</span>
        </div>
      </div>
    </article>`;
}

export async function ideasBoard(view, query) {
  const sort = query.get('sort') || 'votes';
  const status = query.get('status') || '';
  const category = query.get('category') || '';
  const search = query.get('q') || '';

  view.innerHTML = '<div class="ideas">' + '<div class="skeleton" style="height:104px"></div>'.repeat(5) + '</div>';

  const params = new URLSearchParams({ sort, limit: '100' });
  if (category) params.set('category', category);
  if (search) params.set('q', search);
  // Статусы доски объединяют несколько этапов, поэтому фильтруем на клиенте
  const [data, categories] = await Promise.all([
    api.get(`/api/initiatives?${params}`),
    api.get('/api/categories'),
  ]);
  const items = status ? data.items.filter((i) => i.public_status.key === status) : data.items;
  const counts = {};
  for (const i of data.items) counts[i.public_status.key] = (counts[i.public_status.key] || 0) + 1;

  view.innerHTML = html`
    <div class="page-head">
      <div class="page-head__row">
        <div style="flex:1;min-width:260px">
          <h2>Доска идей</h2>
          <p>Все инициативы сотрудников в одном месте. Поддержите то, что важно и в вашей работе, —
             голоса коллег видят эксперты при оценке приоритета. Статус показывает, где идея находится
             на пути от проблемы до внедрения.</p>
        </div>
        ${can('initiative.create') ? '<a href="/initiatives/new" class="btn btn--primary" data-tour="new-initiative">Предложить идею</a>' : ''}
      </div>
      <div class="status-flow" style="margin-top:14px">
        ${FLOW.map(([key, title], n) => html`
          ${n ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 6l6 6-6 6"/></svg>' : ''}
          <span class="st st--${{ review: 'info', development: 'accent', pilot: 'purple', scaling: 'ok', scaled: 'ok' }[key]}">
            <i></i>${esc(title)}</span>`)}
      </div>
    </div>

    <div class="idea-toolbar" data-tour="idea-filters">
      <div class="seg" id="sorts">
        ${SORTS.map(([k, t]) => `<button data-sort="${k}" class="${sort === k ? 'is-on' : ''}">${t}</button>`)}
      </div>
      <input class="input" type="search" id="idea-q" placeholder="Поиск по идеям…" value="${esc(search)}" style="min-width:190px;flex:1;max-width:300px">
      <select class="select" id="idea-status">
        <option value="">Любой статус</option>
        ${FLOW.map(([k, t]) => `<option value="${k}" ${status === k ? 'selected' : ''}>${t}${counts[k] ? ` (${counts[k]})` : ''}</option>`)}
        <option value="hold" ${status === 'hold' ? 'selected' : ''}>Приостановлено${counts.hold ? ` (${counts.hold})` : ''}</option>
        <option value="killed" ${status === 'killed' ? 'selected' : ''}>Отклонено${counts.killed ? ` (${counts.killed})` : ''}</option>
      </select>
      <select class="select" id="idea-category">
        <option value="">Все направления</option>
        ${categories.map((c) => `<option value="${esc(c.name)}" ${category === c.name ? 'selected' : ''}>${esc(c.name)} (${c.count})</option>`)}
      </select>
      <span class="spacer fs-12 text-3">${items.length} ${plural(items.length, 'идея', 'идеи', 'идей')}</span>
    </div>

    ${items.length ? html`
      <div class="ideas" data-tour="idea-list">
        ${items.map((i, idx) => ideaCard(i, idx, sort))}
      </div>` : html`
      <div class="card"><div class="empty">
        <h4>Ничего не найдено</h4>
        <p>Измените условия отбора или предложите свою идею — платформа проведёт её
           от формулировки до внедрения.</p>
      </div></div>`}`;

  const setParam = (key, value) => {
    const q = new URLSearchParams(location.search);
    if (value) q.set(key, value); else q.delete(key);
    navigate(`/ideas${q.toString() ? '?' + q : ''}`);
  };
  view.querySelectorAll('[data-sort]').forEach((b) => b.onclick = () => setParam('sort', b.dataset.sort));
  view.querySelector('#idea-status').onchange = (e) => setParam('status', e.target.value);
  view.querySelector('#idea-category').onchange = (e) => setParam('category', e.target.value);
  view.querySelector('#idea-q').addEventListener('input', debounce((e) => setParam('q', e.target.value.trim()), 400));
  view.querySelectorAll('[data-open]').forEach((el) => el.onclick = () => navigate(`/initiatives/${el.dataset.open}`));

  bindVoting(view, items);
}

/** Голосование без перезагрузки списка: карточка обновляется на месте. */
export function bindVoting(root, items) {
  root.querySelectorAll('[data-vote-for]').forEach((box) => {
    const id = Number(box.dataset.voteFor);
    box.querySelectorAll('.vote__btn').forEach((btn) => btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (btn.disabled) return;
      const wanted = Number(btn.dataset.v);
      box.classList.add('is-busy');
      try {
        const r = await api.post(`/api/initiatives/${id}/vote`, { value: wanted });
        const score = box.querySelector('[data-score]');
        score.textContent = (r.votes_score > 0 ? '+' : '') + r.votes_score;
        score.className = `vote__score ${r.votes_score > 0 ? 'vote__score--pos' : r.votes_score < 0 ? 'vote__score--neg' : ''}`;
        box.querySelector('.vote__label').textContent = plural(Math.abs(r.votes_score), 'голос', 'голоса', 'голосов');
        box.querySelectorAll('.vote__btn').forEach((b) => {
          b.classList.toggle('is-on', Number(b.dataset.v) === r.my_vote && r.my_vote !== 0);
        });
        const item = items?.find((x) => x.id === id);
        if (item) { item.votes_score = r.votes_score; item.my_vote = r.my_vote; }
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        box.classList.remove('is-busy');
      }
    }));
  });
}
