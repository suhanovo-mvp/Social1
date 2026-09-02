// Администрирование: конфигурация процесса, участники, журнал аудита, состояние системы.
import { api, state, esc, html, avatar, navigate, toast, modal, num, fmtDate, fmtAgo,
         ROLE_TITLES, plural } from '../core.js';

export async function adminView(view, query) {
  const tab = query.get('tab') || 'workflow';
  view.innerHTML = html`
    <div class="page-head">
      <h2>Настройки платформы</h2>
      <p>Конфигурация экосистемы: маршруты движения инициатив, SLA и критерии Gate настраиваются
         без изменения кода — это обеспечивает адаптивность процесса к меняющимся условиям.</p>
    </div>
    <div class="tabs">
      ${[['workflow', 'Процесс Stage-Gate'], ['ideahub', 'Идеи и решения'], ['users', 'Участники'],
         ['audit', 'Журнал аудита'], ['system', 'Состояние системы']]
        .map(([k, t]) => `<button class="tab ${tab === k ? 'is-active' : ''}" data-tab="${k}">${t}</button>`)}
    </div>
    <div id="admin-panel"><div class="skeleton" style="height:300px"></div></div>`;

  view.querySelectorAll('.tab').forEach((t) => t.onclick = () => navigate(`/admin?tab=${t.dataset.tab}`));
  const panel = view.querySelector('#admin-panel');
  ({ workflow: workflowPanel, ideahub: ideaHubPanel, users: usersPanel,
     audit: auditPanel, system: systemPanel }[tab] || workflowPanel)(panel);
}

// ── Модуль «Идеи и решения» ──────────────────────────────────
// Правила начисления очков, меры поощрения и режим работы модуля меняются
// администратором без изменения кода.
const INCENTIVE_CATEGORIES = {
  time: 'Время и режим работы', recognition: 'Признание',
  development: 'Развитие и карьера', material: 'Материальные меры', social: 'Социальные программы',
};

async function ideaHubPanel(panel) {
  const d = await api.get('/api/admin/ideahub');
  const s = d.settings;
  const byCategory = {};
  for (const t of d.incentive_types) (byCategory[t.category] ||= []).push(t);

  panel.innerHTML = html`
    <div class="grid grid--kpi" style="margin-bottom:16px">
      <div class="kpi"><div class="kpi__label">Идей подано</div><div class="kpi__value">${num(d.stats.ideas)}</div></div>
      <div class="kpi"><div class="kpi__label">Предложено решений</div><div class="kpi__value">${num(d.stats.proposals)}</div></div>
      <div class="kpi kpi--ok"><div class="kpi__label">Начислено очков</div><div class="kpi__value">${num(d.stats.points)}</div>
        <div class="kpi__meta">Отменено начислений: ${num(d.stats.revoked)}</div></div>
      <div class="kpi"><div class="kpi__label">Рекомендаций к поощрению</div><div class="kpi__value">${num(d.stats.incentives)}</div></div>
      <div class="kpi ${d.stats.flags ? 'kpi--warn' : ''}"><div class="kpi__label">Оценок в ревью</div>
        <div class="kpi__value">${num(d.stats.reviews)}</div>
        <div class="kpi__meta">${d.stats.flags ? `Открытых сигналов антифрода: ${d.stats.flags}` : 'Сигналов антифрода нет'}</div></div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card__head"><h3>Режим работы модуля</h3>
        <span class="card__hint spacer">Изменения применяются немедленно и фиксируются в аудите</span></div>
      <div class="card__body">
        <label class="checkbox" style="margin-bottom:10px">
          <input type="checkbox" id="s-moderation" ${s.moderation_required === '1' ? 'checked' : ''}>
          <span><b>Обязательная модерация новых идей</b><br>
            <span class="fs-12 text-3">Идея публикуется со статусом «Новая» и открывается для решений
              после проверки модератором. При выключенной настройке идея сразу доступна для предложений.</span></span>
        </label>
        <label class="checkbox" style="margin-bottom:14px">
          <input type="checkbox" id="s-rating" ${s.rating_visible === '1' ? 'checked' : ''}>
          <span><b>Рейтинг советчиков виден всем участникам</b><br>
            <span class="fs-12 text-3">При выключении рейтинг остаётся доступен только модераторам,
              руководителям и администраторам — этого требуют политики некоторых организаций.</span></span>
        </label>
        <div class="grid grid--2">
          <div class="field">
            <label class="field__label" for="s-threshold">Порог очков для рекомендации к поощрению</label>
            <input class="input" id="s-threshold" type="number" min="0" step="1" value="${esc(s.incentive_threshold)}">
          </div>
          <div class="field">
            <label class="field__label" for="s-top">Сколько человек попадает в рекомендации</label>
            <input class="input" id="s-top" type="number" min="1" max="50" step="1" value="${esc(s.incentive_top)}">
          </div>
        </div>
      </div>
      <div class="card__foot row">
        <button class="btn btn--sm" id="refresh-badges">Пересчитать знаки отличия</button>
        <button class="btn btn--sm btn--primary spacer" id="save-settings">Сохранить настройки</button>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card__head">
        <div><h3>Быстрое ревью предложений</h3>
          <div class="card__hint">Оценки в ревью не начисляют очки автору — они влияют только на
            полезность предложения и порядок в очереди модератора. Пределы ниже защищают
            от механического пролистывания.</div></div>
      </div>
      <div class="card__body">
        <label class="checkbox" style="margin-bottom:14px">
          <input type="checkbox" id="s-undo" ${s.review_undo === '1' ? 'checked' : ''}>
          <span><b>Разрешать возврат к предыдущей карточке</b><br>
            <span class="fs-12 text-3">Отменить можно только последнюю оценку и только в течение
              десяти минут — это исправление промаха, а не пересмотр решения.</span></span>
        </label>
        <div class="grid grid--2">
          <div class="field">
            <label class="field__label" for="s-top-threshold">Лайков для попадания в «Топ предложений»</label>
            <input class="input" id="s-top-threshold" type="number" min="1" step="1" value="${esc(s.review_top_threshold)}">
          </div>
          <div class="field">
            <label class="field__label" for="s-min-ms">Минимальное время на карточке, мс</label>
            <input class="input" id="s-min-ms" type="number" min="0" step="100" value="${esc(s.review_min_ms)}">
            <div class="field__hint">Быстрее — оценка считается непрочитанной.</div>
          </div>
          <div class="field">
            <label class="field__label" for="s-burst">Быстрых оценок подряд до сигнала модератору</label>
            <input class="input" id="s-burst" type="number" min="2" step="1" value="${esc(s.review_burst_limit)}">
          </div>
          <div class="field">
            <label class="field__label" for="s-per-min">Предел оценок в минуту</label>
            <input class="input" id="s-per-min" type="number" min="1" step="1" value="${esc(s.review_per_minute)}">
          </div>
          <div class="field">
            <label class="field__label" for="s-per-hour">Предел оценок в час</label>
            <input class="input" id="s-per-hour" type="number" min="1" step="1" value="${esc(s.review_per_hour)}">
          </div>
        </div>
      </div>
      <div class="card__foot row">
        <a class="btn btn--sm spacer" href="/moderation?tab=reports">Открытые сигналы антифрода</a>
        <button class="btn btn--sm btn--primary" id="save-review">Сохранить</button>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card__head"><h3>Правила начисления очков</h3>
        <span class="card__hint spacer">Значения меняются без изменения кода</span></div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Действие</th><th class="num" style="width:100px">Очки</th>
          <th class="num" style="width:130px">Предел по объекту</th><th style="width:110px">Состояние</th><th style="width:110px"></th></tr></thead>
        <tbody>${d.rules.map((r) => html`
          <tr>
            <td><div class="fw-600 fs-13">${esc(r.title)}</div>
              ${r.description ? `<div class="fs-12 text-3">${esc(r.description)}</div>` : ''}
              <div class="fs-12 text-3 mono">${esc(r.code)}</div></td>
            <td class="num fw-600">${r.points}</td>
            <td class="num fs-13">${r.cap_per_target ?? '—'}</td>
            <td><span class="badge badge--${r.is_active ? 'ok' : 'danger'}">${r.is_active ? 'Действует' : 'Отключено'}</span></td>
            <td><button class="btn btn--sm" data-rule="${esc(r.code)}">Изменить</button></td>
          </tr>`)}
        </tbody>
      </table></div>
    </div>

    <div class="card">
      <div class="card__head"><h3>Меры поощрения</h3>
        <span class="card__hint spacer">Применяются только в рамках трудового законодательства
          и внутренних регламентов</span></div>
      <div class="card__body">
        ${Object.entries(byCategory).map(([cat, list]) => html`
          <div style="margin-bottom:18px">
            <div class="fs-12 fw-600 text-3" style="text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">
              ${esc(INCENTIVE_CATEGORIES[cat] || cat)}</div>
            <div class="list" style="border:1px solid var(--border);border-radius:var(--radius-sm)">
              ${list.map((t) => html`
                <div class="list__item">
                  <div class="list__main">
                    <div class="list__title">${esc(t.title)}</div>
                    ${t.legal_note ? `<div class="list__body">${esc(t.legal_note)}</div>` : ''}
                  </div>
                  <label class="checkbox" style="flex-shrink:0">
                    <input type="checkbox" data-type="${esc(t.code)}" ${t.is_active ? 'checked' : ''}>
                    <span class="fs-12">${t.is_active ? 'Доступна' : 'Отключена'}</span>
                  </label>
                </div>`)}
            </div>
          </div>`)}
      </div>
    </div>`;

  panel.querySelector('#save-settings').onclick = async () => {
    try {
      await api.patch('/api/admin/ideahub/settings', {
        moderation_required: panel.querySelector('#s-moderation').checked,
        rating_visible: panel.querySelector('#s-rating').checked,
        incentive_threshold: panel.querySelector('#s-threshold').value,
        incentive_top: panel.querySelector('#s-top').value,
      });
      toast('Настройки модуля сохранены', 'ok');
      ideaHubPanel(panel);
    } catch (err) { toast(err.message, 'error'); }
  };

  panel.querySelector('#save-review').onclick = async () => {
    try {
      await api.patch('/api/admin/ideahub/settings', {
        review_undo: panel.querySelector('#s-undo').checked,
        review_top_threshold: panel.querySelector('#s-top-threshold').value,
        review_min_ms: panel.querySelector('#s-min-ms').value,
        review_burst_limit: panel.querySelector('#s-burst').value,
        review_per_minute: panel.querySelector('#s-per-min').value,
        review_per_hour: panel.querySelector('#s-per-hour').value,
      });
      toast('Настройки ревью сохранены', 'ok');
      ideaHubPanel(panel);
    } catch (err) { toast(err.message, 'error'); }
  };

  panel.querySelector('#refresh-badges').onclick = async () => {
    try {
      const r = await api.post('/api/admin/ideahub/refresh-badges', {});
      toast(`Проверено участников: ${r.checked}, присвоено знаков: ${r.granted}`, 'ok');
    } catch (err) { toast(err.message, 'error'); }
  };

  panel.querySelectorAll('[data-type]').forEach((cb) => cb.onchange = async () => {
    try {
      await api.patch(`/api/admin/ideahub/incentive-types/${cb.dataset.type}`, { is_active: cb.checked });
      cb.nextElementSibling.textContent = cb.checked ? 'Доступна' : 'Отключена';
    } catch (err) { toast(err.message, 'error'); cb.checked = !cb.checked; }
  });

  panel.querySelectorAll('[data-rule]').forEach((b) => b.onclick = () =>
    editRuleModal(d.rules.find((r) => r.code === b.dataset.rule), () => ideaHubPanel(panel)));
}

function editRuleModal(rule, onDone) {
  modal({
    title: `Правило: ${rule.title}`,
    body: html`
      <div class="row" style="gap:12px;align-items:flex-start">
        <div class="field" style="width:130px">
          <label class="field__label" for="r-points">Очки</label>
          <input class="input" id="r-points" type="number" min="0" max="1000" step="1" value="${rule.points}">
        </div>
        <div class="field" style="flex:1">
          <label class="field__label" for="r-cap">Предел очков по одному объекту</label>
          <input class="input" id="r-cap" type="number" min="0" step="1" value="${rule.cap_per_target ?? ''}"
                 placeholder="без ограничения">
        </div>
      </div>
      <div class="field">
        <label class="field__label" for="r-title">Формулировка для участников</label>
        <input class="input" id="r-title" value="${esc(rule.title)}">
      </div>
      <div class="field">
        <label class="field__label" for="r-desc">Пояснение</label>
        <textarea class="textarea" id="r-desc" style="min-height:70px">${esc(rule.description || '')}</textarea>
      </div>
      <label class="checkbox"><input type="checkbox" id="r-active" ${rule.is_active ? 'checked' : ''}>
        <span>Правило действует</span></label>
      <div class="field__hint" style="margin-top:12px">Новые значения применяются к начислениям,
        которые произойдут после сохранения. Уже начисленные очки не пересчитываются.</div>`,
    footer: '<button class="btn" data-close>Отмена</button><button class="btn btn--primary" data-ok>Сохранить</button>',
    onMount: (el, close) => {
      el.querySelector('[data-ok]').onclick = async () => {
        try {
          await api.patch(`/api/admin/ideahub/rules/${rule.code}`, {
            points: Number(el.querySelector('#r-points').value),
            cap_per_target: el.querySelector('#r-cap').value === '' ? null : Number(el.querySelector('#r-cap').value),
            title: el.querySelector('#r-title').value.trim(),
            description: el.querySelector('#r-desc').value.trim(),
            is_active: el.querySelector('#r-active').checked,
          });
          toast('Правило обновлено', 'ok'); close(); onDone();
        } catch (err) { toast(err.message, 'error'); }
      };
    },
  });
}

// ── Конфигурация процесса ────────────────────────────────────
async function workflowPanel(panel) {
  const { stages } = await api.get('/api/admin/workflow');
  panel.innerHTML = html`
    <div class="stack">
      ${stages.map((s) => html`
        <div class="card">
          <div class="card__head">
            <div>
              <h3>Этап ${s.tz_stage}. ${esc(s.stage_name)}</h3>
              <div class="card__hint">${s.gate_no ? `Gate ${s.gate_no} — ${esc(s.gate_name || '')}` : 'Без точки принятия решения'}</div>
            </div>
            ${s.gate_no ? `<button class="btn btn--sm spacer" data-edit="${s.stage_no}">Изменить</button>` : ''}
          </div>
          <div class="card__body">
            <dl class="def">
              <dt>Ответственная роль</dt><dd>${esc(ROLE_TITLES[s.role_required] || '—')}</dd>
              <dt>SLA</dt><dd>${s.sla_value ? `${num(s.sla_value)} ${s.sla_unit === 'workdays' ? 'рабочих дней' : 'календарных дней'}` : '—'}</dd>
              <dt>Формулировка SLA</dt><dd class="fs-13">${esc(s.sla_text || '—')}</dd>
              <dt>Решения</dt><dd>${s.decisions.map((d) => `<span class="badge badge--outline">${esc(d)}</span>`).join(' ') || '—'}</dd>
              <dt>Критерии</dt><dd class="fs-13">${s.criteria.length
                ? '<ul style="margin:0;padding-left:16px;line-height:1.7">' + s.criteria.map((c) => `<li>${esc(c)}</li>`).join('') + '</ul>' : '—'}</dd>
              <dt>Обновлено</dt><dd class="fs-12 text-3">${fmtDate(s.updated_at, true)}</dd>
            </dl>
          </div>
        </div>`)}
    </div>`;

  panel.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => {
    const s = stages.find((x) => x.stage_no === Number(b.dataset.edit));
    editStageModal(s, () => workflowPanel(panel));
  });
}

function editStageModal(s, onDone) {
  modal({
    title: `Настройка: ${s.stage_name}`, wide: true,
    body: html`
      <div class="field"><label class="field__label" for="w-gate">Название точки принятия решения</label>
        <input class="input" id="w-gate" value="${esc(s.gate_name || '')}"></div>
      <div class="row" style="gap:12px;align-items:flex-start">
        <div class="field" style="flex:1"><label class="field__label" for="w-role">Ответственная роль</label>
          <select class="select" id="w-role">
            ${Object.entries(ROLE_TITLES).map(([k, v]) => `<option value="${k}" ${s.role_required === k ? 'selected' : ''}>${esc(v)}</option>`)}
          </select></div>
        <div class="field" style="width:120px"><label class="field__label" for="w-sla">Срок SLA</label>
          <input class="input" id="w-sla" type="number" min="0" step="any" value="${s.sla_value ?? ''}"></div>
        <div class="field" style="flex:1"><label class="field__label" for="w-unit">Единица</label>
          <select class="select" id="w-unit">
            <option value="workdays" ${s.sla_unit === 'workdays' ? 'selected' : ''}>Рабочие дни</option>
            <option value="calendardays" ${s.sla_unit === 'calendardays' ? 'selected' : ''}>Календарные дни</option>
          </select></div>
      </div>
      <div class="field"><label class="field__label" for="w-slatext">Формулировка SLA для участников</label>
        <textarea class="textarea" id="w-slatext" style="min-height:64px">${esc(s.sla_text || '')}</textarea></div>
      <div class="field"><label class="field__label" for="w-criteria">Критерии Gate — по одному в строке</label>
        <textarea class="textarea" id="w-criteria" style="min-height:110px">${esc(s.criteria.join('\n'))}</textarea></div>
      <div class="field"><label class="field__label">Допустимые решения</label>
        <div class="chip-row" id="w-decisions">
          ${['go', 'kill', 'hold', 'redirect'].map((d) => `<button type="button" class="chip ${s.decisions.includes(d) ? 'is-on' : ''}" data-d="${d}">${
            { go: 'Go', kill: 'Kill', hold: 'Hold', redirect: 'Redirect' }[d]}</button>`)}
        </div>
        <div class="field__hint">Изменения вступают в силу немедленно и применяются к инициативам,
          которые придут на этот этап далее. Действие фиксируется в журнале аудита.</div>
      </div>`,
    footer: '<button class="btn" data-close>Отмена</button><button class="btn btn--primary" data-ok>Сохранить</button>',
    onMount: (el, close) => {
      el.querySelectorAll('#w-decisions .chip').forEach((c) => c.onclick = () => c.classList.toggle('is-on'));
      el.querySelector('[data-ok]').onclick = async () => {
        const decisions = [...el.querySelectorAll('#w-decisions .chip.is-on')].map((c) => c.dataset.d);
        if (!decisions.length) { toast('Выберите хотя бы одно допустимое решение', 'error'); return; }
        try {
          await api.patch(`/api/admin/workflow/${s.stage_no}`, {
            gate_name: el.querySelector('#w-gate').value.trim(),
            role_required: el.querySelector('#w-role').value,
            sla_value: el.querySelector('#w-sla').value ? Number(el.querySelector('#w-sla').value) : null,
            sla_unit: el.querySelector('#w-unit').value,
            sla_text: el.querySelector('#w-slatext').value.trim(),
            criteria: el.querySelector('#w-criteria').value.split('\n').map((x) => x.trim()).filter(Boolean),
            decisions,
          });
          toast('Конфигурация этапа обновлена', 'ok');
          const { stages } = await api.get('/api/workflow/stages').then((s) => ({ stages: s }));
          state.stages = stages;
          close(); onDone();
        } catch (err) { toast(err.message, 'error'); }
      };
    },
  });
}

// ── Участники ────────────────────────────────────────────────
async function usersPanel(panel) {
  const [users, institutions] = await Promise.all([
    api.get('/api/admin/users'), api.get('/api/institutions'),
  ]);
  const byRole = {};
  for (const u of users) (byRole[u.role] ||= []).push(u);

  panel.innerHTML = html`
    <div class="row" style="margin-bottom:14px">
      <div class="fs-13 text-2">${users.length} ${plural(users.length, 'участник', 'участника', 'участников')}
        в ${institutions.length} ${plural(institutions.length, 'организации', 'организациях', 'организациях')}</div>
      <button class="btn btn--sm btn--primary spacer" data-add-user>Добавить участника</button>
    </div>
    <div class="stack">
      ${Object.entries(ROLE_TITLES).filter(([r]) => byRole[r]).map(([role, title]) => html`
        <div class="card">
          <div class="card__head"><h3>${esc(title)}</h3>
            <span class="badge badge--outline spacer">${byRole[role].length}</span></div>
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Участник</th><th>Должность</th><th>Организация</th><th>Последний вход</th><th></th></tr></thead>
            <tbody>${byRole[role].map((u) => html`
              <tr>
                <td><div class="row" style="gap:9px">${avatar(u.full_name, 'avatar--sm')}
                  <div><div class="fw-600 fs-13">${esc(u.full_name)}</div>
                    <div class="fs-12 text-3">${esc(u.email)}</div></div></div></td>
                <td class="fs-13">${esc(u.position || '—')}</td>
                <td class="fs-13">${esc(u.institution || '—')}</td>
                <td class="fs-12 text-3">${u.last_login_at ? fmtAgo(u.last_login_at) : 'не входил'}</td>
                <td><span class="badge badge--${u.is_active ? 'ok' : 'danger'}">${u.is_active ? 'Активен' : 'Отключён'}</span></td>
              </tr>`)}
            </tbody>
          </table></div>
        </div>`)}
    </div>`;

  panel.querySelector('[data-add-user]').onclick = () => modal({
    title: 'Новый участник',
    body: html`
      <div class="field"><label class="field__label" for="u-name">ФИО <span class="req">*</span></label>
        <input class="input" id="u-name"></div>
      <div class="field"><label class="field__label" for="u-email">Электронная почта <span class="req">*</span></label>
        <input class="input" id="u-email" type="email"></div>
      <div class="row" style="gap:12px">
        <div class="field" style="flex:1"><label class="field__label" for="u-role">Роль <span class="req">*</span></label>
          <select class="select" id="u-role">
            ${Object.entries(ROLE_TITLES).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`)}
          </select></div>
        <div class="field" style="flex:1"><label class="field__label" for="u-inst">Организация</label>
          <select class="select" id="u-inst">
            ${institutions.map((i) => `<option value="${i.id}">${esc(i.short_name)}</option>`)}
          </select></div>
      </div>
      <div class="field"><label class="field__label" for="u-pos">Должность</label>
        <input class="input" id="u-pos"></div>
      <div class="field__hint">Начальный пароль — <b>social1</b>. Участник сможет войти сразу после создания.</div>`,
    footer: '<button class="btn" data-close>Отмена</button><button class="btn btn--primary" data-ok>Создать</button>',
    onMount: (el, close) => {
      el.querySelector('[data-ok]').onclick = async () => {
        try {
          await api.post('/api/admin/users', {
            full_name: el.querySelector('#u-name').value.trim(),
            email: el.querySelector('#u-email').value.trim(),
            role: el.querySelector('#u-role').value,
            institution_id: Number(el.querySelector('#u-inst').value),
            position: el.querySelector('#u-pos').value.trim(),
          });
          toast('Участник добавлен', 'ok'); close(); usersPanel(panel);
        } catch (err) { toast(err.message, 'error'); }
      };
    },
  });
}

// ── Журнал аудита ────────────────────────────────────────────
async function auditPanel(panel) {
  const [log, chain] = await Promise.all([
    api.get('/api/admin/audit?limit=150'),
    api.get('/api/admin/audit/verify'),
  ]);
  const ACTIONS = {
    'auth.login': 'Вход в систему', 'auth.logout': 'Выход', 'auth.failed': 'Неудачная попытка входа',
    'initiative.create': 'Создание инициативы', 'initiative.update': 'Изменение инициативы',
    'initiative.comment': 'Комментарий', 'initiative.resume': 'Возобновление инициативы',
    'gate.go': 'Решение Go', 'gate.kill': 'Решение Kill', 'gate.hold': 'Решение Hold', 'gate.redirect': 'Решение Redirect',
    'workflow.configure': 'Изменение конфигурации процесса', 'user.create': 'Создание участника',
    'user.update': 'Изменение участника', 'pilot.approve': 'Одобрение пилотной площадки',
    'pilot.apply': 'Заявка на пилотирование', 'sla.escalated': 'Эскалация по SLA', 'sla.sweep': 'Проверка SLA',
    'bestpractice.publish': 'Публикация лучшей практики', 'rollout.create': 'Регистрация внедрения',
    'system.seed': 'Загрузка демонстрационных данных', 'survey.create': 'Создание опроса', 'survey.respond': 'Ответ на опрос',
  };

  panel.innerHTML = html`
    <div class="card" style="margin-bottom:16px;border-left:3px solid var(--${chain.valid ? 'ok' : 'danger'})">
      <div class="card__body row">
        <div>
          <div class="fs-13 fw-600" style="color:var(--${chain.valid ? 'ok' : 'danger'})">
            ${chain.valid ? 'Целостность журнала подтверждена' : `Нарушена целостность: запись №${chain.brokenAt}`}
          </div>
          <div class="fs-12 text-3" style="margin-top:3px">
            Проверено записей: ${num(chain.checked)}. Каждая запись связана криптографическим хэшем
            с предыдущей — изменение или удаление записи задним числом ломает цепочку.
          </div>
        </div>
        ${chain.head ? `<div class="spacer mono fs-12 text-3 truncate" style="max-width:190px" title="${esc(chain.head)}">
          ${esc(chain.head.slice(0, 16))}…</div>` : ''}
      </div>
    </div>

    <div class="card">
      <div class="card__head"><h3>Журнал действий</h3>
        <span class="card__hint spacer">Последние ${log.entries.length} из ${num(log.total)}</span></div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th style="width:60px">№</th><th style="width:150px">Время</th><th>Участник</th>
          <th>Действие</th><th>Объект</th><th style="width:110px">Хэш</th></tr></thead>
        <tbody>${log.entries.map((e) => html`
          <tr>
            <td class="mono text-3">${e.id}</td>
            <td class="fs-12 nowrap">${fmtDate(e.at, true)}</td>
            <td class="fs-13">${e.user_name ? esc(e.user_name) : '<span class="text-3">система</span>'}</td>
            <td class="fs-13">${esc(ACTIONS[e.action] || e.action)}</td>
            <td class="fs-12 text-3">${e.entity ? `${esc(e.entity)} #${e.entity_id ?? '—'}` : '—'}</td>
            <td class="mono fs-12 text-3" title="${esc(e.hash)}">${esc(e.hash.slice(0, 10))}…</td>
          </tr>`)}
        </tbody>
      </table></div>
    </div>`;
}

// ── Состояние системы ────────────────────────────────────────
async function systemPanel(panel) {
  const s = await api.get('/api/admin/system');
  const LABELS = {
    initiatives: 'Инициативы', users: 'Участники', institutions: 'Организации',
    gate_decisions: 'Решения на Gate', pilots: 'Пилоты', surveys: 'Опросы',
    survey_responses: 'Ответы на опросы', projects: 'Проекты разработки', board_items: 'Задачи досок',
    forum_topics: 'Темы форума', rollouts: 'Внедрения', audit_log: 'Записи аудита',
  };
  panel.innerHTML = html`
    <div class="grid grid--kpi" style="margin-bottom:16px">
      ${Object.entries(s.counts).map(([k, v]) => html`
        <div class="kpi"><div class="kpi__label">${esc(LABELS[k] || k)}</div>
          <div class="kpi__value">${num(v)}</div></div>`)}
    </div>
    <div class="card">
      <div class="card__head"><h3>Среда исполнения</h3></div>
      <div class="card__body">
        <dl class="def">
          <dt>Версия Node.js</dt><dd class="mono">${esc(s.node)}</dd>
          <dt>Время работы</dt><dd>${num(Math.floor(s.uptime_seconds / 60))} мин</dd>
          <dt>Память</dt><dd>${num(s.memory_mb)} МБ</dd>
          <dt>Журнал аудита</dt><dd>${s.audit.valid ? 'целостность подтверждена' : 'нарушена'}</dd>
        </dl>
      </div>
    </div>`;
}
