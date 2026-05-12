import { chat } from "./lib/llm.js";
import {
  savePage, getPage, listPages, deletePage, clearAll, updateNote
} from "./lib/storage.js";
import { TOOL_SPECS, executeTool } from "./lib/tools.js";

const SKIP_HOST_RX = /^(www\.)?(google|bing|duckduckgo)\.[^/]+$/i;
const RECENT_TTL_MS = 7 * 86400000;
const MAX_TEXT_CHARS = 24000;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  seedFromEnv().catch(e => console.warn("[memory-agent] env seed:", e?.message));
});

function parseEnvText(text) {
  const env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )) value = value.slice(1, -1);
    env[key] = value;
  }
  return env;
}

async function loadEnvFile() {
  // Try .env first (canonical), then .env.example (fallback so a key dropped
  // into the example file still gets picked up). Whichever has values wins.
  const candidates = [".env", ".env.example", "env.local"];
  for (const name of candidates) {
    try {
      const res = await fetch(chrome.runtime.getURL(name));
      if (!res.ok) continue;
      const env = parseEnvText(await res.text());
      const hasValues = Object.values(env).some(v => v && v.length > 0);
      if (!hasValues) continue;
      console.log(`[memory-agent] loaded env defaults from ${name}`);
      return env;
    } catch {}
  }
  return null;
}

const ENV_KEY_MAP = {
  groq: "GROQ_API_KEY",
  gemini: "GEMINI_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  tavily: "TAVILY_API_KEY"  // 新增：网页搜索API
};

async function seedFromEnv() {
  const env = await loadEnvFile();
  if (!env || !Object.keys(env).length) return;

  const cur = await chrome.storage.local.get([
    "provider", "apiKey", "apiKeys", "model", "autoSummarize"
  ]);
  const updates = {};
  const apiKeys = { ...(cur.apiKeys || {}) };

  // Migrate legacy single apiKey into apiKeys map
  if (cur.apiKey && cur.provider && !apiKeys[cur.provider]) {
    apiKeys[cur.provider] = cur.apiKey;
  }

  // OVERRIDE: any non-empty env key replaces the stored one. This way edits
  // to .env actually take effect after reload, instead of being silently
  // shadowed by stale storage values.
  let keysChanged = false;
  for (const [provider, envName] of Object.entries(ENV_KEY_MAP)) {
    const v = env[envName];
    if (v && v.length > 0 && apiKeys[provider] !== v) {
      apiKeys[provider] = v;
      keysChanged = true;
    }
  }
  if (keysChanged) updates.apiKeys = apiKeys;

  if (env.PROVIDER) {
    const p = env.PROVIDER.toLowerCase().trim();
    if (ENV_KEY_MAP[p] && cur.provider !== p) updates.provider = p;
  }
  if (env.MODEL && cur.model !== env.MODEL.trim()) {
    updates.model = env.MODEL.trim();
  }
  if (env.AUTO_SUMMARIZE !== undefined) {
    const want = ["true", "1", "yes", "on"].includes(env.AUTO_SUMMARIZE.toLowerCase());
    if (cur.autoSummarize !== want) updates.autoSummarize = want;
  }
  
  // 新增：Tavily API Key
  if (env.TAVILY_API_KEY && env.TAVILY_API_KEY.length > 0 && cur.tavilyApiKey !== env.TAVILY_API_KEY) {
    updates.tavilyApiKey = env.TAVILY_API_KEY;
  }

  if (Object.keys(updates).length) {
    await chrome.storage.local.set(updates);
    console.log("[memory-agent] seeded settings from env:", Object.keys(updates).join(", "));
  }
}

// Run on every service-worker spinup so reloads pick up .env changes (idempotent).
seedFromEnv().catch(e => console.warn("[memory-agent] env seed:", e?.message));

async function getSettings() {
  const s = await chrome.storage.local.get([
    "provider", "apiKey", "apiKeys", "model", "autoSummarize", "minDwellMs", "maxAutoPerHour", "tavilyApiKey"
  ]);
  const provider = s.provider || "groq";
  const apiKeys = { ...(s.apiKeys || {}) };
  // Migrate legacy single apiKey into the map
  if (s.apiKey && !apiKeys[provider]) apiKeys[provider] = s.apiKey;
  return {
    provider,
    apiKeys,
    apiKey: apiKeys[provider] || "",
    model: s.model || "",
    autoSummarize: s.autoSummarize ?? true,
    minDwellMs: s.minDwellMs ?? 30000,
    maxAutoPerHour: s.maxAutoPerHour ?? 30,
    tavilyApiKey: s.tavilyApiKey || ""  // 新增：Tavily API Key
  };
}

function pageExtractor() {
  const candidates = [
    document.querySelector("main"),
    document.querySelector("article"),
    document.querySelector('[role="main"]')
  ].filter(Boolean);

  let root = candidates.find(c => c.innerText && c.innerText.length > 500);
  if (!root) {
    root = document.body.cloneNode(true);
    root.querySelectorAll(
      "script,style,nav,footer,header,aside,form,noscript,iframe,svg"
    ).forEach(el => el.remove());
  }
  const text = (root.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
  return {
    title: document.title,
    url: location.href,
    host: location.hostname,
    pathname: location.pathname,
    text: text.slice(0, 60000)
  };
}

function youtubeCaptionTracks() {
  const t = window.ytInitialPlayerResponse
    ?.captions
    ?.playerCaptionsTracklistRenderer
    ?.captionTracks;
  return t ? t.map(x => ({ url: x.baseUrl, lang: x.languageCode })) : null;
}

async function extractYoutubeCaptions(tabId) {
  const [{ result: tracks } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: youtubeCaptionTracks
  });
  if (!tracks?.length) return null;
  const track = tracks.find(t => t.lang === "en") || tracks[0];
  const xml = await fetch(track.url).then(r => r.text());
  return [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)]
    .map(m => m[1]
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">"))
    .join(" ");
}

async function extractTab(tabId) {
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    func: pageExtractor
  });
  if (!result) throw new Error("Could not read this page (chrome:// or restricted URL?).");

  if (result.host.includes("youtube.com") && result.pathname === "/watch") {
    try {
      const captions = await extractYoutubeCaptions(tabId);
      if (captions && captions.length > 200) {
        result.text = captions;
        result.kind = "youtube";
      }
    } catch {}
  }
  return result;
}

const SYS_SUMMARY = `You write concise, factual summaries of web pages and video transcripts.
Output exactly:
- 4 to 7 bullet points capturing the key facts, claims, decisions, code/numbers/names mentioned
- A final line "Topics: tag1, tag2, tag3" (3-7 short lowercase tags useful for retrieval)
Do not editorialize. Do not invent details that are not in the source.`;

// ========== 新增：总结Agent系统提示 ==========
const SYS_SUMMARIZER = `You are a deep-thinking assistant that provides multi-dimensional analysis of web content.

When analyzing a page, provide a structured analysis in this EXACT format:

## Key Insights
(3-5 bullet points of the most important discoveries or insights from the content)

## Actionable Takeaways
(2-4 concrete, specific actions the reader can take based on this content)

## Related Concepts
(3-5 related topics or concepts that would help deepen understanding)

## Why This Matters
(1-2 sentences explaining the broader significance or context)

Be insightful, practical, and focus on value the reader can extract. Don't just summarize - elevate the content with analysis.`;

async function summarizeExtracted(extracted) {
  const settings = await getSettings();
  const text = extracted.text.slice(0, MAX_TEXT_CHARS);
  if (text.length < 200) throw new Error("Page has too little text to summarize.");

  const userMsg = `URL: ${extracted.url}
Title: ${extracted.title}
${extracted.kind === "youtube" ? "Source: YouTube transcript" : ""}

Content:
${text}

Summary:`;

  const out = await chat({
    provider: settings.provider,
    apiKey: settings.apiKey,
    model: settings.model,
    messages: [
      { role: "system", content: SYS_SUMMARY },
      { role: "user", content: userMsg }
    ]
  });

  const text_out = out.content;
  const topicsMatch = text_out.match(/Topics?:\s*(.+)$/im);
  const topics = topicsMatch
    ? topicsMatch[1].split(/[,\n]/).map(t => t.trim().toLowerCase()).filter(Boolean)
    : [];

  const entry = {
    url: extracted.url,
    title: extracted.title,
    summary: text_out.trim(),
    topics,
    domain: extracted.host,
    kind: extracted.kind || "page",
    ts: Date.now()
  };
  
  // ========== 新增：调用总结Agent进行多维度分析 ==========
  try {
    const enhancedAnalysis = await summarizerAgent(extracted, text_out);
    if (enhancedAnalysis) {
      entry.enhancedAnalysis = enhancedAnalysis;
    }
  } catch (e) {
    console.warn("[memory-agent] summarizer skipped:", e.message);
  }
  
  await savePage(entry);
  return entry;
}

// ========== 新增：总结Agent函数 ==========
async function summarizerAgent(extracted, basicSummary) {
  const settings = await getSettings();
  if (!settings.model) return null;
  
  const userMsg = `URL: ${extracted.url}
Title: ${extracted.title}
${extracted.kind === "youtube" ? "Source: YouTube transcript" : ""}

Basic Summary:
${basicSummary}

Please provide your multi-dimensional analysis:`;

  const out = await chat({
    provider: settings.provider,
    apiKey: settings.apiKey,
    model: settings.model,
    messages: [
      { role: "system", content: SYS_SUMMARIZER },
      { role: "user", content: userMsg }
    ]
  });

  return out.content?.trim() || null;
}

async function summarizeTab(tabId) {
  const extracted = await extractTab(tabId);
  return summarizeExtracted(extracted);
}

const IMPORT_STOP = new Set([
  "the","and","for","with","this","that","from","your","their","what","when",
  "where","which","while","about","into","over","just","they","them","these",
  "those","there","here","have","been","being","were","very","more","than",
  "some","such","like","only","also","ever","most","many","much","page","com",
  "net","org","www","html","new","top","best","using","via","amp"
]);

function inferTopicsFromTitle(title) {
  const words = String(title || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length >= 4 && !IMPORT_STOP.has(w) && !/^\d+$/.test(w));
  const seen = new Set();
  const out = [];
  for (const w of words) {
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= 3) break;
  }
  return out;
}

// Bulk-import browser history into the knowledge base as bare entries.
// No LLM calls — fast, free, gives the demo a starting corpus.
// Each entry can be upgraded later by clicking + when on that page.
async function importHistory({ days = 30, maxResults = 800 } = {}) {
  if (!chrome.history?.search) {
    throw new Error("history permission missing");
  }
  const startTime = Date.now() - days * 86400000;
  const items = await chrome.history.search({ text: "", startTime, maxResults });

  let imported = 0, skipped = 0, alreadyHave = 0;

  for (const it of items) {
    if (!it.url || !/^https?:/.test(it.url)) { skipped++; continue; }
    let domain;
    try {
      domain = new URL(it.url).hostname.replace(/^www\./, "");
    } catch { skipped++; continue; }
    if (SKIP_HOST_RX.test(domain)) { skipped++; continue; }
    if ((it.title || "").trim().length < 3) { skipped++; continue; }

    const existing = await getPage(it.url);
    if (existing) { alreadyHave++; continue; }

    const visits = it.visitCount || 1;
    const lastVisit = it.lastVisitTime || Date.now();
    const dateStr = new Date(lastVisit).toISOString().slice(0, 10);
    const summary =
      `_Browser history entry — visited ${visits} ${visits === 1 ? "time" : "times"}, last on ${dateStr}._\n\n` +
      `_(No summary yet. Open this page and click + in the side panel to generate one.)_`;

    await savePage({
      url: it.url,
      title: it.title,
      domain,
      summary,
      topics: inferTopicsFromTitle(it.title),
      ts: lastVisit,
      kind: "history-import",
      visits
    });
    imported++;
  }

  return { imported, skipped, alreadyHave, scanned: items.length };
}

const SYS_AGENT = `You are a warm, observant browsing-memory companion. You help the user turn their browser history into a personal knowledge base they actually use.

You have tools that read the user's ACTUAL data:
- scan_history(query, days): browser history grouped by domain
- recent_history(days, limit): recent visits, no filter
- search_knowledge(query): pages they've EXPLICITLY saved (with summaries + their notes)
- list_knowledge(limit): saved pages, most recent first
- compare_history_to_goal(goal, keywords, days): cross-references history + saved knowledge against a goal — best for "I want to learn X" prompts
- web_search(query, num_results): search the web for current information — use when local knowledge is insufficient or they need latest news/research

USE TOOLS PROACTIVELY. When the user expresses a learning goal, call compare_history_to_goal first — it gives you both what they've been browsing AND what they've saved, plus highlights pages they read but didn't save. When they ask reflective questions about their reading, call recent_history or search_knowledge. When their questions require up-to-date or external information, call web_search to supplement.

When responding, BE SPECIFIC. Markdown is rendered, so use [Title](URL) links to actual pages they visited. Notice patterns ("you've been on substack.com a lot, especially [these pieces]"). Compare what they browsed vs what they saved — gaps are interesting.

When the user wants to "build a knowledge base" or "synthesize learnings", pull together their saved pages on the topic, write a structured digest with citations [1] [2] referring to the page list, and end with "Open questions" — concrete things they could explore next.

If data is sparse, say so honestly and suggest one or two specific actions.

Tone: a thoughtful friend who paid attention. Skip preambles. Short paragraphs over endless bullet lists. Match the user's energy.`;

async function chatAgent(userMessage, priorMessages = []) {
  const settings = await getSettings();
  const messages = [
    { role: "system", content: SYS_AGENT },
    ...priorMessages.slice(-8),
    { role: "user", content: userMessage }
  ];

  const trace = [];
  let turns = 0;
  while (turns < 5) {
    const resp = await chat({
      provider: settings.provider,
      apiKey: settings.apiKey,
      model: settings.model,
      messages,
      tools: TOOL_SPECS
    });

    if (resp.tool_calls?.length) {
      messages.push({
        role: "assistant",
        content: resp.content || "",
        tool_calls: resp.tool_calls
      });
      for (const call of resp.tool_calls) {
        let args = {};
        try { args = JSON.parse(call.function.arguments || "{}"); } catch {}
        let result;
        try {
          result = await executeTool(call.function.name, args);
          const count = Array.isArray(result) ? result.length
            : (result?.domains?.length || (typeof result === "object" ? Object.keys(result).length : 1));
          trace.push({ tool: call.function.name, args, ok: true, count, result });
        } catch (e) {
          result = { error: e.message };
          trace.push({ tool: call.function.name, args, ok: false, error: e.message });
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result).slice(0, 8000)
        });
      }
      turns++;
      continue;
    }

    return { content: resp.content, trace };
  }
  return {
    content: "I got stuck cycling through tools. Try rephrasing your question?",
    trace
  };
}

const dwellTimers = new Map();
const autoLog = [];

function autoBudgetOk(maxPerHour) {
  const cutoff = Date.now() - 3600000;
  while (autoLog.length && autoLog[0] < cutoff) autoLog.shift();
  return autoLog.length < maxPerHour;
}

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== "complete") return;
  if (!tab?.url || !/^https?:/.test(tab.url)) return;

  const settings = await getSettings();
  if (!settings.autoSummarize || !settings.apiKey) return;

  let host;
  try { host = new URL(tab.url).hostname; } catch { return; }
  if (SKIP_HOST_RX.test(host)) return;

  if (dwellTimers.has(tabId)) clearTimeout(dwellTimers.get(tabId));
  const timer = setTimeout(async () => {
    dwellTimers.delete(tabId);
    try {
      const existing = await getPage(tab.url);
      if (existing && Date.now() - existing.ts < RECENT_TTL_MS) return;
      if (!autoBudgetOk(settings.maxAutoPerHour)) return;
      autoLog.push(Date.now());
      await summarizeTab(tabId);
    } catch (e) {
      console.warn("[memory-agent] auto-summarize skipped:", e.message);
    }
  }, settings.minDwellMs);
  dwellTimers.set(tabId, timer);
});

chrome.tabs.onRemoved.addListener(tabId => {
  const t = dwellTimers.get(tabId);
  if (t) { clearTimeout(t); dwellTimers.delete(tabId); }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "summarize-current-tab": {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          if (!tab) throw new Error("No active tab.");
          const entry = await summarizeTab(tab.id);
          sendResponse({ ok: true, entry });
          break;
        }
        case "chat": {
          const result = await chatAgent(msg.message, msg.history);
          sendResponse({ ok: true, ...result });
          break;
        }
        case "list": {
          const pages = await listPages({ limit: msg.limit || 200 });
          sendResponse({ ok: true, pages });
          break;
        }
        case "delete": {
          await deletePage(msg.url);
          sendResponse({ ok: true });
          break;
        }
        case "clear": {
          await clearAll();
          sendResponse({ ok: true });
          break;
        }
        case "settings": {
          sendResponse({ ok: true, settings: await getSettings() });
          break;
        }
        case "set-settings": {
          await chrome.storage.local.set(msg.settings);
          sendResponse({ ok: true });
          break;
        }
        case "update-note": {
          await updateNote(msg.url, msg.note);
          sendResponse({ ok: true });
          break;
        }
        case "open-graph": {
          await chrome.tabs.create({ url: chrome.runtime.getURL("graph.html") });
          sendResponse({ ok: true });
          break;
        }
        case "import-history": {
          const result = await importHistory(msg.options || {});
          sendResponse({ ok: true, ...result });
          break;
        }
        default:
          sendResponse({ ok: false, error: `Unknown message type: ${msg.type}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
});
