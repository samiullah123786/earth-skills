// Plain-text views shared by the MCP tools and the CLI. They are deliberately
// compact: an agent pays for every byte of them in its context window.

import { safetyLabel } from './registry.mjs';

function marks(s) {
  const out = [];
  if (!s.served) out.push('link-only');
  const v = s.safety && s.safety.verdict;
  if (v && v !== 'inert_safe') out.push(v);
  return out.length ? ` [${out.join(', ')}]` : '';
}

/** family -> area -> `id — summary`, plus counts. */
export function formatMap(graph, family) {
  const byId = new Map(graph.skills.map((s) => [s.id, s]));
  let families = graph.families;
  if (family) {
    families = families.filter((f) => f.id === family);
    if (!families.length) {
      return { error: `No family "${family}". Families: ${graph.families.map((f) => f.id).join(', ')}.` };
    }
  }
  const lines = [];
  let shown = 0;
  const placed = new Set();
  for (const f of families) {
    const areaBlocks = [];
    let familyCount = 0;
    for (const a of f.areas || []) {
      const skills = (a.skills || []).map((id) => byId.get(id)).filter(Boolean);
      if (!skills.length) continue;
      familyCount += skills.length;
      areaBlocks.push(`  ${a.id} (${a.title || a.id})`);
      for (const s of skills) {
        placed.add(s.id);
        areaBlocks.push(`    ${s.id} — ${s.summary || s.title || ''}${marks(s)}`);
      }
    }
    if (!familyCount) continue;
    shown += familyCount;
    lines.push(`${f.id} — ${f.title || f.id} (${familyCount})`, ...areaBlocks);
  }
  // Skills whose area is missing from `families` still deserve to be seen.
  const orphans = family ? [] : graph.skills.filter((s) => !placed.has(s.id));
  if (orphans.length) {
    lines.push(`other (${orphans.length})`);
    for (const s of orphans) lines.push(`    ${s.id} — ${s.summary || s.title || ''}${marks(s)}`);
    shown += orphans.length;
  }
  const c = graph.counts || {};
  const head = family
    ? `Earth skills: ${shown} in family ${family}.`
    : `Earth skills: ${c.skills ?? graph.skills.length} skills, ${c.families ?? graph.families.length} families, ${c.areas ?? '?'} areas.`;
  const foot = 'Read one: skill_read {"id":"<id>"}. [link-only] = metadata only, files not served. [needs_review] = check its flags first.';
  return { text: [head, ...lines, foot].join('\n') };
}

export function formatSearch(rows, query) {
  if (!rows.length) return `No skills match "${query}". Try fewer or broader words, or skills_map to browse.`;
  return rows
    .map(({ skill: s }) => `${s.id} — ${s.summary || s.title || ''} (${s.family}/${s.area})${marks(s)}`)
    .join('\n');
}

/** Header shown above any file returned by skill_read / prompts / `show`. */
export function formatHeader(skill, { path, digestVerified } = {}) {
  const lines = [
    `# ${skill.title || skill.id} (${skill.id})`,
    `author: ${skill.author || 'unknown'} · licence: ${skill.license || 'unknown'} · ${skill.family}/${skill.area}`,
    `safety: ${safetyLabel(skill)}`,
  ];
  if (skill.served) {
    lines.push(`digest: ${skill.digest}${digestVerified ? ' (verified)' : ''}`);
  }
  if (skill.sourceUrl) lines.push(`source: ${skill.sourceUrl}`);
  if (skill.served) {
    const others = skill.files.filter((f) => f.path !== path).map((f) => `${f.path} (${f.size} B)`);
    lines.push(`file: ${path}${others.length ? ` · other files: ${others.join(', ')}` : ''}`);
  }
  return lines.join('\n') + '\n---\n';
}

export function formatLinkOnly(skill) {
  return formatHeader(skill) +
    `This skill is link-only: its licence does not allow Earth to serve the files. Read it at ${skill.sourceUrl || 'its source repository'}.\n`;
}

export function formatRelated(rel) {
  const row = (s) => `  ${s.id} — ${s.summary || s.title || ''}${marks(s)}`;
  const block = (title, list) => [title + (list.length ? '' : ' none'), ...list.map(row)];
  return [
    `${rel.skill.id} — ${rel.skill.summary || rel.skill.title || ''}`,
    ...block('requires (read these first):', rel.requires),
    ...block('required by:', rel.requiredBy),
    ...block('pairs with:', rel.pairsWith),
  ].join('\n');
}

/** Text, or a short note when the file is binary and cannot be shown inline. */
export function decodeText(bytes) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0')) throw new Error('binary');
    return { text, binary: false };
  } catch {
    return { text: `(binary file, ${bytes.length} bytes, not shown)`, binary: true };
  }
}
