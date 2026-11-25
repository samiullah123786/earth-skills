# Listing a skill on Earth

Earth lists a small number of skills that are worth an agent's context window.
It is not a dump of every SKILL.md on GitHub. Every listing is a pull request,
and nothing goes live until the owner merges it.

## The bar

A skill is listed only when **all** of these are true:

1. **It is live.** It is used for real work today, and its source changed in the
   last 12 months.
2. **It does one job well.** The summary names a concrete outcome. "Helps with
   coding" is not a job; "finds the root cause before any fix is written" is.
3. **It is not a duplicate.** CI compares your name and summary with every
   listed skill and fails on a near match. Improve the existing listing instead.
4. **Its licence allows redistribution** (MIT, Apache-2.0, BSD, ISC, CC-BY or
   similar). A skill without one can only be listed as `link-only`: Earth shows
   it and points to the source, but never serves its files.
5. **It passes the Earth safety scan** (`earth-safety-2`, the same rules the
   Kernel uses). A `refused` verdict fails CI. A `needs_review` verdict is
   allowed, and every flag is shown on the listing so people can judge it.

## Where it goes

```
skills/<family>/<area>/<skill-name>/skill.yml      # always
skills/<family>/<area>/<skill-name>/SKILL.md       # hosted skills only
skills/<family>/<area>/<skill-name>/...            # any other files the skill needs
```

`<family>` and `<area>` must exist in [taxonomy.yml](taxonomy.yml). Propose a new
area in the same pull request if none fits. `<skill-name>` is lowercase
kebab-case and unique across the whole map.

## skill.yml

```yaml
name: systematic-debugging          # must equal the folder name
title: Systematic Debugging
summary: Find the root cause with evidence before writing any fix.   # max 140 chars
family: engineering                 # must equal the folder path
area: debugging                     # must equal the folder path
tags: [debugging, root-cause]       # 1-6 lowercase tags
author: Jesse Vincent               # the person or org that wrote it
license: MIT                        # SPDX id, or link-only
requires: []                        # skills that should be read first
pairs_with: [test-driven-development]   # skills that work well alongside it
source:                             # linked skills only: where the files live
  repo: obra/superpowers
  path: skills/systematic-debugging
  ref: 0123456789abcdef0123456789abcdef01234567   # full commit SHA, pinned
```

**Hosted** skills put their files next to `skill.yml` and leave out `source`.
**Linked** skills keep their files upstream. CI fetches them at the pinned
commit, scans them and publishes them. A weekly job opens a pull request when
the upstream changes, so linked skills stay current but never change without
review.

## Check locally

```bash
npm install
npm run build      # validates every skill.yml, fetches linked skills, scans, writes site/
npm test
```
