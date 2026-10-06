// Проверки, которые ловят поломки сборки целиком, а не поведение отдельного модуля.
// Тесты предметных модулей подключают лишь часть кода, поэтому оборванный импорт
// в слое API проходил мимо них и обнаруживался только при запуске сервера.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DIR = mkdtempSync(join(tmpdir(), 'social1-smoke-'));
process.env.SOCIAL1_DB = join(DIR, 'test.db');
process.on('exit', () => rmSync(DIR, { recursive: true, force: true }));

const ROOT = new URL('..', import.meta.url);
const listing = (dir) => readdirSync(new URL(dir, ROOT)).filter((f) => f.endsWith('.js'));

describe('Целостность сборки', () => {
  test('каждый серверный модуль загружается', async () => {
    // index.js исключён: он поднимает сервер и фоновые таймеры
    const files = listing('server/').filter((f) => f !== 'index.js' && f !== 'seed.js');
    for (const f of files) {
      await assert.doesNotReject(() => import(new URL(`server/${f}`, ROOT).href),
        `server/${f} не загружается`);
    }
    for (const f of listing('server/api/')) {
      await assert.doesNotReject(() => import(new URL(`server/api/${f}`, ROOT).href),
        `server/api/${f} не загружается`);
    }
    assert.ok(files.length >= 10, 'список серверных модулей подозрительно короткий');
  });

  test('каждый общий модуль загружается', async () => {
    for (const f of listing('shared/bpmn/')) {
      await assert.doesNotReject(() => import(new URL(`shared/bpmn/${f}`, ROOT).href),
        `shared/bpmn/${f} не загружается`);
    }
  });

  // Клиентские модули не подключаются ни одним тестом: они грузят DOM и общие
  // модули по адресам браузера. Разбор без запуска ловит опечатку до того, как
  // она станет пустым экраном у пользователя.
  test('каждый клиентский модуль разбирается', () => {
    const files = [
      ...listing('web/js/').map((f) => `web/js/${f}`),
      ...listing('web/js/views/').map((f) => `web/js/views/${f}`),
    ];
    assert.ok(files.length >= 12, 'список клиентских модулей подозрительно короткий');
    for (const rel of files) {
      const path = fileURLToPath(new URL(rel, ROOT));
      assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' }),
        `${rel} не разбирается`);
    }
  });

  // Новую таблицу легко завести и забыть добавить в очистку: тогда «npm run reset»
  // оставит на новых демонстрационных данных чужие записи от прошлого запуска.
  test('каждая таблица учтена в очистке сида', async () => {
    const { db } = await import('../server/db.js');
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
      .map((r) => r.name);
    const seed = readFileSync(new URL('server/seed.js', ROOT), 'utf8');
    const cleared = new Set([...seed.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
    // Журнал аудита неизменяем по замыслу и очистку переживает.
    // Служебные таблицы полнотекстового индекса создаются и чистятся самим FTS5
    // через search_index — перечислять их в сиде не нужно.
    const exempt = new Set(['audit_log']);
    const missing = tables.filter((t) => !cleared.has(t) && !exempt.has(t)
      && !/^search_index_/.test(t));
    assert.deepEqual(missing, [], `таблицы не попали в очистку сида: ${missing.join(', ')}`);
  });

  // Сущность переименована в «социального советника». Прежнее слово легко вернуть
  // копированием старого куска текста, и разнобой в названии роли заметят не сразу.
  test('прежнее название сущности не вернулось в исходники', () => {
    const files = [
      ...listing('server/').map((f) => `server/${f}`),
      ...listing('server/api/').map((f) => `server/api/${f}`),
      ...listing('web/js/').map((f) => `web/js/${f}`),
      ...listing('web/js/views/').map((f) => `web/js/views/${f}`),
      'README.md', 'docs/ideas-user-guide.md', 'docs/ideas-admin-guide.md',
    ];
    const found = [];
    for (const rel of files) {
      const src = readFileSync(new URL(rel, ROOT), 'utf8');
      // Сам механизм переименования обязан упоминать прежнее слово
      if (rel === 'server/ideahub.js') continue;
      for (const line of src.split('\n')) {
        if (/[Сс]оветчик/.test(line)) found.push(`${rel}: ${line.trim().slice(0, 80)}`);
      }
    }
    assert.deepEqual(found, [], `прежнее название встречается: \n${found.join('\n')}`);
  });

  test('маршруты API зарегистрированы и не дублируются', async () => {
    const { routes } = await import('../server/http.js');
    assert.ok(routes.length > 40, `маршрутов подозрительно мало: ${routes.length}`);
    const seen = new Set();
    for (const r of routes) {
      const key = `${r.method} ${r.rx.source}`;
      assert.ok(!seen.has(key), `маршрут объявлен дважды: ${key}`);
      seen.add(key);
    }
  });
});
