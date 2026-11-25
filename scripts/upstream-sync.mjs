#!/usr/bin/env node
/**
 * Moves each linked skill's pinned commit forward when its upstream changes.
 *
 * It only edits `ref:` lines. The weekly workflow turns the edits into one pull
 * request, CI scans the new bytes, and the owner merges or not. A skill never
 * changes on Earth just because someone pushed to their own repository.
 */

import { readFileSync, readdirSync, lstatSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const headers = { 'user-agent': 'earth-skills-upstream', accept: 'application/vnd.github+json' };
if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

function find(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (lstatSync(full).isDirectory()) out.push(...find(full));
    else if (name === 'skill.yml') out.push(full);
  }
  return out;
}

const moved = [];
for (const file of find(join(ROOT, 'skills'))) {
  const text = readFileSync(file, 'utf8');
  const meta = YAML.parse(text);
  if (!meta?.source) continue;
  const { repo, path, ref } = meta.source;
  const url = `https://api.github.com/repos/${repo}/commits?path=${encodeURIComponent(path)}&per_page=1`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    console.warn(`~ ${meta.name}: GitHub answered ${response.status}; left as is`);
    continue;
  }
  const [latest] = await response.json();
  if (!latest?.sha || latest.sha === ref) continue;
  writeFileSync(file, text.replace(ref, latest.sha));
  moved.push(`- **${meta.name}**: ${repo} \`${ref.slice(0, 7)}\` → \`${latest.sha.slice(0, 7)}\` ` +
    `([diff](https://github.com/${repo}/compare/${ref}...${latest.sha}))`);
}

console.log(moved.length ? moved.join('\n') : 'Every linked skill is current.');
if (process.env.GITHUB_OUTPUT) {
  writeFileSync(process.env.GITHUB_OUTPUT, `changed=${moved.length > 0}\nbody<<EOF\n${moved.join('\n')}\nEOF\n`, { flag: 'a' });
}
