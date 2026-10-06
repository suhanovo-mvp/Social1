// Конструктор форм: сборка формы, сбор ответов и результаты.
//
// Публичные маршруты вынесены под /api/public/forms — по ним форму заполняют без
// входа в систему. Всё, что они отдают, видно любому, у кого есть ссылка, поэтому
// состав ответа собирается отдельно, а не отдаётся тем же объектом, что автору.
import { route, readJson, HttpError } from '../http.js';
import { can } from '../auth.js';
import * as forms from '../forms.js';
import { QUESTION_TYPES, CONDITION_OPS } from '../../shared/forms/schema.js';

const need = (user, permission, message) => {
  if (!can(user, permission)) throw new HttpError(403, message);
};

const found = (form) => {
  if (!form) throw new HttpError(404, 'Форма не найдена');
  return form;
};

// ─────────────────────────────────────────────────────────────
// Справочник конструктора
// ─────────────────────────────────────────────────────────────
// Объявлен раньше «/api/forms/:id»: маршруты разбираются в порядке объявления, и
// иначе «meta» досталось бы карточке формы как идентификатор.
route.get('/api/forms/meta', async ({ sendJson }) => {
  sendJson(200, {
    types: QUESTION_TYPES,
    conditions: CONDITION_OPS,
    statuses: forms.FORM_STATUS,
    access: forms.ACCESS_MODES,
  });
});

// ─────────────────────────────────────────────────────────────
// Каталог и правка
// ─────────────────────────────────────────────────────────────
route.get('/api/forms', async ({ user, url, sendJson }) => {
  const p = url.searchParams;
  sendJson(200, {
    forms: forms.listForms({
      user,
      status: p.get('status'),
      mine: p.get('mine') === '1',
      limit: Number(p.get('limit')) || 100,
    }),
    can_create: can(user, 'form.create'),
  });
});

route.post('/api/forms', async ({ req, user, ip, sendJson }) => {
  need(user, 'form.create', 'Собирать формы могут руководители, эксперты и координаторы');
  const b = await readJson(req);
  sendJson(201, forms.createForm({ title: b.title, description: b.description ?? null, user, ip }));
});

route.get('/api/forms/:id', async ({ user, params, sendJson }) => {
  const form = found(forms.formWithQuestions(params.id));
  const editable = forms.canEdit(user, form);
  if (form.status === 'draft' && !editable) throw new HttpError(403, 'Форма ещё не опубликована');
  sendJson(200, {
    ...form,
    can_edit: editable,
    can_fill: forms.isOpen(form) && can(user, 'form.fill'),
    issues: editable ? forms.publishIssues(form.id) : [],
    my_response: form.is_anonymous ? null : forms.myResponse(form.id, user),
  });
});

route.patch('/api/forms/:id', async ({ req, user, params, ip, sendJson }) => {
  sendJson(200, forms.updateForm({ formId: params.id, patch: await readJson(req), user, ip }));
});

route.put('/api/forms/:id/questions', async ({ req, user, params, ip, sendJson }) => {
  const b = await readJson(req);
  if (!Array.isArray(b.questions)) throw new HttpError(400, 'В запросе нет списка вопросов');
  sendJson(200, forms.saveQuestions({ formId: params.id, questions: b.questions, user, ip }));
});

route.post('/api/forms/:id/publish', async ({ user, params, ip, sendJson }) => {
  sendJson(200, forms.publishForm({ formId: params.id, user, ip }));
});

route.post('/api/forms/:id/status', async ({ req, user, params, ip, sendJson }) => {
  const b = await readJson(req);
  sendJson(200, forms.setStatus({ formId: params.id, status: b.status, user, ip }));
});

route.post('/api/forms/:id/duplicate', async ({ user, params, ip, sendJson }) => {
  sendJson(201, forms.duplicateForm({ formId: params.id, user, ip }));
});

route.delete('/api/forms/:id', async ({ user, params, ip, sendJson }) => {
  sendJson(200, forms.deleteForm({ formId: params.id, user, ip }));
});

// ─────────────────────────────────────────────────────────────
// Заполнение
// ─────────────────────────────────────────────────────────────
route.post('/api/forms/:id/responses', async ({ req, user, params, ip, sendJson }) => {
  const form = found(forms.getForm(params.id));
  const b = await readJson(req);
  sendJson(201, forms.submitResponse({
    form, user, answers: b.answers ?? {}, responseId: b.response_id ?? null, source: 'portal', ip,
  }));
});

route.put('/api/forms/:id/draft', async ({ req, user, params, ip, sendJson }) => {
  const form = found(forms.getForm(params.id));
  const b = await readJson(req);
  sendJson(200, forms.saveResponseDraft({ form, user, answers: b.answers ?? {}, ip }));
});

// ─────────────────────────────────────────────────────────────
// Результаты
// ─────────────────────────────────────────────────────────────
const withResults = (user, id) => {
  const form = found(forms.getForm(id));
  if (!forms.canSeeResults(user, form)) throw new HttpError(403, 'Результаты видны только автору формы');
  return form;
};

route.get('/api/forms/:id/results', async ({ user, params, sendJson }) => {
  sendJson(200, forms.results(withResults(user, params.id).id));
});

route.get('/api/forms/:id/responses', async ({ user, params, sendJson }) => {
  sendJson(200, forms.responseTable(withResults(user, params.id).id));
});

route.get('/api/forms/:id/export', async ({ user, params, ip, res }) => {
  const form = withResults(user, params.id);
  const csv = forms.toCsv(form.id);
  const name = `social1-${form.slug}-${new Date().toISOString().slice(0, 10)}.csv`;
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${name}"`,
  });
  res.end(csv);
});

// ─────────────────────────────────────────────────────────────
// Заполнение по ссылке, без входа в систему
// ─────────────────────────────────────────────────────────────
// Отдаётся ровно то, что нужно показать анкету: ни счётчика ответов, ни настроек,
// ни того, кто её ведёт лично. Форма, открытая только участникам платформы, по
// этим маршрутам не отдаётся вовсе.
const publicView = (form) => ({
  slug: form.slug,
  title: form.title,
  description: form.description,
  closing_text: form.closing_text,
  show_progress: form.show_progress,
  is_anonymous: true,
  status: form.status,
  is_open: forms.isOpen(form),
  closes_at: form.closes_at,
  owner: form.author_institution || 'ДТСЗН города Москвы',
  questions: forms.questionsOf(form.id),
});

function publicForm(slug) {
  const form = forms.getFormBySlug(slug);
  if (!form || form.status === 'draft' || form.access !== 'link') {
    throw new HttpError(404, 'Форма не найдена или доступна только участникам платформы');
  }
  return form;
}

route.get('/api/public/forms/:slug', async ({ params, sendJson }) => {
  sendJson(200, publicView(publicForm(params.slug)));
}, { public: true });

route.post('/api/public/forms/:slug/responses', async ({ req, params, ip, sendJson }) => {
  const form = publicForm(params.slug);
  const b = await readJson(req);
  const saved = forms.submitResponse({ form, user: null, answers: b.answers ?? {}, source: 'link', ip });
  sendJson(201, { ok: true, id: saved.id, closing_text: form.closing_text });
}, { public: true });
