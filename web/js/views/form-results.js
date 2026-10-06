// Результаты формы: сводка по вопросам и таблица ответов.
//
// Сводка отвечает на два разных вопроса, и их легко перепутать: «сколько человек
// выбрали этот вариант» и «сколько из тех, кому вопрос вообще показывали». У
// условных вопросов второе число меньше, и без него доля выглядит провалом там,
// где провала нет. Поэтому охват показывается рядом с каждым условным вопросом.
import { api, esc, html, navigate, plural, num, fmtDate, barList, donut } from '../core.js';
import { QUESTION_TYPES } from '/shared/forms/schema.js';

const PALETTE = ['var(--brand-600)', 'var(--ok)', 'var(--purple)', 'var(--warn)',
                 'var(--info)', 'var(--danger)', 'var(--neutral)'];

export async function formResults(view, id, query) {
  const tab = query?.get('tab') === 'responses' ? 'responses' : 'summary';
  let data;
  try {
    data = await api.get(`/api/forms/${id}/results`);
  } catch (e) {
    if (e.status === 403) {
      view.innerHTML = html`<div class="card"><div class="empty">
        <h4>Результаты закрыты</h4>
        <p>Сводку по ответам видит тот, кто ведёт форму.</p>
        <a class="btn" href="/forms" style="margin-top:14px">К списку форм</a>
      </div></div>`;
      return;
    }
    throw e;
  }
  const { form } = data;

  view.innerHTML = html`
    <div class="crumb"><a href="/forms">Формы и опросы</a> ›
      <a href="/forms/${form.id}">${esc(form.title)}</a> › Результаты</div>

    <div class="page-head">
      <div class="page-head__row">
        <div style="flex:1;min-width:280px">
          <h2>${esc(form.title)}</h2>
          <p>${data.responses
            ? `Собрано ${data.responses} ${plural(data.responses, 'ответ', 'ответа', 'ответов')}
               с ${esc(fmtDate(data.first_at))} по ${esc(fmtDate(data.last_at))}`
            : 'Ответов пока нет'}</p>
        </div>
        <div class="row">
          <a class="btn" href="/forms/${form.id}">Конструктор</a>
          ${data.responses ? `<a class="btn" data-native download href="/api/forms/${form.id}/export">Выгрузить (CSV)</a>` : ''}
        </div>
      </div>
    </div>

    <div class="grid grid--kpi" style="margin-bottom:18px">
      ${kpi('Ответов собрано', data.responses)}
      ${kpi('Вопросов в форме', form.questions_count)}
      ${kpi('Заполнено полностью', completion(data), '%')}
      ${kpi('Состояние', null, '', form.is_open ? 'Идёт сбор' : 'Сбор закрыт', form.is_open ? 'ok' : 'warn')}
    </div>

    <div class="tabs">
      <div class="tab ${tab === 'summary' ? 'is-active' : ''}" data-tab="summary">Сводка</div>
      <div class="tab ${tab === 'responses' ? 'is-active' : ''}" data-tab="responses">Ответы построчно
        <span class="tab__count">${data.responses}</span></div>
    </div>
    <div id="res-body"></div>`;

  view.querySelectorAll('[data-tab]').forEach((t) => t.onclick = () =>
    navigate(`/forms/${form.id}/results?tab=${t.dataset.tab}`));

  const body = view.querySelector('#res-body');
  if (tab === 'summary') body.innerHTML = summaryMarkup(data);
  else await renderResponses(body, form.id);
}

const kpi = (label, value, unit = '', text = null, tone = '') => html`
  <div class="kpi ${tone ? 'kpi--' + tone : ''}">
    <div class="kpi__label">${esc(label)}</div>
    <div class="kpi__value">${text ? esc(text) : num(value)}${unit ? `<span class="kpi__unit">${unit}</span>` : ''}</div>
  </div>`;

/** Доля тех, кто ответил на все показанные им обязательные вопросы. */
function completion(data) {
  const required = data.questions.filter((q) => q.required);
  if (!required.length || !data.responses) return 0;
  const filled = required.reduce((s, q) => s + (q.shown ? q.answered / q.shown : 1), 0);
  return Math.round((filled / required.length) * 100);
}

function summaryMarkup(data) {
  if (!data.responses) {
    return html`<div class="card"><div class="empty">
      <h4>Ответов пока нет</h4>
      <p>Как только форму заполнят, здесь появится распределение по каждому вопросу.</p>
    </div></div>`;
  }
  return html`<div class="stack">${data.questions.map((q, i) => questionResult(q, i, data.responses))}</div>`;
}

function questionResult(q, i, total) {
  const meta = QUESTION_TYPES[q.type];
  const coverage = q.conditional
    ? `Показан ${q.shown} из ${total} · ответили ${q.answered}`
    : `Ответили ${q.answered} из ${total}`;
  return html`
    <div class="card">
      <div class="card__head">
        <div style="min-width:0">
          <h3>${i + 1}. ${esc(q.title)}</h3>
          <div class="card__hint">${esc(meta?.title ?? q.type)} · ${esc(coverage)}</div>
        </div>
        ${q.conditional ? '<span class="badge badge--purple spacer">Условный</span>' : ''}
      </div>
      <div class="card__body">${resultBody(q)}</div>
    </div>`;
}

function resultBody(q) {
  if (!q.answered) return '<div class="text-3 fs-13">На этот вопрос пока не ответил никто.</div>';

  if (q.kind === 'choice' || q.kind === 'multi') {
    const items = q.rows.map((r, i) => ({
      label: r.label, value: r.count, color: PALETTE[i % PALETTE.length],
      display: `${r.count} · ${Math.round(r.share * 100)}%`,
    }));
    const texts = q.rows.find((r) => r.texts?.length)?.texts ?? [];
    return html`
      <div class="res-split">
        <div style="min-width:0;flex:1">${barList(items, { max: Math.max(1, ...items.map((x) => x.value)) })}</div>
        ${q.kind === 'choice' ? html`<div class="res-donut">${donut(
          q.rows.filter((r) => r.count).map((r, i) => ({ label: r.label, value: r.count, color: PALETTE[i % PALETTE.length] })),
          { center: { value: q.answered, label: 'ответов' } })}</div>` : ''}
      </div>
      ${texts.length ? html`
        <div class="res-texts">
          <div class="field__label">Свои варианты</div>
          ${texts.map((t) => `<div class="res-text">${esc(t)}</div>`)}
        </div>` : ''}`;
  }

  if (q.kind === 'number') {
    const items = q.rows.map((r) => ({ label: r.label, value: r.count,
      display: `${r.count} · ${Math.round(r.share * 100)}%` }));
    return html`
      <div class="res-split">
        <div style="min-width:0;flex:1">${barList(items)}</div>
        <div class="res-stats">
          <div><b>${num(q.avg, 1)}</b><span>среднее</span></div>
          <div><b>${num(q.median)}</b><span>медиана</span></div>
          <div><b>${num(q.min)}–${num(q.max)}</b><span>размах</span></div>
        </div>
      </div>`;
  }

  if (q.kind === 'date') {
    return html`<div class="res-texts">${q.texts.map((t) => `<div class="res-text">${esc(t)}</div>`)}</div>`;
  }

  // Свободные ответы читают целиком: в них и находится то, ради чего опрос затевали
  return html`
    <div class="res-texts">
      ${q.texts.map((t) => `<div class="res-text">${esc(t)}</div>`)}
    </div>`;
}

async function renderResponses(body, formId) {
  const { form, columns, rows } = await api.get(`/api/forms/${formId}/responses`);
  if (!rows.length) {
    body.innerHTML = html`<div class="card"><div class="empty">
      <h4>Ответов пока нет</h4><p>Здесь появится таблица со всеми заполненными анкетами.</p></div></div>`;
    return;
  }
  body.innerHTML = html`
    <div class="card">
      <div class="card__head"><h3>Ответы построчно</h3>
        <span class="card__hint spacer">${rows.length} ${plural(rows.length, 'анкета', 'анкеты', 'анкет')}</span></div>
      <div class="card__body--flush">
        <div class="table-wrap res-table">
          <table class="table">
            <thead><tr>
              <th>№</th><th>Отправлен</th>
              ${form.is_anonymous ? '' : '<th>Респондент</th><th>Учреждение</th>'}
              ${columns.map((c) => `<th title="${esc(c.title)}">${esc(c.title.slice(0, 60))}</th>`)}
            </tr></thead>
            <tbody>
              ${rows.map((r, i) => html`<tr>
                <td class="text-3">${i + 1}</td>
                <td class="nowrap">${esc(fmtDate(r.submitted_at, true))}</td>
                ${form.is_anonymous ? '' : html`
                  <td>${esc(r.respondent ?? 'по ссылке')}</td>
                  <td>${esc(r.institution ?? '—')}</td>`}
                ${columns.map((c) => `<td>${esc(r.values[c.key] ?? '—')}</td>`)}
              </tr>`)}
            </tbody>
          </table>
        </div>
      </div>
      <div class="card__foot">
        <a class="btn btn--sm" data-native download href="/api/forms/${formId}/export">Выгрузить (CSV)</a>
        <span class="spacer text-3 fs-12">Файл открывается в Excel — разделитель «;», кодировка UTF-8</span>
      </div>
    </div>`;
}
