#!/usr/bin/env node
// Release helpers.
//
//   node prd/scripts/prd-release.mjs snapshot [--prd prd/prd.js] [--tests prd/test-results.json]
//        → prd/status-snapshot.json: statuses at this release (commit it with the release)
//   node prd/scripts/prd-release.mjs draft [--version 0.5.0]
//        → draft of the next release entry from criteria that became implemented since
//          the snapshot, plus regressions. Paste into prd/releases.js and rewrite the
//          wording for people; keep the refs.
import { existsSync, writeFileSync } from 'node:fs';
import { libModule, loadExport, readJson, parseArgs } from './load.mjs';

const args = parseArgs();
const cmd = args._[0];
const modelFile = args.prd ?? ['prd/prd.js', 'prd/prd.mjs', 'prd/prd.ts', 'prd/prd.json'].find(existsSync);
if (!['snapshot', 'draft'].includes(cmd) || !modelFile) {
  console.error('usage: prd-release.mjs snapshot|draft [--prd prd/prd.js] [--tests prd/test-results.json] [--version x.y.z]');
  process.exit(2);
}
const core = await libModule('prd-core.js');
const { draftRelease } = await libModule('changelog.js');
const index = core.indexPrd(await loadExport(modelFile, ['PRD', 'prd']));
const tests = readJson(args.tests ?? 'prd/test-results.json');
const statusOf = core.statusMap(index, tests);
const snapFile = args.snapshot ?? 'prd/status-snapshot.json';

if (cmd === 'snapshot') {
  const version = args.version ?? readJson('package.json')?.version ?? null;
  writeFileSync(snapFile, `${JSON.stringify({ version, at: new Date().toISOString(), statuses: Object.fromEntries(statusOf) }, null, 1)}\n`);
  console.log(`Снимок статусов ${version ?? ''} → ${snapFile}`);
} else {
  const snap = readJson(snapFile, { statuses: {} });
  const draft = draftRelease(index, statusOf, snap.statuses, { version: args.version ?? null });
  console.log(JSON.stringify(draft, null, 2));
  if (draft.regressions.length) console.warn(`\nРегрессии с прошлого снимка: ${draft.regressions.join(', ')}`);
  if (!snap.at) console.warn('\nСнимка нет — в черновик попало всё реализованное. Сделайте snapshot при выпуске релиза.');
}
