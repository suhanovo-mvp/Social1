// Инструкции по каталогу разработчиков собираются из схем процессов, справочников
// каталога и содержания в server/guides. Сломаться они могут тихо: переименовали
// схему — и инструкция падает при скачивании, убрали шаг — и разбор ссылается в
// пустоту. Эти проверки ловят такое до того, как кто-то нажмёт кнопку.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DIR = mkdtempSync(join(tmpdir(), 'social1-guides-'));
process.env.SOCIAL1_DB = join(DIR, 'test.db');
process.on('exit', () => rmSync(DIR, { recursive: true, force: true }));

const auth = await import('../server/auth.js');
const repo = await import('../server/process-repo.js');
const { GUIDES } = await import('../server/guides/providers-guide.js');
const { guidePdf, guideByFile } = await import('../server/guide-pdf.js');

before(() => { auth.ensureRoles(); repo.ensureProcesses(); });

const blocksOf = (g) => g.sections.flatMap((s) => s.blocks);

describe('Инструкции по каталогу разработчиков', () => {
  test('есть инструкции пользователя, модератора и представителя', () => {
    for (const f of ['user', 'moderator', 'representative']) assert.ok(guideByFile(f), `нет инструкции «${f}»`);
  });

  test('каждая схема и разбор ссылаются на схему из альбома, у которой есть разбор', () => {
    const album = repo.album();
    for (const g of Object.values(GUIDES)) {
      for (const b of blocksOf(g)) {
        const id = b.diagram || b.walk;
        if (!id) continue;
        const d = album.find((x) => x.id === id);
        assert.ok(d, `${g.file}: схемы «${id}» нет в альбоме`);
        assert.ok(d.walkthrough?.length >= 4, `${g.file}: у схемы «${id}» слишком короткий разбор`);
      }
    }
  });

  test('каждая инструкция показывает хотя бы одну схему вместе с её разбором', () => {
    for (const g of Object.values(GUIDES)) {
      const diagrams = blocksOf(g).filter((b) => b.diagram).map((b) => b.diagram);
      const walks = blocksOf(g).filter((b) => b.walk).map((b) => b.walk);
      assert.ok(diagrams.length, `${g.file}: нет ни одной схемы`);
      assert.deepEqual(diagrams, walks, `${g.file}: схема без разбора или разбор без схемы`);
    }
  });

  test('инструкция модератора охватывает добавление, представителей, ведение и доступ', () => {
    const ids = blocksOf(guideByFile('moderator')).filter((b) => b.diagram).map((b) => b.diagram);
    assert.deepEqual(ids, ['prov-add', 'prov-self', 'prov-keep', 'prov-access']);
  });

  test('PDF собирается, текст в нём ищется', () => {
    for (const f of ['user', 'moderator', 'representative']) {
      const buf = guidePdf(f);
      assert.equal(buf.subarray(0, 5).toString(), '%PDF-', `${f}: не PDF`);
      // Без ToUnicode кириллица отображается, но не ищется и не копируется
      assert.ok(buf.includes('/ToUnicode'), `${f}: в PDF нет карты ToUnicode`);
      assert.ok(buf.length > 50_000, `${f}: подозрительно маленький файл`);
    }
  });
});
