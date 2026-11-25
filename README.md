# Earth Skills

The curated skill map behind the [Earth Market](https://agentsearth.com/market#atlas).

Connect your agent once and it can browse, search and read every listed skill from any
machine. Nothing to reinstall when you move to a new computer, and nothing goes stale:
the map is rebuilt from this repository on every merge.

```bash
claude mcp add earth-skills -- npx -y github:samiullah123786/earth-skills serve
```

For Claude Desktop, Cursor or Codex, print the config for your client:

```bash
npx -y github:samiullah123786/earth-skills connect --client cursor
```

## What your agent gets

The server is read-only and speaks MCP over stdio. It has no dependencies.

| Tool | What it returns |
| --- | --- |
| `skills_map` | Every family, area and skill, one line each. Small enough to read in full. |
| `skills_search` | The best matches for a few words, ranked over name, tags, area and summary. |
| `skill_read` | A skill's `SKILL.md` (or another of its files), after the bytes pass their digest check. |
| `skills_related` | What a skill builds on, what builds on it, and what pairs with it. |

Every served skill is also an MCP prompt. In Claude Code that makes it a slash command:
`/mcp__earth-skills__systematic-debugging`.

## Installing a copy instead

Some clients only read skills from a folder. `sync` copies verified skills there and
records what it wrote in `~/.earth-skills/installed.json`:

```bash
npx -y github:samiullah123786/earth-skills sync systematic-debugging brainstorming --client claude
npx -y github:samiullah123786/earth-skills sync          # update what Earth installed before
```

`sync` never touches a folder it did not write, and refuses to replace a copy you edited
by hand. Use `--dry-run` to see the plan first.

## How the map is organised

`skills/<family>/<area>/<name>/skill.yml`. Families and areas live in
[`taxonomy.yml`](taxonomy.yml). Each listing may declare `requires` (read that one first)
and `pairs_with` (works well alongside). Those declarations are the lines on the map.

A listing is either:

- **hosted**: its files live in this repository next to `skill.yml`; or
- **linked**: `skill.yml` points to an upstream repository, path and pinned commit.
  CI fetches exactly that commit. A weekly job opens a pull request when upstream moves,
  and CI scans the new bytes before anyone merges it.

Linked skills whose licence does not allow redistribution are **link-only**: they appear
on the map with their source, but the server never serves their files.

## What the build checks

`npm run build` runs on every pull request:

1. Every `skill.yml` is valid, sits in the folder its family, area and name say, and points
   only at skills that exist.
2. No new listing is a near-duplicate of an existing one.
3. Every file is scanned with `earth-safety-2`, the same rules the Earth Kernel uses.
   A `refused` verdict fails the build. Anything flagged is shown on the skill's card.
4. Each served skill gets a `sha256` digest over its files. The server and `sync` check it
   before your agent reads a byte.

The output is `site/graph.json` ([schema](docs/graph-schema.md)), published to GitHub Pages.

## Listing a skill

Read [CONTRIBUTING.md](CONTRIBUTING.md), then open a pull request. The bar is short: the
skill is live, does one job, is not a duplicate, has a licence that allows sharing (or is
marked link-only), and passes the scan. Every listing is merged by hand.

## Develop

```bash
npm install
npm run check   # validate without fetching
npm run build   # fetch, scan, write site/
npm test
EARTH_SKILLS_BASE=./site node bin/earth-skills.mjs map
```

## Licence

The code in this repository is MIT. Each skill keeps its own licence and author, shown
in its listing and on its card.
