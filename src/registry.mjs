// Reads the published Earth skill map (graph.json) and the files it points to.
// Everything here is read-only towards the registry; the only thing written is
// a private cache under ~/.earth-skills/cache so repeat runs are cheap and the
// last good copy still works offline.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const DEFAULT_BASE = 'https://samiullah123786.github.io/earth-skills/';
export const GRAPH_TTL_MS = 10 * 60 * 1000;
const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** Error whose message is written for the agent or person reading it. */
export class EarthError extends Error {
  constructor(message, code = 'earth_error') {
    super(message);
    this.code = code;
  }
}

/** ~/.earth-skills, resolved on every call so tests can swap HOME in-process. */
export function earthHome() {
  return path.join(os.homedir(), '.earth-skills');
}

/**
 * Accepts an http(s) URL, a file:// URL or a local directory path. Local bases
 * exist so tests and people building the site can point at a folder on disk.
 */
export function resolveBase(input) {
  const raw = (input ?? process.env.EARTH_SKILLS_BASE ?? '').trim() || DEFAULT_BASE;
  if (/^https?:\/\//i.test(raw)) {
    return { kind: 'http', root: raw.endsWith('/') ? raw : raw + '/', label: raw };
  }
  const dir = /^file:\/\//i.test(raw) ? fileURLToPath(raw) : path.resolve(raw);
  return { kind: 'file', root: dir, label: dir };
}

/**
 * A file path from graph.json is trusted only if it is a plain relative path.
 * Checked twice: when the graph loads and before any read, so a hostile graph
 * or a hostile caller cannot reach outside the skill folder.
 */
export function assertSafeRelPath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 512) {
    throw new EarthError('File path must be a non-empty string.', 'bad_path');
  }
  if (p.includes('\\') || p.includes('\0') || p.startsWith('/') || /^[a-zA-Z]:/.test(p) ||
      path.posix.isAbsolute(p) || path.win32.isAbsolute(p)) {
    throw new EarthError(`Refused path "${p}": only plain relative paths listed in the skill are allowed.`, 'bad_path');
  }
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new EarthError(`Refused path "${p}": it contains an empty, "." or ".." segment.`, 'bad_path');
    }
  }
  return p;
}

/** Plain code-unit order, the same order Array.prototype.sort() gives strings. */
function byPath(a, b) {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * The digest graph-schema.md defines: sha256 over, for each file sorted by
 * path, path + "\n" + size + "\n" + bytes. `files` is [{ path, bytes }].
 */
export function computeDigest(files) {
  const h = createHash('sha256');
  for (const f of [...files].sort(byPath)) {
    h.update(`${f.path}\n${f.bytes.length}\n`, 'utf8');
    h.update(f.bytes);
  }
  return 'sha256:' + h.digest('hex');
}

function validateGraph(graph, source) {
  if (!graph || typeof graph !== 'object' || graph.version !== 1 || !Array.isArray(graph.skills)) {
    throw new EarthError(`graph.json from ${source} is not a version 1 Earth graph.`, 'bad_graph');
  }
  const seen = new Set();
  for (const s of graph.skills) {
    if (!s || typeof s.id !== 'string' || !ID_RE.test(s.id) || seen.has(s.id)) {
      throw new EarthError(`graph.json from ${source} has a missing, malformed or duplicate skill id (${s && s.id}).`, 'bad_graph');
    }
    seen.add(s.id);
    s.files = Array.isArray(s.files) ? s.files : [];
    for (const f of s.files) assertSafeRelPath(f && f.path);
    if (s.served && (!s.entry || !s.files.some((f) => f.path === s.entry))) {
      throw new EarthError(`graph.json from ${source}: skill ${s.id} has an entry that is not in its files list.`, 'bad_graph');
    }
  }
  graph.families = Array.isArray(graph.families) ? graph.families : [];
  graph.edges = Array.isArray(graph.edges) ? graph.edges.filter((e) => seen.has(e.from) && seen.has(e.to)) : [];
  return graph;
}

function tokenize(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * One registry per base. The returned object caches the graph in memory for
 * ttlMs and caches verified skills by digest, so a skill is hashed once.
 */
export function createRegistry({ base, ttlMs = GRAPH_TTL_MS, fetchImpl = globalThis.fetch, cacheDir, log = () => {} } = {}) {
  const b = resolveBase(base);
  let graphMemo = null; // { graph, at }
  const verified = new Map(); // digest -> Map(path -> Buffer)

  // The disk cache is per base so a fixture or staging site never shadows production.
  const diskDir = () => path.join(cacheDir || path.join(earthHome(), 'cache'),
    createHash('sha256').update(b.root).digest('hex').slice(0, 16));

  async function readJson(file) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
  }

  async function writeAtomic(file, data) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, file);
  }

  async function loadGraphHttp() {
    const dir = diskDir();
    const cached = await readJson(path.join(dir, 'graph.json'));
    const meta = (await readJson(path.join(dir, 'graph.meta.json'))) || {};
    const url = b.root + 'graph.json';
    let res;
    try {
      const headers = { accept: 'application/json' };
      if (cached && meta.etag) headers['if-none-match'] = meta.etag;
      res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15000) });
    } catch (err) {
      if (cached) {
        log(`earth-skills: ${url} unreachable (${err.message}); using cached copy from ${meta.fetchedAt || 'earlier'}.`);
        return validateGraph(cached, 'cache');
      }
      throw new EarthError(`Could not reach ${url} (${err.message}) and there is no cached copy yet. Check the network or set EARTH_SKILLS_BASE.`, 'offline');
    }
    if (res.status === 304 && cached) return validateGraph(cached, 'cache');
    if (!res.ok) {
      if (cached) {
        log(`earth-skills: ${url} returned HTTP ${res.status}; using cached copy.`);
        return validateGraph(cached, 'cache');
      }
      throw new EarthError(`${url} returned HTTP ${res.status}. Try again later or set EARTH_SKILLS_BASE.`, 'http');
    }
    const text = await res.text();
    let graph;
    try { graph = JSON.parse(text); } catch {
      throw new EarthError(`${url} did not return JSON.`, 'bad_graph');
    }
    validateGraph(graph, url);
    // A cache write failure must not break a read, so it is only logged.
    try {
      await writeAtomic(path.join(dir, 'graph.json'), text);
      await writeAtomic(path.join(dir, 'graph.meta.json'),
        JSON.stringify({ url, etag: res.headers.get('etag'), fetchedAt: new Date().toISOString() }));
    } catch (err) {
      log(`earth-skills: could not write cache (${err.message}).`);
    }
    return graph;
  }

  async function loadGraphFile() {
    const file = path.join(b.root, 'graph.json');
    let text;
    try { text = await fs.readFile(file, 'utf8'); } catch (err) {
      throw new EarthError(`Could not read ${file} (${err.code || err.message}). Point EARTH_SKILLS_BASE at a built site folder.`, 'offline');
    }
    let graph;
    try { graph = JSON.parse(text); } catch {
      throw new EarthError(`${file} is not valid JSON.`, 'bad_graph');
    }
    return validateGraph(graph, file);
  }

  async function getGraph({ refresh = false } = {}) {
    if (!refresh && graphMemo && Date.now() - graphMemo.at < ttlMs) return graphMemo.graph;
    const graph = b.kind === 'http' ? await loadGraphHttp() : await loadGraphFile();
    graphMemo = { graph, at: Date.now() };
    return graph;
  }

  async function getSkill(id) {
    const graph = await getGraph();
    const skill = graph.skills.find((s) => s.id === id);
    if (!skill) {
      const near = search(graph, id, 3).map((r) => r.skill.id);
      throw new EarthError(`No skill "${id}" on the Earth map.${near.length ? ` Did you mean: ${near.join(', ')}?` : ''} Search with skills_search (MCP) or: earth-skills search <words>.`, 'not_found');
    }
    return skill;
  }

  async function fetchFileBytes(id, rel) {
    assertSafeRelPath(rel);
    if (b.kind === 'http') {
      const url = `${b.root}skills/${encodeURIComponent(id)}/${rel.split('/').map(encodeURIComponent).join('/')}`;
      let res;
      try { res = await fetchImpl(url, { signal: AbortSignal.timeout(15000) }); } catch (err) {
        throw new EarthError(`Could not fetch ${url} (${err.message}).`, 'offline');
      }
      if (!res.ok) throw new EarthError(`${url} returned HTTP ${res.status}.`, 'http');
      return Buffer.from(await res.arrayBuffer());
    }
    const skillRoot = path.join(b.root, 'skills', id);
    const file = path.resolve(skillRoot, ...rel.split('/'));
    // Belt and braces after assertSafeRelPath: the resolved file must stay inside the skill folder.
    if (!file.startsWith(skillRoot + path.sep)) throw new EarthError(`Refused path "${rel}".`, 'bad_path');
    try { return await fs.readFile(file); } catch (err) {
      throw new EarthError(`Could not read ${file} (${err.code || err.message}).`, 'offline');
    }
  }

  // Verified skill bytes are also kept on disk by digest, so `skill_read` works
  // offline once a skill has been read. They are re-verified on every load.
  async function loadVerifiedFromDisk(skill) {
    if (b.kind !== 'http') return null;
    const rec = await readJson(path.join(diskDir(), 'skills', skill.digest.replace(/^sha256:/, '') + '.json'));
    if (!rec || !Array.isArray(rec.files)) return null;
    const files = rec.files.map((f) => ({ path: f.path, bytes: Buffer.from(f.b64, 'base64') }));
    return checkFiles(skill, files, true) ? files : null;
  }

  async function saveVerifiedToDisk(skill, files) {
    if (b.kind !== 'http') return;
    try {
      await writeAtomic(path.join(diskDir(), 'skills', skill.digest.replace(/^sha256:/, '') + '.json'),
        JSON.stringify({ id: skill.id, digest: skill.digest, files: files.map((f) => ({ path: f.path, b64: f.bytes.toString('base64') })) }));
    } catch (err) {
      log(`earth-skills: could not write cache (${err.message}).`);
    }
  }

  /** Throws unless files exactly match the listed paths, sizes and digest. */
  function checkFiles(skill, files, quiet = false) {
    const fail = (msg) => { if (quiet) return false; throw new EarthError(msg, 'digest_mismatch'); };
    if (files.length !== skill.files.length) return fail(`Skill ${skill.id}: file count does not match graph.json.`);
    for (const listed of skill.files) {
      const got = files.find((f) => f.path === listed.path);
      if (!got) return fail(`Skill ${skill.id}: ${listed.path} is missing.`);
      if (got.bytes.length !== listed.size) {
        return fail(`Skill ${skill.id}: ${listed.path} is ${got.bytes.length} bytes, graph.json says ${listed.size}. Refusing it; the published copy may be mid-deploy or tampered with.`);
      }
    }
    const actual = computeDigest(files);
    if (actual !== skill.digest) {
      return fail(`Skill ${skill.id}: digest mismatch (graph.json ${skill.digest}, files ${actual}). Refusing to use it; the published copy may be mid-deploy or tampered with. Try again in a few minutes.`);
    }
    return true;
  }

  /**
   * All files of a served skill, digest-verified. Link-only skills return
   * metadata and sourceUrl only: their files are never fetched or returned.
   */
  async function fetchSkill(id) {
    const skill = await getSkill(id);
    if (!skill.served) {
      return { skill, served: false, sourceUrl: skill.sourceUrl || null, files: null };
    }
    if (typeof skill.digest !== 'string' || !skill.digest.startsWith('sha256:')) {
      throw new EarthError(`Skill ${id} is marked served but has no sha256 digest; refusing it.`, 'digest_mismatch');
    }
    let byPathMap = verified.get(skill.digest);
    if (!byPathMap) {
      let files = await loadVerifiedFromDisk(skill);
      if (!files) {
        files = [];
        for (const f of skill.files) files.push({ path: f.path, bytes: await fetchFileBytes(id, f.path) });
        checkFiles(skill, files);
        await saveVerifiedToDisk(skill, files);
      }
      byPathMap = new Map(files.map((f) => [f.path, f.bytes]));
      verified.set(skill.digest, byPathMap);
    }
    const files = skill.files.map((f) => ({ path: f.path, size: f.size, bytes: byPathMap.get(f.path) }));
    return { skill, served: true, sourceUrl: skill.sourceUrl || null, digest: skill.digest, files };
  }

  /** One file of a served skill. The path must be listed in the skill's files. */
  async function readSkillFile(id, rel) {
    const skill = await getSkill(id);
    const want = rel == null || rel === '' ? skill.entry : rel;
    assertSafeRelPath(want);
    if (!skill.served) {
      throw new EarthError(`Skill ${id} is link-only: Earth does not serve its files. Read it at ${skill.sourceUrl || 'its source'}.`, 'link_only');
    }
    if (!skill.files.some((f) => f.path === want)) {
      throw new EarthError(`Skill ${id} has no file "${want}". Available: ${skill.files.map((f) => f.path).join(', ')}.`, 'bad_path');
    }
    const full = await fetchSkill(id);
    const file = full.files.find((f) => f.path === want);
    return { skill, path: want, bytes: file.bytes, digest: full.digest };
  }

  return {
    base: b,
    getGraph,
    getSkill,
    fetchSkill,
    readSkillFile,
    async search(query, limit) { return search(await getGraph(), query, limit); },
    async related(id) { await getSkill(id); return related(await getGraph(), id); },
  };
}

/** Simple, dependency-free ranking. Higher weights for the fields people name skills by. */
export function search(graph, query, limit = 10) {
  const terms = tokenize(query);
  const phrase = String(query || '').toLowerCase().trim();
  if (!terms.length) return [];
  const rows = [];
  for (const s of graph.skills) {
    const idTokens = tokenize(s.id);
    const title = String(s.title || '').toLowerCase();
    const summary = String(s.summary || '').toLowerCase();
    const tags = (s.tags || []).map((t) => String(t).toLowerCase());
    const titleTokens = tokenize(title);
    const summaryTokens = tokenize(summary);
    let score = 0;
    let matched = 0;
    for (const t of terms) {
      let ts = 0;
      if (s.id === t) ts += 12;
      if (idTokens.includes(t)) ts += 6; else if (s.id.includes(t)) ts += 3;
      if (titleTokens.includes(t)) ts += 5; else if (title.includes(t)) ts += 2;
      if (tags.includes(t)) ts += 4; else if (tags.some((g) => g.includes(t))) ts += 2;
      if (s.area === t || s.family === t) ts += 3;
      if (summaryTokens.includes(t)) ts += 2; else if (t.length > 3 && summary.includes(t)) ts += 1;
      if (ts > 0) matched++;
      score += ts;
    }
    if (!score) continue;
    if (terms.length > 1 && (title.includes(phrase) || summary.includes(phrase))) score += 4;
    score += matched === terms.length ? 2 * terms.length : 0; // prefer skills matching every word
    rows.push({ skill: s, score });
  }
  rows.sort((a, b) => b.score - a.score || (a.skill.id < b.skill.id ? -1 : 1));
  return rows.slice(0, Math.max(1, Math.min(limit, 50)));
}

/** requires / required-by / pairs-with, merged from edges and the per-skill arrays. */
export function related(graph, id) {
  const byId = new Map(graph.skills.map((s) => [s.id, s]));
  const self = byId.get(id);
  const requires = new Set(self.requires || []);
  const requiredBy = new Set();
  const pairs = new Set(self.pairsWith || []);
  for (const s of graph.skills) {
    if ((s.requires || []).includes(id)) requiredBy.add(s.id);
    if ((s.pairsWith || []).includes(id)) pairs.add(s.id);
  }
  for (const e of graph.edges) {
    if (e.kind === 'requires') {
      if (e.from === id) requires.add(e.to);
      if (e.to === id) requiredBy.add(e.from);
    } else if (e.kind === 'pairs') {
      if (e.from === id) pairs.add(e.to);
      if (e.to === id) pairs.add(e.from);
    }
  }
  const pick = (set) => [...set].filter((x) => x !== id && byId.has(x)).sort().map((x) => byId.get(x));
  return { skill: self, requires: pick(requires), requiredBy: pick(requiredBy), pairsWith: pick(pairs) };
}

/** Short label for the safety line shown wherever a skill is listed. */
export function safetyLabel(skill) {
  const s = skill.safety || {};
  const flags = Array.isArray(s.flags) && s.flags.length ? ` flags: ${s.flags.join(', ')}` : '';
  return `${s.verdict || 'unscanned'}${flags}`;
}
