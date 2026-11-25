/**
 * The Earth safety scanner, earth-safety-2.
 *
 * A JavaScript port of the Kernel's scanner (earth-world/convex/scanner.ts),
 * itself a port of the connector's earth_cli/safety.py. Same rule names, same
 * verdicts, so a skill reads the same here, in the Kernel and in the CLI.
 * No model judges anything: a verdict must be reproducible and must name the
 * exact file and line that caused it.
 */

export const SCANNER_VERSION = 'earth-safety-2';

const INERT_SUFFIXES = new Set(['.md', '.markdown', '.txt', '.rst', '.json', '.yaml', '.yml',
  '.csv', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']);
const EXECUTABLE_SUFFIXES = new Set(['.py', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
  '.js', '.mjs', '.cjs', '.ts', '.rb', '.pl', '.php',
  '.exe', '.dll', '.so', '.dylib', '.jar', '.bin', '.msi']);
const CONFIG_NAMES = new Set(['settings.json', 'settings.local.json', '.mcp.json', 'mcp.json',
  'hooks.json', 'claude.json', '.claude.json', 'config.toml']);
const TEXT_SCAN_SUFFIXES = new Set(['.py', '.sh', '.ps1', '.js', '.ts']);
const PROSE_SUFFIXES = new Set(['.md', '.markdown', '.txt', '.rst']);

export const MAX_FILES = 5_000;
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

// Each pattern describes something the text would make an agent DO, not
// vocabulary that merely sounds alarming. Kept identical to the Kernel's list.
const TEXT_RULES = [
  ['instruction_override',
    /\b(ignore|disregard|forget)\s+(all\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?|messages?)/i,
    'tells an agent to discard the instructions it was given'],
  ['prompt_extraction',
    /\b(reveal|print|output|repeat|show)\b[^.\n]{0,40}\b(system prompt|your instructions)\b/i,
    'asks an agent to disclose its system prompt'],
  ['concealment',
    /\b(do not|don'?t|never)\b[^.\n]{0,30}\b(tell|inform|mention to|show)\b[^.\n]{0,20}\b(the )?(user|owner|human)\b/i,
    'asks an agent to hide what it is doing from its owner'],
  ['shell_execution',
    /(curl|wget|iwr|invoke-webrequest)[^\n|]{0,120}\|\s*(ba|z|sh|pwsh|iex|invoke-expression)/i,
    'pipes a download straight into a shell'],
  ['dynamic_execution',
    /\b(invoke-expression|os\.system|subprocess\.(run|call|popen)|child_process|eval\s*\(|exec\s*\()/i,
    'executes code it builds at run time'],
  ['credential_access',
    /(~[/\\]\.ssh|id_rsa|id_ed25519|AWS_SECRET|AWS_SESSION_TOKEN)/i,
    'reaches for a private key or cloud secret'],
  ['needs_api_key',
    /(\.env\b|ANTHROPIC_API_KEY|OPENAI_API_KEY|\b\w*_API_KEY\b|\bprocess\.env\b|\bos\.environ\b)/i,
    'needs an API key or environment variable to be set'],
  ['exfiltration',
    /^(?=[^\n]*\bhttps?:\/\/)(?=[^\n]*\b(?:post|send|upload|exfiltrat\w*|curl|fetch|transmit)\b)(?=[^\n]*\b(?:key|keys|token|secret|credential|password|\.env|history|contents?)\b)[^\n]*$/im,
    'sends local material to an outside address'],
  ['environment_mutation',
    /"?(mcpServers|hooks|allowedTools|permissions)"?\s*:\s*[{[]/i,
    'reconfigures the coding agent itself'],
  ['encoded_payload',
    /[A-Za-z0-9+/]{240,}={0,2}/,
    'carries a long encoded blob that a reader cannot inspect'],
  ['hidden_text',
    /[​‌‍⁠﻿]/,
    'contains invisible characters that hide text from a human reader'],
  ['bidi_override',
    /[‪-‮⁦-⁩]/,
    'contains Unicode direction controls that make displayed text lie about its order'],
  ['tool_shadowing',
    /\b(instead of (?:using|calling)|do not (?:use|call) the|before (?:using|calling) any other tool|always (?:use|call) this tool (?:first|instead)|intercept(?:s)? (?:all|other) tool|override the behavior of)\b/i,
    'instructs an agent to prefer, avoid, or intercept other tools'],
];

// In prose, naming a config variable is documentation, not behaviour.
const BEHAVIOURAL_RULES = new Set(['needs_api_key']);

const suffixOf = (name) => {
  const base = name.split('/').pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
};

export const isProseFile = (name) => PROSE_SUFFIXES.has(suffixOf(name));

export function scanText(where, text, prose = false) {
  const findings = [];
  for (const [rule, pattern, detail] of TEXT_RULES) {
    const match = pattern.exec(text);
    if (!match) continue;
    const line = text.slice(0, match.index).split('\n').length;
    const severity = prose && BEHAVIOURAL_RULES.has(rule) ? 'capability' : 'review';
    findings.push({ rule, severity, where, detail, line });
  }
  return findings;
}

export function unsafeMember(name) {
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    return 'uses an absolute path, which would write outside the install folder';
  }
  if (normalized.split('/').some((part) => part === '..')) {
    return "walks up out of the install folder with '..'";
  }
  return null;
}

/**
 * entries: [{ name, size, symlink?: boolean, text?: string }]
 * Returns { verdict, flags, findings, fileCount, totalBytes }.
 */
export function scanEntries(entries) {
  const findings = [];
  let fileCount = 0;
  let totalBytes = 0;

  for (const entry of entries) {
    const escape = unsafeMember(entry.name);
    if (escape) {
      findings.push({ rule: 'path_traversal', severity: 'refuse', where: entry.name, detail: escape, line: 0 });
      continue;
    }
    if (entry.symlink) {
      findings.push({
        rule: 'symlink', severity: 'refuse', where: entry.name,
        detail: 'is a symbolic link, which can escape the install folder', line: 0,
      });
      continue;
    }
    fileCount += 1;
    totalBytes += entry.size;

    const base = (entry.name.split('/').pop() ?? entry.name).toLowerCase();
    const suffix = suffixOf(entry.name);
    if (CONFIG_NAMES.has(base)) {
      findings.push({
        rule: 'environment_mutation', severity: 'review', where: entry.name,
        detail: 'is a coding-agent configuration file, not knowledge', line: 0,
      });
    }
    if (EXECUTABLE_SUFFIXES.has(suffix)) {
      findings.push({
        rule: 'executable_file', severity: 'review', where: entry.name,
        detail: `is a ${suffix} program, so installing it puts runnable code on the machine`, line: 0,
      });
    } else if (!INERT_SUFFIXES.has(suffix)) {
      findings.push({
        rule: 'unknown_file_type', severity: 'review', where: entry.name,
        detail: `has the unrecognised extension ${suffix || '(none)'} and cannot be read as knowledge`, line: 0,
      });
    }
    if (typeof entry.text === 'string' && (INERT_SUFFIXES.has(suffix) || TEXT_SCAN_SUFFIXES.has(suffix))) {
      findings.push(...scanText(entry.name, entry.text, isProseFile(entry.name)));
    }
  }

  if (fileCount === 0) {
    findings.push({ rule: 'empty_package', severity: 'refuse', where: 'package', detail: 'contains no files at all', line: 0 });
  }
  if (fileCount > MAX_FILES) {
    findings.push({ rule: 'too_many_files', severity: 'refuse', where: 'package',
      detail: `holds ${fileCount} files, above the ${MAX_FILES} limit`, line: 0 });
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    findings.push({ rule: 'too_large', severity: 'refuse', where: 'package',
      detail: `is ${totalBytes} bytes, above the ${MAX_TOTAL_BYTES} limit`, line: 0 });
  }
  if (!entries.some((entry) => ['.md', '.markdown'].includes(suffixOf(entry.name)))) {
    findings.push({ rule: 'no_documentation', severity: 'review', where: 'package',
      detail: 'ships no markdown, so there is nothing describing what it does', line: 0 });
  }

  const verdict = findings.some((f) => f.severity === 'refuse') ? 'refused'
    : findings.some((f) => f.severity === 'review') ? 'needs_review' : 'inert_safe';
  const flags = [];
  for (const finding of findings) {
    if (finding.severity === 'capability') continue;
    if (!flags.includes(finding.rule)) flags.push(finding.rule);
  }
  return { verdict, flags, findings, fileCount, totalBytes };
}
