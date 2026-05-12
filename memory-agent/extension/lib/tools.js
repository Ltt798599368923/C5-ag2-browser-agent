import { search, listPages } from "./storage.js";

export const TOOL_SPECS = [
  // ========== 原有工具 ==========
  {
    type: "function",
    function: {
      name: "scan_history",
      description: "Search the user's BROWSER HISTORY (everything they've visited, not just saved pages) for pages matching a topic. Returns matches grouped by domain with visit counts. Use this when the user expresses a learning goal or asks about their reading habits — to ground your response in their actual browsing.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Topic or keywords. For breadth use OR-separated terms (e.g. 'llm OR machine learning OR ai'). Single specific term also fine."
          },
          days: {
            type: "integer",
            description: "How many days back to look. Default 60, max 365."
          }
        },
        required: ["query"]
      }
    }
  },
  // ========== 新增：网页搜索工具 ==========
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for current information when local knowledge base is insufficient. Returns top search results with titles, URLs, and brief summaries. Use this when: 1) the user's question requires up-to-date information not in their browsing history, 2) they ask about topics not covered in their saved pages, 3) they want to verify or supplement what they saved with latest news/research.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query - be specific and concise for best results."
          },
          num_results: {
            type: "integer",
            description: "Number of results to return (default 5, max 10)."
          }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "recent_history",
      description: "Get the user's most recently visited pages, regardless of topic. Use when the user asks 'what have I been reading lately' or similar.",
      parameters: {
        type: "object",
        properties: {
          days: { type: "integer", description: "Days back. Default 7." },
          limit: { type: "integer", description: "Max items. Default 30, max 100." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_knowledge",
      description: "Search the user's KNOWLEDGE BASE — pages they previously summarized and saved (not raw history). Returns full summaries and any notes they wrote.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keywords to search for." }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_knowledge",
      description: "List the user's saved knowledge base entries (most recent first). Use when they ask to see everything they've saved.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "Default 20, max 50." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "compare_history_to_goal",
      description: "Given a user goal (e.g. 'improve tech skills', 'learn ML'), scan history AND knowledge base, then return a structured comparison: which domains/topics they've engaged with most, what they've saved vs only browsed, and gaps. Use this when the user expresses a learning goal and you want a fuller picture than scan_history alone.",
      parameters: {
        type: "object",
        properties: {
          goal: {
            type: "string",
            description: "The user's goal in their own words."
          },
          keywords: {
            type: "array",
            items: { type: "string" },
            description: "5-10 broad keywords/synonyms covering the goal, e.g. for 'tech skills': ['programming','llm','ai','system design','react','python']. Be generous — better to over-match than miss."
          },
          days: {
            type: "integer",
            description: "Days of history to consider. Default 90."
          }
        },
        required: ["goal", "keywords"]
      }
    }
  }
];

function tld(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

// ========== 新增：获取 Tavily API Key ==========
async function getTavilyKey() {
  const result = await chrome.storage.local.get(["tavilyApiKey"]);
  return result.tavilyApiKey || null;
}

export async function executeTool(name, args = {}) {
  switch (name) {
    // ========== 新增：网页搜索工具实现 ==========
    case "web_search": {
      const tavilyKey = await getTavilyKey();
      if (!tavilyKey) {
        throw new Error("Web search not configured. Please set TAVILY_API_KEY in Settings.");
      }
      const numResults = Math.min(Math.max(args.num_results || 5, 1), 10);
      const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          api_key: tavilyKey,
          query: args.query,
          search_depth: "basic",
          max_results: numResults,
          include_answer: true,
          include_raw_content: false
        })
      });
      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Tavily search failed: ${response.status} - ${err}`);
      }
      const data = await response.json();
      return {
        query: data.query,
        answer: data.answer || null,
        results: (data.results || []).map(r => ({
          title: r.title,
          url: r.url,
          snippet: r.content || "",
          score: r.score
        })),
        totalResults: data.results?.length || 0
      };
    }

    case "scan_history": {
      const days = Math.min(Math.max(args.days || 60, 1), 365);
      const startTime = Date.now() - days * 86400000;
      const queries = String(args.query || "")
        .split(/\s+OR\s+/i)
        .map(s => s.trim())
        .filter(Boolean);
      const queryList = queries.length ? queries : [""];

      const seen = new Set();
      const results = [];
      for (const q of queryList) {
        const items = await chrome.history.search({
          text: q,
          startTime,
          maxResults: 200
        });
        for (const it of items) {
          if (seen.has(it.url)) continue;
          seen.add(it.url);
          results.push(it);
        }
      }

      const byDomain = new Map();
      for (const it of results) {
        const d = tld(it.url);
        if (!d) continue;
        if (!byDomain.has(d)) byDomain.set(d, []);
        byDomain.get(d).push({
          url: it.url,
          title: it.title || "",
          visits: it.visitCount || 1,
          lastVisit: it.lastVisitTime
        });
      }

      const groups = [...byDomain.entries()]
        .map(([domain, pages]) => ({
          domain,
          pageCount: pages.length,
          totalVisits: pages.reduce((a, b) => a + (b.visits || 1), 0),
          examples: pages
            .sort((a, b) => (b.lastVisit || 0) - (a.lastVisit || 0))
            .slice(0, 5)
            .map(p => ({ title: p.title, url: p.url, visits: p.visits }))
        }))
        .sort((a, b) => b.pageCount - a.pageCount)
        .slice(0, 12);

      return {
        windowDays: days,
        totalMatches: results.length,
        domains: groups
      };
    }

    case "recent_history": {
      const days = Math.min(Math.max(args.days || 7, 1), 90);
      const limit = Math.min(Math.max(args.limit || 30, 1), 100);
      const items = await chrome.history.search({
        text: "",
        startTime: Date.now() - days * 86400000,
        maxResults: limit
      });
      return items.map(it => ({
        title: it.title || "",
        url: it.url,
        domain: tld(it.url),
        visits: it.visitCount || 1,
        lastVisit: new Date(it.lastVisitTime).toISOString().slice(0, 10)
      }));
    }

    case "search_knowledge": {
      const matches = await search(args.query || "", { limit: 10 });
      return matches.map(m => ({
        title: m.title,
        url: m.url,
        domain: m.domain,
        savedAt: new Date(m.ts).toISOString().slice(0, 10),
        topics: m.topics || [],
        summary: (m.summary || "").slice(0, 700),
        note: m.note || null
      }));
    }

    case "list_knowledge": {
      const limit = Math.min(Math.max(args.limit || 20, 1), 50);
      const all = await listPages({ limit });
      return all.map(m => ({
        title: m.title,
        url: m.url,
        domain: m.domain,
        savedAt: new Date(m.ts).toISOString().slice(0, 10),
        topics: m.topics || [],
        hasNote: !!m.note
      }));
    }

    case "compare_history_to_goal": {
      const days = Math.min(Math.max(args.days || 90, 7), 365);
      const startTime = Date.now() - days * 86400000;
      const keywords = (args.keywords || []).map(s => String(s).toLowerCase()).filter(Boolean);

      const seen = new Set();
      const historyHits = [];
      for (const kw of keywords.length ? keywords : [""]) {
        const items = await chrome.history.search({ text: kw, startTime, maxResults: 200 });
        for (const it of items) {
          if (seen.has(it.url)) continue;
          seen.add(it.url);
          historyHits.push(it);
        }
      }

      const byDomain = new Map();
      for (const it of historyHits) {
        const d = tld(it.url);
        if (!d) continue;
        if (!byDomain.has(d)) byDomain.set(d, { domain: d, pages: 0, visits: 0, examples: [] });
        const e = byDomain.get(d);
        e.pages++;
        e.visits += it.visitCount || 1;
        if (e.examples.length < 4) e.examples.push({ title: it.title || "", url: it.url, visits: it.visitCount || 1 });
      }
      const domains = [...byDomain.values()]
        .sort((a, b) => b.pages - a.pages)
        .slice(0, 12);

      const all = await listPages({ limit: 5000 });
      const matchKw = (p) => {
        const hay = `${p.title || ""} ${p.summary || ""} ${(p.topics || []).join(" ")} ${p.domain || ""}`.toLowerCase();
        return keywords.some(k => hay.includes(k));
      };
      const savedMatching = all.filter(matchKw).slice(0, 20).map(p => ({
        title: p.title,
        url: p.url,
        domain: p.domain,
        savedAt: new Date(p.ts).toISOString().slice(0, 10),
        topics: p.topics || [],
        hasNote: !!p.note
      }));

      const browsedNotSaved = historyHits
        .filter(it => !all.some(p => p.url === it.url))
        .slice(0, 12)
        .map(it => ({ title: it.title || "", url: it.url, domain: tld(it.url), visits: it.visitCount || 1 }));

      return {
        goal: args.goal,
        windowDays: days,
        totalHistoryHits: historyHits.length,
        topDomains: domains,
        savedOnTopic: savedMatching,
        savedCount: savedMatching.length,
        browsedNotSaved,
        browsedNotSavedCount: browsedNotSaved.length
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
