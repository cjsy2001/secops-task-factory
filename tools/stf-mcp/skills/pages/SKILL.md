---
name: pages
description: Publish and refresh a repo's stf status pages (hub, plane dashboard, one page per spec) as private claude.ai artifacts, keeping their URLs in .stf/pages.json. Use when the user says "republish the status pages", "refresh the pages", "publish the hub", "set up status pages", or when the pages hook reports rebuilt pages at a phase or task boundary.
---

# stf:pages

Status pages are **read-only views** of `specs/` and `.stf/export/`. Changing a page never changes the plane; every
change still goes through the `stf_*` tools.

| Page | Built by | Local file (gitignored) | `.stf/pages.json` key |
|---|---|---|---|
| Hub `STF · <repo>`: totals, a card per spec, factory decisions, links to every page | `stf hub` | `.stf/hub.html` | `hub` |
| Plane dashboard `STF · <repo> dashboard` | `stf dashboard` | `.stf/dashboard.html` | `dashboard` |
| Spec page `STF · Spec NNN <slug>`: spec/plan/research/tasks, trace markers, decisions | `stf spec-page N` | `.stf/spec-page-NNN.html` | `specs."N"` |

`.stf/pages.json` is committed and per repo: `{"hub": "<url>", "dashboard": "<url>", "specs": {"1": "<url>"}}`. Record
URLs **without** the `?sk=…` share key; project repos are public.

## Rebuild

The plugin's PostToolUse hook rebuilds the pages after every stf plane write, **only** in a repo that has both
`.stf/export/` and `.stf/pages.json`, and its context note lists each rebuilt file with the URL to publish it to. After
running the CLI yourself (it doesn't fire the hook), rebuild with `stf pages`, which prints the same list.

## Republish (once per phase or task boundary, not after every write)

For each line of the hook note or of `stf pages`:
1. In a new conversation, first `Artifact read` the recorded URL; a publish to an unread URL is refused.
2. `Artifact publish` with `file_path=<the rebuilt file>` and `url=<the recorded URL>`.

Publishing without `url` creates a second page instead of updating the recorded one. Never do that for a page that
has a URL.

## First publish (a repo without pages, or a new spec)

1. `stf pages` to build the files. If `.stf/pages.json` doesn't exist yet, create it as `{}` so the hook starts
   rebuilding; that is the switch that turns status pages on for a repo.
2. Publish each file with no `url` (the page's `<title>` already starts with `STF ·`, so the pages sort together in
   the gallery). Publish the hub last, after its links exist.
3. Write each returned URL into `.stf/pages.json`, run `stf pages` again so the hub links them, and republish the hub.
4. Offer to pin the hub; it is the page that links to all the others.

## Turning them off

Delete `.stf/pages.json`. The hook then stays silent in that repo; nothing else changes.
