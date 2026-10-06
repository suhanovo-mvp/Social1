// Заполнение формы: и внутри портала, и по публичной ссылке без входа.
//
// Отрисовка полей и живой пересчёт условий вынесены сюда одним куском, потому что
// оба входа показывают одну и ту же анкету. Расходиться им нельзя: правило показа
// вопроса и вид поля не должны зависеть от того, каким путём человек пришёл.
import { api, esc, html, toast, plural } from '../core.js';
import { QUESTION_TYPES, OTHER, isAnswerable, visibleKeys, parseAnswers }
  from '/shared/forms/schema.js';

// ─────────────────────────────────────────────────────────────
// Поля
// ─────────────────────────────────────────────────────────────
const optionRows = (qn, answer, control) => {
  const chosen = control === 'radio'
    ? [answer?.choice].filter(Boolean)
    : (answer?.choices ?? []);
  const rows = qn.options.map((o) => html`
    <label class="opt">
      <input type="${control}" name="fq-${esc(qn.key)}" value="${esc(o.code)}"
             ${chosen.includes(o.code) ? 'checked' : ''}>
      <span>${esc(o.label)}</span>
    </label>`).join('');
  if (!qn.settings?.allow_other) return rows;
  const otherOn = control === 'radio' ? answer?.choice === OTHER : !!answer?.other;
  return rows + html`
    <label class="opt opt--other">
      <input type="${control}" name="fq-${esc(qn.key)}" value="${OTHER}" ${otherOn ? 'checked' : ''}>
      <span>Другое</span>
      <input class="input opt__text" data-other="${esc(qn.key)}" placeholder="свой вариант"
             value="${esc(answer?.other ?? '')}">
    </label>`;
};

function field(qn, answer) {
  const name = `fq-${esc(qn.key)}`;
  const ph = esc(qn.settings?.placeholder ?? '');
  switch (qn.type) {
    case 'short_text':
      return html`<input class="input" name="${name}" placeholder="${ph}" value="${esc(answer ?? '')}">`;
    case 'long_text':
      return html`<textarea class="textarea" name="${name}" rows="4" placeholder="${ph}">${esc(answer ?? '')}</textarea>`;
    case 'email':
      return html`<input class="input" type="email" name="${name}" placeholder="${ph || 'name@mos.ru'}"
                         value="${esc(answer ?? '')}" autocomplete="email">`;
    case 'phone':
      return html`<input class="input" type="tel" name="${name}" placeholder="${ph || '+7 (495) 000-00-00'}"
                         value="${esc(answer ?? '')}" autocomplete="tel">`;
    case 'number': {
      const s = qn.settings ?? {};
      return html`<div class="row">
        <input class="input" type="number" name="${name}" style="max-width:200px"
               ${s.min !== null && s.min !== undefined ? `min="${s.min}"` : ''}
               ${s.max !== null && s.max !== undefined ? `max="${s.max}"` : ''}
               value="${answer ?? ''}">
        ${s.unit ? `<span class="text-3 fs-13">${esc(s.unit)}</span>` : ''}</div>`;
    }
    case 'date':
      return html`<input class="input" type="date" name="${name}" style="max-width:210px" value="${esc(answer ?? '')}">`;
    case 'scale': {
      const { min = 1, max = 5, min_label, max_label } = qn.settings ?? {};
      const points = [];
      for (let v = min; v <= max; v += 1) points.push(v);
      return html`
        <div class="scale">
          ${min_label ? `<span class="scale__edge">${esc(min_label)}</span>` : ''}
          <div class="scale__points">
            ${points.map((v) => html`
              <button type="button" class="scale__point ${answer === v ? 'is-on' : ''}"
                      data-scale="${esc(qn.key)}" data-value="${v}"
                      aria-pressed="${answer === v ? 'true' : 'false'}">${v}</button>`)}
          </div>
          ${max_label ? `<span class="scale__edge">${esc(max_label)}</span>` : ''}
        </div>`;
    }
    case 'radio':
      return html`<div class="opts">${optionRows(qn, answer, 'radio')}</div>`;
    case 'checkbox':
      return html`<div class="opts">${optionRows(qn, answer, 'checkbox')}</div>`;
    case 'select': {
      const chosen = answer?.choice ?? '';
      return html`
        <select class="select" name="${name}" style="max-width:480px">
          <option value="">— выберите из списка —</option>
          ${qn.options.map((o) => `<option value="${esc(o.code)}" ${chosen === o.code ? 'selected' : ''}>${esc(o.label)}</option>`)}
          ${qn.settings?.allow_other ? `<option value="${OTHER}" ${chosen === OTHER ? 'selected' : ''}>Другое</option>` : ''}
        </select>
        ${chosen === OTHER ? html`<input class="input opt__text" style="margin-top:8px;max-width:480px"
          data-other="${esc(qn.key)}" placeholder="свой вариант" value="${esc(answer?.other ?? '')}">` : ''}`;
    }
    default:
      return '';
  }
}

/** Разметка всех вопросов. Скрытые условием рисуются тоже — их прячет пересчёт. */
export function questionsMarkup(questions, answers) {
  return questions.map((qn, i) => {
    if (qn.type === 'section') {
      return html`
        <div class="fq fq--section" data-key="${esc(qn.key)}">
          <h3>${esc(qn.title)}</h3>
          ${qn.hint ? `<p>${esc(qn.hint)}</p>` : ''}
        </div>`;
    }
    const number = questions.slice(0, i).filter((x) => isAnswerable(x.type)).length + 1;
    return html`
      <div class="fq" data-key="${esc(qn.key)}">
        <div class="fq__title">
          <span class="fq__no">${number}</span>
          <span>${esc(qn.title)}${qn.required ? '<i class="fq__req" title="Обязательный вопрос">*</i>' : ''}</span>
        </div>
        ${qn.hint ? `<div class="fq__hint">${esc(qn.hint)}</div>` : ''}
        <div class="fq__control">${field(qn, answers[qn.key])}</div>
        <div class="fq__error" hidden></div>
      </div>`;
  }).join('');
}

// ─────────────────────────────────────────────────────────────
// Живое поведение формы
// ─────────────────────────────────────────────────────────────
/**
 * Связывает разметку с ответами: собирает значения, пересчитывает видимость и
 * следит за прогрессом. Возвращает доступ к текущим ответам и разметку ошибок.
 */
export function bindForm(root, questions, answers, { onChange } = {}) {
  const byKey = new Map(questions.map((qn) => [qn.key, qn]));
  const blocks = new Map([...root.querySelectorAll('.fq')].map((el) => [el.dataset.key, el]));

  const setValue = (key, value) => {
    if (value === null || value === undefined || value === '') delete answers[key];
    else answers[key] = value;
    refresh();
  };

  const readChoice = (qn) => {
    const picked = root.querySelector(`input[name="fq-${CSS.escape(qn.key)}"]:checked`);
    const other = root.querySelector(`[data-other="${CSS.escape(qn.key)}"]`)?.value.trim() || null;
    if (!picked) return null;
    return { choice: picked.value, other: picked.value === OTHER ? other : null };
  };

  const readMulti = (qn) => {
    const picked = [...root.querySelectorAll(`input[name="fq-${CSS.escape(qn.key)}"]:checked`)]
      .map((i) => i.value);
    const other = root.querySelector(`[data-other="${CSS.escape(qn.key)}"]`)?.value.trim() || null;
    const choices = picked.filter((v) => v !== OTHER);
    if (!choices.length && !(picked.includes(OTHER) && other)) return null;
    return { choices, other: picked.includes(OTHER) ? other : null };
  };

  root.addEventListener('input', (e) => {
    const el = e.target;
    const key = el.name?.startsWith('fq-') ? el.name.slice(3) : el.dataset.other;
    const qn = byKey.get(key);
    if (!qn) return;
    // Выпадающий список обрабатывается ниже, событием change: там же решается,
    // показывать ли поле «свой вариант»
    if (qn.type === 'select' && el.tagName === 'SELECT') return;
    const kind = QUESTION_TYPES[qn.type]?.kind;
    if (kind === 'choice') setValue(key, readChoice(qn));
    else if (kind === 'multi') setValue(key, readMulti(qn));
    else if (kind === 'number') setValue(key, el.value === '' ? null : Number(el.value));
    else setValue(key, el.value);
  });

  // Выпадающий список и переключатели меняются событием change, а «свой вариант»
  // рядом с ними появляется и исчезает — поэтому поле перерисовывается целиком
  root.addEventListener('change', (e) => {
    const el = e.target;
    if (!el.name?.startsWith('fq-')) return;
    const qn = byKey.get(el.name.slice(3));
    if (!qn) return;
    if (qn.type === 'select') {
      const value = el.value ? { choice: el.value, other: answers[qn.key]?.other ?? null } : null;
      answers[qn.key] = value;
      if (!value) delete answers[qn.key];
      const holder = blocks.get(qn.key).querySelector('.fq__control');
      holder.innerHTML = field(qn, answers[qn.key]);
      holder.querySelector('[data-other]')?.focus();
      refresh();
    }
  });

  root.addEventListener('click', (e) => {
    const point = e.target.closest('[data-scale]');
    if (!point) return;
    const key = point.dataset.scale;
    const value = Number(point.dataset.value);
    setValue(key, answers[key] === value ? null : value);
    const holder = blocks.get(key).querySelector('.fq__control');
    holder.innerHTML = field(byKey.get(key), answers[key]);
  });

  function refresh() {
    const visible = visibleKeys(questions, answers);
    for (const [key, el] of blocks) el.hidden = !visible.has(key);
    // Ответ на закрывшийся вопрос удаляется сразу: иначе он вернулся бы при
    // отправке — на экране вопроса нет, а в ответе он есть
    for (const qn of questions) if (!visible.has(qn.key)) delete answers[qn.key];
    onChange?.(progress(questions, answers, visible));
  }

  refresh();
  return { answers, refresh, showErrors: (errors) => showErrors(root, errors) };
}

export function progress(questions, answers, visible = visibleKeys(questions, answers)) {
  const asked = questions.filter((qn) => isAnswerable(qn.type) && visible.has(qn.key));
  const done = asked.filter((qn) => answers[qn.key] !== undefined && answers[qn.key] !== null);
  return { total: asked.length, done: done.length,
           percent: asked.length ? Math.round((done.length / asked.length) * 100) : 0 };
}

function showErrors(root, errors) {
  root.querySelectorAll('.fq').forEach((el) => {
    el.classList.remove('is-error');
    const box = el.querySelector('.fq__error');
    if (box) { box.hidden = true; box.textContent = ''; }
  });
  for (const err of errors ?? []) {
    const el = root.querySelector(`.fq[data-key="${CSS.escape(err.key)}"]`);
    if (!el) continue;
    el.classList.add('is-error');
    const box = el.querySelector('.fq__error');
    box.textContent = err.message.replace(/^«[^»]*»:\s*/, '');
    box.hidden = false;
  }
  root.querySelector('.fq.is-error')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ─────────────────────────────────────────────────────────────
// Экран заполнения внутри портала
// ─────────────────────────────────────────────────────────────
export async function formFill(view, id) {
  const form = await api.get(`/api/forms/${id}`);
  const answers = { ...(form.my_response?.status === 'draft' ? form.my_response.answers : {}) };
  const sent = form.my_response?.status === 'submitted';

  if (sent && form.one_per_user) {
    view.innerHTML = doneCard(form, 'Ваш ответ принят',
      `<a class="btn" href="/forms">К списку форм</a>`);
    return;
  }

  view.innerHTML = html`
    <div class="crumb"><a href="/forms">Формы и опросы</a> › ${esc(form.title)}</div>
    <div class="form-page">
      <div class="card form-intro">
        <div class="card__body">
          <h2>${esc(form.title)}</h2>
          ${form.description ? `<p class="prose" style="margin-top:8px;white-space:pre-line">${esc(form.description)}</p>` : ''}
          <div class="row" style="margin-top:14px">
            ${form.is_anonymous ? '<span class="badge badge--purple">Анонимно</span>' : ''}
            <span class="text-3 fs-12">Вопросов: ${form.questions_count}</span>
            ${form.closes_at ? `<span class="text-3 fs-12">Сбор до ${esc(form.closes_at.slice(0, 10))}</span>` : ''}
          </div>
        </div>
      </div>
      ${form.show_progress ? '<div class="form-progress"><div class="form-progress__track"><i></i></div><span></span></div>' : ''}
      <form class="card form-body" id="fill">
        <div class="card__body">${questionsMarkup(form.questions, answers)}</div>
        <div class="card__foot">
          <button class="btn btn--primary" type="submit">Отправить ответ</button>
          ${form.is_anonymous ? '' : '<button class="btn" type="button" data-draft>Сохранить черновик</button>'}
          <span class="spacer text-3 fs-12">${form.is_anonymous
            ? 'Ответ не связывается с вашей учётной записью'
            : 'Ответ виден только тому, кто ведёт форму'}</span>
        </div>
      </form>
    </div>`;

  const root = view.querySelector('#fill');
  const bar = view.querySelector('.form-progress');
  const bound = bindForm(root, form.questions, answers, {
    onChange: (p) => {
      if (!bar) return;
      bar.querySelector('i').style.width = `${p.percent}%`;
      bar.querySelector('span').textContent =
        `Отвечено ${p.done} из ${p.total} ${plural(p.total, 'вопроса', 'вопросов', 'вопросов')}`;
    },
  });

  view.querySelector('[data-draft]')?.addEventListener('click', async () => {
    try {
      await api.put(`/api/forms/${form.id}/draft`, { answers });
      toast('Черновик сохранён — можно вернуться позже', 'ok');
    } catch (e) { toast(e.message, 'error'); }
  });

  root.addEventListener('submit', async (e) => {
    e.preventDefault();
    const local = parseAnswers(form.questions, answers);
    if (local.errors.length) return bound.showErrors(local.errors);

    const btn = root.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await api.post(`/api/forms/${form.id}/responses`, { answers });
      view.innerHTML = doneCard(form, 'Ответ отправлен', '<a class="btn" href="/forms">К списку форм</a>');
    } catch (err) {
      btn.disabled = false;
      bound.showErrors(err.data?.details);
      toast(err.message, 'error');
    }
  });
}

const doneCard = (form, title, actions = '') => html`
  <div class="card form-done">
    <div class="card__body">
      <div class="form-done__mark">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
      </div>
      <h2>${esc(title)}</h2>
      <p class="prose" style="white-space:pre-line">${esc(form.closing_text
        || 'Спасибо! Ваши ответы учтены — они попадут в сводку по опросу.')}</p>
      <div class="row" style="justify-content:center;margin-top:16px">${actions}</div>
    </div>
  </div>`;

// ─────────────────────────────────────────────────────────────
// Публичная страница: форма по ссылке, без входа в систему
// ─────────────────────────────────────────────────────────────
export async function publicForm(root, slug) {
  let form;
  try {
    form = await api.get(`/api/public/forms/${encodeURIComponent(slug)}`);
  } catch (err) {
    root.innerHTML = html`
      <div class="public"><div class="public__box card"><div class="card__body">
        <h2>Форма недоступна</h2>
        <p class="prose">${esc(err.message)}</p>
      </div></div></div>`;
    return;
  }

  const answers = {};
  const shell = (inner) => html`
    <div class="public">
      <div class="public__head">
        <div class="public__mark">S1</div>
        <div><b>Social1</b><small>${esc(form.owner)}</small></div>
      </div>
      <div class="public__box">${inner}</div>
      <div class="public__foot">Департамент труда и социальной защиты населения города Москвы</div>
    </div>`;

  if (!form.is_open) {
    root.innerHTML = shell(html`<div class="card"><div class="card__body">
      <h2>${esc(form.title)}</h2>
      <p class="prose">Сбор ответов по этой форме завершён.</p>
    </div></div>`);
    return;
  }

  root.innerHTML = shell(html`
    <div class="card form-intro">
      <div class="card__body">
        <h2>${esc(form.title)}</h2>
        ${form.description ? `<p class="prose" style="margin-top:8px;white-space:pre-line">${esc(form.description)}</p>` : ''}
      </div>
    </div>
    ${form.show_progress ? '<div class="form-progress"><div class="form-progress__track"><i></i></div><span></span></div>' : ''}
    <form class="card form-body" id="fill">
      <div class="card__body">${questionsMarkup(form.questions, answers)}</div>
      <div class="card__foot">
        <button class="btn btn--primary" type="submit">Отправить ответ</button>
        <span class="spacer text-3 fs-12">Ответ отправляется без указания имени</span>
      </div>
    </form>`);

  const formEl = root.querySelector('#fill');
  const bar = root.querySelector('.form-progress');
  const bound = bindForm(formEl, form.questions, answers, {
    onChange: (p) => {
      if (!bar) return;
      bar.querySelector('i').style.width = `${p.percent}%`;
      bar.querySelector('span').textContent =
        `Отвечено ${p.done} из ${p.total} ${plural(p.total, 'вопроса', 'вопросов', 'вопросов')}`;
    },
  });

  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    const local = parseAnswers(form.questions, answers);
    if (local.errors.length) return bound.showErrors(local.errors);
    const btn = formEl.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await api.post(`/api/public/forms/${encodeURIComponent(slug)}/responses`, { answers });
      root.innerHTML = shell(doneCard(form, 'Ответ отправлен'));
    } catch (err) {
      btn.disabled = false;
      bound.showErrors(err.data?.details);
      toast(err.message, 'error');
    }
  });
}
