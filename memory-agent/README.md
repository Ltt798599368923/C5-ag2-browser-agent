# Memory Agent

A Chrome side-panel companion that turns your **browser history** into a **personal knowledge base** — local, private, free, and exportable to Obsidian.

Tell it a learning goal in plain language. It scans your actual browsing, compares it to your saved knowledge, and surfaces patterns. Save pages with one click. Build up a graph. Export to a real Obsidian vault. All powered by free-tier LLM APIs.

> *"Looking at the last 60 days, you've been on substack.com a lot for LLM stuff (12 posts) and dev.to for React (8 posts). You've saved 3 of those. Want me to summarize the highest-traffic ones?"*

---

## What it does

- **Talks to you.** A chat side panel with a tool-using agent. Ask "what have I been reading?" or "I want to learn ML" — it calls real tools (`scan_history`, `search_knowledge`, `compare_history_to_goal`) against your browser data and answers with citations.
- **Saves what you read.** One click on the `+` button summarizes the current page (or its YouTube transcript) and stashes it in a local IndexedDB knowledge base.
- **Bulk-imports your past.** Pull in the last 30 days of browser history with one click — instant corpus, no LLM calls needed.
- **Renders an Obsidian-style graph.** Force-directed, pan/zoom, drag-to-pin, hover-highlights backlinks. Nodes coloured by domain, edges by shared topics.
- **Exports to Obsidian as a real vault.** Pick a folder; it writes `_Index.md`, `pages/<title>.md`, `topics/MOC - <topic>.md`, and a `README.md`. Frontmatter is Dataview-compatible. `[[wikilinks]]` make Obsidian's graph view light up immediately.
- **Has a mascot.** Memo, who breathes, blinks, wobbles when thinking, and jumps when you save something.

---

## How AG2 is used creatively

This project was built during an **AG2 (AutoGen 2) hackathon**, but it isn't a typical AG2 submission — it doesn't run a Python `Agent` script. Instead, it borrows AG2's **agent-with-tools paradigm** and reimplements it in a place AG2 wasn't designed to run: **inside a Chrome side panel**, talking to your live browser state.

What we use from the AG2 ecosystem:

- **The AG2-issued OpenRouter key.** AG2 provisions a single key that maps to Google's Gemini models (`google/gemini-2.5-flash`, `2.5-pro`, `3-flash-preview`, etc.) routed through OpenRouter. The extension reads this key from a local `.env` and authenticates against `https://openrouter.ai/api/v1/chat/completions`.
- **The agent loop.** AG2's headline pattern is *agent + tools + iterate until done*. We rebuild that pattern in ~80 lines of vanilla JS in `background.js`: send the user message + tool specs to the LLM, parse `tool_calls` from the response, execute them locally, feed results back, repeat (max 5 turns).

What's *creative* about it:

1. **Browser-only runtime.** No server, no Python, no sandbox spin-up. The "agent" lives in a Chrome service worker — about as constrained an environment as exists. Yet the same AG2-style tool-calling pattern works there unchanged. This proves AG2's agent paradigm translates cleanly to edge contexts.
2. **Tools that only make sense in a browser.** Most AG2 demos use generic tools (web search, calculator, code execution). Ours are deliberately **browser-native**:
   - `scan_history(query, days)` — `chrome.history.search` grouped by domain
   - `compare_history_to_goal(goal, keywords)` — cross-references history against the local IndexedDB knowledge base, returns gaps
   - `search_knowledge(query)` — BM25-ish ranking over saved summaries
   - `list_knowledge` / `recent_history` — corpus introspection

   The agent reasons over **what the user has actually read on this device**, not what's on the public web. That's a kind of grounding most LLM agents can't do.
3. **Free-tier first, multi-provider fallback.** AG2's example uses OpenRouter, but our `lib/llm.js` exposes the same interface for Groq, Cerebras, NVIDIA NIM, and Gemini-direct. Same chat function, same tool-calling shape — just swap `PROVIDER=…` in `.env`. AG2's OpenRouter setup becomes one option among several with no code changes.
4. **The data is yours.** Everything (page summaries, notes, topic clusters) stays in your browser's IndexedDB. The Obsidian export gives you a portable, plain-markdown copy you own. The LLM only sees the page text you choose to summarize and the question you ask. No telemetry, no server.

In short: AG2 inspired the architecture, AG2 supplied the model access, and the extension takes the paradigm somewhere AG2 itself doesn't go.

---

## Tech stack

| Layer | What we use |
| --- | --- |
| **Runtime** | Chrome Manifest V3 extension (service worker + side panel + extension page). No build step. ES modules loaded directly. |
| **UI** | Vanilla HTML/CSS/JS. No React, no framework, no bundler. Custom CSS variables for the Claude-style cream/coral theme. |
| **Chat agent** | Hand-written tool-using loop in `background.js`. OpenAI-compatible `chat/completions` calls with `tools` parameter; up to 5 reasoning turns per message. |
| **LLM providers** | OpenAI-compatible endpoints, drop-in swappable: **OpenRouter** (default for AG2 hackathon, model `google/gemini-2.5-flash`), **Gemini direct**, **Groq**, **Cerebras**, **NVIDIA NIM**. |
| **Local storage** | IndexedDB for the knowledge base (pages + notes); `chrome.storage.local` for settings + per-provider API keys. |
| **Browser data access** | `chrome.history` (history scan + bulk import), `chrome.scripting` (content extraction including YouTube captions). |
| **Retrieval** | BM25-ish keyword + recency scoring (`lib/storage.js#search`) — no embeddings, no external vector DB, runs in-browser instantly. |
| **Markdown rendering** | Custom small-subset renderer (`lib/markdown.js`) — links, lists, bold, code, headings. URL-scheme allowlist for XSS safety. |
| **Knowledge graph** | Vanilla SVG with a hand-written force-directed simulation (~250 lines, no D3). Pan/zoom via SVG transforms, drag-to-pin via pointer events, hover-highlights via class swaps. |
| **Obsidian export** | File System Access API (`window.showDirectoryPicker`) writes a real vault: `_Index.md` + `pages/<Title>.md` + `topics/MOC - <topic>.md`. YAML frontmatter is Dataview-compatible. Wikilinks (`[[topic]]`) auto-populate Obsidian's graph view. |
| **Mascot** | Inline SVG with CSS keyframe animations driven by class swaps. Five states (idle/thinking/happy/reading/wave) plus random blink/wink timers in JS. |
| **Configuration** | Local `.env` file (gitignored), parsed by the service worker on each startup. Falls back to `.env.example` if `.env` is absent — handy for hackathon demos. Per-provider API keys stored separately so switching providers in the UI doesn't lose the others. |

---

## Quickstart

### 1. Get an API key

Pick whichever you prefer. All are free or have a meaningful free tier.

| Provider | Key format | Where |
| --- | --- | --- |
| OpenRouter (event keys, e.g. AG2) | `sk-or-…` | https://openrouter.ai/keys |
| Gemini direct | `AIza…` | https://aistudio.google.com/apikey |
| Groq | `gsk_…` | https://console.groq.com/keys |

### 2. Configure

```bash
cp extension/.env.example extension/.env
# edit and uncomment one path:
#   PROVIDER=openrouter
#   OPENROUTER_API_KEY=sk-or-...
#   MODEL=google/gemini-2.5-flash
```

### 3. Load the extension

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** → pick the `extension/` folder.
4. Pin "Memory Agent" from the puzzle-piece menu.

### 4. Try it

1. Click the toolbar icon → side panel opens.
2. Click **"📥 Pull in my last 30 days of browser history"** (highlighted suggestion in the empty state). One second, instant corpus.
3. Click **"What have I been reading lately?"**. Watch Memo wobble while the agent calls tools, then read the response with clickable Sources.
4. Open the **Review** tab → **Graph view ↗** to see the network. Try wheel-zoom, drag a node, hover for backlinks.
5. **Review** tab → **Export to Obsidian** → pick a folder. Open the folder in Obsidian and you have a working vault.

---

## Demo flow (90 seconds)

1. Reload extension → import 30 days history → ask *"I want to improve my tech skills."* The agent calls `compare_history_to_goal`, reports back with hit counts per domain and pages saved vs only browsed.
2. Open **Review** → **Graph view** → show clusters around topics.
3. Open **Review** → **Export to Obsidian** → drop the folder into Obsidian → open Graph view there too. Same data, two visualisations, fully offline.

---

## Project structure

```
memory-agent/
├── README.md                ← this file
├── .gitignore
└── extension/
    ├── manifest.json        ← MV3 manifest, declares permissions
    ├── .env.example         ← copy to .env and fill in keys
    │
    ├── background.js        ← service worker: agent loop, history import, env loader
    ├── sidepanel.html/.css/.js  ← chat-first side panel UI
    ├── graph.html/.css/.js  ← full-page knowledge graph
    │
    └── lib/
        ├── llm.js           ← OpenAI-compatible client, provider table, key validation
        ├── tools.js         ← agent tool specs + executors
        ├── storage.js       ← IndexedDB wrapper for the knowledge base
        ├── export.js        ← Obsidian vault writer + single-file download
        ├── markdown.js      ← safe minimal markdown renderer
        └── mascot.js        ← Memo: SVG character + state setter
```

---

## Customization

- **Add a provider**: append an entry to `PROVIDERS` in `lib/llm.js`. Any OpenAI-compatible endpoint slots in.
- **Add a tool**: extend `TOOL_SPECS` in `lib/tools.js` with the JSON-schema description, add a case to `executeTool`, and the agent will figure out when to call it from the system prompt.
- **Tune the agent**: edit `SYS_AGENT` in `background.js`. Tone, when to call which tool, when to refuse — all here.
- **Theme**: CSS custom properties at the top of `sidepanel.css` and `graph.css`. Cream/coral is just a `:root` swap away from anything else.

---

## Privacy

- **No server.** Every byte of your knowledge base lives in your browser.
- **No telemetry.** The extension never phones home.
- **The only outbound traffic** is to your chosen LLM provider, only when you click summarize or send a chat message — and only the page text you've explicitly pulled in.
- **Your API key** lives in `chrome.storage.local` (and optionally a gitignored `.env`). It's never logged.

---

## Roadmap / nice-to-haves not built yet

- Auto-sync to Obsidian vault after each save (currently manual one-click)
- Backlink highlighting + hover-locked details panel in the graph
- Dark theme toggle
- Spaced-repetition style review prompts on the Review tab
- An Obsidian plugin counterpart that watches for new exports

---

## Credits

- **AG2 (AutoGen 2)** — provided the OpenRouter-routed Gemini access during the hackathon and inspired the agent-with-tools loop pattern.
- **Anthropic Claude** — the cream/coral palette and conversational tone are an homage to the Claude product family. (And much of this was paired with Claude Code.)
- **Obsidian** — for proving that markdown + wikilinks + graph view is enough for a real personal knowledge management system.
