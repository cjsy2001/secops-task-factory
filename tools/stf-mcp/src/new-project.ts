import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StfError } from "./errors.js";
import { Factory, findSecret } from "./factory.js";
import { initPlane } from "./root.js";

/**
 * Scaffold a new project repo: git, the secret-scanning hook and CI job, the stf plugin config, the per-concern
 * rules, an empty plane and its first spec. Local only: creating the GitHub repo, pushing and protecting main are
 * outward-facing, so the stf:new-project skill does them after asking. Nothing is committed here either, so the
 * first commit runs the gitleaks hook in front of the user.
 */

// src/templates in the working tree and in the built runtime (dist/ sits next to src/ in both)
const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "templates", "project");

/** The one pinned gitleaks image tag, used by the pre-commit hook, the CI job and `make gitleaks`. */
export const GITLEAKS_VERSION = "v8.30.1";

export interface NewProjectOptions {
  dir: string;
  name: string;
  description: string;
  title?: string;
  azure?: boolean;
  license?: "mit" | "none";
  visibility?: "public" | "private";
  author?: string;
  year?: number;
}

function templateFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) templateFiles(p, out);
    else if (e.endsWith(".tmpl")) out.push(p);
  }
  return out;
}

/** Fill {{KEY}} placeholders in one pass (a value containing "{{X}}" is never expanded again); a key with no value is a template bug. */
export function renderTemplate(name: string, tmpl: string, values: Record<string, string>): string {
  const missing = [...tmpl.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]!).find((k) => !(k in values));
  if (missing) throw new Error(`template ${name} has no value for {{${missing}}}`);
  return tmpl.replace(/\{\{([A-Z_]+)\}\}/g, (_, key: string) => values[key]!);
}

function gitUserName(): string {
  try {
    return execFileSync("git", ["config", "user.name"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

export function newProject(o: NewProjectOptions): { root: string; files: string[]; spec: { seq: number; slug: string; dir: string } } {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(o.name)) throw new StfError("bad_name", "name must be lowercase-kebab-case, e.g. zero-trust-audit.");
  if (o.description.trim().length < 10) throw new StfError("description_too_short", "description needs at least a sentence (≥10 chars).");
  const secret = findSecret(o.description, o.title);
  if (secret) throw new StfError("secret_detected", `Refusing to write what looks like a ${secret} into a new repo.`);
  const license = o.license ?? "mit";
  const author = o.author ?? gitUserName();
  if (license === "mit" && !author) throw new StfError("author_required", "The MIT license needs a copyright holder: pass --author or set git config user.name.");

  const root = resolve(o.dir);
  if (existsSync(root) && readdirSync(root).length) throw new StfError("dir_not_empty", `${root} already exists and is not empty. Pick a new directory.`);

  const azure = o.azure ?? true;
  const values: Record<string, string> = {
    NAME: o.name,
    DESCRIPTION: o.description.trim(),
    GITLEAKS_VERSION,
    RULES: azure ? "security, azure, factory" : "security, factory",
    VISIBILITY_RULE:
      (o.visibility ?? "public") === "public"
        ? "This repo is **public**: the gitleaks hook and the `secrets` workflow must stay on."
        : "The gitleaks hook and the `secrets` workflow must stay on, even though this repo is private.",
    YEAR: String(o.year ?? new Date().getFullYear()),
    AUTHOR: author,
  };

  mkdirSync(root, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "core.hooksPath", ".githooks");

  const files: string[] = [];
  for (const src of templateFiles(TEMPLATE_DIR)) {
    const rel = relative(TEMPLATE_DIR, src).replace(/\.tmpl$/, "");
    if (rel === "LICENSE" && license === "none") continue;
    if (rel === join(".claude", "rules", "azure.md") && !azure) continue;
    const text = renderTemplate(rel, readFileSync(src, "utf8"), values);
    const out = join(root, rel);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text);
    if (rel.startsWith(".githooks")) chmodSync(out, 0o755);
    files.push(rel);
  }

  initPlane(root);
  const spec = new Factory(root).charterSpec({ slug: o.name, title: o.title ?? o.name, summary: o.description.trim() });
  return { root, files, spec: { seq: spec.seq, slug: spec.slug, dir: spec.dir } };
}
