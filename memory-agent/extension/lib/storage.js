const DB_NAME = "memory-agent";
const DB_VERSION = 1;
const STORE = "pages";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: "url" });
        s.createIndex("ts", "ts");
        s.createIndex("domain", "domain");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function savePage(entry) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getPage(url) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(url);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function listPages({ limit = 200 } = {}) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const idx = tx.objectStore(STORE).index("ts");
    const req = idx.openCursor(null, "prev");
    const out = [];
    req.onsuccess = () => {
      const c = req.result;
      if (c && out.length < limit) {
        out.push(c.value);
        c.continue();
      } else {
        resolve(out);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deletePage(url) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(url);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function updateNote(url, note) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const req = store.get(url);
    req.onsuccess = () => {
      if (!req.result) return reject(new Error("Page not in memory"));
      store.put({ ...req.result, note: note || "", noteTs: Date.now() });
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getStats() {
  const all = await listPages({ limit: 10000 });
  const dayMs = 86400000;
  const weekAgo = Date.now() - 7 * dayMs;

  const byDomain = new Map();
  const byTopic = new Map();
  const byDay = new Map();
  let weekTotal = 0;

  for (const p of all) {
    if (p.ts >= weekAgo) weekTotal++;
    if (p.domain) byDomain.set(p.domain, (byDomain.get(p.domain) || 0) + 1);
    for (const t of (p.topics || [])) byTopic.set(t, (byTopic.get(t) || 0) + 1);
    const day = new Date(p.ts).toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) || 0) + 1);
  }

  let streak = 0;
  let cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  const todayKey = cursor.toISOString().slice(0, 10);
  if (!byDay.has(todayKey)) cursor.setDate(cursor.getDate() - 1);
  while (true) {
    const k = cursor.toISOString().slice(0, 10);
    if (byDay.has(k)) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    } else break;
  }

  return {
    total: all.length,
    weekTotal,
    streak,
    topDomains: [...byDomain.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
    topTopics: [...byTopic.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16),
    recent: all.slice(0, 30),
    byDay: [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  };
}

const STOP = new Set([
  "the","a","an","and","or","but","if","then","of","to","in","on","for","with","by",
  "is","are","was","were","be","been","being","this","that","these","those","it","its",
  "i","you","we","they","he","she","them","us","my","your","our","their","as","at","from",
  "what","which","who","whom","when","where","why","how","do","does","did","done","not",
  "no","yes","can","could","should","would","may","might","will","just","about","into","over"
]);

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(t => t.length > 2 && !STOP.has(t));
}

export async function search(query, { limit = 8 } = {}) {
  const all = await listPages({ limit: 5000 });
  if (!all.length) return [];

  const qTerms = tokenize(query);
  if (!qTerms.length) {
    return all.slice(0, limit);
  }

  const N = all.length;
  const df = new Map();
  const docTerms = all.map(p => {
    const terms = tokenize(`${p.title} ${p.summary} ${(p.topics || []).join(" ")}`);
    const seen = new Set(terms);
    for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
    return terms;
  });

  const idf = (t) => Math.log(1 + N / (1 + (df.get(t) || 0)));

  const scored = all.map((p, i) => {
    const terms = docTerms[i];
    if (!terms.length) return { ...p, score: 0 };
    const tf = new Map();
    for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);

    let score = 0;
    for (const q of qTerms) {
      const f = tf.get(q) || 0;
      if (f) score += (1 + Math.log(f)) * idf(q);
      const titleHit = (p.title || "").toLowerCase().includes(q);
      const topicHit = (p.topics || []).some(tp => tp.includes(q));
      if (titleHit) score += 2;
      if (topicHit) score += 1.5;
    }
    const ageDays = (Date.now() - p.ts) / 86400000;
    score += Math.max(0, 1 - ageDays / 60);
    return { ...p, score };
  });

  return scored
    .filter(p => p.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
