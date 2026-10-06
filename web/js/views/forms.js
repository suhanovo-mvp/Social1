// Формы и опросы: каталог и конструктор.
//
// Конструктор устроен как в привычных сервисах форм — список вопросов, у каждого
// свой тип и свои настройки. Отличие одно и оно намеренное: условие показа
// вопроса редактируется здесь же, рядом с самим вопросом, а не прячется в
// отдельный раздел «логика». В анкетах департамента условных вопросов больше
// половины («если оценка 3–5, уточните, где именно»), и держать их правило вдали
// от вопроса значит гарантировать расхождение.
import { api, esc, html, navigate, toast, modal, confirmDialog,
         avatar, fmtDate, fmtAgo, plural } from '../core.js';
import { QUESTION_TYPES, CONDITION_OPS, OTHER, isAnswerable, kindOf,
         nextKey, nextOptionCode, describeCondition } from '/shared/forms/schema.js';

const STATUS_BADGE = { draft: 'badge--outline', published: 'badge--ok', closed: 'badge--warn' };
const STATUS_TITLE = { draft: 'Черновик', published: 'Идёт сбор', closed: 'Сбор закрыт' };

// Порядок в меню «добавить вопрос»: сначала то, чем пользуются в каждой анкете
const TYPE_ORDER = ['short_text', 'long_text', 'radio', 'checkbox', 'select',
                    'scale', 'number', 'date', 'email', 'phone', 'section'];

// ─────────────────────────────────────────────────────────────
// Каталог
// ─────────────────────────────────────────────────────────────
export async function formsList(view, query) {
  const status = query.get('status') || '';
  const mine = query.get('mine') === '1';
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (mine) params.set('mine', '1');
  const { forms, can_create } = await api.get(`/api/forms?${params}`);

  const link = (over = {}) => {
    const p = new URLSearchParams({ ...(status ? { status } : {}), ...(mine ? { mine: '1' } : {}), ...over });
    for (const [k, v] of [...p]) if (!v) p.delete(k);
    return `/forms?${p}`;
  };

  view.innerHTML = html`
    <div class="page-head">
      <div class="page-head__row">
        <div style="flex:1;min-width:280px">
          <h2>Формы и опросы</h2>
          <p>Конструктор анкет: соберите форму из вопросов нужного вида, задайте условия
             показа — «уточняющий вопрос только тем, кто поставил высокую оценку», — и
             разошлите ссылку. Ответы сводятся автоматически, выгрузка в CSV рядом.</p>
        </div>
        ${can_create ? '<button class="btn btn--primary" data-new>Создать форму</button>' : ''}
      </div>
      <div class="chip-row" style="margin-top:14px">
        <button class="chip ${!status && !mine ? 'is-on' : ''}" data-go="${esc(link({ status: '', mine: '' }))}">Все</button>
        <button class="chip ${status === 'published' ? 'is-on' : ''}" data-go="${esc(link({ status: 'published' }))}">Идёт сбор</button>
        <button class="chip ${status === 'closed' ? 'is-on' : ''}" data-go="${esc(link({ status: 'closed' }))}">Закрытые</button>
        ${can_create ? html`
          <button class="chip ${status === 'draft' ? 'is-on' : ''}" data-go="${esc(link({ status: 'draft' }))}">Черновики</button>
          <button class="chip ${mine ? 'is-on' : ''}" data-go="${esc(link({ mine: mine ? '' : '1' }))}">Мои формы</button>` : ''}
      </div>
    </div>

    ${forms.length ? html`<div class="grid grid--2">${forms.map(formCard)}</div>` : html`
      <div class="card"><div class="empty">
        <h4>Форм пока нет</h4>
        <p>Опрос собирается за несколько минут: добавьте вопросы, опубликуйте форму
           и разошлите ссылку в учреждения.</p>
      </div></div>`}`;

  view.querySelectorAll('[data-go]').forEach((b) => b.onclick = () => navigate(b.dataset.go));
  view.querySelectorAll('[data-open]').forEach((c) => c.onclick = (e) => {
    if (e.target.closest('a,button')) return;
    navigate(c.dataset.open);
  });
  view.querySelector('[data-new]')?.addEventListener('click', createDialog);
}

function formCard(f) {
  // Открывается карточка формы; тому, кто её не ведёт, конструктор сам покажет
  // заполнение — решать это здесь, по неполным данным списка, незачем
  return html`
    <div class="card form-card is-clickable" data-open="/forms/${f.id}">
      <div class="card__body">
        <div class="row">
          <span class="badge ${STATUS_BADGE[f.status]}">${STATUS_TITLE[f.status]}</span>
          ${f.access === 'link' ? '<span class="badge badge--outline">По ссылке</span>' : ''}
          ${f.is_anonymous ? '<span class="badge badge--purple">Анонимно</span>' : ''}
          <span class="spacer text-3 fs-12">${esc(fmtAgo(f.published_at || f.updated_at))}</span>
        </div>
        <h3 class="form-card__title">${esc(f.title)}</h3>
        ${f.description ? `<p class="form-card__lead clamp-2">${esc(f.description)}</p>` : ''}
        <div class="form-card__stats">
          <span><b>${f.questions_count}</b> ${plural(f.questions_count, 'вопрос', 'вопроса', 'вопросов')}</span>
          <span><b>${f.responses}</b> ${plural(f.responses, 'ответ', 'ответа', 'ответов')}</span>
          ${f.closes_at ? `<span>до ${esc(fmtDate(f.closes_at))}</span>` : ''}
        </div>
        <div class="form-card__foot">
          ${avatar(f.author_name, 'avatar--sm')}
          <span class="fs-12 text-3">${esc(f.author_name || '—')}</span>
          <span class="spacer"></span>
          ${f.is_open ? `<a class="btn btn--sm" href="/forms/${f.id}/fill">Заполнить</a>` : ''}
          <a class="btn btn--sm" href="/forms/${f.id}/results">Результаты</a>
        </div>
      </div>
    </div>`;
}

function createDialog() {
  modal({
    title: 'Новая форма',
    body: html`
      <div class="field">
        <label class="field__label" for="nf-title">Название формы <span class="req">*</span></label>
        <input class="input" id="nf-title" placeholder="Например: Оценка потенциала ИИ-решений">
      </div>
      <div class="field">
        <label class="field__label" for="nf-desc">Вступительный текст</label>
        <textarea class="textarea" id="nf-desc" rows="4"
          placeholder="Кто проводит опрос, зачем и сколько времени займёт заполнение"></textarea>
        <div class="field__hint">Этот текст человек видит перед первым вопросом.</div>
      </div>`,
    footer: '<button class="btn" data-close>Отмена</button><button class="btn btn--primary" data-ok>Создать</button>',
    onMount: (el, close) => {
      el.querySelector('[data-ok]').onclick = async () => {
        const title = el.querySelector('#nf-title').value.trim();
        if (!title) return toast('Укажите название формы', 'error');
        try {
          const form = await api.post('/api/forms', { title, description: el.querySelector('#nf-desc').value });
          close();
          navigate(`/forms/${form.id}`);
        } catch (e) { toast(e.message, 'error'); }
      };
    },
  });
}

// ─────────────────────────────────────────────────────────────
// Конструктор
// ─────────────────────────────────────────────────────────────
export async function formEditor(view, id) {
  let form = await api.get(`/api/forms/${id}`);
  if (!form.can_edit) return navigate(`/forms/${id}/fill`, true);

  let questions = form.questions.map(clone);
  let openKey = null;
  let dirty = false;

  const setDirty = (value) => {
    dirty = value;
    unsaved = value;
    view.querySelector('[data-save]')?.toggleAttribute('disabled', !value);
    const flag = view.querySelector('[data-dirty]');
    if (flag) flag.hidden = !value;
  };
  const markDirty = () => setDirty(true);

  // Состояние всегда перечитывается целиком: сервер нормализует вопросы и заново
  // считает, что мешает публикации, — держать это в двух местах значит расходиться
  const reload = async () => {
    form = await api.get(`/api/forms/${id}`);
    questions = form.questions.map(clone);
    setDirty(false);
  };

  const save = async () => {
    try {
      await api.put(`/api/forms/${form.id}/questions`, { questions });
      await reload();
      toast('Форма сохранена', 'ok');
      render();
    } catch (e) {
      toast([e.message, ...(e.data?.details ?? [])].join(' — '), 'error');
      throw e;
    }
  };

  // ── Разметка ───────────────────────────────────────────────
  // Перерисовывается весь конструктор: карточки вопросов зависят друг от друга —
  // условие показа перечисляет вопросы выше, нумерация сдвигается при добавлении.
  // Чтобы это не выбрасывало человека в начало страницы, положение прокрутки
  // восстанавливается, а раскрытый вопрос подтягивается в видимую часть.
  function render() {
    const scroll = window.scrollY;
    renderMarkup();
    bind();
    window.scrollTo({ top: scroll, behavior: 'instant' });
    const opened = view.querySelector('.qcard.is-open');
    if (opened) {
      const box = opened.getBoundingClientRect();
      if (box.top < 70 || box.bottom > innerHeight) {
        opened.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }

  function renderMarkup() {
    view.innerHTML = html`
      <div class="crumb"><a href="/forms">Формы и опросы</a> › Конструктор</div>
      <div class="page-head">
        <div class="page-head__row">
          <div style="flex:1;min-width:280px">
            <h2>${esc(form.title)}</h2>
            <p>${esc(STATUS_TITLE[form.status])} · ${form.responses}
               ${plural(form.responses, 'ответ', 'ответа', 'ответов')} собрано</p>
          </div>
          <div class="row">
            <span class="badge badge--warn" data-dirty ${dirty ? '' : 'hidden'}>Есть несохранённые изменения</span>
            <a class="btn" href="/forms/${form.id}/results">Результаты</a>
            <button class="btn btn--primary" data-save ${dirty ? '' : 'disabled'}>Сохранить</button>
          </div>
        </div>
      </div>

      <div class="builder">
        <div class="builder__main">
          <div class="card">
            <div class="card__body">
              <div class="field">
                <label class="field__label" for="f-title">Название формы</label>
                <input class="input" id="f-title" data-form="title" value="${esc(form.title)}">
              </div>
              <div class="field" style="margin-bottom:0">
                <label class="field__label" for="f-desc">Вступительный текст</label>
                <textarea class="textarea" id="f-desc" data-form="description" rows="4">${esc(form.description ?? '')}</textarea>
              </div>
            </div>
          </div>

          <div class="qlist">${questions.map((qn, i) => questionCard(qn, i)).join('')}</div>

          <div class="card add-q">
            <div class="card__body">
              <div class="field__label">Добавить вопрос</div>
              <div class="chip-row">
                ${TYPE_ORDER.map((t) => html`
                  <button class="chip" data-add="${t}" title="${esc(QUESTION_TYPES[t].hint)}">
                    ${esc(QUESTION_TYPES[t].title)}</button>`)}
              </div>
            </div>
          </div>
        </div>

        <aside class="builder__side">${sidePanel()}</aside>
      </div>`;
  }

  function questionCard(qn, i) {
    const meta = QUESTION_TYPES[qn.type];
    const byKey = new Map(questions.map((x) => [x.key, x]));
    const number = questions.slice(0, i).filter((x) => isAnswerable(x.type)).length + 1;
    const open = openKey === qn.key;
    return html`
      <div class="qcard ${open ? 'is-open' : ''} ${qn.type === 'section' ? 'qcard--section' : ''}"
           data-key="${esc(qn.key)}">
        <div class="qcard__head" data-toggle>
          <span class="qcard__no">${qn.type === 'section' ? '§' : number}</span>
          <div class="qcard__main">
            <div class="qcard__title">${esc(qn.title || 'Без текста')}
              ${qn.required ? '<i class="fq__req">*</i>' : ''}</div>
            <div class="qcard__meta">
              <span class="badge badge--outline">${esc(meta.title)}</span>
              ${qn.options?.length ? `<span class="text-3 fs-12">вариантов: ${qn.options.length}</span>` : ''}
              ${qn.visible_if ? `<span class="qcard__cond">Показывается, если ${esc(describeCondition(qn, byKey))}</span>` : ''}
            </div>
          </div>
          <div class="qcard__tools">
            <button class="icon-btn" data-move="-1" title="Выше" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="icon-btn" data-move="1" title="Ниже" ${i === questions.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="icon-btn" data-copy title="Дублировать">⧉</button>
            <button class="icon-btn" data-drop title="Удалить">✕</button>
          </div>
        </div>
        ${open ? questionEditor(qn, i) : ''}
      </div>`;
  }

  function questionEditor(qn, index) {
    const meta = QUESTION_TYPES[qn.type];
    const s = qn.settings ?? {};
    return html`
      <div class="qcard__edit">
        <div class="field">
          <label class="field__label">${qn.type === 'section' ? 'Заголовок блока' : 'Текст вопроса'}</label>
          <input class="input" data-q="title" value="${esc(qn.title)}">
        </div>
        <div class="field">
          <label class="field__label">${qn.type === 'section' ? 'Пояснение к блоку' : 'Подсказка под вопросом'}</label>
          <input class="input" data-q="hint" value="${esc(qn.hint ?? '')}"
                 placeholder="${qn.type === 'section' ? 'Что и зачем спрашивается в этом блоке' : 'Например: приведите 2–3 примера'}">
        </div>
        <div class="row">
          <div class="field" style="flex:1;min-width:200px">
            <label class="field__label">Тип</label>
            <select class="select" data-q="type">
              ${TYPE_ORDER.map((t) => `<option value="${t}" ${qn.type === t ? 'selected' : ''}>${esc(QUESTION_TYPES[t].title)}</option>`)}
            </select>
          </div>
          ${isAnswerable(qn.type) ? html`
            <label class="checkbox" style="margin-top:22px">
              <input type="checkbox" data-q="required" ${qn.required ? 'checked' : ''}>
              <span>Обязательный вопрос</span>
            </label>` : ''}
        </div>
        <div class="field__hint" style="margin:-6px 0 14px">${esc(meta.hint)}</div>

        ${meta.options ? optionsEditor(qn) : ''}
        ${qn.type === 'scale' ? scaleEditor(s) : ''}
        ${qn.type === 'number' ? numberEditor(s) : ''}
        ${isAnswerable(qn.type) ? conditionEditor(qn, index) : ''}
      </div>`;
  }

  function optionsEditor(qn) {
    return html`
      <div class="field">
        <label class="field__label">Варианты ответа</label>
        <div class="opt-edit">
          ${qn.options.map((o) => html`
            <div class="opt-edit__row" data-code="${esc(o.code)}">
              <input class="input" data-opt="${esc(o.code)}" value="${esc(o.label)}">
              <button class="icon-btn" data-opt-drop="${esc(o.code)}" title="Убрать вариант">✕</button>
            </div>`)}
        </div>
        <div class="row" style="margin-top:8px">
          <button class="btn btn--sm" data-opt-add>Добавить вариант</button>
          <label class="checkbox">
            <input type="checkbox" data-q="allow_other" ${qn.settings?.allow_other ? 'checked' : ''}>
            <span>Разрешить «Другое» со своим текстом</span>
          </label>
        </div>
      </div>`;
  }

  const scaleEditor = (s) => html`
    <div class="row">
      <div class="field" style="width:110px">
        <label class="field__label">От</label>
        <input class="input" type="number" data-q="scale_min" value="${s.min ?? 1}" min="0" max="9">
      </div>
      <div class="field" style="width:110px">
        <label class="field__label">До</label>
        <input class="input" type="number" data-q="scale_max" value="${s.max ?? 5}" min="1" max="10">
      </div>
      <div class="field" style="flex:1;min-width:170px">
        <label class="field__label">Подпись нижнего края</label>
        <input class="input" data-q="min_label" value="${esc(s.min_label ?? '')}" placeholder="Совсем не актуально">
      </div>
      <div class="field" style="flex:1;min-width:170px">
        <label class="field__label">Подпись верхнего края</label>
        <input class="input" data-q="max_label" value="${esc(s.max_label ?? '')}" placeholder="Критически важно">
      </div>
    </div>`;

  const numberEditor = (s) => html`
    <div class="row">
      <div class="field" style="width:130px">
        <label class="field__label">Не меньше</label>
        <input class="input" type="number" data-q="num_min" value="${s.min ?? ''}">
      </div>
      <div class="field" style="width:130px">
        <label class="field__label">Не больше</label>
        <input class="input" type="number" data-q="num_max" value="${s.max ?? ''}">
      </div>
      <div class="field" style="flex:1;min-width:150px">
        <label class="field__label">Единица измерения</label>
        <input class="input" data-q="unit" value="${esc(s.unit ?? '')}" placeholder="часов в неделю">
      </div>
    </div>`;

  /**
   * Условие показа. Ссылаться можно только на вопросы выше по форме — их и
   * показывает список: вопрос ниже ещё не отвечен, и условие по нему было бы
   * правилом, которое никогда не выполняется.
   */
  function conditionEditor(qn, index) {
    const earlier = questions.slice(0, index).filter((x) => isAnswerable(x.type));
    const rule = qn.visible_if?.rules?.[0] ?? null;
    const target = rule ? earlier.find((x) => x.key === rule.q) : null;
    const ops = Object.entries(CONDITION_OPS)
      .filter(([, o]) => !target || o.kinds.includes(kindOf(target.type)));

    return html`
      <div class="cond">
        <div class="field__label">Когда показывать вопрос</div>
        ${!earlier.length ? '<div class="field__hint">Это первый вопрос формы — показывать его по условию не из чего.</div>' : html`
          <div class="row">
            <select class="select" data-cond="q" style="flex:1;min-width:200px">
              <option value="">Показывать всегда</option>
              ${earlier.map((x) => `<option value="${esc(x.key)}" ${rule?.q === x.key ? 'selected' : ''}>${esc(x.title.slice(0, 60))}</option>`)}
            </select>
            ${rule ? html`
              <select class="select" data-cond="cmp" style="width:180px">
                ${ops.map(([code, o]) => `<option value="${code}" ${rule.cmp === code ? 'selected' : ''}>${esc(o.title)}</option>`)}
              </select>
              ${CONDITION_OPS[rule.cmp]?.value ? conditionValue(rule, target) : ''}` : ''}
          </div>
          ${rule ? '<div class="field__hint">Пока условие не выполнено, вопрос скрыт, ответ на него не сохраняется и обязательным он не считается.</div>' : ''}`}
      </div>`;
  }

  function conditionValue(rule, target) {
    if (!target) return '';
    const kind = kindOf(target.type);
    const many = CONDITION_OPS[rule.cmp].value === 'list';
    const chosen = (Array.isArray(rule.value) ? rule.value : [rule.value]).map(String);

    if (kind === 'choice' || kind === 'multi') {
      const options = [...target.options, ...(target.settings?.allow_other ? [{ code: OTHER, label: 'Другое' }] : [])];
      return html`
        <select class="select" data-cond="value" style="flex:1;min-width:180px" ${many ? 'multiple size="4"' : ''}>
          ${options.map((o) => `<option value="${esc(o.code)}" ${chosen.includes(o.code) ? 'selected' : ''}>${esc(o.label)}</option>`)}
        </select>`;
    }
    if (kind === 'number' && many) {
      const s = target.settings ?? {};
      const points = [];
      for (let v = s.min ?? 1; v <= (s.max ?? 10); v += 1) points.push(v);
      return html`
        <select class="select" data-cond="value" multiple size="4" style="width:120px">
          ${points.map((v) => `<option value="${v}" ${chosen.includes(String(v)) ? 'selected' : ''}>${v}</option>`)}
        </select>`;
    }
    return html`<input class="input" data-cond="value" style="width:170px"
                       type="${kind === 'number' ? 'number' : 'text'}" value="${esc(chosen[0] ?? '')}">`;
  }

  function sidePanel() {
    const url = `${location.origin}/f/${form.slug}`;
    return html`
      <div class="card">
        <div class="card__head"><h3>Публикация</h3>
          <span class="badge ${STATUS_BADGE[form.status]} spacer">${STATUS_TITLE[form.status]}</span></div>
        <div class="card__body">
          ${form.issues?.length ? html`
            <div class="hint-box">
              <div class="hint-box__head">Публиковать пока рано</div>
              ${form.issues.map((t) => `<div class="fs-12 text-2">• ${esc(t)}</div>`)}
            </div>` : ''}
          <div class="row" style="gap:8px">
            ${form.status !== 'published'
              ? '<button class="btn btn--primary btn--sm" data-publish>Опубликовать</button>'
              : '<button class="btn btn--sm" data-status="closed">Закрыть сбор</button>'}
            ${form.status === 'published' ? `<a class="btn btn--sm" href="/forms/${form.id}/fill">Просмотр</a>` : ''}
            <button class="btn btn--sm" data-duplicate>Сделать копию</button>
            <button class="btn btn--sm btn--danger" data-delete>Удалить</button>
          </div>
          ${form.status === 'published' && form.access === 'link' ? html`
            <div class="field" style="margin:16px 0 0">
              <label class="field__label">Ссылка для рассылки</label>
              <div class="row" style="flex-wrap:nowrap">
                <input class="input mono" id="share-url" readonly value="${esc(url)}">
                <button class="btn btn--sm" data-copy-link>Копировать</button>
              </div>
              <div class="field__hint">Заполнить смогут все, у кого есть ссылка, — вход в Social1 не потребуется.</div>
            </div>` : ''}
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card__head"><h3>Настройки</h3></div>
        <div class="card__body">
          <div class="field">
            <label class="field__label">Кто может заполнять</label>
            <select class="select" data-form="access">
              <option value="internal" ${form.access === 'internal' ? 'selected' : ''}>Участники платформы</option>
              <option value="link" ${form.access === 'link' ? 'selected' : ''}>Все, у кого есть ссылка</option>
            </select>
          </div>
          <label class="checkbox"><input type="checkbox" data-form="is_anonymous" ${form.is_anonymous ? 'checked' : ''}>
            <span>Анонимно — ответ не связывается с автором</span></label>
          <label class="checkbox"><input type="checkbox" data-form="one_per_user" ${form.one_per_user ? 'checked' : ''}>
            <span>Один ответ от участника</span></label>
          <label class="checkbox"><input type="checkbox" data-form="show_progress" ${form.show_progress ? 'checked' : ''}>
            <span>Показывать полосу заполнения</span></label>
          <div class="field" style="margin-top:14px">
            <label class="field__label">Собирать ответы до</label>
            <input class="input" type="date" data-form="closes_at"
                   value="${esc((form.closes_at ?? '').slice(0, 10))}">
          </div>
          <div class="field" style="margin-bottom:0">
            <label class="field__label">Текст после отправки</label>
            <textarea class="textarea" data-form="closing_text" rows="3"
              placeholder="Спасибо! Итоги опроса опубликуем в разделе «Аналитика»">${esc(form.closing_text ?? '')}</textarea>
          </div>
        </div>
        <div class="card__foot"><button class="btn btn--sm" data-save-settings>Сохранить настройки</button></div>
      </div>`;
  }

  // ── Обработчики ────────────────────────────────────────────
  function bind() {
    view.querySelector('[data-save]')?.addEventListener('click', () => save().catch(() => {}));

    // Название и описание формы правятся в шапке, остальные настройки — в панели
    view.querySelectorAll('[data-form]').forEach((el) => el.addEventListener('input', () => {
      const key = el.dataset.form;
      form[key] = el.type === 'checkbox' ? el.checked : el.value;
    }));

    view.querySelector('[data-save-settings]')?.addEventListener('click', async () => {
      try {
        const patch = {
          title: form.title, description: form.description, access: form.access,
          is_anonymous: form.is_anonymous, one_per_user: form.one_per_user,
          show_progress: form.show_progress, closing_text: form.closing_text,
          closes_at: form.closes_at ? `${String(form.closes_at).slice(0, 10)} 23:59:59` : null,
        };
        await api.patch(`/api/forms/${form.id}`, patch);
        await reload();
        toast('Настройки сохранены', 'ok');
        render();
      } catch (e) { toast(e.message, 'error'); }
    });

    view.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
      const type = b.dataset.add;
      const qn = {
        key: nextKey(questions), type, title: '', hint: null, required: false,
        options: QUESTION_TYPES[type].options
          ? [{ code: 'o1', label: 'Вариант 1' }, { code: 'o2', label: 'Вариант 2' }] : [],
        settings: type === 'scale' ? { min: 1, max: 5, min_label: '', max_label: '' } : {},
        visible_if: null,
      };
      questions.push(qn);
      openKey = qn.key;
      markDirty();
      render();
      view.querySelector('.qcard.is-open [data-q="title"]')?.focus();
    }));

    view.querySelectorAll('.qcard').forEach((card) => {
      const key = card.dataset.key;
      const qn = questions.find((x) => x.key === key);
      const index = questions.indexOf(qn);

      card.querySelector('[data-toggle]').addEventListener('click', (e) => {
        if (e.target.closest('.qcard__tools')) return;
        openKey = openKey === key ? null : key;
        render();
      });
      card.querySelectorAll('[data-move]').forEach((b) =>
        b.addEventListener('click', () => {
          const to = index + Number(b.dataset.move);
          if (to < 0 || to >= questions.length) return;
          questions.splice(to, 0, questions.splice(index, 1)[0]);
          markDirty();
          render();
        }));
      card.querySelector('[data-copy]').addEventListener('click', () => {
        const copy = clone(qn);
        copy.key = nextKey(questions);
        copy.title = `${qn.title} (копия)`;
        questions.splice(index + 1, 0, copy);
        markDirty();
        render();
      });
      card.querySelector('[data-drop]').addEventListener('click', async () => {
        const dependants = questions.filter((x) => x.visible_if?.rules?.some((r) => r.q === key));
        const message = dependants.length
          ? `На этот вопрос опираются условия показа: ${dependants.map((d) => `«${d.title}»`).join(', ')}. `
            + 'Вместе с вопросом они перестанут действовать.'
          : 'Вопрос будет убран из формы. Уже собранные ответы на него удалятся.';
        if (!await confirmDialog('Удалить вопрос?', message, 'Удалить')) return;
        questions.splice(index, 1);
        for (const other of questions) {
          if (other.visible_if?.rules?.some((r) => r.q === key)) other.visible_if = null;
        }
        if (openKey === key) openKey = null;
        markDirty();
        render();
      });

      if (openKey !== key) return;
      bindEditor(card, qn, index);
    });

    view.querySelector('[data-publish]')?.addEventListener('click', async () => {
      try {
        if (dirty) await save();
        await api.post(`/api/forms/${form.id}/publish`);
        await reload();
        toast('Форма опубликована — можно собирать ответы', 'ok');
        render();
      } catch (e) {
        toast([e.message, ...(e.data?.details ?? [])].join(': '), 'error');
      }
    });

    view.querySelector('[data-status]')?.addEventListener('click', async (e) => {
      try {
        await api.post(`/api/forms/${form.id}/status`, { status: e.target.dataset.status });
        await reload();
        render();
      } catch (err) { toast(err.message, 'error'); }
    });

    view.querySelector('[data-duplicate]')?.addEventListener('click', async () => {
      const copy = await api.post(`/api/forms/${form.id}/duplicate`);
      navigate(`/forms/${copy.id}`);
    });

    view.querySelector('[data-delete]')?.addEventListener('click', async () => {
      const ok = await confirmDialog('Удалить форму?',
        form.responses
          ? `Вместе с формой удалятся ${form.responses} ${plural(form.responses, 'собранный ответ', 'собранных ответа', 'собранных ответов')}. Восстановить их будет нельзя.`
          : 'Форма будет удалена без возможности восстановления.',
        'Удалить');
      if (!ok) return;
      await api.del(`/api/forms/${form.id}`);
      navigate('/forms');
    });

    view.querySelector('[data-copy-link]')?.addEventListener('click', async () => {
      const input = view.querySelector('#share-url');
      try {
        await navigator.clipboard.writeText(input.value);
        toast('Ссылка скопирована', 'ok');
      } catch { input.select(); }
    });
  }

  /** Поля внутри раскрытого вопроса. Правка текста модель меняет без перерисовки. */
  function bindEditor(card, qn, index) {
    card.querySelectorAll('[data-q]').forEach((el) => {
      const field = el.dataset.q;
      const structural = ['type', 'allow_other'].includes(field);
      el.addEventListener(structural || el.type === 'checkbox' ? 'change' : 'input', () => {
        applyField(qn, field, el);
        markDirty();
        if (structural) render();
      });
    });

    card.querySelectorAll('[data-opt]').forEach((el) => el.addEventListener('input', () => {
      const option = qn.options.find((o) => o.code === el.dataset.opt);
      if (option) { option.label = el.value; markDirty(); }
    }));

    card.querySelectorAll('[data-opt-drop]').forEach((el) => el.addEventListener('click', () => {
      qn.options = qn.options.filter((o) => o.code !== el.dataset.optDrop);
      markDirty();
      render();
    }));

    card.querySelector('[data-opt-add]')?.addEventListener('click', () => {
      qn.options.push({ code: nextOptionCode(qn.options), label: '' });
      markDirty();
      render();
      card.querySelector('.opt-edit__row:last-child .input')?.focus();
    });

    card.querySelectorAll('[data-cond]').forEach((el) => el.addEventListener('change', () => {
      applyCondition(qn, index, el);
      markDirty();
      render();
    }));
  }

  function applyField(qn, field, el) {
    const value = el.type === 'checkbox' ? el.checked : el.value;
    switch (field) {
      case 'title': qn.title = value; break;
      case 'hint': qn.hint = value || null; break;
      case 'required': qn.required = value; break;
      case 'allow_other': qn.settings = { ...qn.settings, allow_other: value }; break;
      case 'scale_min': qn.settings = { ...qn.settings, min: Number(value) }; break;
      case 'scale_max': qn.settings = { ...qn.settings, max: Number(value) }; break;
      case 'num_min': qn.settings = { ...qn.settings, min: value === '' ? null : Number(value) }; break;
      case 'num_max': qn.settings = { ...qn.settings, max: value === '' ? null : Number(value) }; break;
      case 'min_label': case 'max_label': case 'unit':
        qn.settings = { ...qn.settings, [field]: value || null }; break;
      case 'type': changeType(qn, value); break;
      default: break;
    }
  }

  /**
   * Смена типа. Варианты сохраняются, если новый тип тоже их использует, — иначе
   * человек, перепутавший «один вариант» и «несколько», терял бы весь список.
   */
  function changeType(qn, type) {
    const wasOptions = QUESTION_TYPES[qn.type].options;
    qn.type = type;
    if (!QUESTION_TYPES[type].options) qn.options = [];
    else if (!wasOptions || !qn.options.length) {
      qn.options = [{ code: 'o1', label: 'Вариант 1' }, { code: 'o2', label: 'Вариант 2' }];
    }
    if (type === 'scale') qn.settings = { min: 1, max: 5, ...qn.settings };
    if (!isAnswerable(type)) { qn.required = false; qn.visible_if = null; }
    // Условия, которые ссылались на этот вопрос, могли стать бессмысленными
    for (const other of questions) {
      const rules = other.visible_if?.rules ?? [];
      if (rules.some((r) => r.q === qn.key && !CONDITION_OPS[r.cmp].kinds.includes(kindOf(type)))) {
        other.visible_if = null;
      }
    }
  }

  function applyCondition(qn, index, el) {
    const rule = qn.visible_if?.rules?.[0] ?? null;
    if (el.dataset.cond === 'q') {
      if (!el.value) { qn.visible_if = null; return; }
      const target = questions.slice(0, index).find((x) => x.key === el.value);
      const kind = kindOf(target.type);
      const cmp = ['choice', 'multi'].includes(kind) ? (kind === 'multi' ? 'contains' : 'eq')
        : kind === 'number' ? 'gte' : 'answered';
      qn.visible_if = { op: 'all', rules: [{ q: el.value, cmp, ...conditionValueSeed(cmp, target) }] };
      return;
    }
    if (!rule) return;
    if (el.dataset.cond === 'cmp') {
      const cmp = el.value;
      const target = questions.slice(0, index).find((x) => x.key === rule.q);
      qn.visible_if = { op: 'all', rules: [{ q: rule.q, cmp, ...conditionValueSeed(cmp, target) }] };
      return;
    }
    const many = CONDITION_OPS[rule.cmp].value === 'list';
    rule.value = many && el.multiple ? [...el.selectedOptions].map((o) => o.value) : el.value;
  }

  render();
}

/**
 * Значение нового правила подставляется сразу — первым вариантом списка или
 * серединой шкалы. Условие без значения не сохранится, а пустой выпадающий список
 * выглядит так, будто выбирать нечего.
 */
function conditionValueSeed(cmp, target) {
  const spec = CONDITION_OPS[cmp].value;
  if (!spec) return {};
  const kind = kindOf(target?.type);
  let value = '';
  if (kind === 'choice' || kind === 'multi') value = target.options[0]?.code ?? OTHER;
  else if (kind === 'number') value = Math.ceil(((target.settings?.min ?? 1) + (target.settings?.max ?? 5)) / 2);
  return { value: spec === 'list' ? [value] : value };
}

const clone = (v) => JSON.parse(JSON.stringify(v));

// Уход со страницы с несохранёнными правками — самая обидная потеря в
// конструкторе: вопросы набраны, но не сохранены. Слушатель один на модуль:
// повешенный при каждом открытии редактора, он предупреждал бы и о правках
// формы, которую человек давно закрыл.
let unsaved = false;
addEventListener('beforeunload', (e) => { if (unsaved) { e.preventDefault(); e.returnValue = ''; } });
