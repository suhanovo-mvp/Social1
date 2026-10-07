// База знаний: каталог решений с поиском и карточка документа.
//
// Смысл раздела не в хранении текстов, а в том, чтобы найденное решение избавляло
// от повторного разбора. Поэтому поиск стоит первым, а в карточке рядом с решением
// всегда видны рассмотренные альтернативы — то, ради чего документ и заводят.
import { api, state, esc, html, can, navigate, toast, modal, confirmDialog,
         avatar, fmtAgo, fmtDate, plural, ROLE_TITLES, slaChip, debounce } from '../core.js';

const STATUS_BADGE = {
  draft: 'badge--outline', review: 'badge--warn', accepted: 'badge--purple',
  published: 'badge--ok', rejected: 'badge--danger', superseded: 'badge--outline',
};
const VERDICT_BADGE = { agree: 'badge--ok', remarks: 'badge--warn', reject: 'badge--danger' };

const TYPE_TITLES = {
  knowledge_doc: 'База знаний', idea: 'Идея', proposal: 'Решение коллеги',
  practice: 'Лучшая практика', process: 'Схема процесса',
};

// ─────────────────────────────────────────────────────────────
// Каталог и поиск
// ─────────────────────────────────────────────────────────────
export async function knowledgeView(view, query) {
  const kind = query.get('kind') || '';
  const mine = query.get('mine') === '1';
  const q = query.get('q') || '';

  const params = new URLSearchParams();
  if (kind) params.set('kind', kind);
  if (mine) params.set('mine', '1');
  const { docs, kinds, statuses } = await api.get(`/api/knowledge?${params}`);

  const link = (over = {}) => {
    const p = new URLSearchParams({ ...(kind ? { kind } : {}), ...(mine ? { mine: '1' } : {}),
                                    ...(q ? { q } : {}), ...over });
    for (const [k, v] of [...p]) if (!v) p.delete(k);
    return `/knowledge?${p}`;
  };

  view.innerHTML = html`
    <div class="page-head">
      <div class="page-head__row">
        <div style="flex:1;min-width:280px">
          <h2>База знаний</h2>
          <p>Решения, которые уже приняты, вместе с их обоснованием: в какой обстановке решали,
             какие варианты рассмотрели и почему отклонили, чем в итоге пришлось пожертвовать.
             Прежде чем разбирать задачу заново, поищите — возможно, её уже разобрали.</p>
        </div>
        ${can('doc.propose') ? '<button data-ac="US-KB-001/AC1" class="btn btn--primary" data-new>Завести документ</button>' : ''}
      </div>

      <div class="kb-search">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
        <input data-ac="US-KB-003/AC1" class="input" id="kb-q" value="${esc(q)}" placeholder="Например: возврат заявления, очередь на путёвку">
      </div>

      <div class="chip-row" style="margin-top:12px">
        <button class="chip ${!kind && !mine ? 'is-on' : ''}" data-go="${esc(link({ kind: '', mine: '' }))}">Всё</button>
        ${Object.entries(kinds).map(([code, k]) => html`
          <button class="chip ${kind === code ? 'is-on' : ''}" data-go="${esc(link({ kind: code }))}">
            ${esc(k.title)}${k.short ? ` · ${esc(k.short)}` : ''}</button>`)}
        <button class="chip ${mine ? 'is-on' : ''}" data-go="${esc(link({ mine: mine ? '' : '1' }))}">Мои документы</button>
      </div>
    </div>

    <div id="kb-results"></div>

    <div data-ac="US-KB-001/AC8" id="kb-list">
      ${docs.length ? html`
        <div class="stack">
          ${docs.map((d) => docCard(d, kinds, statuses))}
        </div>`
      : html`
        <div class="card"><div class="empty">
          <h4>Документов пока нет</h4>
          <p>Первый проект решения обычно рождается из идеи, по которой уже понятно, что делать.</p>
        </div></div>`}
    </div>`;

  view.querySelectorAll('[data-go]').forEach((b) => b.onclick = () => navigate(b.dataset.go));
  view.querySelectorAll('[data-open]').forEach((c) => c.onclick = () => navigate(`/knowledge/${c.dataset.open}`));
  view.querySelector('[data-new]')?.addEventListener('click', () => newDocDialog(kinds));

  // Поиск идёт по мере набора: пауза нужна, чтобы не дёргать сервер на каждой букве
  const input = view.querySelector('#kb-q');
  const results = view.querySelector('#kb-results');
  const list = view.querySelector('#kb-list');
  const run = debounce(async () => {
    const text = input.value.trim();
    if (text.length < 3) { results.innerHTML = ''; list.style.display = ''; return; }
    const found = await api.get(`/api/search?q=${encodeURIComponent(text)}`);
    list.style.display = 'none';
    results.innerHTML = renderResults(found, text);
    results.querySelectorAll('[data-url]').forEach((r) => r.onclick = () => navigate(r.dataset.url));
  }, 260);
  input.addEventListener('input', run);
  if (q) { input.value = q; run(); }
}

function docCard(d, kinds, statuses) {
  return html`
    <div class="card kb-card is-clickable" data-open="${d.id}">
      <div class="card__body">
        <div class="kb-card__head">
          <span class="mono fs-12 text-3">${esc(d.number)}</span>
          <span class="badge badge--outline">${esc(kinds[d.kind]?.title || d.kind)}</span>
          <span class="badge ${STATUS_BADGE[d.status] || 'badge--outline'}">${esc(statuses[d.status]?.title || d.status)}</span>
          <span class="spacer text-3 fs-12">${esc(fmtAgo(d.published_at || d.created_at))}</span>
        </div>
        <h3 class="kb-card__title">${esc(d.title)}</h3>
        <div class="kb-card__foot">
          ${avatar(d.author_name, 'avatar--sm')}
          <span>${esc(d.author_name)} · ${esc(ROLE_TITLES[d.author_role] || d.author_role)}${d.institution ? ' · ' + esc(d.institution) : ''}</span>
          <span class="spacer"></span>
          ${d.comments ? `<span class="fs-12 text-3">💬 ${d.comments}</span>` : ''}
        </div>
      </div>
    </div>`;
}

function renderResults(found, text) {
  if (!found.results.length) {
    return html`
      <div class="card"><div class="empty">
        <h4>По запросу «${esc(text)}» ничего не нашлось</h4>
        <p>Попробуйте другие слова: поиск ищет по смыслу слова, а не по точному написанию,
           но незнакомое понятие найти не сможет.</p>
      </div></div>`;
  }
  return html`
    <div class="card" style="margin-bottom:16px">
      <div class="card__head">
        <h3>Найдено по запросу «${esc(text)}»</h3>
        <span class="card__hint spacer">${found.results.length} ${plural(found.results.length, 'совпадение', 'совпадения', 'совпадений')}</span>
      </div>
      <div class="card__body--flush">
        <div class="list">
          ${found.results.map((r) => html`
            <div class="list__item ${r.url ? 'is-clickable' : ''}" ${r.url ? `data-url="${esc(r.url)}"` : ''}>
              <div class="list__main">
                <div class="list__title">${esc(r.title)}</div>
                <div class="list__meta">
                  <span class="badge badge--outline">${esc(TYPE_TITLES[r.entity_type] || r.entity_type)}</span>
                  ${r.subtitle ? `<span class="mono fs-12">${esc(r.subtitle)}</span>` : ''}
                </div>
                ${r.excerpt ? `<div class="kb-excerpt">${highlight(r.excerpt)}</div>` : ''}
              </div>
            </div>`)}
        </div>
      </div>
    </div>`;
}

// Совпадения приходят обёрнутыми в ⟪⟫: подставлять их как разметку нельзя,
// поэтому текст сначала экранируется и только потом размечается
const highlight = (excerpt) =>
  esc(excerpt).replace(/⟪/g, '<mark>').replace(/⟫/g, '</mark>');

function newDocDialog(kinds) {
  modal({
    title: 'Новый документ',
    body: html`
      <p class="prose" style="margin-bottom:14px">
        Проект решения обсуждают до реализации: в нём описывают проблему, предлагаемое решение
        и — обязательно — рассмотренные альтернативы. Зафиксированное решение описывает уже
        принятое: контекст, само решение и его последствия.
      </p>
      <label class="field__label" for="nd-kind">Вид документа</label>
      <select class="select" id="nd-kind">
        ${Object.entries(kinds).map(([code, k]) =>
          `<option value="${code}">${esc(k.title)}${k.short ? ` (${esc(k.short)})` : ''} — ${esc(k.lead)}</option>`)}
      </select>
      <label class="field__label" for="nd-title" style="margin-top:12px">Название</label>
      <input class="input" id="nd-title" placeholder="Коротко о чём решение">`,
    footer: '<button class="btn" data-close>Отмена</button><button class="btn btn--primary" data-ok>Завести</button>',
    onMount: (el, close) => {
      el.querySelector('[data-ok]').onclick = async () => {
        const title = el.querySelector('#nd-title').value.trim();
        if (!title) { toast('Укажите название', 'warn'); return; }
        try {
          const d = await api.post('/api/knowledge', { kind: el.querySelector('#nd-kind').value, title });
          close();
          navigate(`/knowledge/${d.id}`);
        } catch (e) { toast(e.message, 'danger', 'Не получилось'); }
      };
    },
  });
}

// ─────────────────────────────────────────────────────────────
// Карточка документа
// ─────────────────────────────────────────────────────────────
export async function documentView(view, id) {
  const d = await api.get(`/api/knowledge/${id}`);
  const doc = d.doc;
  const isAuthor = doc.author_id === state.user.id;
  const editable = isAuthor && ['draft', 'review'].includes(doc.status);
  const kinds = (await api.get('/api/knowledge?limit=1')).kinds;
  const statuses = (await api.get('/api/knowledge?limit=1')).statuses;

  view.innerHTML = html`
    <div class="page-head">
      <div class="page-head__row">
        <div style="flex:1;min-width:280px">
          <div class="row" style="gap:8px;margin-bottom:6px">
            <span class="mono fs-12 text-3">${esc(doc.number)}</span>
            <span class="badge badge--outline">${esc(kinds[doc.kind]?.title || doc.kind)}
              ${kinds[doc.kind]?.short ? `· ${esc(kinds[doc.kind].short)}` : ''}</span>
            <span class="badge ${STATUS_BADGE[doc.status]}">${esc(statuses[doc.status]?.title || doc.status)}</span>
          </div>
          <h2>${esc(doc.title)}</h2>
          <p>${esc(doc.author_name)}, ${esc(ROLE_TITLES[doc.author_role] || doc.author_role)}
             · ${esc(fmtDate(doc.created_at))}
             ${doc.supersedes_number ? ` · заменяет ${esc(doc.supersedes_number)}` : ''}
             ${doc.source_number ? ` · вырос из ${esc(doc.source_number)}` : ''}</p>
        </div>
        <div class="row" style="gap:8px">
          ${doc.status === 'draft' && isAuthor ? '<button class="btn btn--primary" data-review>На рецензирование</button>' : ''}
          ${doc.status === 'accepted' && can('doc.publish') ? '<button class="btn btn--ok" data-publish>Опубликовать</button>' : ''}
          ${doc.status === 'published' && can('doc.propose') ? '<button class="btn" data-revise>Новая редакция</button>' : ''}
          ${doc.kind === 'rfc' && doc.status === 'published' && can('doc.propose')
            ? '<button class="btn" data-decision>Зафиксировать решение</button>' : ''}
        </div>
      </div>
    </div>

    <div class="chg-layout">
      <div class="stack">
        ${d.issues.length ? html`
          <div class="card"><div class="card__body">
            <div class="chg-issues">
              <b>Документ заполнен не полностью:</b>
              <ul>${d.issues.map((i) => `<li>${esc(i.message)}</li>`)}</ul>
            </div>
          </div></div>` : ''}

        ${d.sections.map((s) => sectionCard(s, d, editable))}
      </div>

      <aside class="stack">
        ${d.reviews.length ? html`
          <div data-ac="US-KB-001/AC4 US-KB-001/AC5" class="card">
            <div class="card__head"><h3>Рецензенты</h3></div>
            <div class="card__body">
              <div class="appr">
                ${d.reviews.map((a) => html`
                  <div class="appr__row">
                    <div class="appr__who">
                      <b>${esc(a.role_title || 'Названный участник')}</b>
                      ${a.reason ? `<small>${esc(a.reason)}</small>` : ''}
                    </div>
                    <div class="appr__verdict">
                      ${a.verdict ? `<span class="badge ${VERDICT_BADGE[a.verdict]}">${esc(a.verdict_title)}</span>`
                        : slaChip(a.sla) || '<span class="badge badge--outline">Ожидает</span>'}
                    </div>
                    ${a.comment ? `<div class="appr__comment">${esc(a.comment)}</div>` : ''}
                    ${a.decided_by_name ? `<div class="appr__by">${esc(a.decided_by_name)} · ${esc(fmtAgo(a.decided_at))}</div>` : ''}
                  </div>`)}
              </div>
              ${d.can_review.ok ? html`
                <div class="chg-decide">
                  <b>Требуется ваш отзыв</b>
                  <div class="row" style="gap:8px;margin-top:10px">
                    <button class="btn btn--ok btn--sm" data-verdict="agree">Согласовать</button>
                    <button class="btn btn--sm" data-verdict="remarks">С замечаниями</button>
                    <button class="btn btn--danger btn--sm" data-verdict="reject">Не согласовать</button>
                  </div>
                </div>`
                : `<p class="ed__note" style="margin-top:10px">${esc(d.can_review.reason)}</p>`}
            </div>
          </div>` : ''}

        ${d.related.length ? html`
          <div class="card">
            <div class="card__head"><h3>Смежные решения</h3>
              <span class="card__hint spacer">это уже разбирали</span></div>
            <div class="card__body--flush">
              <div class="list">
                ${d.related.map((r) => html`
                  <div class="list__item is-clickable" data-url="${esc(r.url)}">
                    <div class="list__main">
                      <div class="list__title">${esc(r.title)}</div>
                      <div class="list__meta"><span class="mono fs-12">${esc(r.subtitle || '')}</span></div>
                    </div>
                  </div>`)}
              </div>
            </div>
          </div>` : ''}

        <div data-ac="US-KB-001/AC7" class="card">
          <div class="card__head"><h3>История версий</h3></div>
          <div class="card__body--flush">
            <div class="list">
              ${d.versions.map((v) => html`
                <div class="list__item">
                  <div class="list__main">
                    <div class="list__title">Версия ${v.version}
                      ${v.status === 'published' ? '<span class="badge badge--ok">опубликована</span>' : ''}</div>
                    <div class="list__meta"><span>${esc(v.created_by_name || '—')} · ${esc(fmtAgo(v.created_at))}</span></div>
                  </div>
                </div>`)}
            </div>
          </div>
        </div>

        ${doc.decision_note ? html`
          <div data-ac="US-KB-002/AC1" class="card">
            <div class="card__head"><h3>Основание решения</h3></div>
            <div class="card__body"><p class="prose">${esc(doc.decision_note)}</p></div>
          </div>` : ''}
      </aside>
    </div>`;

  bindDocument(view, d, editable);
}

/** Раздел документа: текст, замечания к нему и правка на месте. */
function sectionCard(s, d, editable) {
  const text = d.version.sections[s.key] ?? '';
  const comments = d.comments.filter((c) => c.node_id === s.key);
  return html`
    <div data-ac="US-KB-001/AC2 US-KB-001/AC9" class="card kb-section" data-section="${esc(s.key)}">
      <div class="card__head">
        <h3>${esc(s.title)}${s.required ? '<span class="req"> *</span>' : ''}</h3>
        <span class="spacer"></span>
        ${comments.length ? `<span class="badge badge--warn">${comments.length} ${plural(comments.length, 'замечание', 'замечания', 'замечаний')}</span>` : ''}
        ${editable ? `<button class="btn btn--sm" data-edit="${esc(s.key)}">Править</button>` : ''}
        ${can('doc.comment') ? `<button class="btn btn--sm btn--ghost" data-comment="${esc(s.key)}">Замечание</button>` : ''}
      </div>
      <div class="card__body">
        ${text ? `<div class="prose kb-text">${esc(text).replace(/\n/g, '<br>')}</div>`
               : `<p class="ed__note">${esc(s.hint || 'Раздел пока не заполнен')}</p>`}
        ${comments.length ? html`
          <div class="kb-comments">
            ${comments.map((c) => html`
              <div class="kb-comment">
                <div class="kb-comment__who">${esc(c.author_name)}
                  <span class="text-3">· ${esc(ROLE_TITLES[c.author_role] || c.author_role)} · ${esc(fmtAgo(c.created_at))}</span></div>
                <div>${esc(c.body)}</div>
              </div>`)}
          </div>` : ''}
      </div>
    </div>`;
}

function bindDocument(view, d, editable) {
  const doc = d.doc;
  const reload = () => navigate(`/knowledge/${doc.id}`);
  const act = async (fn, ok) => {
    try { await fn(); toast(ok, 'ok'); reload(); }
    catch (e) { toast(e.message, 'danger', 'Не получилось'); }
  };

  view.querySelectorAll('[data-url]').forEach((r) => r.onclick = () => navigate(r.dataset.url));

  view.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => {
    const s = d.sections.find((x) => x.key === b.dataset.edit);
    modal({
      title: s.title, wide: true,
      body: html`
        <p class="prose" style="margin-bottom:12px">${esc(s.hint || '')}</p>
        <textarea class="textarea" id="sec-text" rows="12">${esc(d.version.sections[s.key] ?? '')}</textarea>`,
      footer: '<button class="btn" data-close>Отмена</button><button class="btn btn--primary" data-ok>Сохранить</button>',
      onMount: (el, close) => {
        el.querySelector('[data-ok]').onclick = async () => {
          try {
            await api.put(`/api/knowledge/${doc.id}`, {
              sections: { [s.key]: el.querySelector('#sec-text').value },
            });
            close(); toast('Раздел сохранён', 'ok'); reload();
          } catch (e) { toast(e.message, 'danger'); }
        };
      },
    });
  });

  view.querySelectorAll('[data-comment]').forEach((b) => b.onclick = () => {
    const s = d.sections.find((x) => x.key === b.dataset.comment);
    modal({
      title: `Замечание к разделу «${s.title}»`,
      body: '<textarea class="textarea" id="sec-comment" rows="4" placeholder="Что смущает или чего не хватает в этом разделе?"></textarea>',
      footer: '<button class="btn" data-close>Отмена</button><button class="btn btn--primary" data-ok>Отправить</button>',
      onMount: (el, close) => {
        el.querySelector('[data-ok]').onclick = async () => {
          const body = el.querySelector('#sec-comment').value.trim();
          if (!body) { toast('Напишите замечание', 'warn'); return; }
          try {
            await api.post(`/api/knowledge/${doc.id}/comments`, { section: s.key, body });
            close(); toast('Замечание отправлено', 'ok'); reload();
          } catch (e) { toast(e.message, 'danger'); }
        };
      },
    });
  });

  view.querySelector('[data-review]')?.addEventListener('click', () =>
    act(() => api.post(`/api/knowledge/${doc.id}/review`), 'Отправлено на рецензирование'));

  view.querySelector('[data-publish]')?.addEventListener('click', async () => {
    if (await confirmDialog('Опубликовать решение',
      'Документ попадёт в базу знаний и станет находиться поиском. Опубликованная версия неизменяема.',
      'Опубликовать')) {
      act(() => api.post(`/api/knowledge/${doc.id}/publish`), 'Опубликовано в базе знаний');
    }
  });

  view.querySelector('[data-revise]')?.addEventListener('click', async () => {
    if (await confirmDialog('Новая редакция',
      'Появится черновик взамен действующего решения. Прежнее останется в истории — по нему поймут, почему передумали.',
      'Создать')) {
      try {
        const next = await api.post(`/api/knowledge/${doc.id}/revise`);
        navigate(`/knowledge/${next.id}`);
      } catch (e) { toast(e.message, 'danger'); }
    }
  });

  view.querySelector('[data-decision]')?.addEventListener('click', async () => {
    try {
      const adr = await api.post(`/api/knowledge/${doc.id}/decision`);
      toast('Заготовка решения создана: контекст перенесён', 'ok');
      navigate(`/knowledge/${adr.id}`);
    } catch (e) { toast(e.message, 'danger'); }
  });

  view.querySelectorAll('[data-verdict]').forEach((b) => b.onclick = () => {
    const verdict = b.dataset.verdict;
    const titles = { agree: 'Согласовать', remarks: 'Согласовать с замечаниями', reject: 'Не согласовать' };
    modal({
      title: titles[verdict],
      body: html`
        <p class="prose" style="margin-bottom:12px">
          ${verdict === 'agree' ? 'Пояснение необязательно, но помогает автору и остальным рецензентам.'
            : 'Пояснение обязательно: автору нужно знать, что именно исправить.'}</p>
        <textarea class="textarea" id="verdict-comment" rows="4"></textarea>`,
      footer: html`<button class="btn" data-close>Отмена</button>
                   <button class="btn btn--primary" data-ok>${esc(titles[verdict])}</button>`,
      onMount: (el, close) => {
        el.querySelector('[data-ok]').onclick = async () => {
          try {
            await api.post(`/api/knowledge/${doc.id}/verdict`,
              { verdict, comment: el.querySelector('#verdict-comment').value.trim() });
            close(); toast('Отзыв записан', 'ok'); reload();
          } catch (e) { toast(e.message, 'danger', 'Не получилось'); }
        };
      },
    });
  });
}
