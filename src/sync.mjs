// `earth-skills sync`: copies verified skills into a client's skill folder.
//
// This is the only code path that writes outside ~/.earth-skills, so it is
// conservative: it always prints the plan first, asks before writing, only
// touches folders it wrote itself (tracked in ~/.earth-skills/installed.json),
// and refuses a managed folder that was edited by hand since Earth wrote it.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { randomBytes } from 'node:crypto';
import { computeDigest, earthHome, EarthError, safetyLabel } from './registry.mjs';

export const CLIENTS = {
  claude: () => path.join(os.homedir(), '.claude', 'skills'),
  codex: () => path.join(os.homedir(), '.codex', 'skills'),
  cursor: () => path.join(os.homedir(), '.cursor', 'skills'),
};

export const installedFile = () => path.join(earthHome(), 'installed.json');

const samePath = (a, b) => {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
};

export async function readInstalled() {
  try {
    const data = JSON.parse(await fs.readFile(installedFile(), 'utf8'));
    return { version: 1, installs: Array.isArray(data.installs) ? data.installs : [] };
  } catch (err) {
    if (err.code === 'ENOENT') return { version: 1, installs: [] };
    throw new EarthError(`${installedFile()} is unreadable (${err.message}). Fix or remove it before syncing.`, 'bad_state');
  }
}

async function writeInstalled(state) {
  const file = installedFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2) + '\n');
  await fs.rename(tmp, file);
}

async function exists(p) {
  try { await fs.lstat(p); return true; } catch { return false; }
}

/** Every regular file under dir as { path (posix, relative), bytes }. Symlinks count as edits. */
async function readTree(dir, rel = '') {
  const out = [];
  for (const ent of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...(await readTree(dir, childRel)));
    else if (ent.isFile()) out.push({ path: childRel, bytes: await fs.readFile(path.join(dir, ...childRel.split('/'))) });
    else out.push({ path: childRel, bytes: Buffer.from('non-regular file') });
  }
  return out;
}

/** Targets as [{ client, root }]. --dir overrides the root; --client all fans out. */
export function resolveTargets({ client, dir }) {
  if (dir) {
    if (client === 'all') throw new EarthError('--dir takes a single folder; use it with one --client or none.', 'bad_args');
    return [{ client: client || 'custom', root: path.resolve(dir) }];
  }
  const names = !client ? ['claude'] : client === 'all' ? Object.keys(CLIENTS) : [client];
  for (const n of names) {
    if (!CLIENTS[n]) throw new EarthError(`Unknown client "${n}". Use claude, codex, cursor or all.`, 'bad_args');
  }
  return names.map((n) => ({ client: n, root: CLIENTS[n]() }));
}

/**
 * Works out what sync would do, without touching anything.
 * Each item: { id, client, dir, action, reason, skill? }, where action is
 * install | update | current | skip | refuse.
 */
export async function planSync(registry, { ids = [], client, dir } = {}) {
  const graph = await registry.getGraph();
  const byId = new Map(graph.skills.map((s) => [s.id, s]));
  const state = await readInstalled();
  const targets = resolveTargets({ client, dir });
  const pairs = [];

  if (ids.length) {
    for (const t of targets) for (const id of ids) pairs.push({ id, client: t.client, dir: path.join(t.root, id) });
  } else {
    // No ids: refresh what Earth installed before, limited to the chosen targets when given.
    for (const rec of state.installs) {
      if ((client || dir) && !targets.some((t) => samePath(path.dirname(rec.dir), t.root))) continue;
      pairs.push({ id: rec.id, client: rec.client, dir: rec.dir });
    }
  }

  const items = [];
  for (const p of pairs) {
    const skill = byId.get(p.id);
    const rec = state.installs.find((r) => samePath(r.dir, p.dir));
    const item = { ...p, skill };
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(p.id)) {
      items.push({ ...item, action: 'refuse', reason: 'not a valid skill id' });
    } else if (!skill && rec) {
      items.push({ ...item, action: 'skip', reason: 'no longer on the Earth map; left in place' });
    } else if (!skill) {
      items.push({ ...item, action: 'refuse', reason: 'no such skill on the Earth map; try `earth-skills search <words>`' });
    } else if (!skill.served) {
      items.push({ ...item, action: 'skip', reason: `link-only, Earth does not serve its files; read it at ${skill.sourceUrl}` });
    } else if (skill.safety && skill.safety.verdict === 'refused') {
      items.push({ ...item, action: 'refuse', reason: 'safety verdict is refused' });
    } else if (!(await exists(p.dir))) {
      items.push({ ...item, action: 'install', reason: rec ? 'folder was removed; will re-create it' : 'new' });
    } else if (!rec) {
      items.push({ ...item, action: 'refuse', reason: 'folder exists but Earth did not write it (not in installed.json); move or delete it yourself to let Earth manage it' });
    } else {
      // Compare what is on disk with what Earth last wrote, so hand edits are never lost.
      let onDisk;
      try { onDisk = computeDigest(await readTree(p.dir)); } catch (err) { onDisk = `unreadable: ${err.message}`; }
      if (onDisk !== rec.digest) {
        items.push({ ...item, action: 'refuse', reason: 'folder was changed since Earth wrote it; keep your edits elsewhere and delete the folder to resync' });
      } else if (rec.digest === skill.digest) {
        items.push({ ...item, action: 'current', reason: 'already current' });
      } else {
        items.push({ ...item, action: 'update', reason: `digest changed (${rec.digest.slice(7, 19)} -> ${skill.digest.slice(7, 19)})` });
      }
    }
  }
  return { graph, items };
}

export function formatPlan(items) {
  if (!items.length) return 'Nothing to sync: no skill ids given and no Earth-managed skills recorded yet.';
  const lines = ['Plan:'];
  for (const it of items) {
    const safety = it.skill ? ` · safety ${safetyLabel(it.skill)}` : '';
    lines.push(`  ${it.action.padEnd(7)} ${it.id} -> ${it.dir}${safety}`);
    if (it.action !== 'install' || it.reason !== 'new') lines.push(`          ${it.reason}`);
  }
  const n = (a) => items.filter((i) => i.action === a).length;
  lines.push(`${n('install')} to install, ${n('update')} to update, ${n('current')} current, ${n('skip')} skipped, ${n('refuse')} refused.`);
  return lines.join('\n');
}

/** Writes one verified skill: temp folder next to the target, then rename into place. */
async function writeSkill(registry, item) {
  const full = await registry.fetchSkill(item.id); // digest-verified or throws
  const root = path.dirname(item.dir);
  await fs.mkdir(root, { recursive: true });
  const tag = randomBytes(4).toString('hex');
  const tmp = path.join(root, `.earth-tmp-${item.id}-${tag}`);
  const old = path.join(root, `.earth-old-${item.id}-${tag}`);
  try {
    for (const f of full.files) {
      const dest = path.join(tmp, ...f.path.split('/'));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, f.bytes);
    }
    // Re-hash what actually landed on disk before it goes live.
    const landed = computeDigest(await readTree(tmp));
    if (landed !== full.digest) throw new EarthError(`Skill ${item.id}: written files do not match the digest; nothing was changed.`, 'digest_mismatch');
    if (await exists(item.dir)) {
      await fs.rename(item.dir, old);
      try { await fs.rename(tmp, item.dir); } catch (err) {
        await fs.rename(old, item.dir); // put the previous copy back
        throw err;
      }
      await fs.rm(old, { recursive: true, force: true });
    } else {
      await fs.rename(tmp, item.dir);
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
  return full;
}

async function askYesNo(question, { input, output }) {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await new Promise((resolve) => rl.question(question, resolve));
    return /^y(es)?$/i.test(String(answer).trim());
  } finally {
    rl.close();
  }
}

/**
 * Runs sync end to end. Returns an exit code; all output goes through `out`.
 * io lets tests supply streams and a TTY flag instead of the real terminal.
 */
export async function runSync(registry, opts = {}, io = {}) {
  const out = io.out || ((s) => process.stdout.write(s + '\n'));
  const input = io.input || process.stdin;
  const output = io.output || process.stdout;
  const isTTY = io.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);

  const { items } = await planSync(registry, opts);
  out(formatPlan(items));
  const work = items.filter((i) => i.action === 'install' || i.action === 'update');
  const refused = items.some((i) => i.action === 'refuse');
  if (!work.length) return refused ? 1 : 0;
  if (opts.dryRun) {
    out('Dry run: nothing was written.');
    return 0;
  }
  if (!opts.yes) {
    if (!isTTY) {
      out('Not a terminal, so there is no one to confirm. Re-run with --yes to write these skills.');
      return 1;
    }
    if (!(await askYesNo(`Write ${work.length} skill folder(s)? [y/N] `, { input, output }))) {
      out('Cancelled: nothing was written.');
      return 1;
    }
  }

  let failed = 0;
  for (const item of work) {
    try {
      const full = await writeSkill(registry, item);
      // installed.json is re-read per skill so a failure part way still records what landed.
      const state = await readInstalled();
      state.installs = state.installs.filter((r) => !samePath(r.dir, item.dir));
      state.installs.push({
        id: item.id,
        client: item.client,
        dir: item.dir,
        digest: full.digest,
        ref: full.skill.ref || (await registry.getGraph()).commit || null,
        installedAt: new Date().toISOString(),
      });
      await writeInstalled(state);
      out(`${item.action === 'update' ? 'updated' : 'installed'} ${item.id} -> ${item.dir}`);
    } catch (err) {
      failed++;
      out(`failed  ${item.id}: ${err.message}`);
    }
  }
  return failed || refused ? 1 : 0;
}
