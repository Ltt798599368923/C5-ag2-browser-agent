import { PROVIDERS } from "./lib/llm.js";
import { renderMarkdown } from "./lib/markdown.js";
import { exportToVault, downloadAsSingleFile } from "./lib/export.js";
import { createMascot, setMascotState, celebrate, startIdleLife } from "./lib/mascot.js";

// Surface any otherwise-silent runtime errors so the panel doesn't appear "crashed"
// without explanation.
window.addEventListener("error", (e) => {
  console.error("[memory-agent] uncaught:", e.error || e.message);
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("[memory-agent] unhandled rejection:", e.reason);
});

const $ = (id) => document.getElementById(id);

function send(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      if (!resp) return reject(new Error("No response from background worker"));
      if (!resp.ok) return reject(new Error(resp.error));
      resolve(resp);
    });
  });
}

const chatHistory = [];

document.querySelectorAll(".appbar-tab").forEach(btn => {
  btn.addEventListener("click", () => {
    const view = btn.dataset.view;
    document.querySelectorAll(".appbar-tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
    btn.classList.add("active");
    $(`view-${view}`).classList.add("active");
    if (view === "lib") loadLibrary();
  });
});

document.querySelectorAll(".suggest").forEach(btn => {
  btn.addEventListener("click", () => {
    if (btn.dataset.action === "import") return runImport(btn);
    const msg = btn.dataset.msg;
    if (!msg) return;
    $("ask-input").value = msg;
    $("composer").requestSubmit();
  });
});

async function runImport(triggerBtn = null) {
  const original = triggerBtn?.textContent;
  if (triggerBtn) {
    triggerBtn.disabled = true;
    triggerBtn.textContent = "Importing your last 30 days…";
  }
  setExportStatus("Reading your browser history…");
  try {
    const result = await send({
      type: "import-history",
      options: { days: 30, maxResults: 800 }
    });
    const msg = `✓ Imported ${result.imported} pages from history${result.alreadyHave ? ` (${result.alreadyHave} already saved)` : ""}.`;
    setExportStatus(msg, 5000);
    flashCelebration();
    if (typeof loadLibrary === "function") {
      try { await loadLibrary(); } catch {}
    }
    if (triggerBtn) triggerBtn.textContent = `${msg} Try a question above.`;
  } catch (e) {
    setExportStatus(`Import failed: ${e.message}`, 6000);
    if (triggerBtn) triggerBtn.textContent = original;
  } finally {
    if (triggerBtn) triggerBtn.disabled = false;
  }
}

function clearEmpty() {
  const e = $("empty-state");
  if (e) e.remove();
}

function appendMsg(role, text) {
  clearEmpty();
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  const body = document.createElement("div");
  body.className = "body";
  if (text) {
    if (role === "agent") body.innerHTML = renderMarkdown(text);
    else body.textContent = text;
  }
  div.appendChild(body);
  $("chat").appendChild(div);
  div.scrollIntoView({ block: "end" });
  return div;
}

function setAgentBody(div, text) {
  let body = div.querySelector(".body");
  if (!body) {
    div.innerHTML = "";
    body = document.createElement("div");
    body.className = "body";
    div.appendChild(body);
  }
  body.innerHTML = renderMarkdown(text);
}

function appendThinking() {
  clearEmpty();
  const div = document.createElement("div");
  div.className = "msg agent";
  const wrap = document.createElement("div");
  wrap.className = "thinking";
  const m = createMascot({ size: "sm", state: "thinking" });
  wrap.appendChild(m);
  const label = document.createElement("span");
  label.textContent = "Thinking…";
  wrap.appendChild(label);
  div.appendChild(wrap);
  $("chat").appendChild(div);
  div.scrollIntoView({ block: "end" });
  return div;
}

function renderTrace(parent, trace) {
  if (!trace?.length) return;
  const div = document.createElement("div");
  div.className = "tool-trace";
  for (const t of trace) {
    const pill = document.createElement("span");
    pill.className = "tool-pill";
    pill.textContent = t.tool.replace(/_/g, " ");
    div.appendChild(pill);
  }
  const note = document.createElement("span");
  const total = trace.reduce((a, t) => a + (t.count || 0), 0);
  note.textContent = total ? `· read ${total} entries` : "";
  div.appendChild(note);
  parent.appendChild(div);
}

function renderSources(parent, trace) {
  if (!trace?.length) return;
  const sourceItems = [];

  for (const t of trace) {
    if (!t.ok || !t.result) continue;
    if (t.tool === "scan_history" && t.result.domains) {
      for (const d of t.result.domains) {
        sourceItems.push({
          kind: "domainGroup",
          domain: d.domain,
          pageCount: d.pageCount,
          totalVisits: d.totalVisits,
          examples: d.examples || []
        });
      }
    } else if (t.tool === "recent_history" && Array.isArray(t.result)) {
      for (const it of t.result) {
        sourceItems.push({
          kind: "history",
          title: it.title || it.url,
          url: it.url,
          domain: it.domain,
          visits: it.visits,
          lastVisit: it.lastVisit
        });
      }
    } else if ((t.tool === "search_knowledge" || t.tool === "list_knowledge") && Array.isArray(t.result)) {
      for (const it of t.result) {
        sourceItems.push({
          kind: "knowledge",
          title: it.title || it.url,
          url: it.url,
          domain: it.domain,
          savedAt: it.savedAt,
          summary: it.summary
        });
      }
    } else if (t.tool === "recommend_articles" && Array.isArray(t.result)) {
      for (const it of t.result) {
        sourceItems.push({
          kind: "recommendation",
          title: it.title,
          url: it.url,
          author: it.author,
          published: it.published,
          snippet: it.snippet
        });
      }
    }
  }

  if (!sourceItems.length) return;

  const det = document.createElement("details");
  det.className = "sources-details";
  const sum = document.createElement("summary");
  const totalLinks = sourceItems.reduce((a, s) => a + (s.examples?.length || 1), 0);
  sum.textContent = `Sources (${totalLinks} link${totalLinks === 1 ? "" : "s"})`;
  det.appendChild(sum);

  const ul = document.createElement("ul");
  ul.className = "sources-list";

  for (const s of sourceItems) {
    if (s.kind === "domainGroup") {
      const li = document.createElement("li");
      const head = document.createElement("div");
      head.className = "src-domain-group";
      head.textContent = s.domain;
      const hits = document.createElement("span");
      hits.className = "src-hits";
      hits.textContent = `${s.pageCount} page${s.pageCount === 1 ? "" : "s"} · ${s.totalVisits} hits`;
      head.appendChild(hits);
      li.appendChild(head);
      for (const ex of s.examples) {
        const a = document.createElement("a");
        a.className = "src-title";
        a.href = ex.url;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = ex.title || ex.url;
        const meta = document.createElement("span");
        meta.className = "src-meta";
        meta.textContent = `${ex.visits || 1} visit${(ex.visits || 1) === 1 ? "" : "s"}`;
        li.append(a, meta);
      }
      ul.appendChild(li);
    } else {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.className = "src-title";
      a.href = s.url;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = s.title;
      const meta = document.createElement("span");
      meta.className = "src-meta";
      const parts = [];
      if (s.domain) parts.push(s.domain);
      if (s.kind === "history") {
        if (s.visits) parts.push(`${s.visits} visit${s.visits === 1 ? "" : "s"}`);
        if (s.lastVisit) parts.push(`last ${s.lastVisit}`);
      } else if (s.kind === "knowledge") {
        if (s.savedAt) parts.push(`saved ${s.savedAt}`);
      } else if (s.kind === "recommendation") {
        if (s.author) parts.push(s.author);
        if (s.published) parts.push(s.published);
        parts.push("medium");
      }
      meta.textContent = parts.join(" · ");
      li.append(a, meta);
      ul.appendChild(li);
    }
  }

  det.appendChild(ul);
  parent.appendChild(det);
}

$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("ask-input").value.trim();
  if (!msg) return;
  $("ask-input").value = "";
  autoResizeInput();

  appendMsg("user", msg);
  const placeholder = appendThinking();

  try {
    if (/^\s*save (this|current) page\s*\.?\s*$/i.test(msg)) {
      const { entry } = await send({ type: "summarize-current-tab" });
      placeholder.innerHTML = "";
      placeholder.textContent = `Saved "${entry.title}" to memory.`;
      const card = document.createElement("div");
      card.className = "summary-card";
      card.innerHTML = `<h4></h4><small></small><pre></pre>`;
      card.querySelector("h4").textContent = entry.title;
      card.querySelector("small").textContent = entry.domain;
      card.querySelector("pre").textContent = entry.summary;
      placeholder.appendChild(card);
      chatHistory.push({ role: "user", content: msg });
      chatHistory.push({ role: "assistant", content: `Saved "${entry.title}" to memory.` });
      return;
    }

    const { content, trace } = await send({
      type: "chat",
      message: msg,
      history: chatHistory
    });
    setAgentBody(placeholder, content);
    renderSources(placeholder, trace);
    renderTrace(placeholder, trace);
    chatHistory.push({ role: "user", content: msg });
    chatHistory.push({ role: "assistant", content });
  } catch (e) {
    placeholder.innerHTML = "";
    placeholder.textContent = `Error: ${e.message}`;
  }
});

$("ask-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("composer").requestSubmit();
  }
});

function autoResizeInput() {
  const ta = $("ask-input");
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
}
$("ask-input").addEventListener("input", autoResizeInput);

$("quick-save").addEventListener("click", async () => {
  appendMsg("user", "Save this page");
  const placeholder = appendThinking();
  try {
    const { entry } = await send({ type: "summarize-current-tab" });
    placeholder.innerHTML = "";
    placeholder.textContent = `Saved "${entry.title}" to memory.`;
    const card = document.createElement("div");
    card.className = "summary-card";
    card.innerHTML = `<h4></h4><small></small><pre></pre>`;
    card.querySelector("h4").textContent = entry.title;
    card.querySelector("small").textContent = entry.domain;
    card.querySelector("pre").textContent = entry.summary;
    placeholder.appendChild(card);
    flashCelebration();
  } catch (e) {
    placeholder.innerHTML = "";
    placeholder.textContent = `Couldn't save: ${e.message}`;
  }
});

// Library
async function loadLibrary() {
  const { pages } = await send({ type: "list", limit: 500 });
  const filter = $("lib-search").value.toLowerCase();
  const visible = pages.filter(p =>
    !filter || `${p.title} ${p.summary} ${p.domain}`.toLowerCase().includes(filter)
  );
  $("lib-count").textContent = `${visible.length} of ${pages.length}`;

  const ul = $("lib-list");
  ul.innerHTML = "";
  if (!pages.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "Nothing saved yet. Hit + in the chat to save the current page.";
    ul.appendChild(li);
    return;
  }

  for (const p of visible) {
    const li = document.createElement("li");

    const a = document.createElement("a");
    a.href = p.url;
    a.target = "_blank";
    a.textContent = p.title || p.url;

    const meta = document.createElement("small");
    meta.textContent = `${new Date(p.ts).toLocaleString()} · ${p.domain}`;

    const det = document.createElement("details");
    const sum = document.createElement("summary");
    sum.textContent = "Summary";
    const pre = document.createElement("pre");
    pre.textContent = p.summary;
    det.append(sum, pre);

    const noteDet = document.createElement("details");
    noteDet.className = "note-block";
    const noteSum = document.createElement("summary");
    noteSum.textContent = p.note ? "My note ✓" : "Add note";
    const ta = document.createElement("textarea");
    ta.placeholder = "Your thoughts, takeaways, questions…";
    ta.value = p.note || "";
    const noteRow = document.createElement("div");
    noteRow.className = "note-row";
    const status = document.createElement("span");
    status.className = "note-status";
    const saveNote = document.createElement("button");
    saveNote.textContent = "Save note";
    saveNote.className = "ghost small";
    saveNote.addEventListener("click", async () => {
      try {
        await send({ type: "update-note", url: p.url, note: ta.value.trim() });
        status.textContent = "Saved";
        noteSum.textContent = ta.value.trim() ? "My note ✓" : "Add note";
        setTimeout(() => { status.textContent = ""; }, 1800);
      } catch (e) {
        status.textContent = `Error: ${e.message}`;
      }
    });
    noteRow.append(status, saveNote);
    noteDet.append(noteSum, ta, noteRow);

    const del = document.createElement("button");
    del.textContent = "Delete";
    del.className = "ghost danger small";
    del.addEventListener("click", async () => {
      await send({ type: "delete", url: p.url });
      loadLibrary();
    });

    li.append(a, meta, det, noteDet, del);
    ul.appendChild(li);
  }
}

$("lib-search").addEventListener("input", loadLibrary);

$("lib-import").addEventListener("click", () => runImport($("lib-import")));

$("lib-clear").addEventListener("click", async () => {
  if (!confirm("Delete all stored summaries? This cannot be undone.")) return;
  await send({ type: "clear" });
  loadLibrary();
});

$("open-graph").addEventListener("click", async () => {
  try { await send({ type: "open-graph" }); } catch (e) { console.warn(e); }
});

function setExportStatus(text, ms = 0) {
  const el = $("export-status");
  if (!el) return;
  el.textContent = text || "";
  if (ms > 0) setTimeout(() => { el.textContent = ""; }, ms);
}

$("download-md").addEventListener("click", async () => {
  try {
    const { pages } = await send({ type: "list", limit: 5000 });
    if (!pages.length) return setExportStatus("Nothing to download — save some pages first.", 3000);
    downloadAsSingleFile(pages);
    setExportStatus(`Downloaded ${pages.length} pages as one .md file.`, 3000);
  } catch (e) {
    setExportStatus(`Download failed: ${e.message}`, 4000);
  }
});

$("export-vault").addEventListener("click", async () => {
  try {
    const { pages } = await send({ type: "list", limit: 5000 });
    if (!pages.length) return setExportStatus("Nothing to export — save some pages first.", 3000);
    setExportStatus("Pick a folder…");
    const { written, vaultName, topicCount } = await exportToVault(pages, {
      onProgress: (n, total) => setExportStatus(`Writing ${n}/${total}…`)
    });
    setExportStatus(`✓ Exported ${written} files to "${vaultName}" (${topicCount} MOCs).`, 5000);
  } catch (e) {
    if (e.name === "AbortError") return setExportStatus("");
    setExportStatus(`Export failed: ${e.message}`, 5000);
  }
});

// Settings modal
$("open-settings").addEventListener("click", openSettings);
$("close-settings").addEventListener("click", closeSettings);
$("settings-modal").querySelector(".modal-backdrop").addEventListener("click", closeSettings);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeSettings();
});

function populateProviderSelect() {
  const sel = $("provider");
  if (sel.options.length) return;
  for (const [key, cfg] of Object.entries(PROVIDERS)) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = cfg.label;
    sel.appendChild(opt);
  }
}

function refreshModelOptions(provider) {
  const cfg = PROVIDERS[provider];
  const dl = $("model-options");
  dl.innerHTML = "";
  for (const m of cfg.models) {
    const o = document.createElement("option");
    o.value = m;
    dl.appendChild(o);
  }
  $("model").placeholder = `default: ${cfg.defaultModel}`;
  $("keys-link").href = cfg.keysUrl;
}

let cachedApiKeys = {};

async function openSettings() {
  populateProviderSelect();
  const { settings } = await send({ type: "settings" });
  cachedApiKeys = { ...(settings.apiKeys || {}) };
  $("provider").value = settings.provider;
  $("apiKey").value = cachedApiKeys[settings.provider] || "";
  $("model").value = settings.model;
  $("autoSummarize").checked = settings.autoSummarize;
  refreshModelOptions(settings.provider);
  $("settings-modal").classList.remove("hidden");
}

function closeSettings() {
  $("settings-modal").classList.add("hidden");
}

$("provider").addEventListener("change", () => {
  // Stash whatever's in the field for the previously-selected provider
  const previousProvider = $("provider").dataset.last || $("provider").value;
  cachedApiKeys[previousProvider] = $("apiKey").value.trim();
  // Switch
  const next = $("provider").value;
  $("provider").dataset.last = next;
  $("apiKey").value = cachedApiKeys[next] || "";
  refreshModelOptions(next);
});

$("save-settings").addEventListener("click", async () => {
  const provider = $("provider").value;
  const apiKey = $("apiKey").value.trim();
  cachedApiKeys[provider] = apiKey;
  const settings = {
    provider,
    apiKeys: cachedApiKeys,
    apiKey,
    model: $("model").value.trim(),
    autoSummarize: $("autoSummarize").checked
  };
  try {
    await send({ type: "set-settings", settings });
    $("settings-status").textContent = "Saved.";
    setTimeout(() => {
      $("settings-status").textContent = "";
      closeSettings();
    }, 1000);
  } catch (e) {
    $("settings-status").textContent = `Error: ${e.message}`;
  }
});

// Inject the greeting mascot into the empty state
function mountGreeting() {
  const row = $("greeting-row");
  if (!row) return;
  row.innerHTML = "";
  const m = createMascot({ size: "lg", state: "idle" });
  row.appendChild(m);
  startIdleLife(m);
}
mountGreeting();

// Quick-save celebration: find the most recent agent message bubble and pulse a happy mascot in it,
// or just briefly pop one in the chat.
function flashCelebration() {
  const m = createMascot({ size: "sm", state: "happy" });
  m.style.position = "fixed";
  m.style.right = "16px";
  m.style.bottom = "70px";
  m.style.zIndex = "200";
  m.style.pointerEvents = "none";
  m.style.filter = "drop-shadow(0 4px 12px rgba(201, 100, 66, 0.35))";
  document.body.appendChild(m);
  setTimeout(() => m.remove(), 1100);
}

// Auto-open settings on first run if no key
(async () => {
  const { settings } = await send({ type: "settings" });
  if (!settings.apiKey) openSettings();
})();
