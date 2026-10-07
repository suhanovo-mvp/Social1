// Рецензирование требований: API /api/prd для страницы «Требования к платформе»
// и панели рецензента внутри портала. Единственное место, где собраны модель PRD,
// результаты тестов, хранилище рецензий, почта и выгрузки.
//
// Рецензии хранятся в отдельной базе var/prd.db, а не в data/social1.db: демо-данные
// портала пересоздаются (npm run reset), а отзывы рецензентов терять нельзя.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrdApi, watchJson, configFromEnv, nodeAdapter } from './lib/prd-server.js';
import { createSqlStore, sqliteQuery } from './lib/store.js';
import { createDevMailer, mailerFromEnv } from './lib/mailer.js';
import { createExporters } from './lib/exporters.js';
import { PRD } from './prd.js';
import { RELEASES } from './releases.js';
import { userFromToken, can } from '../server/auth.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const VAR = process.env.PRD_DATA_DIR || join(ROOT, 'var');
mkdirSync(VAR, { recursive: true });
const production = process.env.NODE_ENV === 'production';

// Секрет подписывает cookie рецензента и коды из писем. В эксплуатации он задаётся
// переменной PRD_SECRET; локально заводится один раз и хранится рядом с базой
// рецензий, чтобы перезапуск сервера не выкидывал рецензентов из сессии.
function secret() {
  if (process.env.PRD_SECRET) return process.env.PRD_SECRET;
  if (production) throw new Error('PRD review: задайте PRD_SECRET (не короче 16 символов)');
  const file = join(VAR, 'prd-secret');
  if (!existsSync(file)) writeFileSync(file, randomBytes(24).toString('base64url'), { mode: 0o600 });
  return readFileSync(file, 'utf8').trim();
}

export const prdApi = createPrdApi({
  prd: PRD,
  releases: RELEASES,
  tests: watchJson(join(HERE, 'test-results.json')),
  lock: watchJson(join(HERE, 'prd.lock.json')),
  store: createSqlStore({ query: sqliteQuery(new DatabaseSync(join(VAR, 'prd.db'))), dialect: 'sqlite' }),
  mailer: mailerFromEnv() ?? (production ? null : createDevMailer()),
  exporters: createExporters({
    fonts: { regular: join(HERE, 'fonts/Regular.ttf'), bold: join(HERE, 'fonts/Bold.ttf') },
    screensDir: join(HERE, 'screens'),
  }),
  config: {
    ...configFromEnv(),
    secret: secret(),
    // Администратор портала (право admin) администрирует и рецензии — без второго входа
    // по коду. Проверка идёт по серверной сессии портала, а не по флагу из браузера.
    externalAdmin: (req) => {
      const user = userFromToken(req.cookies?.s1);
      return Boolean(user && can(user, 'admin'));
    },
    externalAdminName: 'Администратор платформы',
    // Участник, вошедший в портал, рецензирует под своим именем — без кода из письма
    externalReviewer: (req) => {
      const user = userFromToken(req.cookies?.s1);
      return user ? { email: user.email, name: user.full_name } : null;
    },
  },
});

export const prdHandler = nodeAdapter(prdApi, { mount: '/api/prd' });
