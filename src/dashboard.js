#!/usr/bin/env node
import http from "node:http";
import { timingSafeEqual as cryptoTimingSafeEqual } from "node:crypto";
import { LibrarianStore } from "./store.js";
import { DEFAULT_AGENT_ID } from "./constants.js";
import { handleMcpPayload } from "./mcp.js";

const store = new LibrarianStore();
const host = process.env.LIBRARIAN_HOST || process.env.LIBRARIAN_DASHBOARD_HOST || "127.0.0.1";
const port = Number(process.env.LIBRARIAN_PORT || process.env.LIBRARIAN_DASHBOARD_PORT || 3838);
const adminToken = process.env.LIBRARIAN_ADMIN_TOKEN || process.env.LIBRARIAN_AUTH_TOKEN || "";
const agentToken = process.env.LIBRARIAN_AGENT_TOKEN || "";
const agentTokenMap = parseAgentTokenMap(process.env.LIBRARIAN_AGENT_TOKENS || "");
const allowedOrigins = parseCsv(process.env.LIBRARIAN_ALLOWED_ORIGINS || "");
const allowNoAuth = process.env.LIBRARIAN_ALLOW_NO_AUTH === "true" || host === "127.0.0.1" || host === "localhost";
const maxBodyBytes = Number(process.env.LIBRARIAN_MAX_BODY_BYTES || 1024 * 1024);

if (!adminToken && !allowNoAuth) {
  console.error("Refusing to start without LIBRARIAN_ADMIN_TOKEN or LIBRARIAN_AUTH_TOKEN when bound beyond localhost.");
  process.exit(1);
}

if (adminToken && agentToken && adminToken === agentToken) {
  console.error("Refusing to start because LIBRARIAN_ADMIN_TOKEN and LIBRARIAN_AGENT_TOKEN must be different.");
  process.exit(1);
}

if (adminToken && [...agentTokenMap.values()].some((token) => token === adminToken)) {
  console.error("Refusing to start because LIBRARIAN_ADMIN_TOKEN must not match any LIBRARIAN_AGENT_TOKENS entry.");
  process.exit(1);
}

if (!adminToken) {
  console.error("Warning: starting without authentication. Use only on localhost or a private development machine.");
}

if (adminToken && !agentToken && !agentTokenMap.size) {
  console.error("Warning: no agent token is set. Remote agents should use LIBRARIAN_AGENT_TOKEN or per-agent LIBRARIAN_AGENT_TOKENS.");
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/healthz") {
      return sendJson(res, {
        status: "ok",
        auth: adminToken ? "enabled" : "disabled",
        agent_auth: agentToken || agentTokenMap.size ? "enabled" : "disabled"
      });
    }

    const auth = authenticate(req);
    if (!auth) return sendUnauthorized(res);
    if (!isAllowedOrigin(req)) return sendJson(res, { error: "Origin not allowed" }, 403);

    if (req.method === "POST" && url.pathname === "/mcp") {
      const payload = await readJson(req);
      const response = await handleMcpPayload(store, payload, { role: auth.role, agentId: auth.agentId });
      if (response === null) return sendEmpty(res);
      return sendJson(res, response);
    }

    if (req.method === "GET" && url.pathname === "/mcp") {
      return sendJson(res, {
        status: "ok",
        transport: "json-rpc-http",
        message: "POST JSON-RPC MCP messages to this endpoint."
      });
    }

    if (auth.role !== "admin") return sendJson(res, { error: "Admin authorization required" }, 403);

    if (req.method === "GET" && url.pathname === "/") {
      return sendHtml(res, pageHtml());
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      return sendJson(res, {
        memories: store.listMemories({}),
        events: store.readEvents().slice(-200).reverse()
      });
    }

    if (req.method === "POST" && url.pathname === "/api/memories") {
      const body = await readJson(req);
      const result = store.createMemory(body);
      return sendJson(res, result);
    }

    const updateMatch = url.pathname.match(/^\/api\/memories\/([^/]+)\/update$/);
    if (req.method === "POST" && updateMatch) {
      const body = await readJson(req);
      return sendJson(res, store.updateMemory(updateMatch[1], body.patch || body, body.agent_id || "dashboard"));
    }

    const deleteMatch = url.pathname.match(/^\/api\/memories\/([^/]+)\/delete$/);
    if (req.method === "POST" && deleteMatch) {
      const body = await readJson(req);
      return sendJson(res, store.deleteMemory(deleteMatch[1], body.agent_id || "dashboard"));
    }

    const approveMatch = url.pathname.match(/^\/api\/proposals\/([^/]+)\/approve$/);
    if (req.method === "POST" && approveMatch) {
      const body = await readJson(req);
      return sendJson(res, store.approveProposal(approveMatch[1], "approve", body.patch || {}, body.agent_id || "dashboard"));
    }

    const rejectMatch = url.pathname.match(/^\/api\/proposals\/([^/]+)\/reject$/);
    if (req.method === "POST" && rejectMatch) {
      const body = await readJson(req);
      return sendJson(res, store.approveProposal(rejectMatch[1], "reject", {}, body.agent_id || "dashboard"));
    }

    if (req.method === "POST" && url.pathname === "/api/recall") {
      const body = await readJson(req);
      const memories = store.searchMemories({
        agent_id: body.agent_id || DEFAULT_AGENT_ID,
        query: body.query || "",
        categories: body.categories || [],
        project_key: body.project_key || "",
        include_private: body.include_private !== false,
        limit: Number(body.limit || 12)
      });
      store.recordRecall(memories, body.agent_id || DEFAULT_AGENT_ID, body.query || "");
      return sendJson(res, { memories });
    }

    sendJson(res, { error: "Not found" }, 404);
  } catch (error) {
    sendJson(res, { error: error.message }, error.statusCode || 500);
  }
});

server.listen(port, host, () => {
  console.error(`The Librarian HTTP service is running at http://${host}:${port}`);
  console.error(`Dashboard: http://${host}:${port}/`);
  console.error(`MCP endpoint: http://${host}:${port}/mcp`);
});

process.on("SIGINT", () => {
  store.close();
  server.close(() => process.exit(0));
});

process.on("SIGTERM", () => {
  store.close();
  server.close(() => process.exit(0));
});

function sendJson(res, payload, status = 200) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, html) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(html);
}

function sendEmpty(res) {
  res.writeHead(202, {
    "cache-control": "no-store"
  });
  res.end();
}

function sendUnauthorized(res) {
  res.writeHead(401, {
    "content-type": "application/json; charset=utf-8",
    "www-authenticate": "Basic realm=\"The Librarian\", Bearer",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

async function readJson(req) {
  let body = "";
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw httpError("Request body too large", 413);
    body += chunk;
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch (error) {
    throw httpError(`Invalid JSON body: ${error.message}`, 400);
  }
}

function authenticate(req) {
  if (!adminToken) return { role: "admin" };
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length);
    for (const [agentId, mappedToken] of agentTokenMap) {
      if (timingSafeEqual(token, mappedToken)) return { role: "agent", agentId };
    }
    if (agentToken && timingSafeEqual(token, agentToken)) return { role: "agent" };
    if (timingSafeEqual(token, adminToken)) return { role: "admin" };
    return null;
  }
  if (header.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      const password = separator >= 0 ? decoded.slice(separator + 1) : decoded;
      return timingSafeEqual(password, adminToken) ? { role: "admin" } : null;
    } catch {
      return null;
    }
  }
  return null;
}

function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (allowedOrigins.length) return allowedOrigins.includes(origin);
  try {
    const originUrl = new URL(origin);
    const hostHeader = req.headers.host || `${host}:${port}`;
    return originUrl.origin === `http://${hostHeader}`;
  } catch {
    return false;
  }
}

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return cryptoTimingSafeEqual(left, right);
}

function parseCsv(value) {
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseAgentTokenMap(value) {
  const entries = parseCsv(value);
  const map = new Map();
  const seenTokens = new Map();
  for (const entry of entries) {
    const separator = entry.indexOf(":");
    if (separator <= 0 || separator === entry.length - 1) {
      console.error("Invalid LIBRARIAN_AGENT_TOKENS entry. Use agent_id:token pairs separated by commas.");
      process.exit(1);
    }
    const agentId = entry.slice(0, separator).trim();
    const token = entry.slice(separator + 1).trim();
    if (map.has(agentId)) {
      console.error(`Duplicate LIBRARIAN_AGENT_TOKENS entry for agent ${agentId}.`);
      process.exit(1);
    }
    if (seenTokens.has(token)) {
      console.error(`Duplicate LIBRARIAN_AGENT_TOKENS token for agents ${seenTokens.get(token)} and ${agentId}.`);
      process.exit(1);
    }
    map.set(agentId, token);
    seenTokens.set(token, agentId);
  }
  return map;
}

function pageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>The Librarian</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #202124;
      --muted: #5f646d;
      --line: #d8dde5;
      --panel: #f7f8fa;
      --accent: #0f766e;
      --accent-2: #b45309;
      --danger: #b42318;
      --bg: #ffffff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background: var(--bg);
      letter-spacing: 0;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 18px 24px;
      border-bottom: 1px solid var(--line);
      background: #fff;
      position: sticky;
      top: 0;
      z-index: 2;
    }
    h1 { font-size: 20px; margin: 0; font-weight: 700; }
    main {
      display: grid;
      grid-template-columns: minmax(280px, 360px) 1fr;
      min-height: calc(100vh - 66px);
    }
    aside {
      border-right: 1px solid var(--line);
      padding: 18px;
      background: var(--panel);
    }
    section { padding: 18px 22px 40px; }
    .toolbar, .filters {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    .filters { margin-top: 14px; }
    input, select, textarea, button {
      font: inherit;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--ink);
    }
    input, select, textarea {
      padding: 9px 10px;
      width: 100%;
    }
    textarea { min-height: 110px; resize: vertical; }
    button {
      min-height: 36px;
      padding: 7px 11px;
      cursor: pointer;
      white-space: nowrap;
    }
    button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    button.warning { color: var(--accent-2); }
    button.danger { color: var(--danger); }
    label { display: grid; gap: 5px; font-size: 12px; color: var(--muted); margin-bottom: 10px; }
    .memory-list {
      display: grid;
      gap: 10px;
      margin-top: 16px;
    }
    .memory {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 13px;
      background: #fff;
    }
    .memory h2 {
      margin: 0 0 7px;
      font-size: 16px;
      line-height: 1.25;
    }
    .memory p {
      margin: 0 0 10px;
      color: #31343a;
      line-height: 1.45;
      white-space: pre-wrap;
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 10px;
    }
    .pill {
      font-size: 12px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 3px 7px;
      color: var(--muted);
      background: #fbfbfc;
    }
    .pill.proposed { color: var(--accent-2); border-color: #e8c48b; }
    .pill.active { color: var(--accent); border-color: #91c7c0; }
    .pill.deleted, .pill.rejected { color: var(--danger); border-color: #e6aaa4; }
    .actions { display: flex; gap: 7px; flex-wrap: wrap; }
    .tabs { display: flex; gap: 6px; flex-wrap: wrap; }
    .tab.active { background: #202124; color: #fff; }
    .editor {
      display: grid;
      gap: 8px;
      padding-top: 10px;
    }
    .hidden { display: none; }
    .status { color: var(--muted); font-size: 13px; }
    @media (max-width: 820px) {
      main { grid-template-columns: 1fr; }
      aside { border-right: 0; border-bottom: 1px solid var(--line); }
      header { align-items: flex-start; flex-direction: column; }
    }
  </style>
</head>
<body>
  <header>
    <h1>The Librarian</h1>
    <div class="toolbar">
      <button class="primary" id="refresh">Refresh</button>
      <button id="newMemory">New Memory</button>
    </div>
  </header>
  <main>
    <aside>
      <label>Search <input id="search" placeholder="Recall memories"></label>
      <label>Agent <input id="agent" value="dashboard"></label>
      <label>Project <input id="project" placeholder="optional project key"></label>
      <button class="primary" id="recall">Recall</button>
      <div class="filters">
        <select id="category">
          <option value="">All categories</option>
          <option>identity</option><option>relationship</option><option>preferences</option>
          <option>projects</option><option>environment</option><option>tools</option>
          <option>lessons</option><option>people</option><option>open_threads</option>
        </select>
        <select id="visibility">
          <option value="">All visibility</option>
          <option>common</option>
          <option>agent_private</option>
        </select>
      </div>
      <p class="status" id="status"></p>
    </aside>
    <section>
      <div class="tabs">
        <button class="tab active" data-status="active">Active</button>
        <button class="tab" data-status="proposed">Proposed</button>
        <button class="tab" data-status="conflicted">Conflicts</button>
        <button class="tab" data-status="archived">Archived</button>
        <button class="tab" data-status="deleted">Deleted</button>
        <button class="tab" data-status="events">Logs</button>
      </div>
      <div id="newForm" class="memory hidden">
        <div class="editor">
          <label>Title <input id="formTitle"></label>
          <label>Body <textarea id="formBody"></textarea></label>
          <label>Category <select id="formCategory">
            <option>lessons</option><option>identity</option><option>relationship</option><option>preferences</option>
            <option>projects</option><option>environment</option><option>tools</option><option>people</option><option>open_threads</option>
          </select></label>
          <label>Visibility <select id="formVisibility"><option>common</option><option>agent_private</option></select></label>
          <label>Scope <select id="formScope"><option>global</option><option>project</option><option>environment</option><option>tool</option><option>session</option></select></label>
          <label>Tags <input id="formTags" placeholder="comma-separated"></label>
          <button class="primary" id="saveNew">Save</button>
        </div>
      </div>
      <div class="memory-list" id="list"></div>
    </section>
  </main>
  <script>
    let state = { memories: [], events: [] };
    let activeStatus = "active";

    const $ = (id) => document.getElementById(id);
    const list = $("list");
    const status = $("status");

    document.querySelectorAll(".tab").forEach((button) => {
      button.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        activeStatus = button.dataset.status;
        render();
      });
    });

    $("refresh").addEventListener("click", load);
    $("newMemory").addEventListener("click", () => $("newForm").classList.toggle("hidden"));
    $("category").addEventListener("change", render);
    $("visibility").addEventListener("change", render);
    $("search").addEventListener("input", render);
    $("recall").addEventListener("click", recall);
    $("saveNew").addEventListener("click", saveNew);

    async function load() {
      status.textContent = "Loading";
      const response = await fetch("/api/state");
      state = await response.json();
      status.textContent = state.memories.length + " memories";
      render();
    }

    function render() {
      if (activeStatus === "events") return renderEvents();
      const query = $("search").value.toLowerCase();
      const category = $("category").value;
      const visibility = $("visibility").value;
      const memories = state.memories.filter((memory) => {
        if (memory.status !== activeStatus) return false;
        if (category && memory.category !== category) return false;
        if (visibility && memory.visibility !== visibility) return false;
        if (query && !(memory.title + " " + memory.body + " " + memory.tags.join(" ")).toLowerCase().includes(query)) return false;
        return true;
      });
      list.innerHTML = memories.map(renderMemory).join("") || '<p class="status">No memories in this view.</p>';
      bindActions();
    }

    function renderEvents() {
      list.innerHTML = state.events.map((event) => '<article class="memory"><h2>' + escapeHtml(event.event_type) + '</h2><div class="meta"><span class="pill">' + escapeHtml(event.created_at) + '</span><span class="pill">' + escapeHtml(event.agent_id || "") + '</span></div><p>' + escapeHtml(event.memory_id || "") + '</p></article>').join("") || '<p class="status">No logs yet.</p>';
    }

    function renderMemory(memory) {
      return '<article class="memory" data-id="' + memory.id + '">' +
        '<h2>' + escapeHtml(memory.title) + '</h2>' +
        '<p>' + escapeHtml(memory.body) + '</p>' +
        '<div class="meta">' +
          pill(memory.status) + pill(memory.category) + pill(memory.visibility) + pill(memory.scope) + pill(memory.priority) + pill(memory.confidence) +
        '</div>' +
        '<div class="actions">' +
          (memory.status === "proposed" ? '<button class="primary approve">Approve</button><button class="warning reject">Reject</button>' : '') +
          '<button class="edit">Edit</button>' +
          (memory.status !== "deleted" ? '<button class="danger delete">Delete</button>' : '') +
        '</div>' +
        '<div class="editor hidden">' +
          '<label>Title <input class="editTitle" value="' + attr(memory.title) + '"></label>' +
          '<label>Body <textarea class="editBody">' + escapeHtml(memory.body) + '</textarea></label>' +
          '<label>Priority <select class="editPriority">' + options(["low","normal","high","core"], memory.priority) + '</select></label>' +
          '<label>Confidence <select class="editConfidence">' + options(["tentative","working","strong"], memory.confidence) + '</select></label>' +
          '<button class="primary saveEdit">Save Edit</button>' +
        '</div>' +
      '</article>';
    }

    function bindActions() {
      document.querySelectorAll(".memory").forEach((card) => {
        const id = card.dataset.id;
        card.querySelector(".edit")?.addEventListener("click", () => card.querySelector(".editor").classList.toggle("hidden"));
        card.querySelector(".saveEdit")?.addEventListener("click", () => updateMemory(id, {
          title: card.querySelector(".editTitle").value,
          body: card.querySelector(".editBody").value,
          priority: card.querySelector(".editPriority").value,
          confidence: card.querySelector(".editConfidence").value
        }));
        card.querySelector(".delete")?.addEventListener("click", () => post("/api/memories/" + id + "/delete", { agent_id: "dashboard" }).then(load));
        card.querySelector(".approve")?.addEventListener("click", () => post("/api/proposals/" + id + "/approve", { agent_id: "dashboard" }).then(load));
        card.querySelector(".reject")?.addEventListener("click", () => post("/api/proposals/" + id + "/reject", { agent_id: "dashboard" }).then(load));
      });
    }

    async function updateMemory(id, patch) {
      await post("/api/memories/" + id + "/update", { agent_id: "dashboard", patch });
      await load();
    }

    async function recall() {
      const response = await post("/api/recall", {
        agent_id: $("agent").value || "dashboard",
        query: $("search").value,
        project_key: $("project").value,
        limit: 20
      });
      state.memories = response.memories;
      status.textContent = response.memories.length + " recalled";
      activeStatus = "active";
      document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item.dataset.status === "active"));
      render();
    }

    async function saveNew() {
      await post("/api/memories", {
        agent_id: $("agent").value || "dashboard",
        title: $("formTitle").value,
        body: $("formBody").value,
        category: $("formCategory").value,
        visibility: $("formVisibility").value,
        scope: $("formScope").value,
        project_key: $("project").value,
        tags: $("formTags").value.split(",").map((tag) => tag.trim()).filter(Boolean)
      });
      $("formTitle").value = "";
      $("formBody").value = "";
      $("formTags").value = "";
      await load();
    }

    async function post(url, body) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const json = await response.json();
      if (!response.ok || json.error) throw new Error(json.error || "Request failed");
      return json;
    }

    function pill(text) { return '<span class="pill ' + escapeHtml(text) + '">' + escapeHtml(text || "") + '</span>'; }
    function options(values, selected) { return values.map((value) => '<option ' + (value === selected ? "selected" : "") + '>' + value + '</option>').join(""); }
    function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c])); }
    function attr(value) { return escapeHtml(value).replace(/"/g, "&quot;"); }
    load();
  </script>
</body>
</html>`;
}
