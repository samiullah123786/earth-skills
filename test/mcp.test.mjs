import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { FIXTURE, REPO_ROOT, tmpDir, listTree } from './helpers.mjs';

// One real child process, spoken to over stdin/stdout exactly as a client would.
let child;
let home;
const stdoutLines = [];
const waiting = new Map();
let nextId = 1;

before(async () => {
  home = await tmpDir('earth-mcp-home-');
  child = spawn(process.execPath, [path.join(REPO_ROOT, 'bin', 'earth-skills.mjs'), 'serve'], {
    env: { ...process.env, EARTH_SKILLS_BASE: FIXTURE, HOME: home, USERPROFILE: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    stdoutLines.push(line);
    const msg = JSON.parse(line); // a non-JSON line fails the run here
    const w = waiting.get(msg.id);
    if (w) { waiting.delete(msg.id); w(msg); }
  });
});

after(async () => {
  child.stdin.end();
  await new Promise((r) => child.once('exit', r));
  await fs.rm(home, { recursive: true, force: true });
});

function send(msg) { child.stdin.write(JSON.stringify(msg) + '\n'); }

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10000);
    waiting.set(id, (m) => { clearTimeout(timer); resolve(m); });
    send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
  });
}

const call = async (name, args) => (await request('tools/call', { name, arguments: args })).result;
const textOf = (r) => r.content.map((c) => c.text).join('');

test('initialize, initialized notification, ping', async () => {
  const init = await request('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' },
  });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.ok(init.result.capabilities.tools);
  assert.ok(init.result.capabilities.prompts);
  assert.equal(init.result.serverInfo.name, 'earth-skills');
  const linesBefore = stdoutLines.length;
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const ping = await request('ping');
  assert.deepEqual(ping.result, {});
  assert.equal(stdoutLines.length, linesBefore + 1, 'the notification got no response');
});

test('tools/list has exactly the four read-only tools and nothing write-shaped', async () => {
  const { tools } = (await request('tools/list')).result;
  assert.deepEqual(tools.map((t) => t.name).sort(), ['skill_read', 'skills_map', 'skills_related', 'skills_search']);
  const writeShaped = /\b(write|writes|writing|install|delete|remove|exec|execute|run|shell|spawn|save|upload|edit|create|update|modify|purchase|pay)\b|\b(install|exec|delet|writ)/i;
  for (const t of tools) {
    const props = Object.values(t.inputSchema.properties || {}).map((p) => p.description || '');
    for (const s of [t.name, t.title || '', t.description, ...props]) {
      assert.doesNotMatch(s, writeShaped, `${t.name}: "${s}"`);
    }
    assert.equal(t.annotations.readOnlyHint, true, t.name);
    assert.equal(t.inputSchema.type, 'object');
  }
});

test('skills_map is small and lists every skill', async () => {
  const r = await call('skills_map', {});
  assert.ok(!r.isError);
  const t = textOf(r);
  assert.ok(Buffer.byteLength(t) < 4096);
  for (const id of ['systematic-debugging', 'test-driven-development', 'writing-plans', 'executing-plans', 'seo-audit']) {
    assert.ok(t.includes(id), id);
  }
  assert.ok(textOf(await call('skills_map', { family: 'nope' })).includes('No family'));
});

test('skills_search ranks and caps results', async () => {
  const r = await call('skills_search', { query: 'root cause', limit: 50 });
  assert.match(textOf(r).split('\n')[0], /^systematic-debugging — /);
  const missing = await call('skills_search', {});
  assert.equal(missing.isError, true);
  assert.match(textOf(missing), /query/);
});

test('skill_read returns a verified entry file with a header', async () => {
  const t = textOf(await call('skill_read', { id: 'systematic-debugging' }));
  assert.match(t, /^# Systematic Debugging \(systematic-debugging\)/);
  assert.match(t, /author: Jesse Vincent · licence: MIT/);
  assert.match(t, /safety: inert_safe/);
  assert.match(t, /digest: sha256:[0-9a-f]{64} \(verified\)/);
  assert.match(t, /source: https:\/\/github\.com\/obra/);
  assert.match(t, /other files: notes\/root-cause\.md/);
  assert.match(t, /Reproduce the failure/);

  const notes = textOf(await call('skill_read', { id: 'systematic-debugging', file: 'notes/root-cause.md' }));
  assert.match(notes, /Root cause checklist/);

  const flagged = textOf(await call('skill_read', { id: 'executing-plans' }));
  assert.match(flagged, /safety: needs_review flags: shell-command/);
});

test('skill_read errors are tool results that say what to do next', async () => {
  const trav = await call('skill_read', { id: 'systematic-debugging', file: '../../graph.json' });
  assert.equal(trav.isError, true);
  assert.match(textOf(trav), /Refused path/);
  const unknown = await call('skill_read', { id: 'systematic-debuging' });
  assert.equal(unknown.isError, true);
  assert.match(textOf(unknown), /Did you mean: systematic-debugging/);
  const tool = await call('rm_rf', {});
  assert.equal(tool.isError, true);
});

test('skill_read on a link-only skill gives the source, never the files', async () => {
  const r = await call('skill_read', { id: 'seo-audit' });
  assert.ok(!r.isError);
  const t = textOf(r);
  assert.match(t, /link-only/);
  assert.match(t, /https:\/\/github\.com\/example\/seo-skills/);
  assert.doesNotMatch(t, /DECOY/);
  assert.doesNotMatch(textOf(await call('skill_read', { id: 'seo-audit', file: 'SKILL.md' })), /DECOY/);
});

test('skills_related lists neighbours with summaries', async () => {
  const t = textOf(await call('skills_related', { id: 'executing-plans' }));
  assert.match(t, /requires \(read these first\):\n {2}writing-plans — Turn a spec/);
  assert.match(t, /pairs with: none/);
});

test('prompts: every served skill is a prompt; prompts/get returns its entry file', async () => {
  const { prompts } = (await request('prompts/list')).result;
  assert.deepEqual(prompts.map((p) => p.name).sort(), ['executing-plans', 'systematic-debugging', 'test-driven-development', 'writing-plans']);
  assert.equal(prompts.find((p) => p.name === 'writing-plans').description, 'Turn a spec into a step-by-step plan another agent can follow.');
  const got = (await request('prompts/get', { name: 'test-driven-development' })).result;
  assert.equal(got.messages[0].role, 'user');
  assert.match(got.messages[0].content.text, /Red, green, refactor/);
  const linkOnly = await request('prompts/get', { name: 'seo-audit' });
  assert.equal(linkOnly.error.code, -32602);
  assert.doesNotMatch(JSON.stringify(linkOnly), /DECOY/);
});

test('unknown methods and bad JSON get JSON-RPC errors; stdout stays pure protocol', async () => {
  assert.equal((await request('resources/list')).error.code, -32601);
  const parseErr = new Promise((resolve) => waiting.set(null, resolve));
  child.stdin.write('{not json\n');
  assert.equal((await parseErr).error.code, -32700);
  for (const line of stdoutLines) assert.equal(JSON.parse(line).jsonrpc, '2.0');
  // A file:// base needs no cache, so serving wrote nothing into the temp home.
  assert.deepEqual(await listTree(home), []);
});
