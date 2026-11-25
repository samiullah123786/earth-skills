// MCP server over stdio: JSON-RPC 2.0, one message per line.
//
// Read-only by contract. No tool writes files, runs commands or spends
// anything; the only side effect is the registry's private cache. stdout
// carries protocol messages only, so every log line goes to stderr.

import readline from 'node:readline';
import fs from 'node:fs';
import { createRegistry, EarthError } from './registry.mjs';
import { formatMap, formatSearch, formatHeader, formatLinkOnly, formatRelated, decodeText } from './format.mjs';

export const PROTOCOL_VERSION = '2025-06-18';

export function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const TOOLS = [
  {
    name: 'skills_map',
    title: 'Earth skill map',
    description: 'Compact map of every curated Earth skill: family, then area, then one line per skill (id and summary), with counts. Start here to see what exists.',
    inputSchema: {
      type: 'object',
      properties: { family: { type: 'string', description: 'Only show this family, for example "engineering".' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'skills_search',
    title: 'Search Earth skills',
    description: 'Rank Earth skills against a few words, matched over id, title, summary, tags, area and family. Returns one compact row per skill.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words describing the job, for example "root cause bug".' },
        limit: { type: 'number', description: 'Maximum rows, 1-20 (default 8).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'skill_read',
    title: 'Read an Earth skill',
    description: 'Return a skill\'s entry file (or another listed file) after verifying its sha256 digest, with a header naming the author, licence, safety verdict and flags, digest, source and the other files available.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Skill id from skills_map or skills_search.' },
        file: { type: 'string', description: 'A path from the header\'s file list. Defaults to the entry file.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'skills_related',
    title: 'Related Earth skills',
    description: 'Neighbours of a skill on the map: what it requires, what requires it, and what pairs well with it, each with its summary.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Skill id.' } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

const INSTRUCTIONS = 'Earth serves a small curated set of agent skills straight from its published registry. ' +
  'Call skills_map (or skills_search) to find a skill, then skill_read to load it; every file is digest-verified. ' +
  'Each served skill is also available as a prompt named by its id.';

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const toolError = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });

function requireString(args, key) {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) throw new EarthError(`Argument "${key}" is required and must be a non-empty string.`, 'bad_args');
  return v.trim();
}

/** Runs one tool. Every failure becomes an isError result that says what to do next. */
export async function callTool(registry, name, args = {}) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) args = {};
  try {
    switch (name) {
      case 'skills_map': {
        const family = typeof args.family === 'string' && args.family.trim() ? args.family.trim() : undefined;
        const res = formatMap(await registry.getGraph(), family);
        return res.error ? toolError(res.error) : text(res.text);
      }
      case 'skills_search': {
        const query = requireString(args, 'query');
        const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(20, Math.floor(args.limit))) : 8;
        return text(formatSearch(await registry.search(query, limit), query));
      }
      case 'skill_read': {
        const id = requireString(args, 'id');
        const skill = await registry.getSkill(id);
        if (!skill.served) return text(formatLinkOnly(skill));
        const file = typeof args.file === 'string' && args.file.trim() ? args.file.trim() : undefined;
        const res = await registry.readSkillFile(id, file);
        return text(formatHeader(skill, { path: res.path, digestVerified: true }) + decodeText(res.bytes).text);
      }
      case 'skills_related': {
        const id = requireString(args, 'id');
        return text(formatRelated(await registry.related(id)));
      }
      default:
        return toolError(`Unknown tool "${name}". Available tools: ${TOOLS.map((t) => t.name).join(', ')}.`);
    }
  } catch (err) {
    if (err instanceof EarthError) return toolError(err.message);
    return toolError(`Unexpected error: ${err.message}. Try again; if it persists, run \`earth-skills map\` to check the registry.`);
  }
}

class RpcError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Handles one parsed JSON-RPC message; returns the response object or null for notifications. */
export async function handleMessage(registry, msg, version = packageVersion()) {
  const isRequest = msg && typeof msg === 'object' && 'id' in msg && msg.id !== null;
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    // Responses from the client (it never needs to send any) are ignored.
    if (msg && typeof msg === 'object' && !('method' in msg)) return null;
    return { jsonrpc: '2.0', id: isRequest ? msg.id : null, error: { code: -32600, message: 'Invalid request' } };
  }
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
  try {
    const result = await dispatch(registry, msg.method, params, version);
    if (!isRequest) return null;
    return { jsonrpc: '2.0', id: msg.id, result };
  } catch (err) {
    if (!isRequest) return null;
    const code = err instanceof RpcError ? err.code : -32603;
    return { jsonrpc: '2.0', id: msg.id, error: { code, message: err.message } };
  }
}

async function dispatch(registry, method, params, version) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: { name: 'earth-skills', title: 'Earth skills', version },
        instructions: INSTRUCTIONS,
      };
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return {};
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call':
      if (typeof params.name !== 'string') throw new RpcError(-32602, 'tools/call needs params.name');
      return callTool(registry, params.name, params.arguments);
    case 'prompts/list': {
      let graph;
      try { graph = await registry.getGraph(); } catch (err) {
        throw new RpcError(-32603, err.message);
      }
      return {
        prompts: graph.skills.filter((s) => s.served).map((s) => ({
          name: s.id,
          title: s.title || s.id,
          description: s.summary || s.title || s.id,
          arguments: [],
        })),
      };
    }
    case 'prompts/get': {
      const name = params.name;
      if (typeof name !== 'string') throw new RpcError(-32602, 'prompts/get needs params.name');
      try {
        const skill = await registry.getSkill(name);
        if (!skill.served) throw new RpcError(-32602, `Skill ${name} is link-only; read it at ${skill.sourceUrl}.`);
        const res = await registry.readSkillFile(name);
        return {
          description: skill.summary || skill.title,
          messages: [{
            role: 'user',
            content: { type: 'text', text: formatHeader(skill, { path: res.path, digestVerified: true }) + decodeText(res.bytes).text },
          }],
        };
      } catch (err) {
        if (err instanceof RpcError) throw err;
        throw new RpcError(err instanceof EarthError && err.code === 'not_found' ? -32602 : -32603, err.message);
      }
    }
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

/** Starts the stdio server. Resolves when stdin closes. */
export function serve({ input = process.stdin, output = process.stdout, registry } = {}) {
  // Anything a dependency prints with console.log would corrupt the protocol stream.
  console.log = console.error;
  console.info = console.error;
  const reg = registry || createRegistry({ log: (m) => process.stderr.write(m + '\n') });
  const version = packageVersion();
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const send = (obj) => output.write(JSON.stringify(obj) + '\n');
  const pending = new Set();

  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const p = handleMessage(reg, msg, version)
      .then((res) => { if (res) send(res); })
      .catch((err) => process.stderr.write(`earth-skills: ${err.stack || err}\n`))
      .finally(() => pending.delete(p));
    pending.add(p);
  });

  return new Promise((resolve) => {
    rl.on('close', async () => {
      await Promise.allSettled([...pending]);
      resolve();
    });
  });
}
