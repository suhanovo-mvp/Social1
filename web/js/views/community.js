// Сообщество: форум, профили участников, библиотека лучших практик, страница процесса.
import { api, state, esc, html, avatar, can, navigate, toast, modal, num, fmtDate, fmtAgo,
         nl2br, plural, ROLE_TITLES, STATUS_META } from '../core.js';
import { pipeline } from './initiatives.js';

const CATEGORIES = {
  general: 'Общие вопросы', methodology: 'Методология', pilots: 'Пилотирование',
  tech: 'Технологии', practice: 'Обмен практиками',
};

export async function communityView(view, query) {
  const cat = query.get('category') || '';
  const topics = await api.get(`/api/forum/topics${cat ? '?category=' + encodeURIComponent(cat) : ''}`);
  view.innerHTML = html`
    <div class="page-head">
      <div class="page-head__row">
        <div style="flex:1;min-width:250px">
          <h2>Сообщество</h2>
          <p>Тематические обсуждения для обмена опытом между сотрудниками разных учреждений.
             Здесь разбирают методологию подачи инициатив, делятся опытом пилотов и находят единомышленников.</p>
        </div>
        <button class="btn btn--primary" data-new-topic>Создать тему</button>
      </div>
    </div>

    <div class="chip-row" style="margin-bottom:16px">
      <button class="chip ${!cat ? 'is-on' : ''}" data-cat="">Все темы</button>
      ${Object.entries(CATEGORIES).map(([k, v]) => `<button class="chip ${cat === k ? 'is-on' : ''}" data-cat="${k}">${esc(v)}</button>`)}
    </div>

    <div class="card">
      ${topics.length ? html`<div class="list">
        ${topics.map((t) => html`
          <div class="list__item is-clickable" data-goto="/community/${t.id}">
            ${avatar(t.author_name)}
            <div class="list__main">
              <div class="list__title">${t.is_pinned ? '📌 ' : ''}${esc(t.title)}</div>
              <div class="list__meta">
                <span class="badge badge--outline">${esc(CATEGORIES[t.category] || t.category)}</span>
                <span>${esc(t.author_name)}</span>
                ${t.institution ? `<span>${esc(t.institution)}</span>` : ''}
                <span>${t.replies} ${plural(t.replies, 'сообщение', 'сообщения', 'сообщений')}</span>
                <span>${fmtAgo(t.last_activity || t.created_at)}</span>
              </div>
            </div>
          </div>`)}
      </div>` : '<div class="empty"><h4>Тем пока нет</h4><p>Начните обсуждение — задайте вопрос или поделитесь опытом.</p></div>'}
    </div>`;

  view.querySelectorAll('[data-goto]').forEach((el) => el.onclick = () => navigate(el.dataset.goto));
  view.querySelectorAll('[data-cat]').forEach((b) => b.onclick = () =>
    navigate(`/community${b.dataset.cat ? '?category=' + b.dataset.cat : ''}`));
  view.querySelector('[data-new-topic]').onclick = () => newTopicModal(() => communityView(view, query));
}

function newTopicModal(onDone) {
  modal({
    title: 'Новая тема',
    body: html`
      <div class="field"><label class="field__label" for="t-title">Тема <span class="req">*</span></label>
        <input class="input" id="t-title" placeholder="Сформулируйте вопрос или тему обсуждения"></div>
      <div class="field"><label class="field__label" for="t-cat">Раздел</label>
        <select class="select" id="t-cat">
          ${Object.entries(CATEGORIES).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`)}
        </select></div>
      <div class="field"><label class="field__label" for="t-body">Сообщение <span class="req">*</span></label>
        <textarea class="textarea" id="t-body" style="min-height:120px"></textarea></div>`,
    footer: '<button class="btn" data-close>Отмена</button><button class="btn btn--primary" data-ok>Опубликовать</button>',
    onMount: (el, close) => {
      el.querySelector('[data-ok]').onclick = async () => {
        const title = el.querySelector('#t-title').value.trim();
        const body = el.querySelector('#t-body').value.trim();
        if (!title || !body) { toast('Заполните тему и текст сообщения', 'error'); return; }
        try {
          await api.post('/api/forum/topics', { title, body, category: el.querySelector('#t-cat').value });
          toast('Тема опубликована', 'ok'); close(); onDone();
        } catch (err) { toast(err.message, 'error'); }
      };
    },
  });
}

export async function topicDetail(view, id) {
  const t = await api.get(`/api/forum/topics/${id}`);
  view.innerHTML = html`
    <div class="crumb"><a href="/community">Сообщество</a> <span>/</span> <span>${esc(CATEGORIES[t.category] || t.category)}</span></div>
    <div class="page-head">
      <h2>${esc(t.title)}</h2>
      <p>${esc(t.author_name)} · ${fmtDate(t.created_at)}${t.initiative_number ? ' · инициатива ' + esc(t.initiative_number) : ''}</p>
    </div>
    <div class="card">
      <div class="list">
        ${t.posts.map((p) => html`
          <div class="list__item">
            ${avatar(p.author_name)}
            <div class="list__main">
              <div class="list__title">${esc(p.author_name)}
                <span class="fs-12 text-3" style="font-weight:400"> · ${esc(ROLE_TITLES[p.author_role] || '')}${p.institution ? ' · ' + esc(p.institution) : ''}</span></div>
              <div class="list__body">${nl2br(p.body)}</div>
              <div class="list__meta">${fmtAgo(p.created_at)}</div>
            </div>
          </div>`)}
      </div>
      <div class="card__foot">
        <form id="reply-form">
          <textarea class="textarea" name="body" placeholder="Ваш ответ…" style="min-height:80px;margin-bottom:9px" required></textarea>
          <button class="btn btn--primary btn--sm" type="submit">Ответить</button>
        </form>
      </div>
    </div>`;
  view.querySelector('#reply-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.post(`/api/forum/topics/${id}/posts`, { body: e.target.body.value.trim() });
      topicDetail(view, id);
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ══ Лучшие практики ══════════════════════════════════════════
export async function practicesView(view) {
  const [practices, rollouts] = await Promise.all([
    api.get('/api/best-practices'),
    api.get('/api/rollouts').catch(() => []),
  ]);
  view.innerHTML = html`
    <div class="page-head">
      <h2>Библиотека лучших практик</h2>
      <p>Внутренний рынок проверенных решений. Здесь собраны инициативы, доказавшие эффект на пилоте, —
         с методическими материалами, программой обучения и подтверждёнными результатами.
         Любое учреждение может взять практику в работу самостоятельно.</p>
    </div>

    ${practices.length ? html`
    <div class="stack">
      ${practices.map((p) => html`
        <div class="card">
          <div class="card__head">
            <h3>${esc(p.title)}</h3>
            <div class="row spacer">
              ${p.adoptions ? `<span class="badge badge--ok">Внедрено в ${p.adoptions} ${plural(p.adoptions, 'учреждении', 'учреждениях', 'учреждениях')}</span>` : ''}
              <span class="badge badge--outline">${esc(p.category || '')}</span>
            </div>
          </div>
          <div class="card__body">
            <p class="prose" style="margin-bottom:14px">${nl2br(p.summary)}</p>
            ${p.effect_text ? html`
              <div class="ai-box" style="background:var(--ok-bg);border-color:transparent;margin-bottom:14px">
                <div class="fs-12 fw-600" style="color:var(--ok);margin-bottom:5px">Подтверждённый эффект</div>
                <div class="fs-13" style="line-height:1.6">${nl2br(p.effect_text)}</div>
              </div>` : ''}
            ${p.materials ? html`
              <div class="fs-12 fw-600 text-2" style="margin-bottom:5px">Материалы для внедрения</div>
              <p class="fs-13 text-2" style="line-height:1.6">${nl2br(p.materials)}</p>` : ''}
          </div>
          <div class="card__foot row">
            <span class="fs-12 text-3">Автор: ${esc(p.author_name)} · ${esc(p.origin_institution)} · опубликовано ${fmtDate(p.published_at)}</span>
            <div class="row spacer">
              <a href="/initiatives/${p.initiative_id}" class="btn btn--sm">Карточка инициативы</a>
              ${can('rollout.manage') ? `<button class="btn btn--sm btn--primary" data-adopt="${p.initiative_id}">Взять в работу</button>` : ''}
            </div>
          </div>
        </div>`)}
    </div>` : '<div class="card"><div class="empty"><h4>Практик пока нет</h4><p>Библиотека наполняется по мере того, как инициативы доказывают эффект на пилотах.</p></div></div>'}

    ${rollouts.length ? html`
    <div class="card" style="margin-top:18px">
      <div class="card__head"><h3>Ход масштабирования</h3>
        <span class="card__hint spacer">Внедрение решений в учреждениях</span></div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Инициатива</th><th>Учреждение</th><th>Статус</th><th>Источник</th><th>Начато</th></tr></thead>
        <tbody>${rollouts.map((r) => html`
          <tr class="is-clickable" data-goto="/initiatives/${r.initiative_id}">
            <td><span class="mono fs-12">${esc(r.number)}</span><div class="clamp-2 fs-13">${esc(r.initiative_title)}</div></td>
            <td class="fs-13">${esc(r.institution_short)}</td>
            <td><span class="badge badge--${r.status === 'deployed' ? 'ok' : r.status === 'training' ? 'warn' : ''}">
              ${r.status === 'deployed' ? 'Внедрено' : r.status === 'training' ? 'Обучение' : 'Запланировано'}</span></td>
            <td>${r.bottom_up ? '<span class="badge badge--purple">Инициативно снизу</span>' : '<span class="fs-12 text-3">Централизованно</span>'}</td>
            <td class="fs-12 text-3">${fmtDate(r.started_at)}</td>
          </tr>`)}
        </tbody>
      </table></div>
    </div>` : ''}`;

  view.querySelectorAll('[data-goto]').forEach((el) => el.onclick = () => navigate(el.dataset.goto));
  view.querySelectorAll('[data-adopt]').forEach((b) => b.onclick = async () => {
    try {
      await api.post('/api/rollouts', { initiative_id: Number(b.dataset.adopt), status: 'planned' });
      toast('Внедрение зарегистрировано. Практика отмечена как взятая по инициативе учреждения.', 'ok');
      practicesView(view);
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ══ Профиль участника ════════════════════════════════════════
export async function profileView(view, id) {
  const { advisorPanel } = await import('./rating.js');
  const [u, advisor] = await Promise.all([api.get(`/api/users/${id}`), advisorPanel(id)]);
  view.innerHTML = html`
    <div class="page-head">
      <div class="row" style="gap:16px;align-items:flex-start">
        ${avatar(u.full_name, 'avatar--lg')}
        <div style="flex:1;min-width:220px">
          <h2>${esc(u.full_name)}</h2>
          <p>${esc(u.position || '')}${u.institution_name ? ' · ' + esc(u.institution_name) : ''}</p>
          <div class="row" style="margin-top:8px">
            <span class="badge badge--info">${esc(u.role_title || '')}</span>
            ${u.expertise ? `<span class="badge badge--outline">${esc(u.expertise)}</span>` : ''}
          </div>
        </div>
      </div>
    </div>

    ${advisor}

    <div class="grid grid--kpi" style="margin-bottom:16px">
      <div class="kpi"><div class="kpi__label">Подано инициатив</div><div class="kpi__value">${u.initiatives.length}</div></div>
      <div class="kpi kpi--ok"><div class="kpi__label">Масштабировано</div>
        <div class="kpi__value">${u.initiatives.filter((i) => i.status === 'scaled').length}</div></div>
      <div class="kpi"><div class="kpi__label">Решений на Gate</div><div class="kpi__value">${u.decisions_made}</div></div>
      <div class="kpi"><div class="kpi__label">Признание</div><div class="kpi__value">${u.awards.length}</div></div>
    </div>

    <div class="grid grid--2" style="align-items:start">
      <div class="card">
        <div class="card__head"><h3>Инициативы</h3></div>
        <div class="card__body--flush">
          ${u.initiatives.length ? html`<div class="list">
            ${u.initiatives.map((i) => html`
              <div class="list__item is-clickable" data-goto="/initiatives/${i.id}">
                <div class="list__main">
                  <div class="list__title">${esc(i.title)}</div>
                  <div class="list__meta">
                    <span class="mono">${esc(i.number)}</span>
                    <span class="badge badge--${STATUS_META[i.status]?.badge}">${STATUS_META[i.status]?.title}</span>
                    <span>${fmtDate(i.created_at)}</span>
                  </div>
                </div>
              </div>`)}
          </div>` : '<div class="empty" style="padding:30px"><p>Инициатив пока нет</p></div>'}
        </div>
      </div>

      <div class="card">
        <div class="card__head"><h3>Признание и награды</h3>
          <span class="card__hint spacer">Нематериальное стимулирование участников</span></div>
        <div class="card__body--flush">
          ${u.awards.length ? html`<div class="list">
            ${u.awards.map((a) => html`
              <div class="list__item">
                <div style="font-size:20px">★</div>
                <div class="list__main">
                  <div class="list__title">${esc(a.title)}</div>
                  <div class="list__meta">
                    ${a.number ? `<span class="mono">${esc(a.number)}</span>` : ''}
                    <span>${fmtDate(a.granted_at)}</span>
                  </div>
                </div>
              </div>`)}
          </div>` : '<div class="empty" style="padding:30px"><p>Наград пока нет</p></div>'}
        </div>
      </div>
    </div>`;
  view.querySelectorAll('[data-goto]').forEach((el) => el.onclick = () => navigate(el.dataset.goto));
}

// ══ Описание процесса Stage-Gate ═════════════════════════════
export async function processView(view) {
  const stages = state.stages;
  view.innerHTML = html`
    <div class="page-head">
      <h2>Процесс Stage-Gate</h2>
      <p>Управление жизненным циклом инициативы построено по модели «этап — ворота». Работы отделены
         от принятия решений: каждый этап завершается формальной точкой, где уполномоченный участник
         на основе доказательств принимает решение Go, Kill, Hold или Redirect.</p>
    </div>

    <div class="card" style="margin-bottom:18px">
      <div class="card__body">${pipeline(stages, -1, null)}</div>
    </div>

    <div class="stack">
      ${stages.map((s) => html`
        <div class="card">
          <div class="card__head">
            <div>
              <h3>Этап ${s.tz_stage}. ${esc(s.tz_stage_name)}</h3>
              <div class="card__hint">${esc(s.stage_name)}</div>
            </div>
            ${s.gate_no ? `<span class="badge badge--info spacer">Gate ${s.gate_no}</span>`
                        : '<span class="badge badge--outline spacer">без точки принятия решения</span>'}
          </div>
          <div class="card__body">
            <div class="grid grid--2" style="gap:20px">
              <div>
                <div class="fs-12 fw-600 text-3" style="margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em">Триггер</div>
                <p class="fs-13 text-2" style="line-height:1.6;margin-bottom:14px">${esc(s.trigger_text || '—')}</p>
                <div class="fs-12 fw-600 text-3" style="margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em">Процесс</div>
                <p class="fs-13 text-2" style="line-height:1.6;margin-bottom:14px">${esc(s.description || '')}</p>
                <div class="fs-12 fw-600 text-3" style="margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em">Участники</div>
                <div class="chip-row">${s.participants.map((p) => `<span class="chip" style="cursor:default">${esc(ROLE_TITLES[p] || p)}</span>`)}</div>
              </div>
              <div>
                <div class="fs-12 fw-600 text-3" style="margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em">Стандарт обслуживания (SLA)</div>
                <p class="fs-13 text-2" style="line-height:1.6;margin-bottom:14px">${esc(s.sla_text || '—')}</p>
                ${s.criteria.length ? html`
                  <div class="fs-12 fw-600 text-3" style="margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em">Критерии Gate</div>
                  <ul style="margin:0 0 14px;padding-left:18px;font-size:13px;line-height:1.7;color:var(--text-2)">
                    ${s.criteria.map((c) => `<li>${esc(c)}</li>`)}
                  </ul>` : ''}
                ${s.decisions.length ? html`
                  <div class="fs-12 fw-600 text-3" style="margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em">Возможные решения</div>
                  <div class="chip-row">
                    ${s.decisions.map((d) => `<span class="chip" style="cursor:default">${esc({
                      go: 'Go — продолжить', kill: 'Kill — остановить',
                      hold: 'Hold — приостановить', redirect: 'Redirect — перенаправить' }[d] || d)}</span>`)}
                  </div>` : ''}
                ${s.role_required ? `<div class="fs-12 text-3" style="margin-top:12px">
                  Решение принимает: <b>${esc(ROLE_TITLES[s.role_required] || s.role_required)}</b></div>` : ''}
              </div>
            </div>
          </div>
        </div>`)}
    </div>`;
}
