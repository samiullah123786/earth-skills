// Shared test helpers. Everything runs offline against test/fixtures/registry,
// and anything that could write goes to a fresh temp folder.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeDigest } from '../src/registry.mjs';

export const FIXTURE = fileURLToPath(new URL('./fixtures/registry/', import.meta.url));
export const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

export async function tmpDir(prefix = 'earth-test-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** A writable copy of the fixture registry, for tamper and update tests. */
export async function copyFixture() {
  const dir = await tmpDir('earth-registry-');
  await fs.cp(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * Points HOME and USERPROFILE at a temp folder for this process, so sync can
 * never touch the real home. Throws if os.homedir() does not follow.
 */
export async function useTempHome() {
  const home = await tmpDir('earth-home-');
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  if (path.resolve(os.homedir()) !== path.resolve(home)) {
    throw new Error(`os.homedir() did not follow the temp HOME (${os.homedir()}); refusing to run.`);
  }
  return {
    home,
    async restore() {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      await fs.rm(home, { recursive: true, force: true });
    },
  };
}

/** Recomputes sizes and digest in graph.json after a fixture file was edited on purpose. */
export async function rehash(root, id) {
  const graphFile = path.join(root, 'graph.json');
  const graph = JSON.parse(await fs.readFile(graphFile, 'utf8'));
  const skill = graph.skills.find((s) => s.id === id);
  const files = [];
  for (const f of skill.files) {
    files.push({ path: f.path, bytes: await fs.readFile(path.join(root, 'skills', id, ...f.path.split('/'))) });
  }
  skill.files = files.map((f) => ({ path: f.path, size: f.bytes.length }));
  skill.digest = computeDigest(files);
  await fs.writeFile(graphFile, JSON.stringify(graph, null, 2));
  return skill.digest;
}

/** Every file under dir, relative, sorted. Empty array when dir is missing. */
export async function listTree(dir) {
  const out = [];
  async function walk(rel) {
    let ents;
    try { ents = await fs.readdir(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out.push(r + '/'); await walk(r); } else out.push(r);
    }
  }
  await walk('');
  return out.sort();
}
