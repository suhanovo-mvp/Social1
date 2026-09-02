// Точка входа клиента: инициализация, маршрутизация, рендеринг разделов.
import { api, state, html, esc, refreshMe, onRoute, startRouter, navigate,
         currentRoute, initTheme, toast } from './core.js';
import { renderShell, bindShell, renderLogin } from './shell.js';
import { dashboard, tasksView } from './views/dashboard.js';
import { initiativesList, initiativeDetail, initiativeCreate } from './views/initiatives.js';
import { ideasBoard } from './views/ideas.js';
import { analyticsView, slaView } from './views/analytics.js';
import { projectsList, projectDetail } from './views/projects.js';
import { pilotsList, pilotDetail, surveyDetail } from './views/pilots.js';
import { communityView, topicDetail, practicesView, profileView, processView } from './views/community.js';
import { processesView } from './views/processes.js';
import { adminView } from './views/admin.js';

const root = document.getElementById('root');

// Таблица маршрутов: шаблон → заголовок и обработчик
const ROUTES = [
  [/^\/$/,                    'Рабочий стол',            (v) => dashboard(v)],
  [/^\/tasks$/,               'Мои задачи',              (v) => tasksView(v)],
  [/^\/ideas$/,               'Доска идей',              (v, m, q) => ideasBoard(v, q)],
  [/^\/initiatives$/,         'Инициативы',              (v, m, q) => initiativesList(v, q)],
  [/^\/initiatives\/new$/,    'Подать инициативу',       (v) => initiativeCreate(v)],
  [/^\/initiatives\/(\d+)$/,  'Инициатива',              (v, m) => initiativeDetail(v, m[1])],
  [/^\/process$/,             'Процесс Stage-Gate',      (v) => processView(v)],
  [/^\/processes$/,           'Схемы процессов',         (v, m, q) => processesView(v, q)],
  [/^\/projects$/,            'Разработка прототипов',   (v) => projectsList(v)],
  [/^\/projects\/(\d+)$/,     'Проект разработки',       (v, m) => projectDetail(v, m[1])],
  [/^\/pilots$/,              'Пилотирование',           (v) => pilotsList(v)],
  [/^\/pilots\/(\d+)$/,       'Пилотный проект',         (v, m) => pilotDetail(v, m[1])],
  [/^\/surveys\/(\d+)$/,      'Опрос',                   (v, m) => surveyDetail(v, m[1])],
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
