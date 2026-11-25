import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createRegistry } from '../src/registry.mjs';
import { runSync, readInstalled, installedFile } from '../src/sync.mjs';
import { FIXTURE, copyFixture, rehash, useTempHome, listTree } from './helpers.mjs';

// Every test gets its own temp HOME; useTempHome refuses to continue if
// os.homedir() would still point at the real one.
let ctx;
beforeEach(async () => { ctx = await useTempHome(); });
afterEach(() => ctx.restore());

function capture() {
  const lines = [];
  return { lines, out: (s) => lines.push(s), text: () => lines.join('\n') };
}

const claudeDir = (id) => path.join(ctx.home, '.claude', 'skills', id);

async function sync(opts, { base = FIXTURE, ...io } = {}) {
  const c = capture();
  const code = await runSync(createRegistry({ base }), opts, { out: c.out, isTTY: false, ...io });
  return { code, text: c.text() };
}

test('dry run prints the plan and writes nothing at all', async () => {
  const r = await sync({ ids: ['systematic-debugging', 'executing-plans'], dryRun: true });
  assert.equal(r.code, 0);
  assert.match(r.text, /install +systematic-debugging -> .*systematic-debugging · safety inert_safe/);
  assert.match(r.text, /install +executing-plans -> .* · safety needs_review flags: shell-command/);
  assert.match(r.text, /Dry run: nothing was written/);
  assert.deepEqual(await listTree(ctx.home), []);
});

test('without --yes on a non-terminal it refuses and writes nothing', async () => {
  const r = await sync({ ids: ['writing-plans'] });
  assert.equal(r.code, 1);
  assert.match(r.text, /Re-run with --yes/);
  assert.deepEqual(await listTree(ctx.home), []);
});

test('on a terminal it asks, and only "y" writes', async () => {
  const no = new PassThrough();
  const pNo = sync({ ids: ['writing-plans'] }, { isTTY: true, input: no, output: new PassThrough() });
  no.end('n\n');
  assert.equal((await pNo).code, 1);
  assert.deepEqual(await listTree(ctx.home), []);

  const yes = new PassThrough();
  const pYes = sync({ ids: ['writing-plans'] }, { isTTY: true, input: yes, output: new PassThrough() });
  yes.end('y\n');
  assert.equal((await pYes).code, 0);
  assert.ok(await fs.stat(path.join(claudeDir('writing-plans'), 'SKILL.md')));
});

test('--yes installs verified files and records them; a second run is a no-op', async () => {
  const r = await sync({ ids: ['systematic-debugging', 'test-driven-development'], yes: true });
  assert.equal(r.code, 0, r.text);
  for (const rel of ['SKILL.md', 'notes/root-cause.md']) {
    assert.deepEqual(
      await fs.readFile(path.join(claudeDir('systematic-debugging'), ...rel.split('/'))),
      await fs.readFile(path.join(FIXTURE, 'skills', 'systematic-debugging', ...rel.split('/'))),
    );
  }
  const { installs } = await readInstalled();
  const sd = installs.find((i) => i.id === 'systematic-debugging');
  assert.equal(sd.client, 'claude');
  assert.equal(sd.dir, claudeDir('systematic-debugging'));
  assert.equal(sd.ref, '0123456789abcdef0123456789abcdef01234567'); // linked: pinned upstream ref
  assert.match(sd.digest, /^sha256:/);
  assert.ok(Date.parse(sd.installedAt));
  assert.equal(installs.find((i) => i.id === 'test-driven-development').ref, 'fixture0000000000000000000000000000000000'); // hosted: site commit
  // No temp folders are left behind.
  assert.deepEqual((await fs.readdir(path.dirname(claudeDir('x')))).sort(), ['systematic-debugging', 'test-driven-development']);

  const again = await sync({ ids: ['systematic-debugging'], yes: true });
  assert.equal(again.code, 0);
  assert.match(again.text, /current +systematic-debugging/);
});

test('refuses to touch an existing folder Earth did not write', async () => {
  const dir = claudeDir('test-driven-development');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), 'my own version\n');
  const r = await sync({ ids: ['test-driven-development'], yes: true });
  assert.equal(r.code, 1);
  assert.match(r.text, /refuse +test-driven-development/);
  assert.match(r.text, /Earth did not write it/);
  assert.equal(await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8'), 'my own version\n');
  assert.deepEqual(await fs.readdir(dir), ['SKILL.md']);
  await assert.rejects(fs.stat(installedFile()));
});

test('refuses a managed folder that was edited by hand', async () => {
  await sync({ ids: ['writing-plans'], yes: true });
  const file = path.join(claudeDir('writing-plans'), 'SKILL.md');
  await fs.appendFile(file, 'my note\n');
  const root = await copyFixture();
  await fs.appendFile(path.join(root, 'skills', 'writing-plans', 'SKILL.md'), 'upstream change\n');
  await rehash(root, 'writing-plans');
  const r = await sync({ yes: true }, { base: root });
  assert.equal(r.code, 1);
  assert.match(r.text, /changed since Earth wrote it/);
  assert.match(await fs.readFile(file, 'utf8'), /my note\n$/);
});

test('sync with no ids updates installed skills whose digest changed', async () => {
  const root = await copyFixture();
  await sync({ ids: ['systematic-debugging', 'writing-plans'], yes: true }, { base: root });
  const oldDigest = (await readInstalled()).installs.find((i) => i.id === 'systematic-debugging').digest;

  await fs.writeFile(path.join(root, 'skills', 'systematic-debugging', 'SKILL.md'), '# Systematic Debugging v2\n');
  const newDigest = await rehash(root, 'systematic-debugging');
  assert.notEqual(newDigest, oldDigest);

  const r = await sync({ yes: true }, { base: root });
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /update +systematic-debugging/);
  assert.match(r.text, /current +writing-plans/);
  assert.equal(await fs.readFile(path.join(claudeDir('systematic-debugging'), 'SKILL.md'), 'utf8'), '# Systematic Debugging v2\n');
  assert.equal((await readInstalled()).installs.find((i) => i.id === 'systematic-debugging').digest, newDigest);
});

test('a tampered registry copy is never written', async () => {
  const root = await copyFixture();
  const file = path.join(root, 'skills', 'writing-plans', 'SKILL.md');
  const buf = await fs.readFile(file);
  buf[0] = buf[0] ^ 1;
  await fs.writeFile(file, buf);
  const r = await sync({ ids: ['writing-plans'], yes: true }, { base: root });
  assert.equal(r.code, 1);
  assert.match(r.text, /failed +writing-plans: .*digest mismatch/);
  // Verification happens before any folder is created, so the home stays empty.
  assert.deepEqual(await listTree(ctx.home), []);
});

test('link-only skills are skipped with a message', async () => {
  const r = await sync({ ids: ['seo-audit'], yes: true });
  assert.match(r.text, /skip +seo-audit/);
  assert.match(r.text, /link-only/);
  await assert.rejects(fs.stat(claudeDir('seo-audit')));
});

test('--client all and --dir pick the right folders', async () => {
  const all = await sync({ ids: ['writing-plans'], client: 'all', dryRun: true });
  for (const c of ['.claude', '.codex', '.cursor']) {
    assert.ok(all.text.includes(path.join(ctx.home, c, 'skills', 'writing-plans')), c);
  }
  const custom = path.join(ctx.home, 'custom-skills');
  const r = await sync({ ids: ['writing-plans'], dir: custom, yes: true });
  assert.equal(r.code, 0, r.text);
  assert.ok(await fs.stat(path.join(custom, 'writing-plans', 'SKILL.md')));
  assert.equal((await readInstalled()).installs[0].client, 'custom');
  await assert.rejects(sync({ ids: ['writing-plans'], client: 'emacs', dryRun: true }), /Unknown client/);
});

test('unknown ids are refused', async () => {
  const r = await sync({ ids: ['no-such-skill'], yes: true });
  assert.equal(r.code, 1);
  assert.match(r.text, /refuse +no-such-skill/);
});
