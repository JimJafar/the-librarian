(function () {
  "use strict";

  const PROTECTED_CATEGORIES = new Set(["identity", "relationship"]);

  const state = {
    aggregates: null,
    aggregatesLoadedAt: 0,
    memories: [],
    total: 0,
    limit: 100,
    offset: 0,
    activeTab: "browse",
    selectedMemoryId: null,
    sortField: "updated_at",
    sortOrder: "desc",
    eventState: { events: [], total: 0, limit: 25, offset: 0 },
    sessions: [],
    selectedSessionId: null,
  };

  const STALE_SESSION_MS = 7 * 24 * 60 * 60 * 1000;

  const charts = {};
  let toastTimer = null;

  const $ = (id) => document.getElementById(id);

  // ── Tab routing ────────────────────────────────────────────────────────────

  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      btn.classList.add("active");
      state.activeTab = btn.dataset.tab;
      state.offset = 0;
      switchTab();
    });
  });

  function switchTab() {
    const isBrowse = state.activeTab === "browse";
    const isAnalytics = state.activeTab === "analytics";
    const isLogs = state.activeTab === "logs";
    const isSessions = state.activeTab === "sessions";

    $("sortBar").classList.toggle("hidden", !isBrowse);
    $("eventControls").classList.toggle("hidden", !isLogs);
    $("browseLayout").classList.toggle("hidden", isAnalytics || isSessions);
    $("analyticsTab").classList.toggle("hidden", !isAnalytics);
    $("sessionsTab").classList.toggle("hidden", !isSessions);
    $("detailPanel").classList.add("hidden");

    if (isAnalytics) {
      runAction(loadAnalytics);
    } else if (isLogs) {
      runAction(() => loadEvents(0));
    } else if (isSessions) {
      runAction(loadSessions);
    } else {
      runAction(load);
    }
  }

  // ── Sidebar toggle ─────────────────────────────────────────────────────────

  $("sidebarToggle").addEventListener("click", () => {
    document.querySelector("main").classList.toggle("sidebar-collapsed");
  });

  // ── Sidebar filter listeners ───────────────────────────────────────────────

  $("refresh").addEventListener("click", () => runAction(init));
  $("newMemory").addEventListener("click", () => $("newForm").classList.toggle("hidden"));
  $("recall").addEventListener("click", () => runAction(recall));
  $("saveNew").addEventListener("click", () => runAction(saveNew));

  $("search").addEventListener("input", () => { state.offset = 0; runAction(load); });
  $("agent").addEventListener("change", () => { state.offset = 0; runAction(load); });
  $("project").addEventListener("change", () => { state.offset = 0; runAction(load); });
  $("category").addEventListener("change", () => { state.offset = 0; runAction(load); });
  $("visibility").addEventListener("change", () => { state.offset = 0; runAction(load); });
  $("dateFrom").addEventListener("change", () => { state.offset = 0; runAction(load); });
  $("dateTo").addEventListener("change", () => { state.offset = 0; runAction(load); });

  $("sortField").addEventListener("change", () => { state.sortField = $("sortField").value; state.offset = 0; runAction(load); });
  $("sortOrder").addEventListener("change", () => { state.sortOrder = $("sortOrder").value; state.offset = 0; runAction(load); });

  $("eventApply").addEventListener("click", () => runAction(() => loadEvents(0)));
  $("eventPrev").addEventListener("click", () => runAction(() => loadEvents(Math.max(state.eventState.offset - state.eventState.limit, 0))));
  $("eventNext").addEventListener("click", () => {
    const next = state.eventState.offset + state.eventState.limit;
    if (next < state.eventState.total) runAction(() => loadEvents(next));
  });

  $("detailClose").addEventListener("click", closeDetail);

  // ── Init ───────────────────────────────────────────────────────────────────

  async function init() {
    await loadAggregates();
    await load();
  }

  async function loadAggregates() {
    const res = await fetch("/api/aggregates");
    if (!res.ok) throw new Error("Could not load aggregates.");
    state.aggregates = await res.json();
    state.aggregatesLoadedAt = Date.now();
    populateSelect("agent", state.aggregates.agents, "All agents");
    populateSelect("project", state.aggregates.projects, "All projects");
  }

  function populateSelect(selectId, items, allLabel) {
    const el = $(selectId);
    el.innerHTML = `<option value="">${escapeHtml(allLabel)}</option>` +
      items.map(({ value }) => `<option value="${attr(value)}">${escapeHtml(value)}</option>`).join("");
  }

  // ── Data loading ───────────────────────────────────────────────────────────

  async function load() {
    if (state.activeTab === "logs") return loadEvents(0);
    if (state.activeTab === "analytics") return loadAnalytics();
    const params = buildParams();
    const res = await fetch("/api/memories?" + params.toString());
    if (!res.ok) throw new Error("Could not load memories.");
    const data = await res.json();
    state.memories = data.memories;
    state.total = data.total;
    state.limit = data.limit;
    state.offset = data.offset;
    $("status").textContent = data.total + " memories";
    render();
  }

  function buildParams() {
    const params = new URLSearchParams();
    const tabStatus = { browse: "active", proposals: "proposed", conflicts: "conflicted", archive: "archived" };
    const status = tabStatus[state.activeTab];
    if (status) params.set("status", status);

    if (state.activeTab === "browse") {
      const agentVal = $("agent").value;
      const projectVal = $("project").value;
      const categoryVal = $("category").value;
      const visibilityVal = $("visibility").value;
      const searchVal = $("search").value.trim();
      const dateFrom = $("dateFrom").value;
      const dateTo = $("dateTo").value;
      if (agentVal) params.set("agent_id", agentVal);
      if (projectVal) params.set("project_key", projectVal);
      if (categoryVal) params.set("category", categoryVal);
      if (visibilityVal) params.set("visibility", visibilityVal);
      if (searchVal) params.set("query", searchVal);
      if (dateFrom) params.set("from", dateFrom);
      if (dateTo) params.set("to", dateTo);
      params.set("sort", state.sortField);
      params.set("order", state.sortOrder);
    }
    params.set("limit", String(state.limit));
    params.set("offset", String(state.offset));
    return params;
  }

  async function loadAnalytics() {
    if (!state.aggregates || Date.now() - state.aggregatesLoadedAt > 60000) {
      await loadAggregates();
    }
    renderAnalytics();
  }

  async function loadEvents(offset = state.eventState.offset) {
    const params = new URLSearchParams({ limit: String(state.eventState.limit), offset: String(offset) });
    if ($("eventType").value) params.set("type", $("eventType").value);
    if ($("eventResult").value) params.set("result", $("eventResult").value);
    if ($("eventAgent").value.trim()) params.set("agent_id", $("eventAgent").value.trim());
    if ($("eventQuery").value.trim()) params.set("query", $("eventQuery").value.trim());
    const res = await fetch("/api/events?" + params.toString());
    if (!res.ok) throw new Error("Could not load logs.");
    state.eventState = await res.json();
    renderEvents();
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  function render() {
    switch (state.activeTab) {
      case "browse":     return renderBrowse();
      case "proposals":  return renderMemoryList("No proposals pending.");
      case "conflicts":  return renderMemoryList("No conflicted memories.");
      case "archive":    return renderMemoryList("No archived memories.");
      default:           return renderBrowse();
    }
  }

  function renderBrowse() {
    $("list").innerHTML = state.memories.map(renderCard).join("") ||
      '<p class="status">No memories in this view.</p>';
    bindActions();
  }

  function renderMemoryList(emptyMsg) {
    $("list").innerHTML = state.memories.map(renderCard).join("") ||
      `<p class="status">${escapeHtml(emptyMsg)}</p>`;
    bindActions();
  }

  function renderCard(memory) {
    return `<article class="memory" data-id="${attr(memory.id)}">
      <h2>${escapeHtml(memory.title)}</h2>
      <p>${escapeHtml(memory.body.slice(0, 200))}${memory.body.length > 200 ? "…" : ""}</p>
      <div class="meta">
        ${pill(memory.status)}${pill(memory.category)}
        ${PROTECTED_CATEGORIES.has(memory.category) ? pill("protected") : ""}
        ${pill(memory.visibility)}${pill(memory.scope)}
        ${pill(memory.agent_id || "no agent")}
        ${memory.project_key ? pill(memory.project_key) : ""}
        ${pill(memory.priority)}${pill(memory.confidence)}
        ${(memory.tags || []).map(pill).join("")}
      </div>
      <div class="actions">
        ${memory.status === "proposed" ? '<button class="primary approve">Approve</button><button class="warning reject">Reject</button>' : ""}
        <button class="detail-btn">Detail</button>
        ${memory.status !== "deleted" ? '<button class="danger delete">Delete</button>' : ""}
      </div>
    </article>`;
  }

  function renderAnalytics() {
    const agg = state.aggregates;
    if (!agg) return;
    const dims = [
      { canvasId: "chartByAgent",    label: "By Agent",    data: agg.agents },
      { canvasId: "chartByCategory", label: "By Category", data: agg.categories },
      { canvasId: "chartByProject",  label: "By Project",  data: agg.projects },
      { canvasId: "chartByStatus",   label: "By Status",   data: agg.statuses },
      { canvasId: "chartByScope",    label: "By Scope",    data: agg.scopes },
    ];
    for (const { canvasId, label, data } of dims) {
      if (charts[canvasId]) { charts[canvasId].destroy(); delete charts[canvasId]; }
      const canvas = $(canvasId);
      if (!canvas || !data || !data.length) continue;
      charts[canvasId] = new Chart(canvas, {
        type: "doughnut",
        data: {
          labels: data.map((d) => d.value),
          datasets: [{ data: data.map((d) => d.count) }],
        },
        options: { plugins: { title: { display: true, text: label } }, responsive: true },
      });
    }
  }

  function renderEvents() {
    $("eventControls").classList.remove("hidden");
    const es = state.eventState;
    $("eventPrev").disabled = es.offset <= 0;
    $("eventNext").disabled = es.offset + es.limit >= es.total;
    const start = es.total ? es.offset + 1 : 0;
    const end = Math.min(es.offset + es.limit, es.total);
    $("eventPage").textContent = es.total ? `${start}-${end} of ${es.total}` : "0 logs";
    $("list").innerHTML = es.events.map(renderEvent).join("") ||
      '<p class="status">No logs match these filters.</p>';
  }

  function renderEvent(event) {
    const payload = event.payload || {};
    const summary = eventSummary(event, payload);
    const payloadText = JSON.stringify(payload, null, 2);
    return `<article class="memory">
      <h2>${escapeHtml(event.event_type)}</h2>
      <div class="meta">
        ${pill(event.created_at)}${pill(event.agent_id || "no agent")}
        ${event.memory_id ? pill(event.memory_id) : ""}
        ${payload.result ? pill(payload.result) : ""}
        ${payload.returned_count === 0 ? pill("no results") : ""}
      </div>
      ${summary ? `<p>${escapeHtml(summary)}</p>` : ""}
      ${payloadText && payloadText !== "{}" ? `<pre class="event-payload">${escapeHtml(payloadText)}</pre>` : ""}
    </article>`;
  }

  function eventSummary(event, payload) {
    if (event.event_type === "memory.recall_empty") return `Recall returned no memories for "${payload.query || ""}".`;
    if (event.event_type === "memory.recalled") return `Recall returned memory for "${payload.query || ""}".`;
    if (event.event_type === "memory.verified") return `Memory marked ${payload.result || "verified"}${payload.note ? ": " + payload.note : "."  }`;
    if (payload.memory?.title) return payload.memory.title;
    if (payload.patch?.title || payload.patch?.body) return [payload.patch.title, payload.patch.body].filter(Boolean).join(": ");
    if (payload.query) return payload.query;
    return event.memory_id || "";
  }

  // ── Detail panel ───────────────────────────────────────────────────────────

  async function openDetail(id) {
    const res = await fetch(`/api/memories/${id}/related`);
    if (!res.ok) throw new Error("Could not load memory detail.");
    const { memory, related } = await res.json();
    $("detailContent").innerHTML = renderDetailBody(memory);
    $("relatedList").innerHTML = related.length
      ? related.map((r) => `
          <article class="memory related-item" data-id="${attr(r.memory.id)}">
            <h4>${escapeHtml(r.memory.title)}</h4>
            <p>${escapeHtml(r.memory.body.slice(0, 120))}…</p>
            <div class="meta">
              ${pill(r.isDuplicate ? "duplicate" : r.isConflict ? "conflict" : "similar")}
              ${pill(Math.round(r.ratio * 100) + "% match")}
            </div>
          </article>`).join("")
      : '<p class="status">No related memories found.</p>';
    $("relatedSection").classList.remove("hidden");
    $("detailPanel").classList.remove("hidden");
    state.selectedMemoryId = id;
    bindDetailActions(memory);
  }

  function renderDetailBody(memory) {
    return `
      <h2>${escapeHtml(memory.title)}</h2>
      <div class="meta">
        ${pill(memory.status)}${pill(memory.category)}
        ${PROTECTED_CATEGORIES.has(memory.category) ? pill("protected") : ""}
        ${pill(memory.visibility)}${pill(memory.scope)}
        ${pill(memory.agent_id || "no agent")}
        ${memory.project_key ? pill(memory.project_key) : ""}
        ${pill(memory.priority)}${pill(memory.confidence)}
        ${(memory.tags || []).map(pill).join("")}
      </div>
      <p>${escapeHtml(memory.body)}</p>
      <div class="editor">
        <label>Title <input class="editTitle" value="${attr(memory.title)}"></label>
        <label>Body <textarea class="editBody">${escapeHtml(memory.body)}</textarea></label>
        <div class="editor-grid">
          <label>Agent <input class="editAgent" value="${attr(memory.agent_id || "")}"></label>
          <label>Category <select class="editCategory">${categoryOptions(memory.category)}</select></label>
          <label>Visibility <select class="editVisibility">${options(["common","agent_private"], memory.visibility)}</select></label>
          <label>Scope <select class="editScope">${options(["global","project","environment","tool","session"], memory.scope)}</select></label>
          <label>Project <input class="editProject" value="${attr(memory.project_key || "")}"></label>
          <label>Tags <input class="editTags" value="${attr((memory.tags || []).join(", "))}"></label>
          <label>Priority <select class="editPriority">${options(["low","normal","high","core"], memory.priority)}</select></label>
          <label>Confidence <select class="editConfidence">${options(["tentative","working","strong"], memory.confidence)}</select></label>
        </div>
        <button class="primary saveEdit" data-id="${attr(memory.id)}">Save Edit</button>
      </div>`;
  }

  function closeDetail() {
    $("detailPanel").classList.add("hidden");
    $("relatedSection").classList.add("hidden");
    state.selectedMemoryId = null;
  }

  function bindDetailActions(memory) {
    const panel = $("detailPanel");
    panel.querySelector(".saveEdit")?.addEventListener("click", () => runAction(() => updateMemory(memory.id, {
      title:      panel.querySelector(".editTitle").value,
      body:       panel.querySelector(".editBody").value,
      agent_id:   panel.querySelector(".editAgent").value,
      category:   panel.querySelector(".editCategory").value,
      visibility: panel.querySelector(".editVisibility").value,
      scope:      panel.querySelector(".editScope").value,
      project_key: panel.querySelector(".editProject").value,
      tags:       panel.querySelector(".editTags").value.split(",").map((t) => t.trim()).filter(Boolean),
      priority:   panel.querySelector(".editPriority").value,
      confidence: panel.querySelector(".editConfidence").value,
    })));

    panel.querySelectorAll(".related-item").forEach((item) => {
      item.addEventListener("click", () => runAction(() => openDetail(item.dataset.id)));
    });
  }

  // ── Card action delegation ─────────────────────────────────────────────────

  function bindActions() {
    document.querySelectorAll("#list .memory").forEach((card) => {
      const id = card.dataset.id;
      card.querySelector(".detail-btn")?.addEventListener("click", () => runAction(() => openDetail(id)));
      card.querySelector(".approve")?.addEventListener("click", () => runAction(async () => {
        await post("/api/proposals/" + id + "/approve", { agent_id: "dashboard" });
        showToast("Proposal approved.", "success");
        await load();
      }));
      card.querySelector(".reject")?.addEventListener("click", () => runAction(async () => {
        await post("/api/proposals/" + id + "/reject", { agent_id: "dashboard" });
        showToast("Proposal rejected.", "success");
        await load();
      }));
      card.querySelector(".delete")?.addEventListener("click", () => runAction(async () => {
        await post("/api/memories/" + id + "/delete", { agent_id: "dashboard" });
        showToast("Memory deleted.", "success");
        await load();
      }));
    });
  }

  // ── Write operations ───────────────────────────────────────────────────────

  async function updateMemory(id, patch) {
    await post("/api/memories/" + id + "/update", { agent_id: "dashboard", patch });
    showToast("Memory updated.", "success");
    if (state.selectedMemoryId === id) await openDetail(id);
    else await load();
  }

  async function recall() {
    const res = await post("/api/recall", {
      agent_id: $("agent").value || "dashboard",
      query: $("search").value,
      project_key: $("project").value,
      limit: 20,
    });
    state.memories = res.memories;
    state.total = res.memories.length;
    $("status").textContent = res.memories.length + " recalled";
    showToast(res.memories.length + " memories recalled.", "success");
    state.activeTab = "browse";
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === "browse"));
    $("sortBar").classList.remove("hidden");
    $("eventControls").classList.add("hidden");
    renderBrowse();
  }

  async function saveNew() {
    await post("/api/memories", {
      agent_id: $("agent").value || "dashboard",
      title:    $("formTitle").value,
      body:     $("formBody").value,
      category: $("formCategory").value,
      visibility: $("formVisibility").value,
      scope:    $("formScope").value,
      project_key: $("project").value,
      tags: $("formTags").value.split(",").map((t) => t.trim()).filter(Boolean),
    });
    $("formTitle").value = "";
    $("formBody").value = "";
    $("formTags").value = "";
    $("newForm").classList.add("hidden");
    showToast("Memory saved.", "success");
    await loadAggregates();
    await load();
  }

  async function post(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok || json.error) throw new Error(json.error || "Request failed");
    return json;
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  $("sessionRefresh")?.addEventListener("click", () => runAction(loadSessions));
  $("sessionSearch")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") runAction(loadSessions);
  });
  $("sessionProject")?.addEventListener("change", () => runAction(loadSessions));
  $("sessionIncludeArchived")?.addEventListener("change", () => runAction(loadSessions));
  $("sessionIncludeDeleted")?.addEventListener("change", () => runAction(loadSessions));

  async function loadSessions() {
    const query = $("sessionSearch").value.trim();
    const project = $("sessionProject").value.trim();
    const includeArchived = $("sessionIncludeArchived").checked;
    const includeDeleted = $("sessionIncludeDeleted").checked;
    let data;
    if (query) {
      data = await post("/api/sessions/search", {
        query,
        project_key: project || undefined,
        include_archived: includeArchived,
        include_deleted: includeDeleted,
        limit: 50,
      });
    } else {
      const params = new URLSearchParams({ limit: "50" });
      if (project) params.set("project_key", project);
      if (includeArchived) params.set("include_archived", "true");
      if (includeDeleted) params.set("include_deleted", "true");
      const res = await fetch("/api/sessions?" + params.toString());
      if (!res.ok) throw new Error("Could not load sessions.");
      data = await res.json();
    }
    state.sessions = data.sessions || [];
    renderSessionList();
    if (state.selectedSessionId) {
      const stillVisible = state.sessions.some((s) => s.id === state.selectedSessionId);
      if (stillVisible) await openSessionDetail(state.selectedSessionId);
      else closeSessionDetail();
    }
  }

  function renderSessionList() {
    const list = $("sessionList");
    if (!state.sessions.length) {
      list.innerHTML = '<p class="status">No sessions match these filters.</p>';
      return;
    }
    list.innerHTML = state.sessions.map(renderSessionRow).join("");
    list.querySelectorAll(".session-row").forEach((row) => {
      row.addEventListener("click", () => runAction(() => openSessionDetail(row.dataset.id)));
    });
  }

  function renderSessionRow(session) {
    const stale = isSessionStale(session);
    const statusLabel = stale ? `${session.status} · stale` : session.status;
    const nextStep = (session.next_steps || [])[0] || "";
    return `<article class="session-row" data-id="${attr(session.id)}">
      <div class="session-row-head">
        <h3>${escapeHtml(session.title)}</h3>
        <div class="meta">
          ${pill(statusLabel)}
          ${pill(session.visibility)}
          ${session.project_key ? pill(session.project_key) : ""}
          ${pill(session.current_harness || "(unattached)")}
          ${pill(session.current_agent_id || "(no agent)")}
        </div>
      </div>
      <div class="session-row-body">
        ${session.source_ref ? `<div><strong>Source:</strong> ${escapeHtml(session.source_ref)}</div>` : ""}
        <div><strong>Last activity:</strong> ${escapeHtml(session.last_activity_at || "(unknown)")}</div>
        ${nextStep ? `<div><strong>Next:</strong> ${escapeHtml(nextStep)}</div>` : ""}
      </div>
    </article>`;
  }

  function isSessionStale(session) {
    if (session.status !== "active") return false;
    const ts = Date.parse(session.last_activity_at || session.started_at || 0);
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts > STALE_SESSION_MS;
  }

  async function openSessionDetail(sessionId) {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
    if (!res.ok) throw new Error("Could not load session.");
    const session = await res.json();
    const eventsRes = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/events?limit=100`);
    const eventsBody = eventsRes.ok ? await eventsRes.json() : { events: [] };
    state.selectedSessionId = sessionId;
    $("sessionDetail").classList.remove("hidden");
    $("sessionDetail").innerHTML = renderSessionDetail(session, eventsBody.events || []);
    bindSessionDetailActions(session);
  }

  function closeSessionDetail() {
    state.selectedSessionId = null;
    const panel = $("sessionDetail");
    if (panel) {
      panel.classList.add("hidden");
      panel.innerHTML = "";
    }
  }

  function renderSessionDetail(session, events) {
    const lifecycleActive = ["active", "paused"].includes(session.status);
    const canRestore = ["archived", "deleted"].includes(session.status);
    const canArchive = ["active", "paused", "ended"].includes(session.status);
    const canDelete = session.status !== "deleted";
    return `
      <button id="sessionDetailClose" class="icon-btn" aria-label="Close detail">×</button>
      <h2>${escapeHtml(session.title)}</h2>
      <div class="meta">
        ${pill(session.status)}${pill(session.visibility)}
        ${session.project_key ? pill(session.project_key) : ""}
        ${pill(session.current_harness || "(unattached)")}
      </div>
      <p class="muted">id: ${escapeHtml(session.id)}</p>
      <p class="muted">created by ${escapeHtml(session.created_by_agent_id || "?")} in ${escapeHtml(session.created_in_harness || "?")} · last activity ${escapeHtml(session.last_activity_at || "?")}</p>

      ${session.start_summary ? `<section><h3>Goal</h3><p>${escapeHtml(session.start_summary)}</p></section>` : ""}
      ${session.rolling_summary ? `<section><h3>Rolling summary</h3><p>${escapeHtml(session.rolling_summary)}</p></section>` : ""}
      ${session.end_summary ? `<section><h3>End summary</h3><p>${escapeHtml(session.end_summary)}</p></section>` : ""}
      ${(session.next_steps || []).length ? `<section><h3>Next steps</h3><ul>${session.next_steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul></section>` : ""}

      <section>
        <h3>Lifecycle</h3>
        <div class="session-actions">
          ${lifecycleActive ? '<button class="sessionCheckpoint">Checkpoint…</button>' : ""}
          ${lifecycleActive ? '<button class="sessionPause">Pause…</button>' : ""}
          ${lifecycleActive ? '<button class="sessionEnd">End…</button>' : ""}
          ${canArchive ? '<button class="sessionArchive">Archive</button>' : ""}
          ${canRestore ? '<button class="primary sessionRestore">Restore</button>' : ""}
          ${canDelete ? '<button class="danger sessionDelete">Delete</button>' : ""}
        </div>
      </section>

      <section>
        <h3>Continue / handover</h3>
        <div class="editor-grid">
          <label>Target harness <input class="sessionTargetHarness"></label>
          <label>Target source_ref <input class="sessionTargetSource"></label>
          <label>Target cwd <input class="sessionTargetCwd"></label>
          <label>Format
            <select class="sessionContinueFormat">
              <option value="prose">prose</option>
              <option value="markdown">markdown</option>
              <option value="claude">claude</option>
              <option value="codex">codex</option>
              <option value="opencode">opencode</option>
              <option value="hermes">hermes</option>
              <option value="pi">pi</option>
            </select>
          </label>
          <label class="inline"><input type="checkbox" class="sessionContinueAttach"> Attach now</label>
        </div>
        <button class="primary sessionContinue">Generate handover</button>
        <pre class="session-handover hidden"></pre>
      </section>

      <section>
        <h3>Promote a fact to memory</h3>
        <div class="editor-grid">
          <label>Title <input class="sessionPromoteTitle"></label>
          <label>Body <textarea class="sessionPromoteBody"></textarea></label>
          <label>Category
            <select class="sessionPromoteCategory">
              <option>lessons</option>
              <option>identity</option>
              <option>relationship</option>
              <option>preferences</option>
              <option>projects</option>
              <option>environment</option>
              <option>tools</option>
              <option>people</option>
              <option>open_threads</option>
            </select>
          </label>
          <label>Visibility
            <select class="sessionPromoteVisibility">
              <option>common</option>
              <option>agent_private</option>
            </select>
          </label>
          <label>Scope
            <select class="sessionPromoteScope">
              <option>global</option>
              <option>project</option>
              <option>environment</option>
              <option>tool</option>
              <option>session</option>
            </select>
          </label>
        </div>
        <button class="primary sessionPromote">Promote</button>
        <p class="hint">Protected categories (identity, relationship) are routed to the proposal flow.</p>
      </section>

      <section>
        <h3>Events (${events.length})</h3>
        <div class="session-events">${events.map(renderSessionEvent).join("") || '<p class="muted">No events recorded yet.</p>'}</div>
      </section>
    `;
  }

  function renderSessionEvent(event) {
    return `<article class="session-event">
      <div class="meta">${pill(event.type)} ${event.agent_id ? pill(event.agent_id) : ""} <span class="muted">${escapeHtml(event.created_at || "")}</span></div>
      ${event.summary ? `<p>${escapeHtml(event.summary)}</p>` : ""}
    </article>`;
  }

  function bindSessionDetailActions(session) {
    const panel = $("sessionDetail");
    panel.querySelector("#sessionDetailClose")?.addEventListener("click", closeSessionDetail);

    panel.querySelector(".sessionCheckpoint")?.addEventListener("click", () => runAction(async () => {
      const summary = prompt("Checkpoint summary:");
      if (!summary) return;
      await post(`/api/sessions/${session.id}/checkpoint`, { summary });
      showToast("Checkpoint recorded.", "success");
      await openSessionDetail(session.id);
    }));

    panel.querySelector(".sessionPause")?.addEventListener("click", () => runAction(async () => {
      const summary = prompt("Pause summary:");
      if (!summary) return;
      await post(`/api/sessions/${session.id}/pause`, { summary });
      showToast("Session paused.", "success");
      await loadSessions();
    }));

    panel.querySelector(".sessionEnd")?.addEventListener("click", () => runAction(async () => {
      const summary = prompt("End summary:");
      if (!summary) return;
      await post(`/api/sessions/${session.id}/end`, { summary });
      showToast("Session ended.", "success");
      await loadSessions();
    }));

    panel.querySelector(".sessionArchive")?.addEventListener("click", () => runAction(async () => {
      const reason = prompt("Reason (optional):") || "";
      await post(`/api/sessions/${session.id}/archive`, { reason });
      showToast("Session archived.", "success");
      await loadSessions();
    }));

    panel.querySelector(".sessionRestore")?.addEventListener("click", () => runAction(async () => {
      await post(`/api/sessions/${session.id}/restore`, {});
      showToast("Session restored.", "success");
      await loadSessions();
    }));

    panel.querySelector(".sessionDelete")?.addEventListener("click", () => runAction(async () => {
      if (!confirm("Soft-delete this session? You can restore it later.")) return;
      const reason = prompt("Reason (optional):") || "";
      await post(`/api/sessions/${session.id}/delete`, { reason });
      showToast("Session deleted.", "success");
      await loadSessions();
    }));

    panel.querySelector(".sessionContinue")?.addEventListener("click", () => runAction(async () => {
      const body = {
        target_harness: panel.querySelector(".sessionTargetHarness").value.trim() || undefined,
        target_source_ref: panel.querySelector(".sessionTargetSource").value.trim() || undefined,
        target_cwd: panel.querySelector(".sessionTargetCwd").value.trim() || undefined,
        attach: panel.querySelector(".sessionContinueAttach").checked,
        format: panel.querySelector(".sessionContinueFormat").value,
      };
      const result = await post(`/api/sessions/${session.id}/continue`, body);
      const handover = panel.querySelector(".session-handover");
      handover.textContent = result.text || JSON.stringify(result.handover, null, 2);
      handover.classList.remove("hidden");
      showToast(body.attach ? "Attached and handover generated." : "Handover generated.", "success");
      if (body.attach) await loadSessions();
    }));

    panel.querySelector(".sessionPromote")?.addEventListener("click", () => runAction(() => promoteSessionFact(session)));
  }

  async function promoteSessionFact(session) {
    const panel = $("sessionDetail");
    const memory = {
      title: panel.querySelector(".sessionPromoteTitle").value.trim(),
      body: panel.querySelector(".sessionPromoteBody").value.trim(),
      category: panel.querySelector(".sessionPromoteCategory").value,
      visibility: panel.querySelector(".sessionPromoteVisibility").value,
      scope: panel.querySelector(".sessionPromoteScope").value,
      project_key: session.project_key || undefined,
    };
    if (!memory.title && !memory.body) {
      showToast("Provide a title or body before promoting.", "error");
      return;
    }
    const result = await post(`/api/sessions/${session.id}/promote`, { memory });
    if (result.status === "proposed") {
      showToast("Promoted to proposal (awaiting review).", "success");
    } else if (result.status === "active") {
      showToast("Promoted to active memory.", "success");
    } else {
      showToast(`Promotion result: ${result.status}`, "info");
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  function pill(text) { return `<span class="pill ${escapeHtml(text)}">${escapeHtml(text || "")}</span>`; }

  function options(values, selected) {
    return values.map((v) => `<option value="${attr(v)}"${v === selected ? " selected" : ""}>${escapeHtml(v)}</option>`).join("");
  }

  function categoryOptions(selected) {
    return ["identity","relationship","preferences","projects","environment","tools","lessons","people","open_threads"].map((v) => {
      const label = PROTECTED_CATEGORIES.has(v) ? v + " (protected)" : v;
      return `<option value="${attr(v)}"${v === selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
    }).join("");
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
  }

  function attr(value) { return escapeHtml(value); }

  function showToast(message, type = "info") {
    clearTimeout(toastTimer);
    const toast = $("toast");
    toast.textContent = message;
    toast.className = "toast " + type;
    toastTimer = setTimeout(() => { toast.className = "toast hidden"; }, 4500);
  }

  async function runAction(action) {
    try {
      await action();
    } catch (error) {
      showToast(error.message || "Something went wrong.", "error");
    }
  }

  // ── Boot ───────────────────────────────────────────────────────────────────

  document.addEventListener("DOMContentLoaded", () => runAction(init));
})();
