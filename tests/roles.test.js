// Ролевая модель переехала из постоянной в коде в таблицы базы. Главное требование
// переезда — поведение доступа не изменилось ни для одной роли: эти тесты и есть
// его якорь. Сверх того проверяется то, чего раньше не было: несколько ролей у
// одного участника и правка прав администратором на ходу.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DIR = mkdtempSync(join(tmpdir(), 'social1-roles-'));
process.env.SOCIAL1_DB = join(DIR, 'test.db');
process.on('exit', () => rmSync(DIR, { recursive: true, force: true }));

const { q } = await import('../server/db.js');
const auth = await import('../server/auth.js');

// Права, зашитые в коде до переезда. Список умышленно продублирован здесь целиком:
// если кто-то изменит DEFAULT_PERMISSIONS, тест обязан это заметить, а не согласиться.
const BEFORE_MIGRATION = {
  employee:          ['initiative.create', 'initiative.read', 'initiative.comment', 'pilot.feedback', 'community', 'survey.answer',
                      'idea.create', 'idea.propose', 'idea.review'],
  head:              ['initiative.create', 'initiative.read', 'initiative.comment', 'gate.1', 'pilot.apply', 'pilot.manage', 'analytics.institution', 'community', 'survey.answer', 'rollout.manage',
                      'idea.create', 'idea.propose', 'idea.review', 'idea.incentive', 'idea.incentive.decide'],
  expert:            ['initiative.create', 'initiative.read', 'initiative.comment', 'gate.2', 'analytics.expert', 'community', 'survey.answer', 'bestpractice.publish',
                      'idea.create', 'idea.propose', 'idea.review', 'idea.moderate', 'idea.incentive'],
  developer:         ['initiative.read', 'initiative.comment', 'gate.3', 'project.manage', 'board.manage', 'docs.manage', 'community', 'survey.answer',
                      'idea.create', 'idea.propose', 'idea.review'],
  supplier:          ['initiative.read', 'initiative.comment', 'community', 'project.contribute',
                      'idea.propose', 'idea.review'],
  pilot_coordinator: ['initiative.read', 'initiative.comment', 'gate.4', 'pilot.manage', 'pilot.feedback', 'survey.manage', 'analytics.pilot', 'community', 'survey.answer',
                      'idea.create', 'idea.propose', 'idea.review'],
  dtszn:             ['initiative.create', 'initiative.read', 'initiative.comment', 'gate.2', 'gate.5', 'analytics.all', 'admin', 'workflow.configure', 'audit.read', 'community', 'rollout.manage', 'bestpractice.publish', 'awards.grant', 'survey.answer', 'pilot.manage',
                      'idea.create', 'idea.propose', 'idea.review', 'idea.moderate', 'idea.incentive', 'idea.incentive.decide', 'idea.admin'],
};

let institution;
before(() => {
  auth.ensureRoles();
  institution = q.insert("INSERT INTO institutions (name, short_name) VALUES ('Тестовое учреждение','ТУ')");
});

const makeUser = (email, role) => {
  const { hash, salt } = auth.hashPassword('test');
  return q.insert(`INSERT INTO users (email, full_name, password_hash, password_salt, role, institution_id)
                   VALUES (?,?,?,?,?,?)`, email, 'Участник', hash, salt, role, institution);
};
// Пользователь в том виде, в каком его отдаёт userFromToken — с дополнительными ролями
const loadUser = (id) => q.get(`SELECT u.*, (SELECT group_concat(ur.role_code) FROM user_roles ur
                                             WHERE ur.user_id = u.id) AS extra_roles
                                FROM users u WHERE u.id = ?`, id);

describe('Переезд прав в данные', () => {
  test('каждая роль сохранила все прежние права [US-ADM-001/AC1]', () => {
    for (const [role, perms] of Object.entries(BEFORE_MIGRATION)) {
      const user = { role };
      for (const p of perms) {
        assert.ok(auth.can(user, p), `роль «${role}» потеряла право «${p}»`);
      }
    }
  });

  test('роль не получила прав чужой роли [US-ADM-001/AC1]', () => {
    // Полномочия точек принятия решений и администрирования не расползлись
    const exclusive = ['gate.1', 'gate.2', 'gate.3', 'gate.4', 'gate.5', 'admin', 'audit.read', 'idea.admin'];
    for (const [role, perms] of Object.entries(BEFORE_MIGRATION)) {
      for (const p of exclusive) {
        if (perms.includes(p)) continue;
        assert.ok(!auth.can({ role }, p), `роль «${role}» получила лишнее право «${p}»`);
      }
    }
  });

  test('справочник ролей отдаётся в прежней форме', () => {
    const map = auth.roleMap();
    for (const role of Object.keys(BEFORE_MIGRATION)) {
      assert.ok(map[role]?.title, `в справочнике нет роли «${role}»`);
      assert.ok(map[role]?.short, `у роли «${role}» нет краткого названия`);
    }
  });

  test('без пользователя прав нет [US-ADM-001/AC6]', () => {
    assert.equal(auth.can(null, 'admin'), false);
    assert.equal(auth.can(undefined, 'initiative.read'), false);
  });
});

describe('Несколько ролей у участника [US-ADM-001/AC4]', () => {
  test('права ролей объединяются', () => {
    const id = makeUser('multi@social1.mos.ru', 'employee');
    assert.ok(!auth.can(loadUser(id), 'gate.1'), 'сотруднику решение Gate 1 недоступно');

    auth.grantRole(id, 'head', { institutionId: institution });
    const withHead = loadUser(id);
    assert.ok(auth.can(withHead, 'gate.1'), 'после назначения роли руководителя Gate 1 доступен');
    assert.ok(auth.can(withHead, 'idea.create'), 'права основной роли сохранились');
    assert.deepEqual(auth.rolesOf(withHead).sort(), ['employee', 'head']);
  });

  test('снятие роли забирает её права', () => {
    const id = makeUser('temp@social1.mos.ru', 'employee');
    auth.grantRole(id, 'expert');
    assert.ok(auth.can(loadUser(id), 'idea.moderate'));
    auth.revokeRole(id, 'expert');
    assert.ok(!auth.can(loadUser(id), 'idea.moderate'), 'право не отозвано вместе с ролью');
  });

  test('назначение роли дважды не создаёт дубля', () => {
    const id = makeUser('twice@social1.mos.ru', 'employee');
    auth.grantRole(id, 'expert');
    auth.grantRole(id, 'expert', { institutionId: institution });
    assert.equal(q.get('SELECT COUNT(*) AS c FROM user_roles WHERE user_id = ?', id).c, 1);
  });
});

describe('Правка прав администратором', () => {
  test('выданное право начинает действовать без перезапуска [US-ADM-001/AC3]', () => {
    assert.ok(!auth.can({ role: 'employee' }, 'process.publish'));
    auth.setRolePermissions('employee', [...auth.permissionsOf('employee'), 'process.publish']);
    assert.ok(auth.can({ role: 'employee' }, 'process.publish'), 'кэш прав не сброшен после правки');
    // возвращаем как было, чтобы не влиять на соседние проверки
    auth.setRolePermissions('employee', auth.permissionsOf('employee').filter((p) => p !== 'process.publish'));
    assert.ok(!auth.can({ role: 'employee' }, 'process.publish'));
  });

  test('новая роль заводится без правки кода [US-ADM-001/AC2]', () => {
    auth.upsertRole({ code: 'auditor', title: 'Внутренний аудитор', short: 'Аудитор' });
    auth.setRolePermissions('auditor', ['audit.read', 'process.read']);
    assert.ok(auth.can({ role: 'auditor' }, 'audit.read'));
    assert.ok(!auth.can({ role: 'auditor' }, 'admin'));
    assert.equal(auth.roleMap().auditor.kind, 'custom');
  });
});

describe('Права на работу с процессами [US-ADM-001/AC5]', () => {
  test('краудсорсинг открыт рядовому сотруднику', () => {
    const user = { role: 'employee' };
    for (const p of ['process.read', 'process.comment', 'process.propose']) {
      assert.ok(auth.can(user, p), `сотрудник не может «${p}»`);
    }
  });

  test('публикация версии доступна только центральному аппарату', () => {
    for (const role of Object.keys(BEFORE_MIGRATION)) {
      assert.equal(auth.can({ role }, 'process.publish'), role === 'dtszn',
        `право публикации у роли «${role}» задано неверно`);
    }
  });

  test('согласование доступно ролям, отвечающим за дорожки', () => {
    for (const role of ['head', 'expert', 'developer', 'pilot_coordinator', 'dtszn']) {
      assert.ok(auth.can({ role }, 'process.approve'), `роль «${role}» не может согласовывать`);
    }
    assert.ok(!auth.can({ role: 'employee' }, 'process.approve'));
  });
});
