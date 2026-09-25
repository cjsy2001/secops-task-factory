import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Marked, type Tokens } from "marked";
import { dashboardData, type DashboardData } from "./dashboard.js";
import type { Factory } from "./factory.js";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "spec-page.html");

// (tab key, label, file relative to the spec dir); tabs appear only for files that exist
const DOCS: [string, string, string][] = [
  ["spec", "Spec", "spec.md"],
  ["plan", "Plan", "plan.md"],
  ["research", "Research", "research.md"],
  ["datamodel", "Data model", "data-model.md"],
  ["tasks", "Tasks", "tasks.md"],
];
const REF_RE = /\b(FR|NFR|SC|D|ALT|A|Q|OQ)-(\d{3})\b|\bUS(\d)\b|\bR-(\d{2})\b|\bT(\d{3})\b/g;
export const PHASES = ["specify", "clarify", "plan", "tasks", "analyze"];

type Row = Record<string, any>;
interface TocToken {
  level: number;
  id: string;
  name: string;
  children: TocToken[];
}

export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

export const pad3 = (n: number) => String(n).padStart(3, "0");

function unescapeHtml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** python-markdown's toc slugify: NFKD → ASCII, drop non-word chars, lowercase, collapse whitespace/dashes. */
function slugify(value: string): string {
  const ascii = value.normalize("NFKD").replace(/[^\x00-\x7f]/g, "");
  return ascii
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "-");
}

/** python-markdown's unique(): a repeated id gets _1, _2, … */
function unique(id: string, used: Set<string>): string {
  let out = id;
  for (let n = 1; used.has(out); n++) out = `${id}_${n}`;
  used.add(out);
  return out;
}

/** python-markdown's nest_toc_tokens, so the side contents list shows the same top-level entries. */
function nestToc(flat: TocToken[]): TocToken[] {
  const list = flat.map((t) => ({ ...t, children: [] as TocToken[] }));
  const ordered: TocToken[] = [];
  if (!list.length) return ordered;
  let last = list.shift()!;
  let levels = [last.level];
  let parents: TocToken[] = [];
  ordered.push(last);
  for (const t of list) {
    const cur = t.level;
    if (cur < levels[levels.length - 1]!) {
      levels.pop();
      let toPop = 0;
      for (const p of [...parents].reverse()) {
        if (cur <= p.level) toPop++;
        else break;
      }
      if (toPop) {
        levels = levels.slice(0, -toPop);
        parents = parents.slice(0, -toPop);
      }
      levels.push(cur);
    }
    if (cur === levels[levels.length - 1]) (parents.length ? parents[parents.length - 1]!.children : ordered).push(t);
    else {
      last.children.push(t);
      parents.push(last);
      levels.push(cur);
    }
    last = t;
  }
  return ordered;
}

function refTarget(m: RegExpExecArray | string[]): [string, string] {
  const [, kind, num, us, r, t] = m;
  if (r) return [`r-${r}`, "R"];
  if (us) return [`us${us}`, "US"];
  if (t) return [`t${t}`, "T"];
  return [`${kind!.toLowerCase()}-${num}`, kind!];
}

/** Wrap ID references in text nodes (outside code/pre/a) with in-page links. */
export function linkify(fragment: string): string {
  const out: string[] = [];
  let depth = 0;
  for (const part of fragment.split(/(<[^>]+>)/)) {
    if (part.startsWith("<")) {
      const tag = /^<\/?\s*(\w+)/.exec(part);
      if (tag && ["code", "pre", "a"].includes(tag[1]!.toLowerCase())) depth += part.startsWith("</") ? -1 : 1;
      out.push(part);
    } else if (depth > 0) out.push(part);
    else
      out.push(
        part.replace(REF_RE, (...m: string[]) => {
          const [target, kind] = refTarget(m);
          return `<a class="ref ref-${kind}" href="#${target}">${m[0]}</a>`;
        }),
      );
  }
  return out.join("");
}

/** Markdown → HTML with python-markdown-compatible heading ids (prefixed by the tab key) and an h2–h3 contents list. */
function markdown(key: string, text: string): { body: string; toc: TocToken[] } {
  const used = new Set<string>();
  const flat: TocToken[] = [];
  const md = new Marked({ gfm: true });
  md.use({
    renderer: {
      heading(this: any, { tokens, depth }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens) as string;
        const plain = unescapeHtml(inner.replace(/<[^>]+>/g, ""));
        const id = unique(`${key}-${slugify(plain)}`, used);
        if (depth >= 2 && depth <= 3) flat.push({ level: depth, id, name: plain, children: [] });
        return `<h${depth} id="${id}">${inner}</h${depth}>\n`;
      },
      // keep "[x] T001" as text, as python-markdown did: the task-box pass below turns it into the page's own box
      checkbox({ checked }: Tokens.Checkbox) {
        return checked ? "[x] " : "[ ] ";
      },
    },
  });
  const body = md.parse(text, { async: false }) as string;
  return { body, toc: nestToc(flat) };
}

export function renderDoc(key: string, text: string): { body: string; toc: TocToken[] } {
  let { body, toc } = markdown(key, text);

  // mermaid fences -> native <pre class="mermaid">
  body = body.replace(/<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g, (_, src) => `<div class="diagram"><pre class="mermaid">${src}</pre></div>`);

  // <!-- Source: … --> trace markers -> visible "Traces to" line
  body = body.replace(/<!--\s*Source:\s*([\s\S]*?)\s*-->/g, (_, refs: string) => {
    const chips = refs
      .split(",")
      .map((r) => `<span>${esc(r.trim())}</span>`)
      .join(" ");
    return `<p class="trace"><span class="trace-label">Traces to</span> ${chips}</p>`;
  });
  // anchors on definitions: list items starting with a bold ID, R-NN / US headings, inline assumptions, tasks
  body = body.replace(/<li>(<p>)?<strong>((?:FR|NFR|SC|A|Q)-\d{3})([^<]*)<\/strong>/g, (_, p, id, rest) => `<li id="${id.toLowerCase()}">${p ?? ""}<strong>${id}${rest}</strong>`);
  for (const [level, pat] of [
    ["h2", "R-\\d{2}"],
    ["h3", "US\\d"],
  ] as const) {
    body = body.replace(
      new RegExp(`<${level} id="([^"]+)">(${pat})`, "g"),
      (_, alias, id) => `<${level} id="${id.toLowerCase()}"><span class="anchor-alias" id="${alias}"></span>${id}`,
    );
  }
  body = body.replace(/<strong>Assumption (A-\d{3})/g, (_, id) => `<strong id="${id.toLowerCase()}">Assumption ${id}`);
  body = body.replace(/<li>(<p>)?\[( |x|X)\] (T\d{3})/g, (_, p, mark, id) => {
    const done = mark.trim() !== "";
    return `<li id="${id.toLowerCase()}" class="task task-${done ? "done" : "open"}">${p ?? ""}<span class="box">${done ? "✓" : ""}</span> ${id}`;
  });
  body = body.replaceAll("<table>", '<div class="tablewrap"><table>').replaceAll("</table>", "</table></div>");
  // the page header carries the doc's own H1 + meta line
  body = body.replace(/^<h1[^>]*>[\s\S]*?<\/h1>\s*/, "");
  body = body.replace(/^<blockquote>\s*<p>seq:[\s\S]*?<\/blockquote>\s*/, "");
  return { body: linkify(body), toc };
}

function tocHtml(tokens: TocToken[]): string {
  return '<ol class="toc">' + tokens.map((t) => `<li><a href="#${t.id}">${esc(t.name)}</a></li>`).join("") + "</ol>";
}

/** One spec's markdown artefacts + its plane rows as a single read-only page. Reads only. */
export function renderSpecPage(f: Factory, seq: number, data: DashboardData = dashboardData(f)): string {
  const spec = (data.specs as Row[]).find((s) => s.seq === seq);
  if (!spec) throw new Error(`spec seq ${seq} not found in .stf/export/specs.json`);
  const relDir = `specs/${pad3(seq)}-${spec.slug}`;
  const specDir = join(f.root, relDir);

  const decisions = (data.decisions as Row[]).filter((d) => d.seq === seq);
  const alts = new Map((data.alternatives as Row[]).filter((a) => a.seq === seq).map((a) => [a.local_id as string, a]));
  const questions = (data.questions as Row[]).filter((q) => q.seq === seq);
  const hashes = new Map<string, string>();
  for (const files of Object.values((spec.artefacts ?? {}) as Record<string, Record<string, string>>)) {
    for (const [path, digest] of Object.entries(files)) hashes.set(basename(path), digest); // later phases overwrite earlier ones
  }

  const docs = [...DOCS];
  const analysis = join(specDir, "analysis");
  if (existsSync(analysis)) for (const r of readdirSync(analysis).filter((n) => n.endsWith(".md")).sort()) docs.push(["analysis", "Analysis", `analysis/${r}`]);

  const tabs: string[] = [];
  const panels: string[] = [];
  for (const [key, label, fname] of docs) {
    const src = join(specDir, fname);
    if (!existsSync(src)) continue;
    const { body, toc } = renderDoc(key, readFileSync(src, "utf8"));
    const digest = hashes.get(basename(fname)) ?? "";
    const meta = digest ? `<code title="sha256 recorded by stf_advance_phase">sha256 ${digest.slice(0, 12)}…</code>` : "";
    tabs.push(`<a class="tab" role="tab" href="#${key}" data-panel="${key}">${label}</a>`);
    panels.push(
      `<section class="panel" id="${key}" data-panel="${key}" role="tabpanel">` +
        `<aside class="side"><p class="side-file">${relDir}/<b>${fname}</b></p>${meta}${tocHtml(toc)}</aside>` +
        `<article class="doc">${body}</article></section>`,
    );
  }

  const cards = decisions.map((d) => {
    const rej = ((d.rejects ?? []) as string[])
      .filter((a) => alts.has(a))
      .map((a) => `<li id="${a.toLowerCase()}"><b>${a}</b> ${esc(alts.get(a)!.option)}</li>`)
      .join("");
    const res = ((d.resolves ?? []) as string[]).join(", ");
    return (
      `<article class="decision" id="${String(d.local_id).toLowerCase()}">` +
      `<header><span class="did">${d.local_id}</span><h3>${esc(d.title)}</h3>` +
      `<span class="pill pill-${d.status}">${d.status}</span></header>` +
      `<p class="statement">${linkify(esc(d.statement))}</p>` +
      `<dl><dt>Why</dt><dd>${linkify(esc(d.rationale))}</dd>` +
      (d.consequences ? `<dt>Consequences</dt><dd>${linkify(esc(d.consequences))}</dd>` : "") +
      (res ? `<dt>Resolves</dt><dd>${res}</dd>` : "") +
      (rej ? `<dt>Rejected</dt><dd><ul class="alts">${rej}</ul></dd>` : "") +
      "</dl></article>"
    );
  });
  const used = new Set(decisions.flatMap((d) => (d.rejects ?? []) as string[]));
  const orphans = [...alts.entries()].filter(([k]) => !used.has(k)).map(([, a]) => a);
  const orphanHtml = orphans.length
    ? '<h2 id="other-alternatives">Alternatives not tied to a decision</h2><ul class="alts">' +
      orphans
        .map(
          (a) =>
            `<li id="${String(a.local_id).toLowerCase()}"><b>${a.local_id}</b> ${esc(a.option)} ` +
            `<span class="pill pill-${a.verdict}">${a.verdict}</span>: ${linkify(esc(a.rationale ?? ""))}</li>`,
        )
        .join("") +
      "</ul>"
    : "";
  const qrows = questions
    .map(
      (q) =>
        `<tr id="${String(q.local_id).toLowerCase()}"><td><code>${q.local_id}</code></td><td>${esc(q.spec_ref ?? "")}</td>` +
        `<td>${esc(q.question)}</td><td><span class="pill pill-${q.status}">${q.status}</span></td></tr>`,
    )
    .join("");
  tabs.push('<a class="tab" role="tab" href="#decisions" data-panel="decisions">Decisions</a>');
  panels.push(
    '<section class="panel" id="decisions" data-panel="decisions" role="tabpanel">' +
      '<aside class="side"><p class="side-file">.stf/export/<b>decisions.json</b></p>' +
      `<p class="side-note">${decisions.length} decisions · ${alts.size} alternatives · ${questions.length} questions, ` +
      "read from the committed plane export.</p></aside>" +
      '<article class="doc"><h2 id="decisions-list">Decisions</h2><div class="decisions">' +
      cards.join("") +
      '</div><h2 id="questions-list">Open questions</h2><div class="tablewrap"><table><thead><tr><th>ID</th>' +
      "<th>Spec ref</th><th>Question</th><th>Status</th></tr></thead><tbody>" +
      qrows +
      "</tbody></table></div>" +
      orphanHtml +
      "</article></section>",
  );

  const cur = (spec.phase as string) ?? "specify";
  const curI = PHASES.includes(cur) ? PHASES.indexOf(cur) : PHASES.length; // "done" marks every phase complete
  const steps = PHASES.map((p, i) => `<li class="step step-${i < curI ? "done" : i === curI ? "next" : "todo"}"><span class="dot"></span>${p}</li>`).join("");

  // function replacers: a "$" in plane text must never be read as a replacement pattern
  const fill = (page: string, key: string, val: string) => page.replaceAll(key, () => val);
  let page = readFileSync(TEMPLATE_PATH, "utf8");
  for (const [k, v] of [
    ["{{TITLE}}", esc(spec.title ?? spec.slug)],
    ["{{SUMMARY}}", esc(spec.summary ?? "")],
    ["{{SEQ}}", pad3(seq)],
    ["{{SLUG}}", esc(spec.slug)],
    ["{{SPEC_DIR}}", relDir],
    ["{{BRANCH}}", esc(data.branch || "unknown")],
    ["{{STEPS}}", steps],
    ["{{PHASE}}", esc(cur)],
    ["{{UPDATED}}", esc(spec.updated_at ?? "")],
    // document content goes in last so text inside the docs is never treated as a placeholder
    ["{{TABS}}", tabs.join("")],
    ["{{PANELS}}", panels.join("")],
  ] as const)
    page = fill(page, k, v);
  return page;
}

/** Write one spec page (default .stf/spec-page-NNN.html, gitignored) and say where it went. */
export function writeSpecPage(f: Factory, seq: number, out?: string, data?: DashboardData): { out: string; seq: number; phase: string } {
  const d = data ?? dashboardData(f);
  const path = resolve(out ?? join(f.root, ".stf", `spec-page-${pad3(seq)}.html`));
  const html = renderSpecPage(f, seq, d);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, html);
  return { out: path, seq, phase: (d.specs as Row[]).find((s) => s.seq === seq)!.phase };
}
