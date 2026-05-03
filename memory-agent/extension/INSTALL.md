# Memory Agent — install & use

A Chrome/Edge extension that summarizes pages you read and lets you ask questions across your browsing memory, using free-tier LLM APIs.

## Install (unpacked)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** → pick the `extension/` folder in this repo.
4. Pin "Memory Agent" from the puzzle-piece menu so the side panel button is always visible.

## Get a free API key

Pick one — they all work:

| Provider     | Free? | Get a key                         |
| ------------ | ----- | --------------------------------- |
| Groq         | Yes   | https://console.groq.com/keys     |
| NVIDIA NIM   | Free credits | https://build.nvidia.com/  |
| OpenRouter   | `:free` models | https://openrouter.ai/keys |
| Cerebras     | Free tier | https://cloud.cerebras.ai/    |

## Configure

1. Click the toolbar icon → side panel opens.
2. Open the **Settings** tab.
3. Pick a provider, paste your key, hit **Save**.
4. (Optional) Toggle **Auto-summarize** to capture pages you actually read (default: 30 s dwell, max 30/hour).

## Use

- **Summarize current page** — manually summarize whatever tab you're on (works on YouTube too — pulls captions automatically).
- **Ask** — ask a question; the agent retrieves the most relevant entries from your local memory and answers with `[1]`-style citations.
- **Library** — browse, filter, or delete stored summaries.

## Data

- Summaries live in IndexedDB inside the extension, on your machine only.
- Your API key lives in `chrome.storage.local`.
- Nothing leaves your browser except the page text you summarize, sent to the LLM provider you chose.

## Customize

- Prompts: `background.js` → `SYS_SUMMARY` / `SYS_AGENT`.
- Providers/models: `lib/llm.js` → `PROVIDERS`.
- Retrieval (BM25-ish keyword scoring): `lib/storage.js` → `search()`.
- Auto-capture rules: `background.js` → `chrome.tabs.onUpdated` listener.
