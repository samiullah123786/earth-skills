import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRegistry, computeDigest, assertSafeRelPath, resolveBase } from '../src/registry.mjs';
import { formatMap } from '../src/format.mjs';
import { FIXTURE, copyFixture, rehash, useTempHome, listTree } from './helpers.mjs';

test('digest matches the graph-schema definition (known answer from sha256sum)', () => {
  // printf 'a.md\n3\nabcb/c.md\n2\nhi' | sha256sum  -- input order must not matter.
  const files = [
    { path: 'b/c.md', bytes: Buffer.from('hi') },
    { path: 'a.md', bytes: Buffer.from('abc') },
  ];
  assert.equal(computeDigest(files), 'sha256:db1000c014f9795301a3138063c65709dc7541250bc32378cf343edb5644c0e6');
});

test('fetchSkill verifies every served fixture skill', async () => {
  const reg = createRegistry({ base: FIXTURE });
  const graph = await reg.getGraph();
  for (const s of graph.skills.filter((x) => x.served)) {
    const full = await reg.fetchSkill(s.id);
    assert.equal(full.digest, s.digest);
    assert.equal(full.files.length, s.files.length);
  }
  const sd = await reg.fetchSkill('systematic-debugging');
  assert.deepEqual(sd.files.map((f) => f.path), ['SKILL.md', 'notes/root-cause.md']);
  assert.match(sd.files[0].bytes.toString(), /# Systematic Debugging/);
});

test('a tampered file is rejected and its bytes are never returned', async () => {
  const root = await copyFixture();
  const file = path.join(root, 'skills', 'systematic-debugging', 'SKILL.md');
  const orig = await fs.readFile(file);
  const evil = Buffer.from(orig);
  evil[evil.length - 2] = evil[evil.length - 2] === 0x41 ? 0x42 : 0x41; // same size, one byte changed
  await fs.writeFile(file, evil);

  const reg = createRegistry({ base: root });
  await assert.rejects(reg.fetchSkill('systematic-debugging'), /digest mismatch/);
  await assert.rejects(reg.readSkillFile('systematic-debugging'), /digest mismatch/);
  // Other skills are unaffected.
  await reg.fetchSkill('test-driven-development');
});

test('a file whose size differs from graph.json is rejected', async () => {
  const root = await copyFixture();
  await fs.appendFile(path.join(root, 'skills', 'writing-plans', 'SKILL.md'), 'extra\n');
  const reg = createRegistry({ base: root });
  await assert.rejects(reg.fetchSkill('writing-plans'), /bytes, graph.json says/);
});

test('path traversal and unlisted paths are refused before any read', async () => {
  const reg = createRegistry({ base: FIXTURE });
  const bad = ['../writing-plans/SKILL.md', '../../graph.json', '/etc/passwd', 'notes\\root-cause.md',
    'C:/Windows/win.ini', 'notes/../SKILL.md', './SKILL.md', 'notes//root-cause.md', '\0', 'unlisted.md'];
  for (const p of bad) {
    await assert.rejects(reg.readSkillFile('systematic-debugging', p), /Refused path|has no file|non-empty/, p);
  }
  for (const p of bad.slice(0, -1)) assert.throws(() => assertSafeRelPath(p), p);
  assert.equal((await reg.readSkillFile('systematic-debugging', 'notes/root-cause.md')).path, 'notes/root-cause.md');
});

test('a graph listing a traversal path is rejected as a whole', async () => {
  const root = await copyFixture();
  const graphFile = path.join(root, 'graph.json');
  const graph = JSON.parse(await fs.readFile(graphFile, 'utf8'));
  graph.skills[0].files.push({ path: '../../secret', size: 1 });
  await fs.writeFile(graphFile, JSON.stringify(graph));
  await assert.rejects(createRegistry({ base: root }).getGraph(), /Refused path/);
});

test('link-only skills return metadata and sourceUrl, never files', async () => {
  const reg = createRegistry({ base: FIXTURE });
  const full = await reg.fetchSkill('seo-audit');
  assert.equal(full.served, false);
  assert.equal(full.files, null);
  assert.match(full.sourceUrl, /^https:\/\/github\.com\//);
  // The fixture has a decoy file on disk; it must still never be read out.
  await assert.rejects(reg.readSkillFile('seo-audit'), /link-only/);
  await assert.rejects(reg.readSkillFile('seo-audit', 'SKILL.md'), /link-only/);
});

test('search ranks the obvious match first and ignores noise', async () => {
  const reg = createRegistry({ base: FIXTURE });
  assert.equal((await reg.search('root cause bug'))[0].skill.id, 'systematic-debugging');
  assert.equal((await reg.search('tdd'))[0].skill.id, 'test-driven-development');
  const plans = (await reg.search('planning')).map((r) => r.skill.id);
  assert.deepEqual(plans.slice(0, 2).sort(), ['executing-plans', 'writing-plans']);
  assert.deepEqual(await reg.search('zzzz qqqq'), []);
  assert.equal((await reg.search('plan', 1)).length, 1);
});

test('related merges requires, required-by and pairs-with', async () => {
  const reg = createRegistry({ base: FIXTURE });
  const ep = await reg.related('executing-plans');
  assert.deepEqual(ep.requires.map((s) => s.id), ['writing-plans']);
  const wp = await reg.related('writing-plans');
  assert.deepEqual(wp.requiredBy.map((s) => s.id), ['executing-plans']);
  const tdd = await reg.related('test-driven-development');
  assert.deepEqual(tdd.pairsWith.map((s) => s.id), ['systematic-debugging']);
  await assert.rejects(reg.related('no-such-skill'), /No skill/);
});

test('map is compact, complete and filterable', async () => {
  const graph = await createRegistry({ base: FIXTURE }).getGraph();
  const { text } = formatMap(graph);
  assert.ok(Buffer.byteLength(text) < 4096);
  for (const s of graph.skills) assert.ok(text.includes(`${s.id} — `), s.id);
  assert.match(text, /seo-audit — .*\[link-only\]/);
  assert.match(text, /executing-plans — .*\[needs_review\]/);
  assert.doesNotMatch(formatMap(graph, 'marketing').text, /writing-plans/);
  assert.match(formatMap(graph, 'nope').error, /No family/);
});

test('resolveBase accepts http, file:// and plain folders', () => {
  assert.equal(resolveBase('https://x.test/a').root, 'https://x.test/a/');
  const viaUrl = resolveBase(pathToFileURL(FIXTURE).href);
  assert.equal(viaUrl.kind, 'file');
  assert.equal(path.resolve(viaUrl.root), path.resolve(FIXTURE));
  assert.equal(resolveBase(FIXTURE).kind, 'file');
});

test('http: disk cache with ETag, in-memory TTL, and offline fallback', async (t) => {
  const { home, restore } = await useTempHome();
  t.after(restore);
  const hits = [];
  const server = http.createServer(async (req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
    hits.push({ url: req.url, inm: req.headers['if-none-match'] });
    try {
      const body = await fs.readFile(path.join(FIXTURE, ...rel.split('/')));
      if (rel === 'graph.json') {
        if (req.headers['if-none-match'] === '"v1"') { res.writeHead(304); res.end(); return; }
        res.setHeader('etag', '"v1"');
      }
      res.writeHead(200); res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  const r1 = createRegistry({ base });
  await r1.getGraph();
  await r1.getGraph(); // within TTL: no second request
  assert.equal(hits.filter((h) => h.url === '/graph.json').length, 1);
  await r1.fetchSkill('systematic-debugging');
  assert.ok((await listTree(path.join(home, '.earth-skills', 'cache'))).some((p) => p.endsWith('/graph.json')));

  const r2 = createRegistry({ base }); // fresh process memory, same disk cache
  await r2.getGraph();
  const last = hits.filter((h) => h.url === '/graph.json').at(-1);
  assert.equal(last.inm, '"v1"', 'second run sends If-None-Match');

  await new Promise((r) => server.close(r));
  const before = hits.length;
  const r3 = createRegistry({ base, log: () => {} }); // server gone: last good copy still works
  assert.equal((await r3.getGraph()).skills.length, 5);
  const sd = await r3.fetchSkill('systematic-debugging');
  assert.match(sd.files[0].bytes.toString(), /Systematic Debugging/);
  assert.equal(hits.length, before);
  await assert.rejects(r3.fetchSkill('writing-plans'), /Could not fetch/); // never fetched, not cached
});
