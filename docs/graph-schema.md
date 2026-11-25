# graph.json, the published skill map

Built by `npm run build` from `taxonomy.yml` and every `skills/**/skill.yml`.
Published at `https://samiullah123786.github.io/earth-skills/graph.json`, with
each served skill's files at `skills/<id>/<path>`.

```jsonc
{
  "version": 1,
  "generatedAt": "2026-11-25T06:00:00.000Z",
  "commit": "abc123…",                 // earth-skills commit the site was built from
  "base": "https://samiullah123786.github.io/earth-skills/",
  "scanner": "earth-safety-2",
  "counts": { "families": 9, "areas": 21, "skills": 25, "edges": 18 },
  "families": [
    {
      "id": "engineering", "title": "Engineering", "color": "#3B82F6",
      "areas": [
        { "id": "debugging", "title": "Debugging", "summary": "…", "skills": ["systematic-debugging"] }
      ]
    }
  ],
  "skills": [
    {
      "id": "systematic-debugging",       // unique; equals skill.yml name
      "title": "Systematic Debugging",
      "summary": "…",
      "family": "engineering",
      "area": "debugging",
      "tags": ["debugging"],
      "author": "Jesse Vincent",
      "license": "MIT",                   // or "link-only"
      "kind": "linked",                   // "hosted" | "linked"
      "served": true,                     // false for link-only: no files published
      "sourceUrl": "https://github.com/obra/superpowers/tree/<ref>/skills/systematic-debugging",
      "ref": "<commit sha>",              // linked only, else null
      "digest": "sha256:…",               // null when not served
      "files": [{ "path": "SKILL.md", "size": 4210 }],
      "entry": "SKILL.md",                // the file an agent reads first
      "requires": [],
      "pairsWith": ["test-driven-development"],
      "safety": { "verdict": "inert_safe", "flags": [] }
    }
  ],
  "edges": [
    { "from": "systematic-debugging", "to": "test-driven-development", "kind": "pairs" }
  ]
}
```

Rules consumers can rely on:

- `skills[].id` is unique and matches `^[a-z0-9][a-z0-9-]{1,63}$`.
- A served skill's files are at `${base}skills/${id}/${path}`; its entry file is `${base}skills/${id}/${entry}`.
- Edges only reference listed skills. A `requires` edge points from a skill to its prerequisite. A `pairs` edge is emitted once per pair, with the lexically smaller id in `from`.
- `digest` is `sha256:` + hex of, for each file sorted by path, `path + "\n" + size + "\n" + bytes`. Recompute it before writing anything to disk.
- `files` never contains a path with `..`, a leading `/`, or a backslash.
