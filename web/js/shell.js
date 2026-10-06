// Экран входа, боковая навигация, шапка.
import { api, state, esc, html, avatar, can, navigate, toast, ROLE_TITLES, ROLE_SHORT,
         applyTheme, refreshMe, currentRoute } from './core.js';

const ICONS = {
  dashboard: '<path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/>',
  initiatives: '<path d="M9 18h6M10 22h4M12 2a7 7 0 00-4 12.7V17h8v-2.3A7 7 0 0012 2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  ideas: '<path d="M7 10l5-5 5 5M12 5v9M5 19h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  tasks: '<path d="M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  board: '<path d="M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  pilots: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  analytics: '<path d="M3 3v18h18M7 15l3-4 3 3 5-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  community: '<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  practices: '<path d="M4 19.5A2.5 2.5 0 016.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  admin: '<path d="M12 15a3 3 0 100-6 3 3 0 000 6z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 008 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9v0a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  sla: '<path d="M12 22a10 10 0 100-20 10 10 0 000 20zM12 6v6l4 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  process: '<path d="M4 4h6v6H4zM14 14h6v6h-6zM10 7h4a2 2 0 012 2v5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  bpmn: '<path d="M3 5h6v5H3zM15 3h6v5h-6zM15 16h6v5h-6zM9 7.5h6M12 7.5v11h3M9 7.5v11h3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>',
  rating: '<path d="M12 15a6 6 0 100-12 6 6 0 000 12zM8.2 13.5L7 22l5-3 5 3-1.2-8.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  changes: '<path d="M4 6h9M4 6l3-3M4 6l3 3M20 18h-9M20 18l-3-3M20 18l-3 3M15 4.5h5v5M9 19.5H4v-5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
  knowledge: '<path d="M4 5.5A1.5 1.5 0 015.5 4H11v16H5.5A1.5 1.5 0 014 18.5v-13zM20 5.5A1.5 1.5 0 0018.5 4H13v16h5.5a1.5 1.5 0 001.5-1.5v-13zM7 8h2M7 11h2M15 8h2M15 11h2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  review: '<path d="M4 7.5l7-3.2a2 2 0 011.7 0l7 3.2M6.5 9v9.5a1.5 1.5 0 001.5 1.5h8a1.5 1.5 0 001.5-1.5V9M9.5 13.5l1.8 1.8 3.4-3.6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
  moderation: '<path d="M12 3l8 3v6c0 4.5-3.2 7.9-8 9-4.8-1.1-8-4.5-8-9V6l8-3zM9 12l2 2 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  forms: '<path d="M6.5 4.5h11v15h-11zM9.5 3h5v3h-5zM9.5 11h5M9.5 15h3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>',
  providers: '<path d="M4 20V9l4-3 4 3v11M12 20V5l4-2 4 2v15M2 20h20M7 12h2M7 16h2M15 8h2M15 12h2M15 16h2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  incentives: '<path d="M20 12v9H4v-9M2 7h20v5H2zM12 21V7M12 7H7.5a2.5 2.5 0 010-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 000-5C13 2 12 7 12 7z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>',
};
const icon = (name) => html`<svg class="nav__icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${ICONS[name] || ''}</svg>`;

function navItems() {
  const groups = [
    { label: 'Работа', items: [
      { path: '/', title: 'Рабочий стол', icon: 'dashboard' },
      { path: '/tasks', title: 'Мои задачи', icon: 'tasks', badge: state.counts.tasks, alert: true },
      { path: '/ideas', title: 'Идеи и решения', icon: 'ideas' },
      { path: '/initiatives', title: 'Реестр инициатив', icon: 'initiatives' },
    ]},
    { label: 'Вклад сотрудников', items: [
      ...(can('idea.review') ? [{ path: '/review', title: 'Ревью предложений', icon: 'review' }] : []),
      { path: '/rating', title: 'Рейтинг социальных советников', icon: 'rating' },
      ...(can('idea.moderate') ? [{ path: '/moderation', title: 'Модерация идей', icon: 'moderation' }] : []),
      ...(can('idea.incentive') ? [{ path: '/incentives', title: 'Поощрения', icon: 'incentives' }] : []),
    ]},
    { label: 'Жизненный цикл', items: [
      { path: '/process', title: 'Процесс Stage-Gate', icon: 'process' },
      { path: '/processes', title: 'Схемы процессов', icon: 'bpmn' },
      ...(can('process.propose') || can('process.approve')
        ? [{ path: '/changes', title: 'Изменения процессов', icon: 'changes' }] : []),
      ...(can('doc.read') ? [{ path: '/knowledge', title: 'База знаний', icon: 'knowledge' }] : []),
      ...(can('project.manage') || can('board.manage') || can('project.contribute')
        ? [{ path: '/projects', title: 'Разработка', icon: 'board' }] : []),
      ...(can('provider.read') ? [{ path: '/providers', title: 'Каталог разработчиков ИИ-решений', icon: 'providers' }]
        // Представитель разработчика видит не каталог, а только карточку своей компании
        : can('provider.self') ? [{ path: '/providers', title: 'Моя компания в каталоге', icon: 'providers' }] : []),
      { path: '/pilots', title: 'Пилотирование', icon: 'pilots' },
      { path: '/practices', title: 'Лучшие практики', icon: 'practices' },
    ]},
    { label: 'Анализ и сообщество', items: [
      { path: '/forms', title: 'Формы и опросы', icon: 'forms' },
      { path: '/analytics', title: 'Аналитика и КПЭ', icon: 'analytics' },
      ...(can('analytics.all') || can('analytics.institution')
        ? [{ path: '/sla', title: 'Контроль SLA', icon: 'sla' }] : []),
      { path: '/community', title: 'Сообщество', icon: 'community' },
    ]},
  ];
  if (can('admin')) {
    groups.push({ label: 'Администрирование', items: [{ path: '/admin', title: 'Настройки платформы', icon: 'admin' }] });
  }
  return groups;
}

export function renderShell(content, { title = '' } = {}) {
  const route = currentRoute();
  // Точное совпадение либо вложенный путь: иначе /process подсвечивал бы и /processes
  const active = (p) => p === '/' ? route.path === '/' : (route.path === p || route.path.startsWith(p + '/'));
  return html`
  <div class="app">
    <aside class="sidebar" id="sidebar">
      <div class="sidebar__brand">
        <div class="sidebar__mark">S1</div>
        <div>Social1<div class="sidebar__role">${esc(ROLE_SHORT[state.user.role] || '')}</div></div>
      </div>
      <nav class="nav">
        ${navItems().map((g) => html`
          <div class="nav__group">
            <div class="nav__label">${esc(g.label)}</div>
            ${g.items.map((i) => html`
              <a href="${i.path}" data-nav="${i.path}" class="nav__item ${active(i.path) ? 'is-active' : ''}">
                ${icon(i.icon)}<span>${esc(i.title)}</span>
                ${i.badge ? `<span class="nav__badge ${i.alert ? 'nav__badge--alert' : ''}">${i.badge}</span>` : ''}
              </a>`)}
          </div>`)}
      </nav>
      <div class="sidebar__user">
        <a href="/profile/${state.user.id}" title="Мой профиль">${avatar(state.user.full_name)}</a>
        <div class="sidebar__user-info">
          <b>${esc(state.user.full_name)}</b>
          <small>${esc(state.user.institution_short || ROLE_TITLES[state.user.role])}</small>
        </div>
        <button class="icon-btn" data-logout title="Выйти из системы" aria-label="Выйти">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>
        </button>
      </div>
    </aside>
    <div class="main">
      <header class="header">
        <button class="icon-btn burger" data-burger aria-label="Меню">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
        </button>
        <div class="header__title">${esc(title)}</div>
        <div class="header__search">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
            stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
          <input type="search" placeholder="Поиск инициатив…" id="global-search" aria-label="Поиск инициатив">
        </div>
        <button class="icon-btn" data-notifications title="Уведомления" aria-label="Уведомления">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0"/></svg>
          ${state.counts.notifications ? '<span class="dot"></span>' : ''}
        </button>
        <button class="icon-btn tour-launch" data-tour-launch title="Интерактивное обучение" aria-label="Интерактивное обучение">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/>
            <path d="M9.1 9a3 3 0 015.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>
        </button>
        <button class="icon-btn" data-theme-toggle title="Сменить оформление" aria-label="Сменить оформление">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/></svg>
        </button>
      </header>
      <main class="content" id="view">${content}</main>
    </div>
  </div>`;
}

export function bindShell(root) {
  root.querySelector('[data-logout]')?.addEventListener('click', async () => {
    await api.post('/api/auth/logout');
    state.user = null;
    navigate('/login');
  });
  root.querySelector('[data-theme-toggle]')?.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });
  const sidebar = root.querySelector('#sidebar');
  root.querySelector('[data-burger]')?.addEventListener('click', () => {
    sidebar.classList.add('is-open');
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.onclick = () => { sidebar.classList.remove('is-open'); scrim.remove(); };
    root.querySelector('.app').append(scrim);
  });
  root.querySelectorAll('.nav__item').forEach((a) => a.addEventListener('click', () => {
    sidebar.classList.remove('is-open');
    root.querySelector('.scrim')?.remove();
  }));
  const search = root.querySelector('#global-search');
  search?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.value.trim()) {
      navigate(`/initiatives?q=${encodeURIComponent(e.target.value.trim())}`);
      e.target.value = '';
    }
  });
  root.querySelector('[data-notifications]')?.addEventListener('click', showNotifications);

  const launcher = root.querySelector('[data-tour-launch]');
  if (launcher) {
    launcher.addEventListener('click', async () => (await import('./tour.js')).openTourCatalog());
    // Точка на кнопке подсказывает, что есть непройденные сценарии
    import('./tour.js').then(({ toursForRole, completedTours }) => {
      const done = completedTours();
      launcher.classList.toggle('has-new', toursForRole(state.user.role).some((s) => !done.includes(s.id)));
    });
  }
}

async function showNotifications() {
  const { modal, fmtAgo } = await import('./core.js');
  const items = await api.get('/api/notifications');
  // Уведомление ведёт в карточку инициативы, идеи или разработчика ИИ-решений
  const target = (n) => n.initiative_id ? `/initiatives/${n.initiative_id}`
    : n.idea_id ? `/ideas/${n.idea_id}`
    : n.provider_id ? `/providers/${n.provider_id}` : null;
  const body = items.length ? html`<div class="list">
    ${items.map((n) => html`
      <div class="list__item ${n.is_read ? '' : 'is-unread'} ${target(n) ? 'is-clickable' : ''}"
           ${target(n) ? `data-goto="${target(n)}"` : ''}>
        <div class="list__main">
          <div class="list__title">${esc(n.title)}</div>
          ${n.body ? `<div class="list__body">${esc(n.body)}</div>` : ''}
          <div class="list__meta"><span>${fmtAgo(n.created_at)}</span>
            ${n.number ? `<span class="mono">${esc(n.number)}</span>` : ''}</div>
        </div>
      </div>`)}
  </div>` : '<div class="empty"><h4>Уведомлений нет</h4><p>Здесь появятся оповещения о ваших идеях, начисленных очках и решениях на Gate.</p></div>';

  modal({
    title: 'Уведомления', body, wide: false,
    footer: items.length ? '<button class="btn" data-read-all>Отметить всё прочитанным</button>' : '',
    onMount: (el, close) => {
      el.querySelector('[data-read-all]')?.addEventListener('click', async () => {
        await api.post('/api/notifications/read', {});
        await refreshMe(); close(); navigate(currentRoute().path);
      });
      el.querySelectorAll('[data-goto]').forEach((n) => n.addEventListener('click', () => {
        close(); navigate(n.dataset.goto);
      }));
    },
  });
}

// ── Экран входа ──────────────────────────────────────────────
export async function renderLogin(root) {
  let accounts = [];
  try { accounts = await api.get('/api/auth/demo-accounts'); } catch {}
  root.innerHTML = html`
  <div class="login">
    <div class="login__hero">
      <div class="login__brand"><div class="login__mark">S1</div>Social1</div>
      <div class="login__lead">
        <h1>От проблемы на рабочем месте — до внедрённого решения</h1>
        <p>Экосистема ускоренного выявления, разработки, тестирования и внедрения инициатив
        сотрудников учреждений ДТСЗН. Конечный продукт платформы — не база предложений,
        а поток реально внедрённых улучшений социальных услуг и процессов.</p>
        <div class="login__flow">
          <span>Проблема</span><span>Инициатива</span><span>Экспертиза</span>
          <span>Прототип</span><span>Пилот</span><span>Эффект</span><span>Масштабирование</span>
        </div>
      </div>
      <div class="login__foot">Департамент труда и социальной защиты населения города Москвы</div>
    </div>
    <div class="login__panel">
      <form class="login__form" id="login-form">
        <h2>Вход в платформу</h2>
        <p>Используйте служебную учётную запись</p>
        <div class="field">
          <label class="field__label" for="email">Электронная почта</label>
          <input class="input" type="email" id="email" name="email" required autocomplete="username"
                 placeholder="familia@social1.mos.ru">
        </div>
        <div class="field">
          <label class="field__label" for="password">Пароль</label>
          <input class="input" type="password" id="password" name="password" required
                 autocomplete="current-password" placeholder="••••••••">
        </div>
        <button class="btn btn--primary btn--block" type="submit">Войти</button>
        <div id="login-error" style="margin-top:12px"></div>
        ${accounts.length ? html`
        <div class="demo">
          <div class="demo__title">Демонстрационный доступ — выберите роль</div>
          <div class="demo__list">
            ${accounts.map((a) => html`
              <button type="button" class="demo__item" data-email="${esc(a.email)}">
                ${avatar(a.full_name, 'avatar--sm')}
                <span style="min-width:0">
                  <b>${esc(a.role_title)}</b>
                  <small>${esc(a.full_name)}${a.institution ? ' · ' + esc(a.institution) : ''}</small>
                </span>
              </button>`)}
          </div>
        </div>` : ''}
      </form>
    </div>
  </div>`;

  const form = root.querySelector('#login-form');
  const errBox = root.querySelector('#login-error');
  root.querySelectorAll('.demo__item').forEach((b) => b.addEventListener('click', () => {
    form.email.value = b.dataset.email;
    form.password.value = 'social1';
    form.requestSubmit();
  }));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.innerHTML = '';
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Проверка…';
    try {
      await api.post('/api/auth/login', { email: form.email.value, password: form.password.value });
      await refreshMe();
      navigate('/');
    } catch (err) {
      errBox.innerHTML = `<div class="badge badge--danger" style="white-space:normal">${esc(err.message)}</div>`;
      btn.disabled = false; btn.textContent = 'Войти';
    }
  });
}
