// Модуль управления инициативами: список, карточка жизненного цикла, подача, решения на Gate.
import { bindVoting, voteBlock } from './ideas.js';
import { api, state, esc, html, avatar, can, navigate, toast, modal, confirmDialog, nl2br,
         fmtDate, fmtShort, fmtAgo, fmtHours, num, debounce, slaChip, plural,
         STATUS_META, DECISION_META, ROLE_TITLES } from '../core.js';

// ══ Конвейер этапов ══════════════════════════════════════════
export function pipeline(stages, current, status, counts) {
  return html`<div class="pipeline">
    ${stages.map((s) => {
      let cls = '';
      if (status === 'killed' && s.stage_no === current) cls = 'is-killed';
      else if (status === 'scaled' || s.stage_no < current) cls = 'is-done';
      else if (s.stage_no === current) cls = 'is-current';
      return html`<div class="pipe-stage ${cls}" title="${esc(s.description || '')}">
        <div class="pipe-stage__tz">Этап ${s.tz_stage}</div>
        <div class="pipe-stage__name">${esc(s.stage_name)}</div>
        ${s.gate_no ? `<div class="pipe-stage__gate">Gate ${s.gate_no} · ${esc(s.role_required ? ROLE_TITLES[s.role_required].split(' ')[0] : '')}</div>`
                    : '<div class="pipe-stage__gate">без Gate</div>'}
        ${counts ? `<div class="pipe-stage__count">${counts[s.stage_no] ?? 0}</div>` : ''}
      </div>`;
    })}
  </div>`;
}

// ══ Список инициатив ═════════════════════════════════════════
export async function initiativesList(view, query) {
  const params = new URLSearchParams();
  for (const k of ['stage', 'status', 'category', 'q', 'mine', 'sort', 'institution']) {
    if (query.get(k)) params.set(k, query.get(k));
  }
  params.set('limit', '100');

  view.innerHTML = '<div class="card"><div class="card__body"><div class="skeleton" style="height:280px"></div></div></div>';
  const [data, categories] = await Promise.all([
    api.get(`/api/initiatives?${params}`),
    api.get('/api/categories'),
  ]);

  const chip = (key, val, label) => {
    const on = (query.get(key) || '') === val;
    return html`<button class="chip ${on ? 'is-on' : ''}" data-filter="${key}" data-value="${esc(on ? '' : val)}">${esc(label)}</button>`;
  };

  view.innerHTML = html`
    <div class="page-head">
      <div class="page-head__row">
        <div style="flex:1;min-width:260px">
          <h2>Инициативы</h2>
          <p>Все предложения сотрудников учреждений и их движение по конвейеру Stage-Gate.
             Найдено: ${num(data.total)} ${data.total === 1 ? 'инициатива' : 'инициатив'}.</p>
        </div>
        ${can('initiative.create') ? '<a href="/initiatives/new" class="btn btn--primary">Подать инициативу</a>' : ''}
      </div>
    </div>

    <div class="filters">
      <input class="input" type="search" id="f-q" placeholder="Поиск по названию, номеру, описанию…"
             value="${esc(query.get('q') || '')}" style="min-width:250px;flex:1;max-width:400px">
      <select class="select" id="f-stage">
        <option value="">Все этапы</option>
        ${state.stages.map((s) => `<option value="${s.stage_no}" ${query.get('stage') == s.stage_no ? 'selected' : ''}>
          Этап ${s.tz_stage}. ${esc(s.stage_name)}</option>`)}
      </select>
      <select class="select" id="f-category">
        <option value="">Все направления</option>
        ${categories.map((c) => `<option value="${esc(c.name)}" ${query.get('category') === c.name ? 'selected' : ''}>
          ${esc(c.name)} (${c.count})</option>`)}
      </select>
      <select class="select" id="f-sort">
        <option value="new" ${query.get('sort') === 'new' ? 'selected' : ''}>Сначала новые</option>
        <option value="old" ${query.get('sort') === 'old' ? 'selected' : ''}>Сначала старые</option>
        <option value="stage" ${query.get('sort') === 'stage' ? 'selected' : ''}>По этапу</option>
        <option value="sla" ${query.get('sort') === 'sla' ? 'selected' : ''}>По сроку SLA</option>
      </select>
    </div>
    <div class="chip-row" style="margin-bottom:16px">
      ${chip('status', 'active', 'В работе')}
      ${chip('status', 'hold', 'Приостановленные')}
      ${chip('status', 'scaled', 'Масштабированные')}
      ${chip('status', 'killed', 'Остановленные')}
      ${chip('mine', '1', 'Мои инициативы')}
    </div>

    <div class="card">
      ${data.items.length ? html`
      <div class="table-wrap">
        <table class="table">
          <thead><tr>
            <th style="width:120px">Номер</th><th>Инициатива</th>
            <th style="width:190px">Этап</th><th style="width:150px">Учреждение</th>
            <th style="width:140px">Статус</th><th style="width:130px">Обновлена</th>
          </tr></thead>
          <tbody>
            ${data.items.map((i) => html`
              <tr class="is-clickable" data-id="${i.id}">
                <td class="mono nowrap">${esc(i.number)}</td>
                <td>
                  <div class="fw-600" style="margin-bottom:3px">${esc(i.title)}</div>
                  <div class="fs-12 text-3">${esc(i.category || '')} · ${esc(i.author_name)}</div>
                </td>
                <td>
                  <div class="fs-12 fw-600">${esc(i.stage_name || '')}</div>
                  <div class="fs-12 text-3">Этап ${i.tz_stage}${i.gate_no ? ` · Gate ${i.gate_no}` : ''}</div>
                </td>
                <td class="fs-12">${esc(i.institution_short)}</td>
                <td>
                  <span class="badge badge--${STATUS_META[i.status]?.badge}">${STATUS_META[i.status]?.title}</span>
                  ${i.sla?.code && i.sla.code !== 'ok' && i.sla.code !== 'none'
                    ? `<div style="margin-top:4px">${slaChip(i.sla)}</div>` : ''}
                </td>
                <td class="fs-12 text-3 nowrap">${fmtShort(i.updated_at)}</td>
              </tr>`)}
          </tbody>
        </table>
      </div>` : html`
      <div class="empty">
        <h4>Инициативы не найдены</h4>
        <p>Измените условия поиска или подайте первую инициативу по этому направлению.</p>
      </div>`}
    </div>`;

  const setParam = (key, value) => {
    const q = new URLSearchParams(location.search);
    if (value) q.set(key, value); else q.delete(key);
    navigate(`/initiatives${q.toString() ? '?' + q : ''}`);
  };
  view.querySelector('#f-q').addEventListener('input', debounce((e) => setParam('q', e.target.value.trim()), 400));
  view.querySelector('#f-stage').onchange = (e) => setParam('stage', e.target.value);
  view.querySelector('#f-category').onchange = (e) => setParam('category', e.target.value);
  view.querySelector('#f-sort').onchange = (e) => setParam('sort', e.target.value);
  view.querySelectorAll('[data-filter]').forEach((b) => b.onclick = () => setParam(b.dataset.filter, b.dataset.value));
  view.querySelectorAll('tr[data-id]').forEach((tr) => tr.onclick = () => navigate(`/initiatives/${tr.dataset.id}`));
}

// ══ Карточка инициативы ══════════════════════════════════════
export async function initiativeDetail(view, id) {
  view.innerHTML = '<div class="card"><div class="card__body"><div class="skeleton" style="height:340px"></div></div></div>';
  const it = await api.get(`/api/initiatives/${id}`);
  const cfg = it.stage_config;

  const effect = it.effect_value
    ? `${num(it.effect_value, it.effect_value % 1 ? 1 : 0)} ${esc(it.effect_unit || '')}` : null;

  // Хронология: создание + переходы + решения
  const events = [
    { at: it.created_at, kind: 'create', title: 'Инициатива подана',
      who: it.author_name, body: 'Этап 1 не содержит точки принятия решения — инициатива автоматически направлена руководителю учреждения.' },
    ...it.decisions.map((d) => ({
      at: d.decided_at, kind: d.decision,
      title: `${DECISION_META[d.decision]?.title} · Gate ${d.gate_no}`,
      who: `${d.decided_by_name} — ${ROLE_TITLES[d.decided_by_role] || d.decided_by_role}`,
      body: d.rationale, sla_met: d.sla_met, duration: d.duration_hours,
      scores: d.criteria_scores,
    })),
  ].sort((a, b) => new Date(a.at.replace(' ', 'T')) - new Date(b.at.replace(' ', 'T')));

  view.innerHTML = html`
    <div class="crumb"><a href="/initiatives">Инициативы</a> <span>/</span> <span class="mono">${esc(it.number)}</span></div>
    <div class="page-head">
      <div class="page-head__row">
        <div style="flex:1;min-width:280px">
          <h2>${esc(it.title)}</h2>
          <div class="row" style="margin-top:9px">
            <span class="st st--${it.public_status.tone}"><i></i>${esc(it.public_status.title)}</span>
            <span class="badge badge--${STATUS_META[it.status]?.badge}">${STATUS_META[it.status]?.title}</span>
            ${it.category ? `<span class="badge badge--outline">${esc(it.category)}</span>` : ''}
            ${slaChip(it.sla)}
            <span class="fs-12 text-3">Подана ${fmtDate(it.created_at)} · ${esc(it.institution_short)}</span>
          </div>
        </div>
        <div class="row">
          ${it.can_decide ? '<button class="btn btn--primary" data-decide>Принять решение на Gate</button>' : ''}
          ${it.status === 'hold' && (it.is_author || can('admin')) ? '<button class="btn" data-resume>Возобновить</button>' : ''}
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card__body">${pipeline(state.stages, it.stage, it.status)}</div>
      ${it.status === 'active' && cfg?.gate_no ? html`
      <div class="card__foot row">
        <div>
          <b class="fs-13">${esc(cfg.gate_name)}</b>
          <div class="fs-12 text-3" style="margin-top:2px">${esc(cfg.sla_text || '')}</div>
        </div>
        <div class="spacer fs-12 text-3" style="text-align:right">
          ${it.sla_due_at ? `Срок решения: <b>${fmtDate(it.sla_due_at, true)}</b>` : ''}
          ${!it.can_decide && it.decide_reason ? `<div>${esc(it.decide_reason)}</div>` : ''}
        </div>
      </div>` : ''}
    </div>

    <div class="grid grid--2" style="align-items:start">
      <div class="stack">
        <div class="card">
          <div class="card__head"><h3>Проблема</h3></div>
          <div class="card__body prose">${nl2br(it.problem)}</div>
        </div>
        <div class="card">
          <div class="card__head"><h3>Предлагаемое решение</h3></div>
          <div class="card__body prose">${nl2br(it.solution)}</div>
        </div>
        <div class="card">
          <div class="card__head"><h3>Прогнозируемый эффект</h3>
            ${effect ? `<span class="badge badge--ok spacer">${effect}</span>` : ''}</div>
          <div class="card__body prose">${nl2br(it.expected_effect)}</div>
        </div>

        <div class="card">
          <div class="card__head"><h3>Жизненный цикл</h3>
            <span class="card__hint spacer">Все решения документируются с аргументацией</span></div>
          <div class="card__body">
            <div class="timeline">
              ${events.map((e) => html`
                <div class="tl-item tl-item--${e.kind}">
                  <div class="tl-item__head">
                    <span class="tl-item__title">${esc(e.title)}</span>
                    <span class="tl-item__time">${fmtDate(e.at, true)}</span>
                    ${e.sla_met !== undefined && e.sla_met !== null
                      ? `<span class="badge badge--${e.sla_met ? 'ok' : 'danger'}">${e.sla_met ? 'SLA соблюдён' : 'SLA нарушен'}</span>` : ''}
                    ${e.duration ? `<span class="fs-12 text-3">${fmtHours(e.duration)} на этапе</span>` : ''}
                  </div>
                  <div class="tl-item__who">${avatar(e.who?.split(' —')[0], 'avatar--sm')} ${esc(e.who || '')}</div>
                  <div class="tl-item__body">${nl2br(e.body)}</div>
                  ${e.scores && Object.keys(e.scores).length ? html`
                    <div class="fs-12 text-3" style="margin-top:7px;padding-left:2px">
                      ${Object.entries(e.scores).map(([k, v]) => `<div>${esc(k)} — <b>${v}</b>/5</div>`)}
                    </div>` : ''}
                </div>`)}
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card__head"><h3>Обсуждение</h3>
            <span class="card__hint spacer">${it.comments.length} ${it.comments.length === 1 ? 'комментарий' : 'комментариев'}</span></div>
          <div class="card__body--flush">
            ${it.comments.length ? html`<div class="list">
              ${it.comments.map((c) => html`
                <div class="list__item">
                  ${avatar(c.author_name)}
                  <div class="list__main">
                    <div class="list__title">${esc(c.author_name)}
                      <span class="fs-12 text-3" style="font-weight:400"> · ${esc(ROLE_TITLES[c.author_role] || '')}</span></div>
                    <div class="list__body">${nl2br(c.body)}</div>
                    <div class="list__meta">${fmtAgo(c.created_at)}</div>
                  </div>
                </div>`)}
            </div>` : '<div class="empty" style="padding:26px"><p>Обсуждение пока не начато</p></div>'}
          </div>
          ${can('initiative.comment') ? html`
          <div class="card__foot">
            <form id="comment-form">
              <textarea class="textarea" name="body" placeholder="Задайте вопрос автору, предложите доработку или поделитесь опытом…"
                        style="min-height:74px;margin-bottom:9px" required></textarea>
              <button class="btn btn--primary btn--sm" type="submit">Отправить</button>
            </form>
          </div>` : ''}
        </div>
      </div>

      <div class="stack">
        <div class="card" data-tour="support">
          <div class="card__head"><h3>Поддержка коллег</h3>
            ${it.followers ? `<span class="badge badge--outline spacer">${it.followers} ${it.followers === 1 ? 'подписчик' : 'подписчиков'}</span>` : ''}</div>
          <div class="card__body">
            <div class="row" style="gap:16px;align-items:center">
              ${voteBlock(it)}
              <div style="flex:1;min-width:150px">
                <div class="fs-13 text-2" style="line-height:1.55">
                  ${it.votes_up} ${plural(it.votes_up, 'коллега поддержал', 'коллеги поддержали', 'коллег поддержали')} инициативу${it.votes_down ? `, ${it.votes_down} — против` : ''}.
                </div>
                <div class="fs-12 text-3" style="margin-top:6px">
                  Голоса видны экспертам при оценке приоритета, но решение на Gate принимает уполномоченный участник.
                </div>
              </div>
            </div>
            <button class="btn btn--sm btn--block" data-follow style="margin-top:13px">
              ${it.following ? 'Не следить за инициативой' : 'Следить за инициативой'}
            </button>
          </div>
          ${it.voters.length ? html`
          <div class="card__foot">
            <div class="fs-12 text-3" style="margin-bottom:7px">Поддержали</div>
            <div class="row" style="gap:5px">
              ${it.voters.filter((v) => v.value === 1).slice(0, 12).map((v) =>
                `<a href="/profile/${v.id}" title="${esc(v.full_name)}${v.institution ? ' · ' + esc(v.institution) : ''}">${avatar(v.full_name, 'avatar--sm')}</a>`)}
              ${it.votes_up > 12 ? `<span class="fs-12 text-3" style="align-self:center">+${it.votes_up - 12}</span>` : ''}
            </div>
          </div>` : ''}
        </div>

        <div class="card">
          <div class="card__head"><h3>Сведения</h3></div>
          <div class="card__body">
            <dl class="def">
              <dt>Номер</dt><dd class="mono">${esc(it.number)}</dd>
              <dt>Автор</dt><dd><a href="/profile/${it.author_id}">${esc(it.author_name)}</a></dd>
              <dt>Учреждение</dt><dd>${esc(it.institution_name)}</dd>
              <dt>Направление</dt><dd>${esc(it.category || '—')}</dd>
              <dt>Текущий этап</dt><dd>Этап ${it.tz_stage}. ${esc(it.stage_name)}</dd>
              <dt>На этапе с</dt><dd>${fmtDate(it.stage_entered_at)}</dd>
              ${effect ? `<dt>Эффект</dt><dd>${effect}</dd>` : ''}
              ${it.scaled_at ? `<dt>Масштабирована</dt><dd>${fmtDate(it.scaled_at)}</dd>` : ''}
            </dl>
          </div>
        </div>

        ${cfg?.criteria?.length ? html`
        <div class="card">
          <div class="card__head"><h3>Критерии ${esc(cfg.gate_name || '')}</h3></div>
          <div class="card__body">
            <ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.75;color:var(--text-2)">
              ${cfg.criteria.map((c) => `<li>${esc(c)}</li>`)}
            </ul>
          </div>
        </div>` : ''}

        <div class="card" id="ai-card">
          <div class="card__head"><h3>ИИ-помощник</h3></div>
          <div class="card__body"><div class="skeleton" style="height:130px"></div></div>
        </div>

        ${it.project ? html`
        <div class="card">
          <div class="card__head"><h3>Проект разработки</h3></div>
          <div class="card__body">
            <dl class="def">
              <dt>Продакт-менеджер</dt><dd>${esc(it.project.product_owner_name || '—')}</dd>
              <dt>Руководитель</dt><dd>${esc(it.project.team_lead_name || '—')}</dd>
            </dl>
            <a href="/projects/${it.project.id}" class="btn btn--sm btn--block" style="margin-top:12px">Открыть доску задач</a>
          </div>
        </div>` : ''}

        ${it.pilots.length ? html`
        <div class="card">
          <div class="card__head"><h3>Пилотирование</h3></div>
          <div class="card__body--flush"><div class="list">
            ${it.pilots.map((p) => html`
              <div class="list__item is-clickable" data-goto="/pilots/${p.id}">
                <div class="list__main">
                  <div class="list__title">${esc(p.institution_short)}</div>
                  <div class="list__meta">
                    <span>${fmtShort(p.starts_at)} — ${fmtShort(p.ends_at)}</span>
                    <span>${p.participants_count} участников</span>
                  </div>
                </div>
              </div>`)}
          </div></div>
        </div>` : ''}

        ${it.rollouts.length ? html`
        <div class="card">
          <div class="card__head"><h3>Внедрение в учреждениях</h3>
            <span class="badge badge--ok spacer">${it.rollouts.filter((r) => r.status === 'deployed').length} из ${it.rollouts.length}</span></div>
          <div class="card__body--flush"><div class="list">
            ${it.rollouts.map((r) => html`
              <div class="list__item">
                <div class="list__main">
                  <div class="list__title">${esc(r.institution_short)}</div>
                  <div class="list__meta">
                    <span class="badge badge--${r.status === 'deployed' ? 'ok' : r.status === 'training' ? 'warn' : ''}">
                      ${r.status === 'deployed' ? 'Внедрено' : r.status === 'training' ? 'Обучение' : 'Запланировано'}</span>
                    ${r.bottom_up ? '<span class="badge badge--purple">Инициативно</span>' : ''}
                  </div>
                </div>
              </div>`)}
          </div></div>
        </div>` : ''}
      </div>
    </div>`;

  // Обработчики
  view.querySelectorAll('[data-goto]').forEach((el) => el.onclick = () => navigate(el.dataset.goto));
  bindVoting(view);
  view.querySelector('[data-follow]')?.addEventListener('click', async (e) => {
    try {
      const r = await api.post(`/api/initiatives/${id}/follow`);
      e.target.textContent = r.following ? 'Не следить за инициативой' : 'Следить за инициативой';
      toast(r.following ? 'Вы будете получать уведомления об этой инициативе' : 'Уведомления отключены', 'ok');
    } catch (err) { toast(err.message, 'error'); }
  });
  view.querySelector('#comment-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = e.target.body.value.trim();
    if (!body) return;
    try {
      await api.post(`/api/initiatives/${id}/comments`, { body });
      toast('Комментарий добавлен', 'ok');
      initiativeDetail(view, id);
    } catch (err) { toast(err.message, 'error'); }
  });
  view.querySelector('[data-decide]')?.addEventListener('click', () => gateModal(it, () => initiativeDetail(view, id)));
  view.querySelector('[data-resume]')?.addEventListener('click', () => resumeModal(it, () => initiativeDetail(view, id)));

  // ИИ-блок подгружается отдельно, чтобы не задерживать основную карточку
  api.get(`/api/initiatives/${id}/prediction`).then((p) => {
    const box = view.querySelector('#ai-card');
    if (!box) return;
    box.querySelector('.card__body').innerHTML = html`
      <div class="row" style="margin-bottom:11px">
        <div>
          <div class="fs-12 text-3">Вероятность прохождения цикла</div>
          <div style="font-size:26px;font-weight:700;letter-spacing:-.03em">${p.probability}%</div>
        </div>
      </div>
      <div class="progress ${p.probability > 60 ? 'progress--ok' : p.probability < 35 ? 'progress--danger' : 'progress--warn'}"
           style="margin-bottom:13px"><i style="width:${p.probability}%"></i></div>
      <div class="fs-12 fw-600 text-2" style="margin-bottom:5px">Факторы оценки</div>
      ${p.factors.map((f) => html`
        <div class="factor">
          <span class="factor__impact factor__impact--${f.impact > 0 ? 'plus' : 'minus'}">${f.impact > 0 ? '+' : ''}${f.impact.toFixed(2)}</span>
          <span class="text-2">${esc(f.name)}</span>
        </div>`)}
      ${p.similar.length ? html`
        <div class="hr"></div>
        <div class="fs-12 fw-600 text-2" style="margin-bottom:7px">Похожие инициативы</div>
        ${p.similar.map((s) => html`
          <a href="/initiatives/${s.id}" class="row fs-12" style="padding:4px 0;justify-content:space-between">
            <span class="truncate" style="max-width:70%">${esc(s.title)}</span>
            <span class="badge badge--outline">${s.similarity}%</span>
          </a>`)}` : ''}
      <div class="ai-box__note">${esc(p.disclaimer)}</div>`;
  }).catch(() => {
    view.querySelector('#ai-card')?.remove();
  });
}

// ══ Решение на Gate ══════════════════════════════════════════
function gateModal(it, onDone) {
  const cfg = it.stage_config;
  const scores = {};
  modal({
    title: cfg.gate_name, wide: true,
    body: html`
      <div class="prose" style="margin-bottom:16px">
        <b>${esc(it.number)}</b> — ${esc(it.title)}<br>
        <span class="text-3 fs-13">${esc(cfg.sla_text || '')}</span>
      </div>
      ${cfg.criteria?.length ? html`
        <div class="field">
          <label class="field__label">Оценка по критериям Gate</label>
          <div class="criteria">
            ${cfg.criteria.map((c, ci) => html`
              <div class="criteria__item">
                <span class="criteria__text">${esc(c)}</span>
                <span class="score" data-criterion="${ci}">
                  ${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-score="${n}">${n}</button>`)}
                </span>
              </div>`)}
          </div>
          <div class="field__hint">Оценки сохраняются в карточке инициативы и формируют архив знаний для будущих решений.</div>
        </div>` : ''}
      <div class="field">
        <label class="field__label" for="g-decision">Решение <span class="req">*</span></label>
        <select class="select" id="g-decision">
          ${cfg.decisions.map((d) => `<option value="${d}">${DECISION_META[d]?.title || d}</option>`)}
        </select>
      </div>
      <div class="field" id="redirect-field" hidden>
        <label class="field__label" for="g-redirect">Вернуть на этап</label>
        <select class="select" id="g-redirect">
          ${state.stages.filter((s) => s.stage_no < cfg.stage_no)
            .map((s) => `<option value="${s.stage_no}" ${s.stage_no === cfg.stage_no - 1 ? 'selected' : ''}>
              Этап ${s.tz_stage}. ${esc(s.stage_name)}</option>`)}
        </select>
      </div>
      <div class="field">
        <label class="field__label" for="g-rationale">Аргументация решения <span class="req">*</span></label>
        <textarea class="textarea" id="g-rationale" required minlength="10"
          placeholder="Обоснуйте решение: какие критерии выполнены, что нужно доработать, какие риски выявлены…"></textarea>
        <div class="field__hint">Обязательное поле. Решения на Gate документируются — это создаёт архив опыта и обеспечивает прозрачность процесса.</div>
      </div>`,
    footer: html`<button class="btn" data-close>Отмена</button>
                 <button class="btn btn--primary" data-submit>Зафиксировать решение</button>`,
    onMount: (el, close) => {
      el.querySelectorAll('.score').forEach((group) => {
        group.querySelectorAll('button').forEach((b) => b.onclick = () => {
          group.querySelectorAll('button').forEach((x) => x.classList.remove('is-on'));
          b.classList.add('is-on');
          scores[cfg.criteria[Number(group.dataset.criterion)]] = Number(b.dataset.score);
        });
      });
      const decisionSel = el.querySelector('#g-decision');
      decisionSel.onchange = () => {
        el.querySelector('#redirect-field').hidden = decisionSel.value !== 'redirect';
      };
      el.querySelector('[data-submit]').onclick = async (ev) => {
        const rationale = el.querySelector('#g-rationale').value.trim();
        if (rationale.length < 10) { toast('Укажите аргументацию решения — не менее 10 символов', 'error'); return; }
        ev.target.disabled = true; ev.target.textContent = 'Сохранение…';
        try {
          await api.post(`/api/initiatives/${it.id}/gate`, {
            decision: decisionSel.value, rationale, criteria_scores: scores,
            redirect_to: decisionSel.value === 'redirect' ? Number(el.querySelector('#g-redirect').value) : undefined,
          });
          toast(`Решение «${DECISION_META[decisionSel.value]?.title}» зафиксировано`, 'ok');
          close(); onDone();
        } catch (err) {
          toast(err.message, 'error');
          ev.target.disabled = false; ev.target.textContent = 'Зафиксировать решение';
        }
      };
    },
  });
}

function resumeModal(it, onDone) {
  modal({
    title: 'Возобновить инициативу',
    body: html`<div class="field">
      <label class="field__label" for="r-comment">Что изменилось</label>
      <textarea class="textarea" id="r-comment" placeholder="Опишите, какая информация предоставлена или какие условия выполнены…"></textarea>
      <div class="field__hint">Отсчёт SLA по текущему этапу начнётся заново с момента возобновления.</div>
    </div>`,
    footer: html`<button class="btn" data-close>Отмена</button>
                 <button class="btn btn--primary" data-ok>Возобновить</button>`,
    onMount: (el, close) => {
      el.querySelector('[data-ok]').onclick = async () => {
        try {
          await api.post(`/api/initiatives/${it.id}/resume`, { comment: el.querySelector('#r-comment').value.trim() });
          toast('Инициатива возобновлена', 'ok'); close(); onDone();
        } catch (err) { toast(err.message, 'error'); }
      };
    },
  });
}

// ══ Подача инициативы ════════════════════════════════════════
export async function initiativeCreate(view) {
  view.innerHTML = html`
    <div class="crumb"><a href="/initiatives">Инициативы</a> <span>/</span> <span>Новая инициатива</span></div>
    <div class="page-head">
      <h2>Подать инициативу</h2>
      <p>Опишите проблему, с которой вы столкнулись в работе, и предложите решение. Форма проста намеренно —
         технических навыков не требуется. После отправки инициатива автоматически поступит руководителю вашего учреждения.</p>
    </div>
    <div class="grid grid--2" style="align-items:start">
      <form class="card" id="new-form">
        <div class="card__body">
          <div class="field">
            <label class="field__label" for="n-title">Краткое название <span class="req">*</span></label>
            <input class="input" id="n-title" name="title" required maxlength="180"
                   placeholder="Например: Мобильное приложение для учёта визитов">
          </div>
          <div class="field">
            <label class="field__label" for="n-problem">Какую проблему вы обнаружили? <span class="req">*</span></label>
            <textarea class="textarea" id="n-problem" name="problem" required style="min-height:130px"
              placeholder="Опишите, что именно мешает в работе, как часто это происходит и кого затрагивает. Приведите цифры, если они есть."></textarea>
            <div class="field__hint">Чем конкретнее описание с цифрами, тем быстрее эксперты оценят инициативу.</div>
          </div>
          <div class="field">
            <label class="field__label" for="n-solution">Что вы предлагаете сделать? <span class="req">*</span></label>
            <textarea class="textarea" id="n-solution" name="solution" required style="min-height:120px"
              placeholder="Опишите предлагаемое решение так, как вы его видите. Не обязательно быть техническим специалистом."></textarea>
          </div>
          <div class="field">
            <label class="field__label" for="n-effect">Какой эффект это даст? <span class="req">*</span></label>
            <textarea class="textarea" id="n-effect" name="expected_effect" required
              placeholder="Экономия времени, снижение затрат, повышение качества услуги, удовлетворённость граждан или сотрудников."></textarea>
          </div>
          <div class="row" style="gap:12px;align-items:flex-start">
            <div class="field" style="flex:1;min-width:150px">
              <label class="field__label" for="n-etype">Тип эффекта</label>
              <select class="select" id="n-etype" name="effect_type">
                <option value="time">Экономия времени</option>
                <option value="cost">Снижение затрат</option>
                <option value="quality">Качество услуги</option>
                <option value="satisfaction">Удовлетворённость</option>
                <option value="other">Иное</option>
              </select>
            </div>
            <div class="field" style="width:120px">
              <label class="field__label" for="n-evalue">Значение</label>
              <input class="input" id="n-evalue" name="effect_value" type="number" step="any" min="0" placeholder="45">
            </div>
            <div class="field" style="flex:1;min-width:140px">
              <label class="field__label" for="n-eunit">Единица измерения</label>
              <input class="input" id="n-eunit" name="effect_unit" placeholder="мин/день на сотрудника">
            </div>
          </div>
          <div class="field">
            <label class="field__label" for="n-links">Ссылки на материалы</label>
            <input class="input" id="n-links" name="links" placeholder="Ссылка на регламент, документ, пример — по одной в строке">
            <div class="field__hint">Необязательно. Можно приложить ссылку на регламент или пример из практики.</div>
          </div>
        </div>
        <div class="card__foot row">
          <a href="/initiatives" class="btn">Отмена</a>
          <button class="btn btn--primary spacer" type="submit">Подать инициативу</button>
        </div>
      </form>

      <div class="stack">
        <div class="card ai-box" id="ai-hint">
          <div class="ai-box__head">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round"><path d="M12 2v4M12 18v4M4.9 4.9l2.9 2.9M16.2 16.2l2.9 2.9M2 12h4M18 12h4M4.9 19.1l2.9-2.9M16.2 7.8l2.9-2.9"/></svg>
            ИИ-помощник
          </div>
          <p class="fs-13 text-2">Начните описывать проблему — система автоматически определит тематическое
            направление и проверит, не решает ли кто-то похожую задачу.</p>
        </div>
        <div class="card">
          <div class="card__head"><h3>Что произойдёт дальше</h3></div>
          <div class="card__body">
            <div class="timeline">
              ${[
                ['Инициатива поступит руководителю', 'Этап 1 не содержит точки принятия решения — переход автоматический.'],
                ['Решение руководителя — 3 рабочих дня', 'Gate 1: оценка соответствия регламентам и потенциала локального улучшения.'],
                ['Экспертиза ДТСЗН — 5 рабочих дней', 'Gate 2: стратегическая значимость, масштабируемость, ожидаемый эффект.'],
                ['Разработка прототипа', 'Команда цифровой трансформации создаёт MVP по Agile.'],
                ['Пилот — 1 месяц', 'Проверка в реальной работе учреждения со сбором обратной связи.'],
                ['Масштабирование', 'Успешное решение тиражируется на другие учреждения.'],
              ].map(([t, b]) => html`
                <div class="tl-item">
                  <div class="tl-item__head"><span class="tl-item__title">${esc(t)}</span></div>
                  <div class="fs-12 text-3" style="line-height:1.5">${esc(b)}</div>
                </div>`)}
            </div>
          </div>
        </div>
      </div>
    </div>`;

  const form = view.querySelector('#new-form');
  const hint = view.querySelector('#ai-hint');

  const analyse = debounce(async () => {
    const text = `${form.title.value} ${form.problem.value} ${form.solution.value}`.trim();
    if (text.length < 30) return;
    try {
      const [cls, similar] = await Promise.all([
        api.post('/api/ai/classify', { text }),
        api.post('/api/ai/similar', { text }),
      ]);
      hint.innerHTML = html`
        <div class="ai-box__head">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round"><path d="M12 2v4M12 18v4M4.9 4.9l2.9 2.9M16.2 16.2l2.9 2.9M2 12h4M18 12h4M4.9 19.1l2.9-2.9M16.2 7.8l2.9-2.9"/></svg>
          ИИ-помощник
        </div>
        <div class="fs-12 text-3" style="margin-bottom:4px">Тематическое направление</div>
        <div class="row" style="margin-bottom:9px">
          <span class="badge badge--purple">${esc(cls.category)}</span>
          <span class="fs-12 text-3">уверенность ${Math.round(cls.confidence * 100)}%</span>
        </div>
        <div class="fs-12 text-2" style="line-height:1.5">${esc(cls.rationale)}</div>
        ${similar.length ? html`
          <div class="hr" style="margin:13px 0"></div>
          <div class="fs-12 fw-600 text-2" style="margin-bottom:7px">Похожие инициативы — проверьте, нет ли дублирования</div>
          ${similar.map((s) => html`
            <a href="/initiatives/${s.id}" target="_blank" class="row fs-12" style="padding:5px 0;justify-content:space-between;gap:10px">
              <span class="clamp-2" style="max-width:72%">${esc(s.title)}</span>
              <span class="badge badge--outline">${s.similarity}%</span>
            </a>`)}` : ''}
        <div class="ai-box__note">Классификация носит рекомендательный характер и может быть уточнена экспертом.</div>`;
    } catch {}
  }, 700);

  ['title', 'problem', 'solution'].forEach((n) => form[n].addEventListener('input', analyse));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Отправка…';
    try {
      const payload = {
        title: form.title.value.trim(), problem: form.problem.value.trim(),
        solution: form.solution.value.trim(), expected_effect: form.expected_effect.value.trim(),
        effect_type: form.effect_type.value,
        effect_value: form.effect_value.value ? Number(form.effect_value.value) : null,
        effect_unit: form.effect_unit.value.trim() || null,
        links: form.links.value.split('\n').map((s) => s.trim()).filter(Boolean),
      };
      const created = await api.post('/api/initiatives', payload);
      toast(`Инициатива ${created.number} подана и направлена руководителю учреждения`, 'ok', 'Готово');
      navigate(`/initiatives/${created.id}`);
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false; btn.textContent = 'Подать инициативу';
    }
  });
}
