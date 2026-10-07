// Release history (changelog): validation and drafting. Pure ES module.
//
// prd/releases.js exports RELEASES, newest first:
//   { version: '0.4.0', date: '2026-10-05', title, summary,
//     changes: [{ type: 'feature'|'improvement'|'fix', area, text, refs: ['US-LIB-001/AC4', 'process:4.3', 'tour:specifier-flow'] }] }
//
// refs are what tie a release to the rest: a criterion shows "в релизе 0.4.0", a
// release shows which criteria it closed, and a reviewer can jump from one to the other.
import * as core from './prd-core.js';

export const CHANGE_TYPES = {
  feature: { label: 'Новое', tone: 'good' },
  improvement: { label: 'Улучшение', tone: 'accent' },
  fix: { label: 'Исправление', tone: 'warn' },
};

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const cmp = (a, b) => {
  const pa = a.split(/[.-]/).map((x) => (Number.isNaN(Number(x)) ? x : Number(x)));
  const pb = b.split(/[.-]/).map((x) => (Number.isNaN(Number(x)) ? x : Number(x)));
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  return 0;
};

/**
 * Checks: semver, newest first, unique versions, dates not in the future and not
 * going backwards, known change types, refs to existing criteria, and the latest
 * release equal to package.json version (pass it as packageVersion).
 */
export function validateReleases(releases, { index = null, packageVersion = null, today = new Date().toISOString().slice(0, 10) } = {}) {
  const problems = [];
  const err = (id, msg) => problems.push({ level: 'error', id, msg });
  const warn = (id, msg) => problems.push({ level: 'warn', id, msg });
  if (!Array.isArray(releases)) { err('releases', 'RELEASES должен быть массивом'); return problems; }
  const seen = new Set();
  releases.forEach((r, i) => {
    const id = `release ${r.version ?? `#${i}`}`;
    if (!SEMVER.test(r.version ?? '')) err(id, 'версия в формате SemVer: 1.4.0');
    if (seen.has(r.version)) err(id, 'версия повторяется');
    seen.add(r.version);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date ?? '')) err(id, 'дата в формате ГГГГ-ММ-ДД');
    else if (r.date > today) warn(id, 'дата релиза в будущем');
    const prev = releases[i - 1];
    if (prev && SEMVER.test(prev.version ?? '') && SEMVER.test(r.version ?? '')) {
      if (cmp(prev.version, r.version) <= 0) err(id, `порядок: новые релизы сверху, ${prev.version} должен быть больше ${r.version}`);
      if (prev.date && r.date && prev.date < r.date) err(id, 'дата старше следующего релиза');
    }
    if (!r.title) err(id, 'нет title');
    if (!Array.isArray(r.changes) || !r.changes.length) warn(id, 'нет изменений');
    for (const [j, ch] of (r.changes ?? []).entries()) {
      if (!CHANGE_TYPES[ch.type]) err(`${id} #${j + 1}`, `тип «${ch.type}»: допустимы ${Object.keys(CHANGE_TYPES).join(', ')}`);
      if (!String(ch.text ?? '').trim()) err(`${id} #${j + 1}`, 'пустой текст изменения');
      if (index) for (const ref of ch.refs ?? []) {
        if (/^US-/.test(ref) && !index.criteria.has(ref) && !index.stories.has(ref)) err(`${id} #${j + 1}`, `ссылка на несуществующий ${ref}`);
      }
    }
  });
  if (packageVersion && releases[0]?.version && releases[0].version !== packageVersion) {
    err('package.json', `version ${packageVersion}, а последний релиз ${releases[0].version} — поднимите одно до другого`);
  }
  return problems;
}

/**
 * Draft of the next release from what changed in the PRD statuses since the last
 * snapshot (prd/status-snapshot.json, written by scripts/prd-status.mjs --snapshot).
 * Claude edits the wording; the refs are what matters and are computed here.
 */
export function draftRelease(index, statusOf, previousStatuses = {}, { version = null, date = new Date().toISOString().slice(0, 10) } = {}) {
  const implementedNow = (k) => core.STATUS[statusOf.get(k)]?.implemented;
  const implementedBefore = (k) => core.STATUS[previousStatuses[k]]?.implemented;
  const byStory = new Map();
  const regressions = [];
  for (const c of index.criteria.values()) {
    if (c.retired) continue;
    const now = implementedNow(c.key), before = implementedBefore(c.key);
    if (now && !before) {
      const list = byStory.get(c.story.id) ?? [];
      list.push(c.key);
      byStory.set(c.story.id, list);
    }
    if (statusOf.get(c.key) === 'failing' && previousStatuses[c.key] !== 'failing') regressions.push(c.key);
  }
  const changes = [];
  for (const [storyId, keys] of byStory) {
    const story = index.stories.get(storyId);
    const isNew = !core.activeCriteria(story).some((ac) => implementedBefore(core.acKey(story, ac)));
    changes.push({
      type: isNew ? 'feature' : 'improvement',
      area: index.modules.get(story.module)?.title ?? story.module,
      text: `${story.title}: ${keys.map((k) => index.criteria.get(k).ac.text.replace(/\.$/, '')).join('; ')}`,
      refs: keys,
    });
  }
  return { version, date, title: '', summary: '', changes, regressions };
}

/** key → first release that references it (oldest), for "в релизе 0.4.0" next to a criterion. */
export function releaseIndex(releases) {
  const map = new Map();
  for (const r of [...(releases ?? [])].reverse()) {
    for (const ch of r.changes ?? []) for (const ref of ch.refs ?? []) if (!map.has(ref)) map.set(ref, r.version);
  }
  return map;
}
