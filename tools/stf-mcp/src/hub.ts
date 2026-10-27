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

/**
 * Decisions not tied to a spec (seq null), newest first. Supersedes and corrects are shown both ways; a record on the
 * hub is linked, one elsewhere is named. Superseded decisions stay listed, dimmed, so links to them still land.
 */
function factoryDecisions(data: DashboardData): string {
  const all = data.decisions as Row[];
  const decisions = all.filter((d) => d.seq == null).sort((a, b) => String(b.local_id).localeCompare(String(a.local_id)));
  const alts = new Map((data.alternatives as Row[]).filter((a) => a.seq == null).map((a) => [String(a.local_id), a]));
  const onHub = new Set(decisions.map((d) => String(d.local_id)));
  const ref = (id: string) => (onHub.has(id) ? `<a href="#${esc(id.toLowerCase())}">${esc(id)}</a>` : esc(id));
  const inverse = (key: string) => {
    const m = new Map<string, string[]>();
    for (const d of all) for (const id of (d[key] ?? []) as string[]) m.set(id, [...(m.get(id) ?? []), String(d.local_id)]);
    return m;
  };
  const supersededBy = inverse("supersedes");
  const correctedBy = inverse("corrects");
  return decisions
    .map((d) => {
      const id = String(d.local_id);
      const rel = (
        [
          ["supersedes", (d.supersedes ?? []) as string[]],
          ["superseded by", supersededBy.get(id) ?? []],
          ["corrects", (d.corrects ?? []) as string[]],
          ["corrected by", correctedBy.get(id) ?? []],
          ["resolves", (d.resolves ?? []) as string[]],
        ] as [string, string[]][]
      )
        .filter(([, ids]) => ids.length)
        .map(([label, ids]) => `${label} ${ids.map(ref).join(", ")}`)
        .join(" · ");
      const rejected = ((d.rejects ?? []) as string[]).map(
        (a) => `<li><b>${esc(a)}</b> ${esc(alts.get(a)?.option ?? "")}</li>`,
      );
      const why =
        `<details><summary>Why${rejected.length ? ` · ${rejected.length} rejected` : ""}</summary>` +
        `<p>${esc(d.rationale)}</p>` +
        (d.consequences ? `<p><b>Consequences</b> ${esc(d.consequences)}</p>` : "") +
        (rejected.length ? `<ul class="alts">${rejected.join("")}</ul>` : "") +
        "</details>";
      return (
        `<article class="decision s-${esc(d.status)}" id="${esc(id.toLowerCase())}">` +
        `<header><span class="did">${esc(id)}</span><h3>${esc(d.title)}</h3>` +
        `<span class="pill pill-${esc(d.status)}">${esc(d.status)}</span></header>` +
        `<p class="statement">${esc(d.statement)}</p>` +
        (rel ? `<p class="rel">${rel}</p>` : "") +
        why +
        "</article>"
      );
    })
    .join("");
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
    ["{{DECISIONS}}", factoryDecisions(data) || '<p class="empty">No factory decisions yet. <code>/stf:decide</code> records one.</p>'],
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
