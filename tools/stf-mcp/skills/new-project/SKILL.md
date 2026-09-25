---
name: new-project
description: Create a new project repo wired for the stf factory - git, the gitleaks pre-commit hook and CI job, the stf plugin config, the per-concern rules, an empty plane with spec 001 chartered - then (after asking) publish it to GitHub and protect main. Use when the user says "new project", "start a project", "create a project repo", "scaffold a repo", or "/stf:new-project".
---

# stf:new-project

Each project gets its own repo and its own plane (factory decision D-004). This skill makes one. The files come from
`stf new-project`, which is local and repeatable; everything that reaches GitHub waits for the user's yes.

## 1. Ask (one AskUserQuestion, recommended option first)

- **Name**: lowercase-kebab-case. It becomes the directory, the GitHub repo and spec 001's slug.
- **Description**: one or two sentences. It becomes the README lede, the CLAUDE.md intro and spec 001's summary.
- **Spec title**: spec 001's title (defaults to the name).
- **Visibility**: public (recommended: portfolio projects are public from the first commit, and GitHub code
  scanning is free there) or private.
- **Azure rules**: include (recommended: every project targets Azure, D-001) or not.
- **License**: MIT (recommended) or none.

Default location: next to the current repo (`../<name>`). Confirm it if the user named another place.

## 2. Build (local, no network, no commit)

```
stf new-project <dir> --name <name> --description "<text>" --title "<spec title>" [--private] [--no-azure] [--license none]
```

It refuses a non-empty directory, a bad name, a thin description, and anything that looks like a secret. Then:
- `cd <dir> && make gitleaks` must print "no leaks found";
- show the user the file list it printed.

## 3. First commit (the only commit ever made on main)

`git add -A && git commit -m "chore: scaffold <name> with gitleaks hook, secrets CI and stf plugin config"`, ending
with the session's attribution line. The pre-commit hook runs gitleaks: report its result, and never use `--no-verify`.

## 4. GitHub (outward-facing: ask first, one step at a time)

1. `gh repo create <owner>/<name> --public|--private --description "<text>" --source <dir> --remote origin --push`.
2. Wait for the `secrets` workflow on that push and report its real conclusion (`gh run list --limit 1`).
3. Offer to protect `main`, with the same rule as the other project repos:
   ```
   gh api -X PUT repos/<owner>/<name>/branches/main/protection --input - <<'EOF'
   {"required_status_checks": {"strict": true, "contexts": ["gitleaks"]}, "enforce_admins": true,
    "required_pull_request_reviews": {"required_approving_review_count": 0}, "restrictions": null,
    "allow_force_pushes": false, "allow_deletions": false}
   EOF
   ```
   Read it back and report what the API returned. From then on, every change goes through a branch and a PR.

## 5. Hand over

- In the new repo: `claude plugin install stf@secops-task-factory --scope project` (once per machine).
- This session's stf server belongs to the repo it started in, so it can't drive the new repo's lifecycle. Tell the
  user to open a new session there (`cd <dir> && claude`) and start with `/stf:spec-lifecycle specify 1`. Spec 001 is
  already chartered, so its phase is `specify`.
- Status pages are optional: `/stf:pages` in the new repo sets them up.
- Optional, in the factory repo: add the project to the "Specs" list in its CLAUDE.md.

## Never

- Create or push the GitHub repo, or change its settings, without the user's yes for that step.
- Commit on main after the first commit, or bypass the gitleaks hook.
- Put a credential in the description, the title or any scaffold file.
