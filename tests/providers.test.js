// Каталог разработчиков ИИ-решений: ввод и проверка сведений, фильтры и сортировка,
// сквозной каталог решений и выдача доступа конкретным людям.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DIR = mkdtempSync(join(tmpdir(), 'social1-providers-'));
process.env.SOCIAL1_DB = join(DIR, 'test.db');
process.on('exit', () => rmSync(DIR, { recursive: true, force: true }));

const { q } = await import('../server/db.js');
const auth = await import('../server/auth.js');
const pr = await import('../server/providers.js');

let admin, editor, stranger;
const loadUser = (id) => q.get(`SELECT u.*, (SELECT group_concat(ur.role_code) FROM user_roles ur
                                             WHERE ur.user_id = u.id) AS extra_roles
                                FROM users u WHERE u.id = ?`, id);
const makeUser = (email, role) => {
  const { hash, salt } = auth.hashPassword('test');
  return q.insert(`INSERT INTO users (email, full_name, password_hash, password_salt, role)
                   VALUES (?,?,?,?,?)`, email, email.split('@')[0], hash, salt, role);
};

before(() => {
  auth.ensureRoles();
  admin = loadUser(makeUser('admin@test', 'dtszn'));
  editor = loadUser(makeUser('editor@test', 'employee'));
  stranger = loadUser(makeUser('stranger@test', 'expert'));
});

describe('Доступ к каталогу', () => {
  test('по умолчанию каталог видит только центральный аппарат', () => {
    assert.ok(auth.can(admin, 'provider.read'));
    assert.ok(auth.can(admin, 'provider.admin'));
    for (const role of ['employee', 'head', 'expert', 'developer', 'supplier']) {
      assert.ok(!auth.can({ role }, 'provider.read'), `роль «${role}» не должна видеть каталог`);
    }
  });

  test('выданная роль даёт права, повторная выдача заменяет прежнюю', () => {
    pr.grantAccess(editor.id, 'provider_viewer', admin, '');
    let u = loadUser(editor.id);
    assert.ok(auth.can(u, 'provider.read'));
    assert.ok(!auth.can(u, 'provider.edit'));

    pr.grantAccess(editor.id, 'provider_editor', admin, '');
    u = loadUser(editor.id);
    assert.equal(u.extra_roles, 'provider_editor', 'у человека должна остаться одна роль каталога');
    assert.ok(auth.can(u, 'provider.edit'));
    assert.ok(!auth.can(u, 'provider.admin'));
    assert.ok(pr.accessList().granted.some((g) => g.user_id === editor.id));
  });

  test('поиск сотрудника не зависит от регистра кириллицы', () => {
    q.run("UPDATE users SET full_name = 'Смирнова Ирина' WHERE id = ?", stranger.id);
    assert.ok(pr.accessCandidates('смир').some((u) => u.id === stranger.id));
  });

  test('чужую роль платформы через каталог не выдать', () => {
    assert.throws(() => pr.grantAccess(stranger.id, 'dtszn', admin, ''), /не относится/);
  });

  test('отзыв снимает все роли каталога', () => {
    pr.grantAccess(stranger.id, 'provider_manager', admin, '');
    pr.revokeAccess(stranger.id, admin, '');
    assert.ok(!auth.can(loadUser(stranger.id), 'provider.read'));
  });

  test('администратор каталога по роли не может отозвать доступ у себя', () => {
    pr.grantAccess(stranger.id, 'provider_manager', admin, '');
    const self = loadUser(stranger.id);
    assert.throws(() => pr.revokeAccess(self.id, self, ''), /самого себя/);
    pr.revokeAccess(stranger.id, admin, '');
  });
});

describe('Карточка разработчика', () => {
  test('ввод проверяется, ссылка без схемы дополняется, опасная — отклоняется', () => {
    assert.throws(() => pr.createProvider({ kind: 'external' }, admin, ''), /название/);
    assert.throws(() => pr.createProvider({ kind: 'robots', name: 'X' }, admin, ''), /Вид/);
    assert.throws(() => pr.createProvider({ kind: 'external', name: 'X', inn: '123' }, admin, ''), /ИНН/);
    assert.throws(() => pr.createProvider({ kind: 'external', name: 'X', website: 'javascript:alert(1)' }, admin, ''), /http/);
    const p = pr.createProvider({ kind: 'external', name: 'ООО «Нейросеть»', website: 'neuro.example',
      competencies: ['llm', 'unknown'], tags: 'Python, python, GigaChat' }, admin, '');
    assert.equal(p.website, 'https://neuro.example');
    assert.deepEqual(p.competencies, ['llm'], 'неизвестная компетенция должна отбрасываться');
    assert.deepEqual(p.tags, ['Python', 'GigaChat']);
  });

  test('второй вендор с тем же ИНН не заводится, похожее название распознаётся', () => {
    pr.createProvider({ kind: 'external', name: 'АО «Вектор»', inn: '7701234567' }, admin, '');
    assert.throws(() => pr.createProvider({ kind: 'external', name: 'Другой', inn: '7701234567' }, admin, ''),
      (e) => e.status === 409);
    const dups = pr.findDuplicates({ name: 'ООО Вектор' });
    assert.ok(dups.some((d) => d.reason === 'name'));
  });

  test('у внутренней команды нет ИНН и признака МСП', () => {
    const p = pr.createProvider({ kind: 'internal', name: 'Команда ЦТ', inn: '7701234567',
      org_unit: 'Центр цифровой трансформации', compliance: ['msp', 'pdn'] }, admin, '');
    assert.equal(p.inn, null);
    assert.deepEqual(p.compliance, ['pdn']);
  });

  test('заполненность растёт с портфолио и каталогом', () => {
    const p = pr.createProvider({ kind: 'dit', name: 'Команда ДИТ по ИИ', org_unit: 'Управление ИИ' }, admin, '');
    const before = p.completeness;
    pr.saveCase(p.id, null, { title: 'Ассистент оператора', public_sector: true, year: 2025 }, admin, '');
    pr.saveSolution(p.id, null, { name: 'Распознавание обращений', competencies: ['nlp'], maturity: 'pilot' }, admin, '');
    const after = pr.getProvider(p.id);
    assert.ok(after.completeness > before);
    assert.equal(after.cases_count, 1);
    assert.equal(after.solutions_count, 1);
  });

  test('оценка одна от участника и уточняется', () => {
    const p = pr.listProviders({ kind: 'dit' }).providers[0];
    pr.saveReview(p.id, { quality: 5, deadlines: 3, communication: 4 }, admin, '');
    pr.saveReview(p.id, { quality: 5, deadlines: 5, communication: 5 }, admin, '');
    const after = pr.getProvider(p.id);
    assert.equal(after.reviews.length, 1);
    assert.equal(after.rating, 5);
    assert.throws(() => pr.saveReview(p.id, { quality: 7, deadlines: 1, communication: 1 }, admin, ''));
  });

  test('чужую запись журнала редактор не удалит', () => {
    const p = pr.listProviders({ kind: 'dit' }).providers[0];
    const note = pr.addNote(p.id, { kind: 'meeting', body: 'Обсудили пилот' }, admin, '');
    assert.throws(() => pr.deleteNote(p.id, note.id, editor, false, ''), /свою/);
    pr.deleteNote(p.id, note.id, admin, true, '');
  });
});

describe('Фильтры, сортировка и каталог', () => {
  test('фильтр по виду оставляет счётчики остальных видов', () => {
    const r = pr.listProviders({ kind: 'external' });
    assert.ok(r.providers.every((p) => p.kind === 'external'));
    assert.ok(r.counts.internal >= 1 && r.counts.dit >= 1);
  });

  test('компетенции требуются все сразу', () => {
    const r = pr.listProviders({ competencies: ['llm'] });
    assert.ok(r.providers.length >= 1);
    assert.equal(pr.listProviders({ competencies: ['llm', 'cv'] }).providers.length, 0);
  });

  test('архив скрыт, пока его не выбрали', () => {
    const p = pr.createProvider({ kind: 'external', name: 'Ушедший вендор' }, admin, '');
    pr.setStatus(p.id, 'archived', admin, '');
    assert.ok(!pr.listProviders({}).providers.some((x) => x.id === p.id));
    assert.ok(pr.listProviders({ status: 'archived' }).providers.some((x) => x.id === p.id));
  });

  test('сортировка по названию и по числу проектов', () => {
    const names = pr.listProviders({ sort: 'name' }).providers.map((p) => p.name);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'ru')));
    const byCases = pr.listProviders({ sort: 'cases' }).providers;
    assert.equal(byCases[0].name, 'Команда ДИТ по ИИ');
  });

  test('сквозной каталог находит решение по компетенции', () => {
    const found = pr.listSolutions({ competency: 'nlp' });
    assert.equal(found.length, 1);
    assert.equal(found[0].provider_kind, 'dit');
  });

  test('выгрузка обезвреживает формулы', () => {
    pr.createProvider({ kind: 'external', name: '=HYPERLINK("x")' }, admin, '');
    const csv = pr.exportCsv({});
    assert.ok(csv.startsWith('﻿'));
    assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
  });
});

describe('Демонстрационный набор', () => {
  test('по три разработчика каждого вида, повторный запуск ничего не добавляет, удаление не трогает ручные', async () => {
    const seed = await import('../server/seed-providers.js');
    const { hash, salt } = auth.hashPassword('test');
    q.insert(`INSERT INTO users (email, full_name, password_hash, password_salt, role)
              VALUES ('director@social1.mos.ru','Директор',?,?,'dtszn')`, hash, salt);
    const manual = pr.listProviders({ includeArchived: true }).providers.length;
    assert.equal(seed.seedSampleProviders(), 9);
    assert.equal(seed.seedSampleProviders(), 0);
    const demo = q.all('SELECT kind, COUNT(*) AS c FROM providers WHERE is_demo = 1 GROUP BY kind');
    assert.deepEqual(Object.fromEntries(demo.map((r) => [r.kind, r.c])), { dit: 3, external: 3, internal: 3 });
    assert.ok(pr.listProviders({ stale: true }).providers.some((p) => p.is_demo), 'нужна карточка с меткой «сверить»');
    assert.ok(pr.summary().gaps.includes('recsys'), 'нужна незакрытая компетенция для подсказки о пробелах');
    assert.ok(pr.summary().incomplete >= 1, 'нужна карточка с низкой заполненностью');
    assert.equal(seed.removeSampleProviders(), 9);
    assert.equal(pr.listProviders({ includeArchived: true }).providers.length, manual);
  });
});

describe('Представитель разработчика', () => {
  let rep, card;
  before(() => {
    const { hash, salt } = auth.hashPassword('test');
    rep = loadUser(q.insert(`INSERT INTO users (email, full_name, password_hash, password_salt, role)
                             VALUES ('rep@vendor.example','Представитель',?,?,'supplier')`, hash, salt));
    card = pr.createProvider({ kind: 'external', name: 'ООО «Своя компания»', inn: '7700000099', price_band: 3,
      owner_id: admin.id }, admin, '');
    pr.saveReview(card.id, { quality: 2, deadlines: 2, communication: 2, comment: 'внутреннее' }, admin, '');
  });

  test('поставщик ведёт свою карточку, но не видит каталог', () => {
    assert.ok(auth.can(rep, 'provider.self'));
    assert.ok(!auth.can(rep, 'provider.read'));
    assert.ok(!pr.isMember(rep, card.id));
    pr.addMember(card.id, rep.id, admin, '');
    assert.ok(pr.isMember(rep, card.id));
    assert.deepEqual(pr.membershipsOf(rep).map((m) => m.id), [card.id]);
  });

  test('представителю не показываются оценки, журнал, статус и ориентир стоимости', () => {
    const v = pr.representativeView(pr.getProvider(card.id));
    for (const k of ['reviews', 'notes', 'rating', 'price_band', 'status', 'owner_name']) {
      assert.ok(!(k in v), `поле «${k}» не должно доходить до представителя`);
    }
    assert.ok(Array.isArray(v.solutions) && Array.isArray(v.cases));
  });

  test('правка профиля меняет только технологические поля и ставит карточку на проверку', () => {
    const after = pr.updateProfile(card.id, { name: 'Подмена', inn: '7700000098', description: 'Умеем',
      competencies: ['cv'], tags: 'OpenCV', availability: 'available' }, rep, '');
    assert.equal(after.name, 'ООО «Своя компания»', 'название меняет только модератор');
    assert.equal(after.inn, '7700000099');
    assert.deepEqual(after.competencies, ['cv']);
    assert.equal(after.profile_status, 'pending');
    const n = q.get("SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND provider_id = ?", admin.id, card.id).c;
    assert.equal(n, 1, 'тот, кто ведёт контакт, должен получить уведомление');
    pr.markProfileChanged(card.id, rep, 'добавлено решение');
    assert.equal(q.get("SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND provider_id = ?", admin.id, card.id).c, 1,
      'повторная правка до проверки не должна плодить уведомления');
  });

  test('модератор подтверждает сведения, представитель узнаёт об этом', () => {
    const after = pr.confirmProfile(card.id, admin, '');
    assert.equal(after.profile_status, 'confirmed');
    assert.ok(q.get('SELECT 1 FROM notifications WHERE user_id = ? AND provider_id = ?', rep.id, card.id));
    assert.ok(pr.listProviders({ pending: true }).providers.every((p) => p.id !== card.id));
  });

  test('отвязанный представитель теряет доступ', () => {
    pr.removeMember(card.id, rep.id, admin, '');
    assert.ok(!pr.isMember(rep, card.id));
  });
});
