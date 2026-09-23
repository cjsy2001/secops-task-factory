import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The repository the plane belongs to: $STF_ROOT, else the nearest ancestor of cwd holding `.stf/`,
 * else the repo this server was built in (dist/ is tools/stf-mcp/dist → three levels up).
 */
export function resolveRoot(): string {
  if (process.env.STF_ROOT) return resolve(process.env.STF_ROOT);
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, ".stf"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}
