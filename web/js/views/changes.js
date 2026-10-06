// Предложения об изменении процессов: лента и карточка предложения.
//
// Карточка отвечает на три вопроса в том порядке, в каком их задаёт согласующий:
// что именно меняется (сводка и схема с пометками), зачем (обоснование автора и
// поддержка коллег) и что от меня требуется (лист согласования и кнопка решения).
import { api, state, esc, html, can, navigate, toast, modal, confirmDialog,
         avatar, fmtAgo, fmtDate, plural, ROLE_TITLES, slaChip } from '../core.js';
import { renderDiagram } from '../bpmn.js';

const STATUS_BADGE = {
  draft: 'badge--outline', discussion: 'badge--info', approval: 'badge--warn',
  accepted: 'badge--purple', published: 'badge--ok', rejected: 'badge--danger',
  withdrawn: 'badge--outline',
};
const VERDICT_BADGE = { agree: 'badge--ok', remarks: 'badge--warn', reject: 'badge--danger' };

// ─────────────────────────────────────────────────────────────
// Лента предложений
// ─────────────────────────────────────────────────────────────
export async function changesBoard(view, query) {
  const status = query.get('status') || '';
  const mine = query.get('mine') === '1';
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (mine) params.set('mine', '1');
  const { changes, statuses } = await api.get(`/api/process-changes?${params}`);

  const link = (over = {}) => {
    const p = new URLSearchParams({ ...(status ? { status } : {}), ...(mine ? { mine: '1' } : {}), ...over });
    for (const [k, v] of [...p]) if (!v) p.delete(k);
    return `/changes?${p}`;
  };

  view.innerHTML = html`
    <div class="page-head">
      <div class="page-head__row">
        <div style="flex:1;min-width:280px">
          <h2>Изменения процессов</h2>
          <p>Схема процесса — не картинка в справочнике, а описание того, как работа идёт на самом деле.
             Если шаг лишний, срок завышен или ответственность лежит не на том участнике — это можно
             показать прямо на схеме и провести через согласование. Принятое изменение меняет работу платформы.</p>
        </div>
        ${can('process.propose') ? html`
          <a class="btn btn--primary" href="/processes">Предложить изменение</a>` : ''}
      </div>
      <div class="chip-row" style="margin-top:14px">
        <button class="chip ${!status && !mine ? 'is-on' : ''}" data-go="${esc(link({ status: '', mine: '' }))}">Все</button>
        ${Object.entries(statuses).map(([code, s]) => html`
          <button class="chip ${status === code ? 'is-on' : ''}" data-go="${esc(link({ status: code }))}">${esc(s.title)}</button>`)}
        <button class="chip ${mine ? 'is-on' : ''}" data-go="${esc(link({ mine: mine ? '' : '1' }))}">Мои предложения</button>
      </div>
    </div>

    ${changes.length ? html`
      <div class="stack">
        ${changes.map((c) => html`
          <div class="card chg-card is-clickable" data-open="${c.id}">
            <div class="card__body">
              <div class="chg-card__head">
                <span class="mono fs-12 text-3">${esc(c.number)}</span>
                <span class="badge ${STATUS_BADGE[c.status] || 'badge--outline'}">${esc(statuses[c.status]?.title || c.status)}</span>
                ${c.is_pipeline ? '<span class="badge badge--purple" title="Изменение затрагивает конвейер инициатив">Конвейер</span>' : ''}
                <span class="spacer text-3 fs-12">${esc(fmtAgo(c.created_at))}</span>
              </div>
              <h3 class="chg-card__title">${esc(c.title)}</h3>
              <div class="chg-card__proc">Процесс: <b>${esc(c.def_title)}</b></div>
              <p class="chg-card__why">${esc(c.rationale)}</p>
              <div class="chg-card__foot">
                ${avatar(c.author_name, 'avatar--sm')}
                <span>${esc(c.author_name)} · ${esc(ROLE_TITLES[c.author_role] || c.author_role)}${c.institution ? ' · ' + esc(c.institution) : ''}</span>
                <span class="spacer"></span>
                ${c.voters ? `<span class="chg-card__stat" title="Поддержали коллеги">👍 ${c.support}</span>` : ''}
                ${c.comments ? `<span class="chg-card__stat" title="Замечаний в обсуждении">💬 ${c.comments}</span>` : ''}
                ${c.pending_approvals ? `<span class="chg-card__stat" title="Ожидают согласования">⏳ ${c.pending_approvals}</span>` : ''}
              </div>
            </div>
          </div>`)}
      </div>`
    : html`
      <div class="card"><div class="empty">
        <h4>Предложений пока нет</h4>
        <p>Откройте схему процесса, найдите шаг, который мешает работать, и предложите изменение.</p>
        <a class="btn btn--primary" href="/processes" style="margin-top:14px">Открыть схемы процессов</a>
      </div></div>`}`;

  view.querySelectorAll('[data-go]').forEach((b) => b.onclick = () => navigate(b.dataset.go));
  view.querySelectorAll('[data-open]').forEach((c) => c.onclick = () => navigate(`/changes/${c.dataset.open}`));
}

// ─────────────────────────────────────────────────────────────
// Карточка предложения
// ─────────────────────────────────────────────────────────────
export async function changeDetail(view, id) {
  const d = await api.get(`/api/process-changes/${id}`);
  const c = d.change;
  const statuses = (await api.get('/api/process-changes?limit=1')).statuses;
  const isAuthor = c.author_id === state.user.id;
  const editable = isAuthor && ['draft', 'discussion'].includes(c.status);

  view.innerHTML = html`
    <div class="page-head">
      <div class="page-head__row">
        <div style="flex:1;min-width:280px">
          <div class="row" style="gap:8px;margin-bottom:6px">
            <span class="mono fs-12 text-3">${esc(c.number)}</span>
            <span class="badge ${STATUS_BADGE[c.status]}">${esc(statuses[c.status]?.title || c.status)}</span>
            ${c.is_pipeline ? '<span class="badge badge--purple">Конвейер инициатив</span>' : ''}
          </div>
          <h2>${esc(c.title)}</h2>
          <p>Процесс: <b>${esc(c.def_title)}</b> · автор ${esc(c.author_name)},
             ${esc(ROLE_TITLES[c.author_role] || c.author_role)} · ${esc(fmtDate(c.created_at))}</p>
        </div>
        <div class="row" style="gap:8px">
          ${editable ? '<button class="btn" data-edit>Править схему</button>' : ''}
          ${isAuthor && c.status === 'draft' ? '<button class="btn btn--primary" data-submit>Вынести на обсуждение</button>' : ''}
          ${isAuthor && c.status === 'discussion' ? '<button class="btn btn--primary" data-approval>Отправить на согласование</button>' : ''}
          ${c.status === 'accepted' && can('process.publish') ? '<button class="btn btn--ok" data-publish>Опубликовать версию</button>' : ''}
          ${isAuthor && ['draft', 'discussion', 'approval'].includes(c.status) ? '<button class="btn btn--ghost" data-withdraw>Отозвать</button>' : ''}
        </div>
      </div>
    </div>

    <div class="chg-layout">
      <div class="stack">
        <div class="card">
          <div class="card__head">
            <h3>Что меняется</h3>
            <span class="card__hint spacer">относительно действующей версии ${d.base_version}</span>
          </div>
          <div class="card__body">
            ${d.summary.length ? html`
              <ul class="chg-summary">${d.summary.map((l) => `<li>${esc(l)}</li>`)}</ul>`
              : '<p class="prose">Изменений нет.</p>'}
            ${d.issues.length ? html`
              <div class="chg-issues">
                <b>Схему нельзя опубликовать, пока есть замечания:</b>
                <ul>${d.issues.map((i) => `<li>${esc(i.message)}</li>`)}</ul>
              </div>` : ''}
          </div>
        </div>

        <div class="card">
          <div class="card__head">
            <h3>Предлагаемая схема</h3>
            <span class="card__hint spacer">зелёное — добавлено, янтарное — изменено</span>
          </div>
          <div class="bp-canvas">
            <div class="bp-canvas__inner" data-diagram>${renderDiagram(d.draft.model, null)}</div>
          </div>
        </div>

        <div class="card">
          <div class="card__head"><h3>Обоснование автора</h3></div>
          <div class="card__body">
            <p class="prose">${esc(c.rationale)}</p>
            ${c.expected_effect ? html`
              <div class="chg-effect"><b>Ожидаемый эффект.</b> ${esc(c.expected_effect)}</div>` : ''}
          </div>
        </div>

        <div class="card">
          <div class="card__head">
            <h3>Обсуждение</h3>
            <span class="card__hint spacer">${d.comments.length} ${plural(d.comments.length, 'замечание', 'замечания', 'замечаний')}</span>
          </div>
          <div class="card__body">
            ${d.comments.length ? html`
              <div class="list">
                ${d.comments.map((m) => html`
                  <div class="list__item">
                    <div class="list__main">
                      <div class="list__title">${esc(m.author_name)}
                        <span class="text-3 fs-12">· ${esc(ROLE_TITLES[m.author_role] || m.author_role)}
                          · ${esc(fmtAgo(m.created_at))}</span></div>
                      ${m.node_id ? `<div class="chg-anchor">к шагу «${esc(nodeLabel(d.draft.model, m.node_id))}»</div>` : ''}
                      <div class="list__body">${esc(m.body)}</div>
                    </div>
                  </div>`)}
              </div>` : '<p class="prose text-3">Замечаний пока нет.</p>'}
            ${can('process.comment') ? html`
              <div style="margin-top:14px">
                <textarea class="textarea" id="chg-comment" rows="3"
                  placeholder="Что смущает или чего не хватает в предложении?"></textarea>
                <button class="btn btn--sm" data-comment style="margin-top:8px">Отправить</button>
              </div>` : ''}
          </div>
        </div>
      </div>

      <aside class="stack">
        <div class="card">
          <div class="card__head"><h3>Поддержка коллег</h3></div>
          <div class="card__body">
            <div class="chg-votes">
              <button class="btn ${d.votes.my === 1 ? 'btn--ok' : ''}" data-vote="1">
                Поддерживаю · ${d.votes.support}</button>
              <button class="btn ${d.votes.my === -1 ? 'btn--danger' : ''}" data-vote="-1">
                Возражаю · ${d.votes.against}</button>
            </div>
            <p class="ed__note" style="margin-top:10px">Голоса не решают судьбу предложения —
               они показывают согласующим, насколько изменение нужно людям.</p>
          </div>
        </div>

        <div class="card">
          <div class="card__head"><h3>Лист согласования</h3></div>
          <div class="card__body">
            ${d.approvals.length ? html`
              <div class="appr">
                ${d.approvals.map((a) => html`
                  <div class="appr__row">
                    <div class="appr__who">
                      <b>${esc(a.role_title || '—')}</b>
                      ${a.reason ? `<small>${esc(a.reason)}</small>` : ''}
                    </div>
                    <div class="appr__verdict">
                      ${a.verdict
                        ? `<span class="badge ${VERDICT_BADGE[a.verdict]}">${esc(a.verdict_title)}</span>`
                        : slaChip(a.sla) || '<span class="badge badge--outline">Ожидает</span>'}
                    </div>
                    ${a.comment ? `<div class="appr__comment">${esc(a.comment)}</div>` : ''}
                    ${a.decided_by_name ? `<div class="appr__by">${esc(a.decided_by_name)} · ${esc(fmtAgo(a.decided_at))}</div>` : ''}
                  </div>`)}
              </div>
              ${d.can_approve.ok ? html`
                <div class="chg-decide">
                  <b>Требуется ваше решение</b>
                  <div class="row" style="gap:8px;margin-top:10px">
                    <button class="btn btn--ok btn--sm" data-verdict="agree">Согласовать</button>
                    <button class="btn btn--sm" data-verdict="remarks">С замечаниями</button>
                    <button class="btn btn--danger btn--sm" data-verdict="reject">Не согласовать</button>
                  </div>
                </div>`
                : `<p class="ed__note" style="margin-top:10px">${esc(d.can_approve.reason)}</p>`}`
            : html`
              <p class="prose text-3">Лист появится, когда предложение уйдёт на согласование.
                 Состав определяется тем, чью работу изменение затрагивает.</p>
              ${['draft', 'discussion'].includes(c.status) ? '<button class="btn btn--sm" data-route style="margin-top:10px">Кто будет согласовывать</button>' : ''}`}
          </div>
        </div>

        ${c.decision_note ? html`
          <div class="card">
            <div class="card__head"><h3>Основание решения</h3></div>
            <div class="card__body"><p class="prose">${esc(c.decision_note)}</p></div>
          </div>` : ''}
      </aside>
    </div>`;

  markDiff(view, d);
  bind(view, d, c);
}

const nodeLabel = (model, id) => model.nodes.find((n) => n.id === id)?.label || id;

/** Пометки различий прямо на схеме — читать сводку и схему рядом проще, чем по очереди. */
function markDiff(view, d) {
  const svg = view.querySelector('[data-diagram] .bp-svg');
  if (!svg || !d.diff) return;
  const added = new Set(d.diff.nodes.added.map((n) => n.id));
  const edited = new Set(d.diff.nodes.changed.map((n) => n.id));
  svg.querySelectorAll('.bp-node').forEach((el) => {
    el.classList.toggle('is-added', added.has(el.dataset.node));
    el.classList.toggle('is-edited', edited.has(el.dataset.node));
  });
}

function bind(view, d, c) {
  const reload = () => navigate(`/changes/${c.id}`);
  const act = async (fn, ok) => {
    try { await fn(); toast(ok, 'ok'); reload(); }
    catch (e) { toast(e.message, 'danger', 'Не получилось'); }
  };

  view.querySelector('[data-edit]')?.addEventListener('click', () => navigate(`/changes/${c.id}/edit`));

  view.querySelector('[data-submit]')?.addEventListener('click', () =>
    act(() => api.post(`/api/process-changes/${c.id}/submit`), 'Предложение вынесено на обсуждение'));

  view.querySelector('[data-approval]')?.addEventListener('click', async () => {
    const route = await api.get(`/api/process-changes/${c.id}/route`);
    const names = route.roles.map((r) => ROLE_TITLES[r] || r);
    const ok = await confirmDialog('Отправить на согласование',
      `Согласуют: ${names.join(', ')}. Состав определён тем, чью работу изменение затрагивает. ` +
      `Срок ответа — ${route.sla.value} ${route.sla.unit === 'workdays' ? 'рабочих дней' : 'календарных дней'}. ` +
      'После отправки схему править нельзя.', 'Отправить');
    if (ok) act(() => api.post(`/api/process-changes/${c.id}/to-approval`), 'Отправлено на согласование');
  });

  view.querySelector('[data-route]')?.addEventListener('click', async () => {
    const route = await api.get(`/api/process-changes/${c.id}/route`);
    modal({
      title: 'Кто будет согласовывать',
      body: html`
        <p class="prose">Состав согласующих выводится из изменения: его смотрят те, чью работу
           оно меняет.</p>
        <div class="ed__group">
          <div class="ed__group-title">По затронутым дорожкам</div>
          <ul class="ed__list">${(route.fromLanes.length ? route.fromLanes : ['— изменение не затрагивает чужих дорожек —'])
            .map((r) => `<li>${esc(ROLE_TITLES[r] || r)}</li>`)}</ul>
        </div>
        ${route.always.length ? html`
          <div class="ed__group">
            <div class="ed__group-title">Согласуют всегда</div>
            <ul class="ed__list">${route.always.map((r) => `<li>${esc(ROLE_TITLES[r] || r)}</li>`)}</ul>
          </div>` : ''}`,
      footer: '<button class="btn" data-close>Закрыть</button>',
    });
  });

  view.querySelector('[data-publish]')?.addEventListener('click', async () => {
    const ok = await confirmDialog('Опубликовать версию',
      c.is_pipeline
        ? 'Это конвейер инициатив: после публикации новые сроки и ответственные вступят в силу для всех инициатив.'
        : 'Схема станет действующей. Прежняя версия сохранится в истории.',
      'Опубликовать');
    if (ok) act(() => api.post(`/api/process-changes/${c.id}/publish`), 'Изменение вступило в силу');
  });

  view.querySelector('[data-withdraw]')?.addEventListener('click', async () => {
    const ok = await confirmDialog('Отозвать предложение',
      'Предложение будет закрыто. Схема останется в истории версий.', 'Отозвать');
    if (ok) act(() => api.post(`/api/process-changes/${c.id}/withdraw`, {}), 'Предложение отозвано');
  });

  view.querySelectorAll('[data-vote]').forEach((b) => b.onclick = async () => {
    const value = Number(b.dataset.vote);
    try {
      if (d.votes.my === value) await api.del(`/api/process-changes/${c.id}/vote`);
      else await api.post(`/api/process-changes/${c.id}/vote`, { value });
      reload();
    } catch (e) { toast(e.message, 'danger'); }
  });

  view.querySelector('[data-comment]')?.addEventListener('click', async () => {
    const body = view.querySelector('#chg-comment').value.trim();
    if (!body) { toast('Напишите замечание', 'warn'); return; }
    act(() => api.post(`/api/processes/${c.def_key}/comments`, { change_id: c.id, body }),
      'Замечание отправлено');
  });

  view.querySelectorAll('[data-verdict]').forEach((b) => b.onclick = () => {
    const verdict = b.dataset.verdict;
    const titles = { agree: 'Согласовать', remarks: 'Согласовать с замечаниями', reject: 'Не согласовать' };
    modal({
      title: titles[verdict],
      body: html`
        <p class="prose" style="margin-bottom:12px">
          ${verdict === 'agree'
            ? 'Пояснение необязательно, но помогает автору и остальным согласующим.'
            : 'Пояснение обязательно: автору нужно знать, что именно исправить.'}</p>
        <textarea class="textarea" id="verdict-comment" rows="4"
          placeholder="${verdict === 'agree' ? 'Комментарий (необязательно)' : 'Что мешает согласовать'}"></textarea>`,
      footer: html`<button class="btn" data-close>Отмена</button>
                   <button class="btn btn--primary" data-ok>${esc(titles[verdict])}</button>`,
      onMount: (el, close) => {
        el.querySelector('[data-ok]').onclick = async () => {
          const comment = el.querySelector('#verdict-comment').value.trim();
          try {
            await api.post(`/api/process-changes/${c.id}/approve`, { verdict, comment });
            close(); toast('Решение записано', 'ok'); reload();
          } catch (e) { toast(e.message, 'danger', 'Не получилось'); }
        };
      },
    });
  });
}

// ─────────────────────────────────────────────────────────────
// Правка схемы предложения
// ─────────────────────────────────────────────────────────────
export async function changeEditor(view, id) {
  const d = await api.get(`/api/process-changes/${id}`);
  const c = d.change;
  const readOnly = !(c.author_id === state.user.id && ['draft', 'discussion'].includes(c.status));

  view.innerHTML = html`
    <div class="page-head">
      <div class="page-head__row">
        <div style="flex:1;min-width:280px">
          <div class="row" style="gap:8px;margin-bottom:6px">
            <span class="mono fs-12 text-3">${esc(c.number)}</span>
            <span class="badge ${STATUS_BADGE[c.status]}">${esc(c.status)}</span>
          </div>
          <h2>${esc(c.title)}</h2>
          <p>Правка схемы процесса «${esc(c.def_title)}». Действующая версия не меняется,
             пока предложение не согласовано и не опубликовано.</p>
        </div>
        <a class="btn" href="/changes/${c.id}">К предложению</a>
      </div>
    </div>
    <div id="editor-host"></div>`;

  const { mountEditor } = await import('./process-editor.js');
  mountEditor(view.querySelector('#editor-host'), {
    model: d.draft.model,
    baseModel: d.base.model,
    readOnly,
    title: c.def_title,
    onSave: (model) => api.put(`/api/process-changes/${c.id}/model`, { model }),
  });
}
