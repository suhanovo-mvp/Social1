// Точка входа клиента: инициализация, маршрутизация, рендеринг разделов.
import { api, state, html, esc, refreshMe, onRoute, startRouter, navigate,
         currentRoute, initTheme, toast } from './core.js';
import { renderShell, bindShell, renderLogin } from './shell.js';
import { dashboard, tasksView } from './views/dashboard.js';
import { initiativesList, initiativeDetail, initiativeCreate } from './views/initiatives.js';
import { ideasBoard, ideaCreate, ideaDetail } from './views/ideas.js';
import { ratingView, moderationView, incentivesView } from './views/rating.js';
import { reviewView } from './views/review.js';
import { analyticsView, slaView } from './views/analytics.js';
import { projectsList, projectDetail } from './views/projects.js';
import { pilotsList, pilotDetail, surveyDetail } from './views/pilots.js';
import { communityView, topicDetail, practicesView, profileView, processView } from './views/community.js';
import { processesView } from './views/processes.js';
import { changesBoard, changeDetail, changeEditor } from './views/changes.js';
import { knowledgeView, documentView } from './views/knowledge.js';
import { formsList, formEditor } from './views/forms.js';
import { formFill, publicForm } from './views/form-fill.js';
import { formResults } from './views/form-results.js';
import { providersView, providerDetail, providerEditor } from './views/providers.js';
import { adminView } from './views/admin.js';

const root = document.getElementById('root');

// Таблица маршрутов: шаблон → заголовок и обработчик
const ROUTES = [
  [/^\/$/,                    'Рабочий стол',            (v) => dashboard(v)],
  [/^\/tasks$/,               'Мои задачи',              (v) => tasksView(v)],
  [/^\/ideas$/,               'Идеи и решения',          (v, m, q) => ideasBoard(v, q)],
  [/^\/ideas\/new$/,          'Новая идея',              (v) => ideaCreate(v)],
  [/^\/ideas\/(\d+)$/,        'Идея',                    (v, m) => ideaDetail(v, m[1])],
  [/^\/review$/,              'Ревью предложений',       (v, m, q) => reviewView(v, q)],
  [/^\/rating$/,              'Рейтинг социальных советников',      (v, m, q) => ratingView(v, q)],
  [/^\/moderation$/,          'Модерация идей',          (v, m, q) => moderationView(v, q)],
  [/^\/incentives$/,          'Рекомендации к поощрению',(v, m, q) => incentivesView(v, q)],
  [/^\/initiatives$/,         'Инициативы',              (v, m, q) => initiativesList(v, q)],
  [/^\/initiatives\/new$/,    'Подать инициативу',       (v) => initiativeCreate(v)],
  [/^\/initiatives\/(\d+)$/,  'Инициатива',              (v, m) => initiativeDetail(v, m[1])],
  [/^\/process$/,             'Процесс Stage-Gate',      (v) => processView(v)],
  [/^\/processes$/,           'Схемы процессов',         (v, m, q) => processesView(v, q)],
  [/^\/changes$/,              'Изменения процессов',     (v, m, q) => changesBoard(v, q)],
  [/^\/changes\/(\d+)$/,        'Предложение об изменении',(v, m) => changeDetail(v, m[1])],
  [/^\/changes\/(\d+)\/edit$/,   'Правка схемы процесса',   (v, m) => changeEditor(v, m[1])],
  [/^\/knowledge$/,           'База знаний',             (v, m, q) => knowledgeView(v, q)],
  [/^\/knowledge\/(\d+)$/,     'Документ базы знаний',    (v, m) => documentView(v, m[1])],
  [/^\/projects$/,            'Разработка прототипов',   (v) => projectsList(v)],
  [/^\/projects\/(\d+)$/,     'Проект разработки',       (v, m) => projectDetail(v, m[1])],
  [/^\/pilots$/,              'Пилотирование',           (v) => pilotsList(v)],
  [/^\/pilots\/(\d+)$/,       'Пилотный проект',         (v, m) => pilotDetail(v, m[1])],
  [/^\/surveys\/(\d+)$/,      'Опрос',                   (v, m) => surveyDetail(v, m[1])],
  [/^\/forms$/,               'Формы и опросы',          (v, m, q) => formsList(v, q)],
  [/^\/forms\/(\d+)$/,         'Конструктор формы',       (v, m) => formEditor(v, m[1])],
  [/^\/forms\/(\d+)\/fill$/,    'Заполнение формы',        (v, m) => formFill(v, m[1])],
  [/^\/forms\/(\d+)\/results$/, 'Результаты формы',        (v, m, q) => formResults(v, m[1], q)],
  [/^\/providers$/,           'Каталог разработчиков ИИ-решений',  (v, m, q) => providersView(v, q)],
  [/^\/providers\/new$/,      'Новый разработчик',       (v) => providerEditor(v, null)],
  [/^\/providers\/(\d+)$/,    'Разработчик ИИ-решений',             (v, m, q) => providerDetail(v, m[1], q)],
  [/^\/providers\/(\d+)\/edit$/, 'Редактирование разработчика', (v, m) => providerEditor(v, m[1])],
  [/^\/analytics$/,           'Аналитика и КПЭ',         (v, m, q) => analyticsView(v, q)],
  [/^\/sla$/,                 'Контроль SLA',            (v) => slaView(v)],
  [/^\/community$/,           'Сообщество',              (v, m, q) => communityView(v, q)],
  [/^\/community\/(\d+)$/,    'Обсуждение',              (v, m) => topicDetail(v, m[1])],
  [/^\/practices$/,           'Лучшие практики',         (v) => practicesView(v)],
  [/^\/profile\/(\d+)$/,      'Профиль участника',       (v, m) => profileView(v, m[1])],
  [/^\/admin$/,               'Настройки платформы',     (v, m, q) => adminView(v, q)],
];

let lastShellKey = null;

async function render(route) {
  // Форма, открытая по ссылке, живёт до входа в систему: её заполняют сотрудники
  // учреждений, у которых учётной записи в Social1 может и не быть. Страница
  // рисуется без каркаса портала — на ней нет ничего, кроме самой анкеты.
  if (route.path.startsWith('/f/')) {
    lastShellKey = null;
    await publicForm(root, route.path.slice(3));
    return;
  }

  // Экран входа
  if (!state.user) {
    if (route.path !== '/login') { navigate('/login', true); return; }
    lastShellKey = null;
    await renderLogin(root);
    return;
  }
  if (route.path === '/login') { navigate('/', true); return; }

  // Справочник этапов нужен большинству разделов — загружаем при первом обращении
  if (!state.stages.length) {
    try { state.stages = await api.get('/api/workflow/stages'); } catch {}
  }

  const match = ROUTES.find(([rx]) => rx.test(route.path));
  const [, title, handler] = match || [null, 'Раздел не найден', notFound];
  const params = match ? route.path.match(match[0]) : [];

  // Каркас перерисовывается только при смене пользователя или счётчиков
  const shellKey = `${state.user.id}:${state.counts.tasks}:${state.counts.notifications}:${route.path}`;
  if (lastShellKey !== shellKey) {
    root.innerHTML = renderShell('<div class="skeleton" style="height:60vh"></div>', { title });
    bindShell(root);
    lastShellKey = shellKey;
  } else {
    root.querySelector('.header__title').textContent = title;
  }

  const view = root.querySelector('#view');
  try {
    await handler(view, params, route.query);
  } catch (err) {
    if (err.status === 401) { state.user = null; navigate('/login', true); return; }
    view.innerHTML = html`
      <div class="card"><div class="empty">
        <h4>Не удалось загрузить раздел</h4>
        <p>${esc(err.message || 'Неизвестная ошибка')}</p>
        <button class="btn" onclick="location.reload()" style="margin-top:14px">Обновить страницу</button>
      </div></div>`;
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function notFound(view) {
  view.innerHTML = html`
    <div class="card"><div class="empty">
      <h4>Раздел не найден</h4>
      <p>Проверьте адрес страницы или вернитесь на рабочий стол.</p>
      <a href="/" class="btn btn--primary" style="margin-top:14px">На рабочий стол</a>
    </div></div>`;
}

async function boot() {
  initTheme();
  await refreshMe();
  if (state.user) {
    try { state.stages = await api.get('/api/workflow/stages'); } catch {}
  }
  onRoute(render);
  startRouter();

  if (state.user) {
    const { offerFirstRun } = await import('./tour.js');
    offerFirstRun();
  }

  // Периодическое обновление счётчиков задач и уведомлений
  setInterval(async () => {
    if (!state.user) return;
    const before = `${state.counts.tasks}:${state.counts.notifications}`;
    await refreshMe();
    if (state.user && `${state.counts.tasks}:${state.counts.notifications}` !== before) {
      lastShellKey = null;
      render(currentRoute());
    }
  }, 60000);
}

boot().catch((err) => {
  root.innerHTML = `<div class="boot"><p>Ошибка запуска: ${esc(err.message)}</p></div>`;
});
