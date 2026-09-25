import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dashboardData, type DashboardData } from "./dashboard.js";
import type { Factory } from "./factory.js";
import { readPages, type Pages } from "./pages.js";
import { esc, pad3, PHASES } from "./spec-page.js";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "hub.html");
const EVENTS_SHOWN = 8;

type Row = Record<string, any>;

function link(url: string | undefined, label: string): string {
  if (!url) return '<span class="nolink">not published yet</span>';
  return `<a class="open" href="${esc(url)}" target="_blank" rel="noopener">${esc(label)} <span aria-hidden="true">↗</span></a>`;
}

/** The hub: plane totals, a card per spec, and a link to every status page recorded in .stf/pages.json. Reads only. */
export function renderHub(f: Factory, pages: Pages = readPages(f.root), data: DashboardData = dashboardData(f), built = new Date()): string {
  const specs = [...(data.specs as Row[])].sort((a, b) => a.seq - b.seq);
  const tasks = data.tasks as Row[];
  // a moved spec's questions belong to the repo it moved to; its card links there instead
  const movedSeqs = new Set(specs.filter((s) => s.moved).map((s) => s.seq));
  const questions = (data.questions as Row[]).filter((q) => !movedSeqs.has(q.seq));
  const done = tasks.filter((t) => t.status === "done").length;
  const blocked = tasks.filter((t) => t.status === "blocked").length;
  const openQ = questions.filter((q) => q.status === "open").length;
  const openRuns = (data.runs as Row[]).filter((r) => r.status === "open");
  const pending = (data.handoffs as Row[]).filter((h) => h.status === "sent");

  const stats: [unknown, string, string][] = [
    [specs.length, "specs", ""],
    [`${done} / ${tasks.length}`, "tasks done", ""],
    [blocked, "tasks blocked", blocked ? "bad" : ""],
    [openQ, "open questions", openQ ? "warn" : ""],
    [openRuns.length, "open runs", openRuns.length ? "warn" : ""],
    [pending.length, "pending handoffs", pending.length ? "warn" : ""],
  ];
  const statsHtml = stats.map(([n, l, c]) => `<div class="stat ${c}"><span class="n">${esc(n)}</span><span class="l">${esc(l)}</span></div>`).join("");

  const specUrls = pages.specs ?? {};
  const rows = specs.map((s) => {
    const seq = s.seq as number;
    const cur = PHASES.includes(s.phase) ? PHASES.indexOf(s.phase) : PHASES.length;
    const track = PHASES.map((p, i) => `<li class="${i < cur ? "done" : i === cur ? "next" : ""}" title="${p}"><i></i><span>${p}</span></li>`).join("");
    const ts = tasks.filter((t) => t.seq === seq);
    const tsDone = ts.filter((t) => t.status === "done").length;
    const qOpen = questions.filter((q) => q.seq === seq && q.status === "open").length;
    const nxt = [...ts].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0)).find((t) => t.status === "pending" || t.status === "in_progress");
    const handoff = pending.find((h) => h.seq === seq);
    const note = s.moved
      ? `moved → <a href="https://github.com/${esc(s.moved.repo)}" target="_blank" rel="noopener">${esc(s.moved.repo)}</a> (spec ${pad3(s.moved.seq)} there); history only here`
      : handoff
      ? `handoff <code>${esc(handoff.invocation)}</code>`
      : s.gate
        ? "fresh session needed for analyze"
        : `next phase: <b>${esc(s.phase)}</b>`;
    return (
      `<article class="spec${s.moved ? " moved" : ""}"><div class="spec-id"><span class="seq">${pad3(seq)}</span>` +
      `<span class="slug">${esc(s.slug)}</span></div>` +
      `<h3>${esc(s.title ?? s.slug)}</h3>` +
      `<ol class="track" aria-label="phase ${esc(s.phase)}">${track}</ol>` +
      `<dl><dt>tasks</dt><dd>${ts.length ? `${tsDone} / ${ts.length} done` : "none yet"}</dd>` +
      `<dt>next task</dt><dd>${nxt ? esc(nxt.local_id) : "—"}</dd>` +
      `<dt>open questions</dt><dd>${qOpen}</dd></dl>` +
      `<p class="note">${note}</p>` +
      `<p class="links">${link(specUrls[String(seq)], "Spec page")}</p></article>`
    );
  });

  const recent = [...(data.events as Row[])]
    .reverse()
    .slice(0, EVENTS_SHOWN)
    .map(
      (ev) =>
        `<li><time>${esc(String(ev.at ?? "").replace("T", " ").slice(0, 16))}</time><span class="kind">${esc(ev.kind)}</span> ${esc(ev.summary)}</li>`,
    )
    .join("");

  const fill = (page: string, key: string, val: string) => page.replaceAll(key, () => val);
  let page = readFileSync(TEMPLATE_PATH, "utf8");
  for (const [k, v] of [
    ["{{REPO}}", esc(data.repo)],
    ["{{BRANCH}}", esc(data.branch || "unknown")],
    ["{{COMMIT}}", esc(data.commit || "unknown")],
    ["{{BUILT}}", built.toISOString().replace("T", " ").slice(0, 16) + " UTC"],
    ["{{DASHBOARD}}", link(pages.dashboard, "Open dashboard")],
    ["{{STATS}}", statsHtml],
    // plane-derived content last, so its text is never treated as a placeholder
    ["{{EVENTS}}", recent || '<li class="empty">No events yet.</li>'],
    ["{{SPECS}}", rows.join("") || '<p class="empty">No specs chartered yet.</p>'],
  ] as const)
    page = fill(page, k, v);
  return page;
}

/** Write the hub (default .stf/hub.html, gitignored) and say where it went. */
export function writeHub(f: Factory, out?: string, data?: DashboardData): { out: string; specs: number } {
  const d = data ?? dashboardData(f);
  const path = resolve(out ?? join(f.root, ".stf", "hub.html"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderHub(f, readPages(f.root), d));
  return { out: path, specs: d.specs.length };
}
