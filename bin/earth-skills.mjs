#!/usr/bin/env node
// earth-skills: use curated agent skills from the Earth registry without
// copying them onto every machine. `serve` is the MCP server; the other
// commands are for people at a terminal.

import { createRegistry, EarthError } from '../src/registry.mjs';
import { formatMap, formatSearch, formatHeader, formatLinkOnly, formatRelated, decodeText } from '../src/format.mjs';
import { serve, packageVersion } from '../src/mcp.mjs';
import { runSync } from '../src/sync.mjs';

const REPO = 'github:samiullah123786/earth-skills';

const HELP = `earth-skills ${packageVersion()}: curated agent skills, served from one registry.

Usage:
  earth-skills serve                     Start the MCP server on stdio (read-only)
  earth-skills map [family]              Show the skill map
  earth-skills search <words...>         Find skills
  earth-skills show <id> [file]          Show a skill's entry file (or another file) and its neighbours
  earth-skills sync [ids...] [options]   Copy verified skills into a client's skill folder
  earth-skills connect [--client <c>]    Print the MCP config for your client (writes nothing)

Sync options:
  --client claude|codex|cursor|all       Target client (default claude)
  --dir <path>                           Use this skills folder instead of the client's default
  --dry-run                              Print the plan and stop
  --yes                                  Do not ask before writing
  With no ids, sync updates every skill Earth installed before whose digest changed.

Environment:
  EARTH_SKILLS_BASE   Registry URL, file:// URL or local folder
                      (default https://samiullah123786.github.io/earth-skills/)
`;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--dry-run' || a === '-n') opts.dryRun = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--version' || a === '-v') opts.version = true;
    else if (a === '--client' || a === '--dir') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new EarthError(`${a} needs a value.`, 'bad_args');
      opts[a.slice(2)] = v;
    } else if (a.startsWith('--client=')) opts.client = a.slice(9);
    else if (a.startsWith('--dir=')) opts.dir = a.slice(6);
    else if (a.startsWith('-') && a !== '-') throw new EarthError(`Unknown option ${a}. See earth-skills --help.`, 'bad_args');
    else opts._.push(a);
  }
  return opts;
}

function connectText(client = 'all') {
  const json = JSON.stringify({ mcpServers: { 'earth-skills': { command: 'npx', args: ['-y', REPO, 'serve'] } } }, null, 2);
  const parts = {
    claude: [
      'Claude Code (run this once):',
      `  claude mcp add earth-skills -- npx -y ${REPO} serve`,
      '',
      'Claude Desktop (add to claude_desktop_config.json, then restart the app):',
      json,
    ],
    cursor: ['Cursor (add to ~/.cursor/mcp.json or .cursor/mcp.json in a project):', json],
    codex: [
      'Codex (add to ~/.codex/config.toml):',
      '[mcp_servers.earth-skills]',
      'command = "npx"',
      `args = ["-y", "${REPO}", "serve"]`,
    ],
  };
  const names = client === 'all' ? ['claude', 'cursor', 'codex'] : [client];
  for (const n of names) if (!parts[n]) throw new EarthError(`Unknown client "${n}". Use claude, codex, cursor or all.`, 'bad_args');
  return [...names.flatMap((n) => [...parts[n], '']), 'Nothing was written. The server is read-only: it maps, searches and reads skills.'].join('\n');
}

async function main(argv) {
  const opts = parseArgs(argv);
  const [cmd, ...rest] = opts._;
  if (opts.version) { console.log(packageVersion()); return 0; }
  if (opts.help || !cmd || cmd === 'help') { console.log(HELP); return 0; }

  if (cmd === 'serve') {
    await serve();
    return 0;
  }
  if (cmd === 'connect') {
    console.log(connectText(opts.client));
    return 0;
  }

  const registry = createRegistry({ log: (m) => process.stderr.write(m + '\n') });
  switch (cmd) {
    case 'map': {
      const res = formatMap(await registry.getGraph(), rest[0]);
      if (res.error) throw new EarthError(res.error);
      console.log(res.text.replace(/\nRead one: .*$/, '\nShow one: earth-skills show <id>'));
      return 0;
    }
    case 'search': {
      if (!rest.length) throw new EarthError('search needs some words, for example: earth-skills search debugging', 'bad_args');
      const q = rest.join(' ');
      console.log(formatSearch(await registry.search(q, 20), q));
      return 0;
    }
    case 'show': {
      if (!rest[0]) throw new EarthError('show needs a skill id. Find one with earth-skills search <words>.', 'bad_args');
      const skill = await registry.getSkill(rest[0]);
      if (!skill.served) {
        console.log(formatLinkOnly(skill));
      } else {
        const res = await registry.readSkillFile(skill.id, rest[1]);
        console.log(formatHeader(skill, { path: res.path, digestVerified: true }) + decodeText(res.bytes).text);
      }
      console.log('\n---\n' + formatRelated(await registry.related(skill.id)));
      return 0;
    }
    case 'sync':
      return runSync(registry, { ids: rest, client: opts.client, dir: opts.dir, dryRun: opts.dryRun, yes: opts.yes });
    default:
      throw new EarthError(`Unknown command "${cmd}". See earth-skills --help.`, 'bad_args');
  }
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err) => {
    process.stderr.write(`earth-skills: ${err instanceof EarthError ? err.message : err.stack || err}\n`);
    process.exitCode = 1;
  },
);
