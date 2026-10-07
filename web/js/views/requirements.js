// Требования к платформе: PRD с маркерами готовности и рецензиями.
// Страница открыта и без входа в портал — рецензенты со стороны заказчика приходят
// без учётной записи; оценки они оставляют анонимно или подтвердив почту кодом.
import { mountReviewPage } from '/prd/lib/review-ui.js';
import { html } from '../core.js';

const OPTIONS = {
  api: '/api/prd',
  title: 'Требования к платформе Social1',
  intro: 'Каждый критерий приёмки отмечен по результатам автотестов и ручных проверок. '
    + 'Согласитесь с ним или оспорьте — ответ увидит команда платформы.',
};

/** Внутри портала: раздел в общем каркасе. */
export function requirementsView(view) {
  view.innerHTML = '<div class="requirements"></div>';
  mountReviewPage(view.firstElementChild, OPTIONS);
}

/** Без входа: отдельная страница с шапкой и ссылкой на вход. */
export function requirementsPublic(root) {
  root.innerHTML = html`
    <div class="requirements-public">
      <header class="requirements-public__bar">
        <span class="sidebar__mark">S1</span>
        <b>Social1</b>
        <span class="requirements-public__sub">платформа системных инноваций ДТСЗН</span>
        <a href="/login" class="btn btn--sm">Войти в портал</a>
      </header>
      <main class="requirements-public__body"><div class="requirements"></div></main>
    </div>`;
  mountReviewPage(root.querySelector('.requirements'), OPTIONS);
}
