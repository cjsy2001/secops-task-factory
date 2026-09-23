import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";
import { StfError } from "../errors.js";
import { sha256 } from "../store.js";

/** Resolve a caller-supplied path to a repo-relative one, refusing anything outside the root. */
export function repoRelative(root: string, p: string): string {
  const abs = isAbsolute(p) ? normalize(p) : normalize(join(root, p));
  const rel = relative(root, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new StfError("path_outside_repo", `${p} is outside the repository root; artefacts must be repo files.`);
  }
  return rel.split("\\").join("/");
}

export function hashFile(root: string, rel: string): { sha256: string; bytes: number } | null {
  const abs = join(root, rel);
  if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  const buf = readFileSync(abs);
  return { sha256: sha256(buf), bytes: buf.length };
}

function git(root: string, args: string[]): Buffer | null {
  try {
    return execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/** Is this exact content reachable anywhere in git history (any ref) at this path? */
export function inGitHistory(root: string, rel: string, wantSha: string, maxCommits = 300): boolean {
  const out = git(root, ["rev-list", "--all", `--max-count=${maxCommits}`, "--", rel]);
  if (!out) return false;
  for (const commit of out.toString().split("\n").filter(Boolean)) {
    const blob = git(root, ["show", `${commit}:${rel}`]);
    if (blob && sha256(blob) === wantSha) return true;
  }
  return false;
}

export function commitExists(root: string, sha: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(sha) && git(root, ["cat-file", "-e", `${sha}^{commit}`]) !== null;
}

export type ArtefactVerdict = "verified" | "superseded" | "absent";

/**
 * verified   — the file on disk still has the recorded hash.
 * superseded — it changed (or was deleted) later, but the recorded content is in git history.
 * absent     — the recorded content exists nowhere: the claim of done has no evidence left.
 */
export function verifyArtefact(root: string, rel: string, recordedSha: string): ArtefactVerdict {
  const now = hashFile(root, rel);
  if (now && now.sha256 === recordedSha) return "verified";
  return inGitHistory(root, rel, recordedSha) ? "superseded" : "absent";
}
