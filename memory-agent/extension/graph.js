import { exportToVault, downloadAsSingleFile } from "./lib/export.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function send(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      if (!resp?.ok) return reject(new Error(resp?.error || "background error"));
      resolve(resp);
    });
  });
}

const PALETTE = [
  "#c96442", "#5e8b54", "#3a6ea5", "#a96bb0", "#d99a2b",
  "#3f8b8b", "#b94f6c", "#6c7a89", "#8b6f47", "#5f6caf",
  "#7a8e3c", "#c25e9a", "#4a7d7a", "#a64f3a", "#6b5b95"
];

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function colorFor(domain) {
  if (!domain) return PALETTE[0];
  return PALETTE[hashStr(domain) % PALETTE.length];
}

function buildGraph(pages, mode) {
  const nodes = pages.map((p) => ({
    id: p.url,
    title: p.title || p.url,
    url: p.url,
    domain: p.domain || "",
    topics: p.topics || [],
    summary: p.summary || "",
    note: p.note || "",
    ts: p.ts,
    color: colorFor(p.domain || "")
  }));

  const links = [];
  if (mode === "topic") {
    const topicIndex = new Map();
    for (const n of nodes) {
      for (const t of n.topics) {
        if (!topicIndex.has(t)) topicIndex.set(t, []);
        topicIndex.get(t).push(n);
      }
    }
    const seen = new Set();
    for (const group of topicIndex.values()) {
      if (group.length < 2 || group.length > 18) continue;
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i], b = group[j];
          const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          links.push({ source: a.id, target: b.id });
        }
      }
    }
  } else if (mode === "domain") {
    const byDomain = new Map();
    for (const n of nodes) {
      if (!byDomain.has(n.domain)) byDomain.set(n.domain, []);
      byDomain.get(n.domain).push(n);
    }
    for (const group of byDomain.values()) {
      if (group.length < 2) continue;
      for (let i = 0; i < group.length - 1; i++) {
        links.push({ source: group[i].id, target: group[i + 1].id });
      }
    }
  }
  return { nodes, links };
}

class ForceGraph {
  constructor(svg) {
    this.svg = svg;
    this.zoomGroup = document.createElementNS(SVG_NS, "g");
    this.zoomGroup.classList.add("zoom-group");
    this.linkLayer = document.createElementNS(SVG_NS, "g");
    this.nodeLayer = document.createElementNS(SVG_NS, "g");
    this.zoomGroup.append(this.linkLayer, this.nodeLayer);
    svg.appendChild(this.zoomGroup);

    this.nodes = [];
    this.links = [];
    this.alpha = 0.05;
    this.frame = null;
    this.selected = null;
    this.tooltip = document.createElement("div");
    this.tooltip.className = "tooltip";
    document.body.appendChild(this.tooltip);
    this.onSelect = null;
    this.adj = new Map();

    this.scale = 1;
    this.tx = 0;
    this.ty = 0;

    this.draggedNode = null;
    this.isPanning = false;
    this.panStart = null;

    this.resize();
    window.addEventListener("resize", () => this.resize());

    this.setupInteraction();
  }

  resize() {
    const r = this.svg.getBoundingClientRect();
    this.width = r.width;
    this.height = r.height;
  }

  applyTransform() {
    this.zoomGroup.setAttribute("transform", `translate(${this.tx},${this.ty}) scale(${this.scale})`);
    this.zoomGroup.classList.toggle("zoomed-in", this.scale > 1.4);
  }

  screenToGraph(clientX, clientY) {
    const rect = this.svg.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    return {
      x: (sx - this.tx) / this.scale,
      y: (sy - this.ty) / this.scale
    };
  }

  setupInteraction() {
    this.svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      const delta = -e.deltaY * 0.0015;
      const newScale = Math.max(0.25, Math.min(4, this.scale * Math.exp(delta)));
      const rect = this.svg.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const gx = (sx - this.tx) / this.scale;
      const gy = (sy - this.ty) / this.scale;
      this.scale = newScale;
      this.tx = sx - gx * this.scale;
      this.ty = sy - gy * this.scale;
      this.applyTransform();
    }, { passive: false });

    this.svg.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest(".node")) return;
      this.isPanning = true;
      this.panStart = { x: e.clientX - this.tx, y: e.clientY - this.ty };
      this.svg.setPointerCapture(e.pointerId);
      this.svg.style.cursor = "grabbing";
    });
    this.svg.addEventListener("pointermove", (e) => {
      if (!this.isPanning) return;
      this.tx = e.clientX - this.panStart.x;
      this.ty = e.clientY - this.panStart.y;
      this.applyTransform();
    });
    this.svg.addEventListener("pointerup", (e) => {
      if (this.isPanning) {
        this.isPanning = false;
        try { this.svg.releasePointerCapture(e.pointerId); } catch {}
        this.svg.style.cursor = "";
      }
    });
  }

  reheat(alpha = 0.6) {
    this.alpha = alpha;
    if (!this.frame) this.frame = requestAnimationFrame(() => this.tick());
  }

  setData({ nodes, links }) {
    this.linkLayer.innerHTML = "";
    this.nodeLayer.innerHTML = "";
    this.nodes = nodes.map((n, i) => {
      const a = (i / Math.max(nodes.length, 1)) * Math.PI * 2;
      const r = 120 + Math.random() * 60;
      return {
        ...n,
        x: this.width / 2 + Math.cos(a) * r,
        y: this.height / 2 + Math.sin(a) * r,
        vx: 0, vy: 0,
        fx: null, fy: null
      };
    });
    const idMap = new Map(this.nodes.map(n => [n.id, n]));
    this.links = links
      .map(l => ({ source: idMap.get(l.source), target: idMap.get(l.target) }))
      .filter(l => l.source && l.target);

    this.adj = new Map(this.nodes.map(n => [n.id, new Set()]));
    for (const l of this.links) {
      this.adj.get(l.source.id).add(l.target.id);
      this.adj.get(l.target.id).add(l.source.id);
    }

    for (const l of this.links) {
      const line = document.createElementNS(SVG_NS, "line");
      line.classList.add("link");
      this.linkLayer.appendChild(line);
      l.el = line;
    }

    for (const n of this.nodes) {
      const g = document.createElementNS(SVG_NS, "g");
      g.classList.add("node");
      const c = document.createElementNS(SVG_NS, "circle");
      const radius = Math.max(5, Math.min(13, 5 + Math.min(n.topics.length, 8) * 0.8));
      c.setAttribute("r", radius);
      c.setAttribute("fill", n.color);
      const t = document.createElementNS(SVG_NS, "text");
      t.setAttribute("y", radius + 4);
      const label = (n.title || "").slice(0, 28) + ((n.title || "").length > 28 ? "…" : "");
      t.textContent = label;
      g.append(c, t);
      this.nodeLayer.appendChild(g);
      n.el = g;
      n.radius = radius;

      g.addEventListener("pointerenter", (e) => {
        if (this.draggedNode) return;
        this.showTooltip(n, e);
        this.highlightNeighbors(n);
      });
      g.addEventListener("pointermove", (e) => this.moveTooltip(e));
      g.addEventListener("pointerleave", () => {
        this.hideTooltip();
        if (!this.draggedNode) this.clearHighlight();
      });
      g.addEventListener("click", (e) => {
        if (this._dragMoved) return;
        this.select(n);
      });
      g.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        n.fx = null;
        n.fy = null;
        g.classList.remove("pinned");
        this.reheat(0.4);
      });
      g.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        this.draggedNode = n;
        this._dragMoved = false;
        this._dragPointerId = e.pointerId;
        try { g.setPointerCapture(e.pointerId); } catch {}
        const p = this.screenToGraph(e.clientX, e.clientY);
        this._dragOffset = { dx: n.x - p.x, dy: n.y - p.y };
        this.reheat(0.3);
      });
      g.addEventListener("pointermove", (e) => {
        if (this.draggedNode !== n) return;
        const p = this.screenToGraph(e.clientX, e.clientY);
        n.fx = p.x + this._dragOffset.dx;
        n.fy = p.y + this._dragOffset.dy;
        n.x = n.fx; n.y = n.fy;
        this._dragMoved = true;
      });
      g.addEventListener("pointerup", (e) => {
        if (this.draggedNode !== n) return;
        try { g.releasePointerCapture(e.pointerId); } catch {}
        this.draggedNode = null;
        if (this._dragMoved) {
          g.classList.add("pinned");
        }
        this.clearHighlight();
        setTimeout(() => { this._dragMoved = false; }, 0);
      });
    }

    this.reheat(1);
  }

  highlightNeighbors(node) {
    const neighbors = this.adj.get(node.id) || new Set();
    for (const m of this.nodes) {
      const isNeighbor = m === node || neighbors.has(m.id);
      m.el.classList.toggle("dim", !isNeighbor);
      m.el.classList.toggle("neighbor", m !== node && isNeighbor);
    }
    for (const l of this.links) {
      const incident = (l.source === node || l.target === node);
      l.el.classList.toggle("dim", !incident);
      l.el.classList.toggle("highlight", incident);
    }
    node.el.classList.add("hovered");
  }

  clearHighlight() {
    for (const m of this.nodes) {
      m.el.classList.remove("dim", "neighbor", "hovered");
    }
    for (const l of this.links) {
      l.el.classList.remove("dim", "highlight");
    }
  }

  showTooltip(n, e) {
    this.tooltip.innerHTML = `<div class="t-title"></div><div class="t-meta"></div>`;
    this.tooltip.querySelector(".t-title").textContent = n.title;
    this.tooltip.querySelector(".t-meta").textContent =
      `${n.domain}${n.topics.length ? " · " + n.topics.slice(0, 3).join(", ") : ""}`;
    this.tooltip.classList.add("visible");
    this.moveTooltip(e);
  }
  moveTooltip(e) {
    this.tooltip.style.left = `${e.clientX + 12}px`;
    this.tooltip.style.top = `${e.clientY + 12}px`;
  }
  hideTooltip() {
    this.tooltip.classList.remove("visible");
  }

  select(n) {
    this.selected = n;
    for (const node of this.nodes) node.el.classList.toggle("selected", node === n);
    if (this.onSelect) this.onSelect(n);
  }

  highlight(filter) {
    if (!filter) {
      for (const n of this.nodes) n.el.classList.remove("faded");
      for (const l of this.links) l.el.classList.remove("faded");
      return;
    }
    const f = filter.toLowerCase();
    const matches = new Set();
    for (const n of this.nodes) {
      const hit = (n.title || "").toLowerCase().includes(f) ||
                  (n.domain || "").toLowerCase().includes(f) ||
                  n.topics.some(t => t.toLowerCase().includes(f));
      n.el.classList.toggle("faded", !hit);
      if (hit) matches.add(n.id);
    }
    for (const l of this.links) {
      l.el.classList.toggle("faded", !(matches.has(l.source.id) && matches.has(l.target.id)));
    }
  }

  tick() {
    const { nodes, links, width, height } = this;
    const alpha = Math.max(this.alpha, 0.05);
    const cx = width / 2, cy = height / 2;

    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy + 0.01;
        if (d2 > 90000) continue;
        const d = Math.sqrt(d2);
        const f = 800 / d2;
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
    }

    const linkDist = 70;
    for (const l of links) {
      const dx = l.target.x - l.source.x;
      const dy = l.target.y - l.source.y;
      const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const f = (d - linkDist) * 0.04;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      l.source.vx += fx; l.source.vy += fy;
      l.target.vx -= fx; l.target.vy -= fy;
    }

    for (const n of nodes) {
      if (n.fx != null) {
        n.x = n.fx; n.vx = 0;
      } else {
        n.vx += (cx - n.x) * 0.005;
        n.vx *= 0.86;
        n.x += n.vx * alpha;
      }
      if (n.fy != null) {
        n.y = n.fy; n.vy = 0;
      } else {
        n.vy += (cy - n.y) * 0.005;
        n.vy *= 0.86;
        n.y += n.vy * alpha;
      }
      n.x = Math.max(20, Math.min(width - 20, n.x));
      n.y = Math.max(20, Math.min(height - 20, n.y));
      n.el.setAttribute("transform", `translate(${n.x},${n.y})`);
    }

    for (const l of links) {
      l.el.setAttribute("x1", l.source.x);
      l.el.setAttribute("y1", l.source.y);
      l.el.setAttribute("x2", l.target.x);
      l.el.setAttribute("y2", l.target.y);
    }

    this.alpha *= 0.99;
    const needsRun = this.alpha > 0.06 || this.draggedNode || this.isPanning;
    if (needsRun) {
      this.frame = requestAnimationFrame(() => this.tick());
    } else {
      this.frame = null;
    }
  }

  fitToScreen() {
    if (!this.nodes.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.nodes) {
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y);
    }
    const padding = 60;
    const w = (maxX - minX) + padding * 2;
    const h = (maxY - minY) + padding * 2;
    const sx = this.width / w;
    const sy = this.height / h;
    this.scale = Math.max(0.25, Math.min(2, Math.min(sx, sy)));
    this.tx = -minX * this.scale + (this.width - (maxX - minX) * this.scale) / 2;
    this.ty = -minY * this.scale + (this.height - (maxY - minY) * this.scale) / 2;
    this.applyTransform();
  }
}

const $ = (id) => document.getElementById(id);
const svg = $("graph");
const fg = new ForceGraph(svg);

let pagesCache = [];
let mode = "topic";

fg.onSelect = (n) => {
  $("d-title").textContent = n.title;
  $("d-meta").textContent = `${n.domain} · saved ${new Date(n.ts).toLocaleDateString()}`;
  const tWrap = $("d-topics");
  tWrap.innerHTML = "";
  for (const t of n.topics) {
    const c = document.createElement("span");
    c.className = "chip";
    c.textContent = t;
    tWrap.appendChild(c);
  }
  $("d-summary").textContent = n.summary;
  if (n.note) {
    $("d-note-block").classList.remove("hidden");
    $("d-note").textContent = n.note;
  } else {
    $("d-note-block").classList.add("hidden");
  }
  $("d-link").href = n.url;
  $("details").classList.remove("hidden");
};

$("close-details").addEventListener("click", () => $("details").classList.add("hidden"));

function renderLegend() {
  const counts = new Map();
  for (const p of pagesCache) {
    const d = p.domain || "(unknown)";
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const el = $("legend");
  el.innerHTML = "";
  if (!top.length) { el.style.display = "none"; return; }
  el.style.display = "";
  for (const [domain, n] of top) {
    const row = document.createElement("div");
    row.className = "legend-row";
    const sw = document.createElement("span");
    sw.className = "legend-swatch";
    sw.style.background = colorFor(domain);
    const label = document.createElement("span");
    label.textContent = `${domain} (${n})`;
    row.append(sw, label);
    el.appendChild(row);
  }
}

function showStatus(text, ms = 2400) {
  const s = $("status");
  s.textContent = text;
  s.classList.remove("hidden");
  setTimeout(() => s.classList.add("hidden"), ms);
}

async function load() {
  const { pages } = await send({ type: "list", limit: 5000 });
  pagesCache = pages;
  $("counts").textContent = `${pages.length} page${pages.length === 1 ? "" : "s"}`;
  if (!pages.length) {
    $("empty").classList.remove("hidden");
    return;
  }
  $("empty").classList.add("hidden");
  const data = buildGraph(pages, mode);
  fg.setData(data);
  renderLegend();
}

$("filter").addEventListener("input", (e) => fg.highlight(e.target.value.trim()));
$("link-mode").addEventListener("change", (e) => {
  mode = e.target.value;
  if (pagesCache.length) fg.setData(buildGraph(pagesCache, mode));
});
$("fit-screen").addEventListener("click", () => fg.fitToScreen());
$("reset-view").addEventListener("click", () => {
  fg.scale = 1; fg.tx = 0; fg.ty = 0; fg.applyTransform();
  for (const n of fg.nodes) { n.fx = null; n.fy = null; n.el.classList.remove("pinned"); }
  fg.reheat(1);
});

$("export-vault").addEventListener("click", async () => {
  if (!pagesCache.length) return showStatus("Nothing to export.");
  try {
    const { written, vaultName } = await exportToVault(pagesCache, {
      onProgress: (n, total) => showStatus(`Writing ${n}/${total}…`, 600)
    });
    showStatus(`Exported ${written} pages to "${vaultName}".`, 4000);
  } catch (e) {
    if (e.name !== "AbortError") showStatus(`Export failed: ${e.message}`, 4000);
  }
});

$("export-file").addEventListener("click", () => {
  if (!pagesCache.length) return showStatus("Nothing to export.");
  downloadAsSingleFile(pagesCache);
  showStatus("Downloading single .md file…");
});

load().catch(e => showStatus(`Load failed: ${e.message}`, 4000));
