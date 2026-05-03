// Obsidian vault export. Produces:
//   pages/<Page Title>.md          — one note per saved page (atomic notes)
//   topics/MOC - <topic>.md         — Map of Content per topic, with backlinks
//   _Index.md                       — vault overview / entry point
//   README.md                       — how to use this in Obsidian
//
// File names preserve title casing for nicer wikilinks like [[Understanding Transformers]].

const ILLEGAL = /[\/\\:*?"<>|#^[\]]+/g;

function safeName(s) {
  return String(s || "untitled")
    .replace(ILLEGAL, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100) || "untitled";
}

function topicSlug(s) {
  return String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function escapeYamlScalar(s) {
  return String(s || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function frontmatter(obj) {
  const lines = ["---"];
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || v === "") continue;
    if (Array.isArray(v)) {
      if (!v.length) continue;
      lines.push(`${k}: [${v.map(x => topicSlug(x) || `"${escapeYamlScalar(x)}"`).join(", ")}]`);
    } else if (typeof v === "string") {
      const needsQuote = /[:#&*!|>'"%@`,{}\[\]]/.test(v) || v.includes("\n");
      lines.push(needsQuote ? `${k}: "${escapeYamlScalar(v)}"` : `${k}: ${v}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

function dateOnly(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

export function pageToMarkdown(p, { topicMap }) {
  const date = dateOnly(p.ts);
  const fm = frontmatter({
    type: "page",
    title: p.title || "",
    url: p.url,
    domain: p.domain || "",
    saved: date,
    tags: (p.topics || []).map(topicSlug)
  });

  const lines = [];
  lines.push(`# ${p.title || "Untitled"}`, "");
  lines.push(`> *Saved ${date} from [${p.domain || "source"}](${p.url})*`, "");

  lines.push("## Summary", "");
  lines.push(p.summary || "_(no summary)_", "");

  if (p.note?.trim()) {
    lines.push("## My note", "");
    lines.push(p.note.trim(), "");
  }

  if (p.topics?.length) {
    lines.push("## Topics", "");
    lines.push(p.topics.map(t => `[[MOC - ${t}]]`).join(" · "), "");
  }

  // Related pages: pages sharing ≥1 topic, top 5 by overlap
  if (p.topics?.length && topicMap) {
    const ownTopics = new Set(p.topics);
    const candidates = new Map();
    for (const t of ownTopics) {
      for (const other of (topicMap.get(t) || [])) {
        if (other.url === p.url) continue;
        candidates.set(other.url, (candidates.get(other.url) || 0) + 1);
      }
    }
    const ranked = [...candidates.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([url]) => topicMap._byUrl?.get(url))
      .filter(Boolean);
    if (ranked.length) {
      lines.push("## Related", "");
      for (const r of ranked) {
        lines.push(`- [[${safeName(r.title)}]] — *${r.domain}*`);
      }
      lines.push("");
    }
  }

  return `${fm}\n\n${lines.join("\n")}`;
}

function buildTopicMap(pages) {
  const m = new Map();
  for (const p of pages) {
    for (const t of (p.topics || [])) {
      if (!m.has(t)) m.set(t, []);
      m.get(t).push(p);
    }
  }
  m._byUrl = new Map(pages.map(p => [p.url, p]));
  return m;
}

function topicMOC(topic, pages) {
  const fm = frontmatter({
    type: "moc",
    topic: topicSlug(topic),
    pages: pages.length,
    created: dateOnly(Date.now())
  });

  const lines = [];
  lines.push(`# 🗺️ ${topic}`, "");
  lines.push(`A Map of Content collecting everything you've saved on **${topic}**.`, "");
  lines.push(`*${pages.length} page${pages.length === 1 ? "" : "s"}.*`, "");

  // By recency
  lines.push("## Recent saves", "");
  const sorted = [...pages].sort((a, b) => b.ts - a.ts);
  for (const p of sorted) {
    lines.push(`- ${dateOnly(p.ts)} · [[${safeName(p.title)}]] — *${p.domain}*${p.note ? " · 📝" : ""}`);
  }
  lines.push("");

  // By domain
  const domainCounts = new Map();
  for (const p of pages) {
    const d = p.domain || "(unknown)";
    domainCounts.set(d, (domainCounts.get(d) || 0) + 1);
  }
  const sortedDomains = [...domainCounts.entries()].sort((a, b) => b[1] - a[1]);
  if (sortedDomains.length > 1) {
    lines.push("## Domains", "");
    for (const [d, n] of sortedDomains) {
      lines.push(`- **${d}** — ${n} page${n === 1 ? "" : "s"}`);
    }
    lines.push("");
  }

  // Related topics: topics that co-occur on pages tagged with this topic
  const coTopics = new Map();
  for (const p of pages) {
    for (const t of (p.topics || [])) {
      if (t === topic) continue;
      coTopics.set(t, (coTopics.get(t) || 0) + 1);
    }
  }
  const related = [...coTopics.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  if (related.length) {
    lines.push("## See also", "");
    lines.push(related.map(([t]) => `[[MOC - ${t}]]`).join(" · "), "");
  }

  // Dataview hint comment (renders cleanly even without Dataview)
  lines.push("---", "");
  lines.push("*Tip: install the Dataview plugin in Obsidian and use this query to keep this MOC fresh:*", "");
  lines.push("````dataview", `LIST FROM #${topicSlug(topic)} SORT file.ctime DESC`, "````", "");

  return `${fm}\n\n${lines.join("\n")}`;
}

function buildIndex(pages, topicMap) {
  const fm = frontmatter({
    type: "index",
    pages: pages.length,
    topics: topicMap.size,
    exported: dateOnly(Date.now())
  });

  const domains = new Map();
  for (const p of pages) domains.set(p.domain, (domains.get(p.domain) || 0) + 1);

  const topicEntries = [...topicMap.entries()]
    .filter(([k]) => k !== "_byUrl")
    .sort((a, b) => b[1].length - a[1].length);

  const lines = [];
  lines.push("# 🧠 Memory Agent — Knowledge base", "");
  lines.push(`Exported on **${dateOnly(Date.now())}**.`, "");
  lines.push(`At a glance: **${pages.length}** pages · **${topicMap.size}** topics · **${domains.size}** domains.`, "");

  lines.push("## Maps of Content", "");
  if (!topicEntries.length) {
    lines.push("*No topic clusters yet — save more pages and the agent will tag them.*", "");
  } else {
    for (const [topic, ps] of topicEntries) {
      lines.push(`- [[MOC - ${topic}]] — ${ps.length} page${ps.length === 1 ? "" : "s"}`);
    }
    lines.push("");
  }

  lines.push("## Recent saves", "");
  const sorted = [...pages].sort((a, b) => b.ts - a.ts).slice(0, 30);
  for (const p of sorted) {
    lines.push(`- ${dateOnly(p.ts)} · [[${safeName(p.title)}]] — *${p.domain}*`);
  }
  if (pages.length > 30) {
    lines.push("", `*…and ${pages.length - 30} more in the \`pages/\` folder.*`);
  }
  lines.push("");

  return `${fm}\n\n${lines.join("\n")}`;
}

const VAULT_README = `# Memory Agent vault

This folder is your personal knowledge base, exported from the Memory Agent browser extension.

## Structure

- \`pages/\` — one note per saved page. Each has YAML frontmatter (\`type: page\`, \`url\`, \`domain\`, \`saved\`, \`tags\`).
- \`topics/\` — auto-generated Maps of Content. One \`MOC - <topic>.md\` per topic that appears on 2+ pages.
- \`_Index.md\` — entry point. Open this first.

## How to use this in Obsidian

1. Open Obsidian.
2. **File → Open vault → Open folder as vault**, then pick this folder. (Or move this folder inside an existing vault.)
3. Open \`_Index.md\`. Click any \`[[link]]\` to navigate.
4. Open the **Graph view** (Cmd/Ctrl+G) — every page links to its topic MOCs, and pages share edges through topics.

## Optional plugins

- **Dataview** — every MOC has a fenced \`dataview\` block at the bottom that auto-lists pages tagged with that topic, so the MOC stays current as you add notes.
- **Tag Wrangler** — clean view of all your topics.

## Re-exporting

When you re-export from the extension into the same folder, files with the same name get **overwritten**. Your hand-edited notes in this vault are safe as long as their filenames don't collide with re-exports — keep your own notes in a separate folder (e.g. \`my notes/\`) to be safe.
`;

export async function writeVault(dirHandle, pages, { onProgress } = {}) {
  const topicMap = buildTopicMap(pages);

  const writeFile = async (parent, name, content) => {
    const fh = await parent.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(content);
    await w.close();
  };

  const pagesDir = await dirHandle.getDirectoryHandle("pages", { create: true });
  const topicsDir = await dirHandle.getDirectoryHandle("topics", { create: true });

  const seen = new Set();
  let written = 0;
  const total = pages.length + [...topicMap.keys()].filter(k => k !== "_byUrl").length + 2;

  for (const p of pages) {
    let base = safeName(p.title);
    let candidate = base;
    let i = 2;
    while (seen.has(candidate)) candidate = `${base} (${i++})`;
    seen.add(candidate);
    await writeFile(pagesDir, `${candidate}.md`, pageToMarkdown(p, { topicMap }));
    written++;
    if (onProgress) onProgress(written, total);
  }

  for (const [topic, tpages] of topicMap) {
    if (topic === "_byUrl") continue;
    if (tpages.length < 2) continue;
    await writeFile(topicsDir, `MOC - ${safeName(topic)}.md`, topicMOC(topic, tpages));
    written++;
    if (onProgress) onProgress(written, total);
  }

  await writeFile(dirHandle, "_Index.md", buildIndex(pages, topicMap));
  written++;
  await writeFile(dirHandle, "README.md", VAULT_README);
  written++;
  if (onProgress) onProgress(written, total);

  return { written, vaultName: dirHandle.name, topicCount: topicMap.size - 1 };
}

export async function exportToVault(pages, opts) {
  if (!window.showDirectoryPicker) {
    throw new Error("Your browser doesn't expose the File System Access API. Use 'Download as one file' instead.");
  }
  const dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
  return writeVault(dirHandle, pages, opts);
}

export function downloadAsSingleFile(pages, filename = "memory-agent-export.md") {
  const topicMap = buildTopicMap(pages);
  const parts = [];
  parts.push(`# Memory Agent export`);
  parts.push("");
  parts.push(`Exported ${dateOnly(Date.now())} · ${pages.length} pages · ${topicMap.size - 1} topics.`);
  parts.push("");
  parts.push("---");
  parts.push("");

  for (const p of pages) {
    parts.push(pageToMarkdown(p, { topicMap }));
    parts.push("");
    parts.push("---");
    parts.push("");
  }

  for (const [topic, tpages] of topicMap) {
    if (topic === "_byUrl") continue;
    if (tpages.length < 2) continue;
    parts.push(topicMOC(topic, tpages));
    parts.push("");
    parts.push("---");
    parts.push("");
  }

  const blob = new Blob([parts.join("\n")], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
