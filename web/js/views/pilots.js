// Модуль пилотирования: площадки, ход пилота, KPI, опросы и NLP-анализ обратной связи.
import { api, state, esc, html, avatar, can, navigate, toast, modal, num, fmtDate, fmtShort,
         nl2br, PILOT_STATUS, plural, barList } from '../core.js';

export async function pilotsList(view) {
  const [pilots, applications] = await Promise.all([
    api.get('/api/pilots'),
    api.get('/api/pilot-applications').catch(() => []),
  ]);
  const pending = applications.filter((a) => a.status === 'pending');

  view.innerHTML = html`
    <div class="page-head">
      <div class="page-head__row">
        <div style="flex:1;min-width:250px">
          <h2>Пилотирование</h2>
          <p>Пилотное учреждение внедряет прототип в реальную работу на один месяц. Собирается обратная
             связь от сотрудников и граждан, отслеживаются KPI, определённые на этапе оценки инициативы.</p>
        </div>
        ${can('pilot.apply') ? '<button class="btn btn--primary" data-apply data-ac="US-PIL-001/AC1">Заявить площадку</button>' : ''}
      </div>
    </div>

    ${pending.length && can('pilot.manage') ? html`
    <div class="card" style="margin-bottom:16px;border-left:3px solid var(--warn)" data-ac="US-PIL-001/AC3">
      <div class="card__head"><h3>Заявки на роль пилотной площадки</h3>
        <span class="badge badge--warn spacer">${pending.length}</span></div>
      <div class="card__body--flush"><div class="list">
        ${pending.map((a) => html`
          <div class="list__item">
            <div class="list__main">
              <div class="list__title">${esc(a.institution_name)}</div>
              <div class="list__body">${esc(a.message || '')}</div>
              <div class="list__meta">
                <span class="mono">${esc(a.number)}</span><span>${esc(a.initiative_title)}</span>
                <span>${esc(a.applicant_name)}</span><span>${fmtDate(a.created_at)}</span>
              </div>
            </div>
            <button class="btn btn--sm btn--primary" data-approve="${a.id}">Одобрить</button>
          </div>`)}
      </div></div>
    </div>` : ''}

    ${pilots.length ? html`
    <div class="grid grid--3">
      ${pilots.map((p) => html`
        <div class="card" data-goto="/pilots/${p.id}" style="cursor:pointer">
          <div class="card__body">
            <div class="row fs-12 text-3" style="margin-bottom:9px">
              <span class="mono">${esc(p.number)}</span>
              <span class="spacer badge badge--${p.status === 'finished' ? 'ok' : p.status === 'running' ? 'info' : 'warn'}">
                ${PILOT_STATUS[p.status]}</span>
            </div>
            <div class="fw-600" style="font-size:14px;line-height:1.4;margin-bottom:11px">${esc(p.initiative_title)}</div>
            <dl class="def" style="font-size:12.5px">
              <dt>Площадка</dt><dd>${esc(p.institution_short)}</dd>
              <dt>Период</dt><dd>${fmtShort(p.starts_at)} — ${fmtShort(p.ends_at)}</dd>
              <dt>Участников</dt><dd>${p.participants_count}</dd>
              <dt>Откликов</dt><dd>${p.responses_count} в ${p.surveys_count} ${plural(p.surveys_count, 'опросе', 'опросах', 'опросах')}</dd>
            </dl>
          </div>
        </div>`)}
    </div>` : '<div class="card"><div class="empty"><h4>Пилотов нет</h4><p>Пилот начинается после того, как прототип получает решение Go на Gate 3.</p></div></div>'}`;

  view.querySelectorAll('[data-goto]').forEach((el) => el.onclick = () => navigate(el.dataset.goto));
  view.querySelectorAll('[data-approve]').forEach((b) => b.onclick = async (e) => {
    e.stopPropagation();
    try {
      await api.post(`/api/pilot-applications/${b.dataset.approve}/approve`, {});
      toast('Заявка одобрена, пилот запланирован', 'ok');
      pilotsList(view);
    } catch (err) { toast(err.message, 'error'); }
  });
  view.querySelector('[data-apply]')?.addEventListener('click', () => applyModal(() => pilotsList(view)));
}

async function applyModal(onDone) {
  const list = await api.get('/api/initiatives?stage=4&limit=50');
  const candidates = list.items;
  modal({
    title: 'Заявить учреждение пилотной площадкой',
    body: candidates.length ? html`
      <div class="field">
        <label class="field__label" for="p-init">Инициатива</label>
        <select class="select" id="p-init">
          ${candidates.map((i) => `<option value="${i.id}">${esc(i.number)} — ${esc(i.title)}</option>`)}
        </select>
        <div class="field__hint">Доступны инициативы, находящиеся на этапе разработки прототипа.</div>
      </div>
      <div class="field">
        <label class="field__label" for="p-msg">Обоснование</label>
        <textarea class="textarea" id="p-msg" placeholder="Почему ваше учреждение подходит: профиль, готовность сотрудников, наличие ресурсов…"></textarea>
      </div>` : '<div class="empty"><p>Сейчас нет инициатив на этапе разработки, для которых нужна пилотная площадка.</p></div>',
    footer: candidates.length ? '<button class="btn" data-close>Отмена</button><button class="btn btn--primary" data-ok>Подать заявку</button>' : '',
    onMount: (el, close) => {
      el.querySelector('[data-ok]')?.addEventListener('click', async () => {
        try {
          await api.post('/api/pilot-applications', {
            initiative_id: Number(el.querySelector('#p-init').value),
            message: el.querySelector('#p-msg').value.trim(),
          });
          toast('Заявка подана и направлена координатору', 'ok'); close(); onDone();
        } catch (err) { toast(err.message, 'error'); }
      });
    },
  });
}

export async function pilotDetail(view, id) {
  view.innerHTML = '<div class="card"><div class="card__body"><div class="skeleton" style="height:300px"></div></div></div>';
  const p = await api.get(`/api/pilots/${id}`);
  const fa = p.feedback_analysis;
  const manage = can('pilot.manage') || can('survey.manage');

  view.innerHTML = html`
    <div class="crumb"><a href="/pilots">Пилотирование</a> <span>/</span> <span class="mono">${esc(p.number)}</span></div>
    <div class="page-head">
      <div class="page-head__row">
        <div style="flex:1;min-width:250px">
          <h2>${esc(p.initiative_title)}</h2>
          <div class="row" style="margin-top:8px">
            <span class="badge badge--${p.status === 'finished' ? 'ok' : p.status === 'running' ? 'info' : 'warn'}">${PILOT_STATUS[p.status]}</span>
            <span class="fs-13 text-2">${esc(p.institution_name)}</span>
            <span class="fs-13 text-3">${fmtDate(p.starts_at)} — ${fmtDate(p.ends_at)}</span>
          </div>
        </div>
        <a href="/initiatives/${p.initiative_id}" class="btn">Карточка инициативы</a>
      </div>
    </div>

    <div class="grid grid--2" style="align-items:start">
      <div class="stack">
        <div class="card" data-ac="US-PIL-002/AC1 US-PIL-002/AC2">
          <div class="card__head"><h3>Мониторинг KPI пилота</h3>
            ${manage ? '<button class="btn btn--sm spacer" data-add-kpi>Добавить показатель</button>' : ''}</div>
          <div class="card__body">
            ${p.kpis.length ? p.kpis.map((k) => {
              const improved = k.direction === 'up' ? (k.actual ?? 0) >= (k.target ?? 0) : (k.actual ?? 0) <= (k.target ?? 0);
              const span = Math.abs((k.target ?? 0) - (k.baseline ?? 0)) || 1;
              const progress = Math.min(100, Math.max(0, (Math.abs((k.actual ?? k.baseline ?? 0) - (k.baseline ?? 0)) / span) * 100));
              return html`
              <div style="margin-bottom:16px">
                <div class="row fs-13" style="justify-content:space-between;margin-bottom:6px">
                  <b>${esc(k.name)}</b>
                  <span class="badge badge--${k.actual === null ? '' : improved ? 'ok' : 'warn'}">
                    ${k.actual === null ? 'нет данных' : `${num(k.actual, 1)} ${esc(k.unit || '')}`}</span>
                </div>
                <div class="progress ${improved ? 'progress--ok' : 'progress--warn'}"><i style="width:${progress}%"></i></div>
                <div class="row fs-12 text-3" style="justify-content:space-between;margin-top:5px">
                  <span>База: ${num(k.baseline, 1)} ${esc(k.unit || '')}</span>
                  <span>Цель: ${num(k.target, 1)} ${esc(k.unit || '')}</span>
                </div>
              </div>`;
            }).join('') : '<div class="empty" style="padding:26px"><p>Показатели пилота не заданы</p></div>'}
          </div>
        </div>

        <div class="card">
          <div class="card__head"><h3>План пилотирования</h3></div>
          <div class="card__body prose">${nl2br(p.plan || 'План не задан')}</div>
          <div class="card__foot">
            <dl class="def" style="font-size:12.5px">
              <dt>Координатор</dt><dd>${esc(p.coordinator_name || '—')}</dd>
              <dt>Участников</dt><dd>${p.participants_count}</dd>
              <dt>Ожидаемый эффект</dt><dd>${esc(p.expected_effect || '—')}</dd>
            </dl>
          </div>
        </div>
      </div>

      <div class="stack">
        <div class="card" data-ac="US-PIL-003/AC4">
          <div class="card__head"><h3>Анализ обратной связи</h3>
            <span class="card__hint spacer">NLP-обработка свободных ответов</span></div>
          <div class="card__body">
            ${fa.count ? html`
              <div class="row" style="gap:24px;margin-bottom:14px;flex-wrap:wrap">
                <div>
                  <div class="fs-12 text-3">Тональность</div>
                  <div style="font-size:24px;font-weight:700;letter-spacing:-.03em;
                       color:${fa.sentiment > .2 ? 'var(--ok)' : fa.sentiment < -.2 ? 'var(--danger)' : 'var(--warn)'}">
                    ${fa.sentiment > 0 ? '+' : ''}${fa.sentiment.toFixed(2)}</div>
                </div>
                <div class="spacer" style="flex:1;min-width:170px">
                  ${barList([
                    { label: 'Положительные', value: fa.positive, color: 'var(--ok)' },
                    { label: 'Нейтральные', value: fa.neutral, color: 'var(--neutral)' },
                    { label: 'Отрицательные', value: fa.negative, color: 'var(--danger)' },
                  ], { max: fa.count })}
                </div>
              </div>
              ${fa.themes.length ? html`
                <div class="fs-12 fw-600 text-2" style="margin-bottom:7px">Ключевые темы откликов</div>
                <div class="chip-row" style="margin-bottom:13px">
                  ${fa.themes.map((t) => `<span class="chip" style="cursor:default">${esc(t.word)} · ${t.count}</span>`)}
                </div>` : ''}
              ${fa.signals.length ? html`
                <div class="fs-12 fw-600 text-2" style="margin-bottom:7px">Проблемные сигналы</div>
                ${fa.signals.map((s) => `<div class="tl-item__body" style="margin-bottom:6px">${esc(s)}</div>`)}` : ''}
              <div class="ai-box__note">${esc(fa.rationale || '')}</div>`
            : '<div class="empty" style="padding:26px"><p>Обратная связь пока не собрана</p></div>'}
          </div>
        </div>

        <div class="card" data-ac="US-PIL-003/AC1">
          <div class="card__head"><h3>Опросы участников</h3>
            ${manage ? '<button class="btn btn--sm spacer" data-add-survey>Создать опрос</button>' : ''}</div>
          <div class="card__body--flush">
            ${p.surveys.length ? html`<div class="list">
              ${p.surveys.map((s) => html`
                <div class="list__item is-clickable" data-goto="/surveys/${s.id}">
                  <div class="list__main">
                    <div class="list__title">${esc(s.title)}</div>
                    <div class="list__meta">
                      <span class="badge badge--outline">${s.audience === 'citizen' ? 'Граждане' : 'Сотрудники'}</span>
                      <span>${s.responses} ${plural(s.responses, 'ответ', 'ответа', 'ответов')}</span>
                      <span class="badge badge--${s.is_open ? 'info' : ''}">${s.is_open ? 'Открыт' : 'Закрыт'}</span>
                    </div>
                  </div>
                </div>`)}
            </div>` : '<div class="empty" style="padding:26px"><p>Опросы не созданы</p></div>'}
          </div>
        </div>
      </div>
    </div>`;

  view.querySelectorAll('[data-goto]').forEach((el) => el.onclick = () => navigate(el.dataset.goto));
  view.querySelector('[data-add-kpi]')?.addEventListener('click', () => kpiModal(p.id, () => pilotDetail(view, id)));
  view.querySelector('[data-add-survey]')?.addEventListener('click', () => surveyModal(p, () => pilotDetail(view, id)));
}

function kpiModal(pilotId, onDone) {
  modal({
    title: 'Показатель эффективности пилота',
    body: html`
      <div class="field"><label class="field__label" for="k-name">Название <span class="req">*</span></label>
        <input class="input" id="k-name" placeholder="Например: Время оформления визита"></div>
      <div class="row" style="gap:12px">
        <div class="field" style="flex:1"><label class="field__label" for="k-unit">Единица</label>
          <input class="input" id="k-unit" placeholder="мин"></div>
        <div class="field" style="flex:1"><label class="field__label" for="k-base">База</label>
          <input class="input" id="k-base" type="number" step="any"></div>
        <div class="field" style="flex:1"><label class="field__label" for="k-target">Цель</label>
          <input class="input" id="k-target" type="number" step="any"></div>
        <div class="field" style="flex:1"><label class="field__label" for="k-actual">Факт</label>
          <input class="input" id="k-actual" type="number" step="any"></div>
      </div>
      <div class="field"><label class="field__label" for="k-dir">Направление улучшения</label>
        <select class="select" id="k-dir"><option value="down">Уменьшение показателя — лучше</option>
          <option value="up">Увеличение показателя — лучше</option></select></div>`,
    footer: '<button class="btn" data-close>Отмена</button><button class="btn btn--primary" data-ok>Добавить</button>',
    onMount: (el, close) => {
      el.querySelector('[data-ok]').onclick = async () => {
        const name = el.querySelector('#k-name').value.trim();
        if (!name) { toast('Укажите название показателя', 'error'); return; }
        const val = (sel) => el.querySelector(sel).value === '' ? null : Number(el.querySelector(sel).value);
        try {
          await api.post(`/api/pilots/${pilotId}/kpis`, {
            name, unit: el.querySelector('#k-unit').value.trim(), baseline: val('#k-base'),
            target: val('#k-target'), actual: val('#k-actual'), direction: el.querySelector('#k-dir').value,
          });
          toast('Показатель добавлен', 'ok'); close(); onDone();
        } catch (err) { toast(err.message, 'error'); }
      };
    },
  });
}

function surveyModal(pilot, onDone) {
  modal({
    title: 'Новый опрос участников пилота',
    body: html`
      <div class="field"><label class="field__label" for="s-title">Название <span class="req">*</span></label>
        <input class="input" id="s-title" value="Оценка решения участниками пилота"></div>
      <div class="field"><label class="field__label" for="s-aud">Аудитория</label>
        <select class="select" id="s-aud"><option value="staff">Сотрудники</option><option value="citizen">Граждане</option></select></div>
      <div class="field__hint" style="margin-bottom:12px">Опрос будет создан с типовым набором вопросов:
        оценка удобства по шкале, влияние на рабочее время и свободный отзыв. Текстовые ответы автоматически
        проходят NLP-анализ для выявления тем и тональности.</div>`,
    footer: '<button class="btn" data-close>Отмена</button><button class="btn btn--primary" data-ok>Создать</button>',
    onMount: (el, close) => {
      el.querySelector('[data-ok]').onclick = async () => {
        try {
          await api.post('/api/surveys', {
            pilot_id: pilot.id, initiative_id: pilot.initiative_id,
            title: el.querySelector('#s-title').value.trim(), audience: el.querySelector('#s-aud').value,
            questions: [
              { text: 'Насколько удобно пользоваться решением?', type: 'scale' },
              { text: 'Экономит ли решение ваше рабочее время?', type: 'choice', options: ['Да, заметно', 'Незначительно', 'Нет'] },
              { text: 'Что стоит улучшить в решении?', type: 'text' },
            ],
          });
          toast('Опрос создан', 'ok'); close(); onDone();
        } catch (err) { toast(err.message, 'error'); }
      };
    },
  });
}

// ══ Опрос: прохождение и результаты ══════════════════════════
export async function surveyDetail(view, id) {
  const s = await api.get(`/api/surveys/${id}`);
  const answers = {};

  view.innerHTML = html`
    <div class="page-head">
      <h2>${esc(s.title)}</h2>
      <p>${s.audience === 'citizen' ? 'Опрос граждан' : 'Опрос сотрудников'} ·
         ${s.responses} ${plural(s.responses, 'ответ', 'ответа', 'ответов')} ·
         ${s.is_open ? 'открыт' : 'закрыт'}</p>
    </div>

    <div class="grid grid--2" style="align-items:start">
      ${s.is_open && !s.answered ? html`
      <div data-ac="US-PIL-003/AC2" class="card">
        <div class="card__head"><h3>Пройти опрос</h3></div>
        <form class="card__body" id="survey-form">
          ${s.questions.map((qq) => html`
            <div class="field">
              <label class="field__label">${esc(qq.text)}</label>
              ${qq.type === 'scale' ? html`
                <div class="score" data-q="${qq.id}" style="gap:6px">
                  ${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-v="${n}" style="width:40px;height:38px">${n}</button>`)}
                </div>
                <div class="field__hint">1 — совсем неудобно, 5 — очень удобно</div>` : ''}
              ${qq.type === 'choice' ? html`
                <div class="chip-row" data-q="${qq.id}">
                  ${qq.options.map((o) => `<button type="button" class="chip" data-v="${esc(o)}">${esc(o)}</button>`)}
                </div>` : ''}
              ${qq.type === 'text' ? `<textarea class="textarea" data-q="${qq.id}" placeholder="Ваш ответ"></textarea>` : ''}
            </div>`)}
          <button class="btn btn--primary" type="submit">Отправить ответы</button>
        </form>
      </div>` : html`
      <div class="card">
        <div class="card__head"><h3>Ваше участие</h3></div>
        <div class="card__body">
          <p class="prose">${s.answered ? 'Вы уже прошли этот опрос — спасибо за обратную связь.' : 'Опрос закрыт, приём ответов завершён.'}</p>
        </div>
      </div>`}

      <div data-ac="US-PIL-003/AC3" class="card">
        <div class="card__head"><h3>Результаты</h3></div>
        <div class="card__body">
          ${s.results.map((r) => {
            const qq = s.questions.find((x) => x.id === r.question_id);
            if (r.type === 'scale') return html`
              <div style="margin-bottom:18px">
                <div class="fs-13 fw-600" style="margin-bottom:6px">${esc(qq.text)}</div>
                <div class="row"><div style="font-size:24px;font-weight:700;letter-spacing:-.03em">${r.avg ?? '—'}</div>
                  <span class="text-3 fs-13">из 5 · ${r.n} ${plural(r.n, 'ответ', 'ответа', 'ответов')}</span></div>
                <div class="progress progress--ok" style="margin-top:6px"><i style="width:${((r.avg || 0) / 5) * 100}%"></i></div>
              </div>`;
            if (r.type === 'choice') return html`
              <div style="margin-bottom:18px">
                <div class="fs-13 fw-600" style="margin-bottom:6px">${esc(qq.text)}</div>
                ${barList(r.distribution.map((d) => ({ label: d.option || '—', value: d.n })))}
              </div>`;
            return html`
              <div style="margin-bottom:18px">
                <div class="fs-13 fw-600" style="margin-bottom:6px">${esc(qq.text)}</div>
                ${r.analysis?.count ? html`
                  <div class="row fs-12 text-3" style="gap:12px;margin-bottom:9px">
                    <span>Тональность: <b>${r.analysis.sentiment > 0 ? '+' : ''}${r.analysis.sentiment}</b></span>
                    <span>+${r.analysis.positive} / −${r.analysis.negative}</span>
                  </div>
                  ${r.samples.slice(0, 6).map((t) => `<div class="tl-item__body" style="margin-bottom:6px">${esc(t)}</div>`)}`
                : '<p class="text-3 fs-13">Ответов нет</p>'}
              </div>`;
          })}
        </div>
      </div>
    </div>`;

  view.querySelectorAll('[data-q]').forEach((group) => {
    if (group.tagName === 'TEXTAREA') return;
    group.querySelectorAll('button').forEach((b) => b.onclick = () => {
      group.querySelectorAll('button').forEach((x) => x.classList.remove('is-on'));
      b.classList.add('is-on');
      answers[group.dataset.q] = b.dataset.v;
    });
  });

  view.querySelector('#survey-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = s.questions.map((qq) => {
      const el = view.querySelector(`[data-q="${qq.id}"]`);
      if (qq.type === 'text') return { question_id: qq.id, value_text: el?.value?.trim() || null };
      const v = answers[qq.id];
      return qq.type === 'scale'
        ? { question_id: qq.id, value_num: v ? Number(v) : null }
        : { question_id: qq.id, value_text: v || null };
    }).filter((a) => a.value_num !== null || a.value_text);
    if (!payload.length) { toast('Ответьте хотя бы на один вопрос', 'error'); return; }
    try {
      await api.post(`/api/surveys/${id}/respond`, { answers: payload });
      toast('Спасибо! Ваш отзыв учтён', 'ok');
      surveyDetail(view, id);
    } catch (err) { toast(err.message, 'error'); }
  });
}
