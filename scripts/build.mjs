#!/usr/bin/env node
/**
 * Builds the published skill map.
 *
 *   node scripts/build.mjs            validate, fetch, scan, write site/
 *   node scripts/build.mjs --check    the same, and fail on anything a reviewer
 *                                     should not have to catch by eye
 *
 * Output (site/): graph.json, every served skill's files under
 * skills/<id>/, and a small index page. GitHub Pages serves site/ from a CDN,
 * so agents fetching skills never touch the AgentsEarth server.
 *
 * Linked skills are fetched from GitHub at their pinned commit. One tarball per
 * repo@ref, cached in .cache/, so a build with 25 skills from 3 repos makes 3
 * downloads, and a rebuild makes none.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { SCANNER_VERSION, scanEntries } from './scan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');
const CACHE = join(ROOT, '.cache');
const BASE = process.env.EARTH_SKILLS_BASE ?? 'https://samiullah123786.github.io/earth-skills/';
const CHECK = process.argv.includes('--check');

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const TAG_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ALLOWED_KEYS = new Set(['name', 'title', 'summary', 'family', 'area', 'tags', 'author',
  'license', 'requires', 'pairs_with', 'source']);
// Near-duplicate threshold on name+summary word overlap. Two genuinely different
// skills in one area share a few words; a re-listing shares most of them.
const DUPLICATE_JACCARD = 0.6;
const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'with',
  'your', 'you', 'it', 'is', 'by', 'from', 'before', 'any', 'into', 'that', 'this', 'when']);

const errors = [];
const warnings = [];
const fail = (where, message) => errors.push(`${where}: ${message}`);

// ---------- taxonomy ----------
const taxonomy = YAML.parse(readFileSync(join(ROOT, 'taxonomy.yml'), 'utf8'));
const families = Object.entries(taxonomy.families ?? {}).map(([id, family]) => ({
  id,
  title: family.title,
  color: family.color,
  areas: Object.entries(family.areas ?? {}).map(([areaId, area]) => ({
    id: areaId, title: area.title, summary: area.summary, skills: [],
  })),
}));
const areaOf = (familyId, areaId) => families.find((f) => f.id === familyId)?.areas.find((a) => a.id === areaId);

// ---------- read every skill.yml ----------
function findSkillFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (lstatSync(full).isDirectory()) out.push(...findSkillFiles(full));
    else if (name === 'skill.yml') out.push(full);
  }
  return out;
}

const skills = [];
for (const file of findSkillFiles(join(ROOT, 'skills')).sort()) {
  const rel = relative(ROOT, file).split(sep).join('/');
  const parts = rel.split('/');                       // skills/<family>/<area>/<name>/skill.yml
  let meta;
  try {
    meta = YAML.parse(readFileSync(file, 'utf8')) ?? {};
  } catch (error) {
    fail(rel, `is not valid YAML (${error.message})`);
    continue;
  }
  if (parts.length !== 5) {
    fail(rel, 'must sit at skills/<family>/<area>/<skill-name>/skill.yml');
    continue;
  }
  const [, family, area, folder] = parts;
  for (const key of Object.keys(meta)) {
    if (!ALLOWED_KEYS.has(key)) fail(rel, `unknown field "${key}"`);
  }
  if (!NAME_RE.test(meta.name ?? '')) fail(rel, 'name must be lowercase kebab-case, 2-64 chars');
  if (meta.name !== folder) fail(rel, `name "${meta.name}" must equal its folder "${folder}"`);
  if (meta.family !== family) fail(rel, `family "${meta.family}" must equal its folder "${family}"`);
  if (meta.area !== area) fail(rel, `area "${meta.area}" must equal its folder "${area}"`);
  if (!areaOf(family, area)) fail(rel, `${family}/${area} is not in taxonomy.yml`);
  if (typeof meta.title !== 'string' || !meta.title.trim()) fail(rel, 'title is required');
  if (typeof meta.summary !== 'string' || !meta.summary.trim()) fail(rel, 'summary is required');
  else if (meta.summary.length > 140) fail(rel, `summary is ${meta.summary.length} chars; the limit is 140`);
  if (typeof meta.author !== 'string' || !meta.author.trim()) fail(rel, 'author is required');
  if (typeof meta.license !== 'string' || !meta.license.trim()) fail(rel, 'license is required (SPDX id or link-only)');
  const tags = meta.tags ?? [];
  if (!Array.isArray(tags) || tags.length < 1 || tags.length > 6 || !tags.every((t) => TAG_RE.test(t))) {
    fail(rel, 'tags must be 1-6 lowercase words');
  }
  for (const key of ['requires', 'pairs_with']) {
    if (meta[key] !== undefined && !Array.isArray(meta[key])) fail(rel, `${key} must be a list`);
  }

  const dir = dirname(file);
  const siblings = readdirSync(dir).filter((n) => n !== 'skill.yml');
  let kind = 'hosted';
  if (meta.source !== undefined) {
    kind = 'linked';
    const { repo, path, ref } = meta.source ?? {};
    if (!REPO_RE.test(repo ?? '')) fail(rel, 'source.repo must be owner/name');
    if (typeof path !== 'string' || !path || path.startsWith('/') || path.split('/').includes('..')) {
      fail(rel, 'source.path must be a relative folder path inside the repo');
    }
    if (!SHA_RE.test(ref ?? '')) fail(rel, 'source.ref must be a full 40-character commit SHA');
    if (siblings.length) fail(rel, `a linked skill keeps its files upstream; remove ${siblings.join(', ')}`);
  } else if (!siblings.some((n) => n.toLowerCase() === 'skill.md')) {
    fail(rel, 'a hosted skill needs a SKILL.md next to skill.yml (or add source: to link it)');
  }
  skills.push({ rel, dir, meta, kind });
}

// ---------- cross-skill checks ----------
const ids = new Set();
for (const s of skills) {
  if (ids.has(s.meta.name)) fail(s.rel, `name "${s.meta.name}" is already used by another skill`);
  ids.add(s.meta.name);
}
for (const s of skills) {
  for (const key of ['requires', 'pairs_with']) {
    for (const other of s.meta[key] ?? []) {
      if (other === s.meta.name) fail(s.rel, `${key} lists the skill itself`);
      else if (!ids.has(other)) fail(s.rel, `${key} names "${other}", which is not a listed skill`);
    }
  }
}
const words = (s) => new Set(`${s.meta.name.replace(/-/g, ' ')} ${s.meta.summary ?? ''}`
  .toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)));
for (let i = 0; i < skills.length; i += 1) {
  for (let j = i + 1; j < skills.length; j += 1) {
    const a = words(skills[i]);
    const b = words(skills[j]);
    const inter = [...a].filter((w) => b.has(w)).length;
    const score = inter / (a.size + b.size - inter || 1);
    if (score >= DUPLICATE_JACCARD) {
      fail(skills[j].rel, `looks like a duplicate of ${skills[i].meta.name} (overlap ${score.toFixed(2)}); improve that listing instead`);
    }
  }
}

// ---------- fetch linked sources ----------
// Extracts only the listed folder: faster, and it never touches files elsewhere in
// the upstream repository (a root-level symlink there cannot break the build).
async function sourceDir(repo, ref, path) {
  const key = `${repo.replace('/', '__')}@${ref}`;
  const out = join(CACHE, 'src', `${key}__${path.replace(/[^\w.-]+/g, '_')}`);
  if (existsSync(join(out, '.complete'))) return out;
  mkdirSync(join(CACHE, 'tar'), { recursive: true });
  const tarball = join(CACHE, 'tar', `${key}.tar.gz`);
  if (!existsSync(tarball)) {
    const headers = { 'user-agent': 'earth-skills-build' };
    if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const response = await fetch(`https://codeload.github.com/${repo}/tar.gz/${ref}`, { headers });
    if (!response.ok) throw new Error(`download ${repo}@${ref.slice(0, 7)} failed: HTTP ${response.status}`);
    writeFileSync(tarball, Buffer.from(await response.arrayBuffer()));
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  // System tar (GNU on CI, bsdtar on Windows/macOS) both read .tar.gz and strip the top folder.
  // Paths are passed relative to CACHE: GNU tar on Windows reads "E:\..." as host:path.
  // The top folder is "<repo>-<sha>", but a renamed repo keeps its new name there,
  // so read it from the archive rather than guessing.
  const top = execFileSync('tar', ['-tzf', relative(CACHE, tarball).split(sep).join('/')], { cwd: CACHE, stdio: 'pipe', maxBuffer: 1 << 28 })
    .toString().split('\n', 1)[0].replace(/\/.*$/, '');
  const member = `${top}/${path}`;
  execFileSync('tar', ['-xzf', relative(CACHE, tarball).split(sep).join('/'), '-C', relative(CACHE, out).split(sep).join('/'),
    '--strip-components=1', member], { cwd: CACHE, stdio: 'pipe' });
  writeFileSync(join(out, '.complete'), '');
  return out;
}

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === '.git' || name === '.complete') continue;
    const full = join(dir, name);
    const stat = lstatSync(full);
    const rel = relative(base, full).split(sep).join('/');
    if (stat.isSymbolicLink()) out.push({ name: rel, full, size: 0, symlink: true });
    else if (stat.isDirectory()) out.push(...walk(full, base));
    else out.push({ name: rel, full, size: stat.size });
  }
  return out;
}

function digestOf(files) {
  const hash = createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    hash.update(`${f.name}\n${f.size}\n`);
    hash.update(readFileSync(f.full));
  }
  return `sha256:${hash.digest('hex')}`;
}

// ---------- assemble ----------
if (errors.length === 0) {
  rmSync(SITE, { recursive: true, force: true });
  mkdirSync(join(SITE, 'skills'), { recursive: true });
}

const nodes = [];
for (const s of errors.length ? [] : skills) {
  const m = s.meta;
  const linkOnly = m.license === 'link-only';
  let files = [];
  let srcRoot = s.dir;
  let sourceUrl = null;
  if (s.kind === 'linked') {
    sourceUrl = `https://github.com/${m.source.repo}/tree/${m.source.ref}/${m.source.path}`;
    if (!linkOnly) {
      try {
        srcRoot = join(await sourceDir(m.source.repo, m.source.ref, m.source.path), ...m.source.path.split('/'));
      } catch (error) {
        fail(s.rel, error.message);
        continue;
      }
      if (!existsSync(srcRoot)) {
        fail(s.rel, `source.path ${m.source.path} does not exist at ${m.source.ref.slice(0, 7)}`);
        continue;
      }
    }
  }
  let safety = null;
  let digest = null;
  let entry = null;
  if (!linkOnly) {
    files = walk(srcRoot).filter((f) => !(s.kind === 'hosted' && f.name === 'skill.yml'));
    const entries = files.map((f) => {
      if (f.symlink) return { name: f.name, size: 0, symlink: true };
      const text = f.size <= 2 * 1024 * 1024 ? readFileSync(f.full, 'utf8') : undefined;
      return { name: f.name, size: f.size, text };
    });
    const scan = scanEntries(entries);
    safety = { verdict: scan.verdict, flags: scan.flags,
      findings: scan.findings.filter((f) => f.severity !== 'capability')
        .map(({ rule, where, line, detail }) => ({ rule, where, line, detail })) };
    if (scan.verdict === 'refused') {
      fail(s.rel, `refused by ${SCANNER_VERSION}: ${scan.findings.filter((f) => f.severity === 'refuse')
        .map((f) => `${f.rule} at ${f.where}`).join('; ')}`);
      continue;
    }
    entry = files.find((f) => f.name.toLowerCase() === 'skill.md')?.name ?? null;
    if (!entry) {
      fail(s.rel, 'has no SKILL.md at the top of its folder');
      continue;
    }
    digest = digestOf(files);
    const dest = join(SITE, 'skills', m.name);
    for (const f of files) {
      mkdirSync(dirname(join(dest, f.name)), { recursive: true });
      cpSync(f.full, join(dest, f.name));
    }
  }
  nodes.push({
    id: m.name,
    title: m.title,
    summary: m.summary,
    family: m.family,
    area: m.area,
    tags: m.tags,
    author: m.author,
    license: m.license,
    kind: s.kind,
    served: !linkOnly,
    sourceUrl: sourceUrl ?? `https://github.com/samiullah123786/earth-skills/tree/main/${s.rel.replace(/\/skill\.yml$/, '')}`,
    ref: s.kind === 'linked' ? m.source.ref : null,
    digest,
    files: files.map((f) => ({ path: f.name, size: f.size })),
    entry,
    requires: m.requires ?? [],
    pairsWith: m.pairs_with ?? [],
    safety,
  });
  areaOf(m.family, m.area).skills.push(m.name);
}

const edges = [];
const seenPairs = new Set();
for (const n of nodes) {
  for (const r of n.requires) edges.push({ from: n.id, to: r, kind: 'requires' });
  for (const p of n.pairsWith) {
    const [from, to] = [n.id, p].sort();
    if (seenPairs.has(`${from}|${to}`)) continue;
    seenPairs.add(`${from}|${to}`);
    edges.push({ from, to, kind: 'pairs' });
  }
}

if (errors.length) {
  console.error(`\n✗ ${errors.length} problem(s):\n`);
  for (const e of errors) console.error(`  - ${e}`);
  writeSummary(false);
  process.exit(1);
}

let commit = process.env.GITHUB_SHA ?? null;
if (!commit) {
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, stdio: 'pipe' }).toString().trim(); } catch { /* no commits yet */ }
}

for (const f of families) f.areas.forEach((a) => a.skills.sort());
const graph = {
  version: 1,
  generatedAt: new Date().toISOString(),
  commit,
  base: BASE,
  scanner: SCANNER_VERSION,
  counts: {
    families: families.length,
    areas: families.reduce((n, f) => n + f.areas.length, 0),
    skills: nodes.length,
    edges: edges.length,
  },
  families,
  skills: nodes.sort((a, b) => a.id.localeCompare(b.id)),
  edges,
};
writeFileSync(join(SITE, 'graph.json'), `${JSON.stringify(graph, null, 1)}\n`);
writeFileSync(join(SITE, '.nojekyll'), '');
writeFileSync(join(SITE, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Earth skills</title>
<meta http-equiv="refresh" content="0; url=https://agentsearth.com/market#atlas">
<p>The Earth skill map: <a href="graph.json">graph.json</a> · browse it at
<a href="https://agentsearth.com/market#atlas">agentsearth.com/market</a>.</p>\n`);

const review = nodes.filter((n) => n.safety?.verdict === 'needs_review');
console.log(`✓ ${nodes.length} skills · ${edges.length} edges · ${review.length} need review · site/graph.json`);
for (const n of review) console.log(`  ! ${n.id}: ${n.safety.flags.join(', ')}`);
if (warnings.length) warnings.forEach((w) => console.warn(`  ~ ${w}`));
writeSummary(true);

function writeSummary(ok) {
  const out = process.env.GITHUB_STEP_SUMMARY;
  if (!out) return;
  const lines = [`## Earth skills build: ${ok ? 'passed' : 'failed'}`, ''];
  if (!ok) lines.push(...errors.map((e) => `- ❌ ${e}`), '');
  else {
    lines.push('| Skill | Area | Licence | Safety | Flags |', '|---|---|---|---|---|');
    for (const n of nodes) {
      lines.push(`| ${n.id} | ${n.family}/${n.area} | ${n.license} | ${n.safety?.verdict ?? 'not served'} | ${n.safety?.flags.join(', ') ?? ''} |`);
    }
  }
  writeFileSync(out, `${lines.join('\n')}\n`, { flag: 'a' });
}

if (CHECK && !process.env.CI) console.log('(check mode: same rules CI runs on every pull request)');
