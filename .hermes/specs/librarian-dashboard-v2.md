# Librarian Dashboard v2 — Specification

## Overview

The v2 dashboard replaces the current flat-card, text-filter UI with a tabbed layout featuring
data-driven dropdowns, date-range filtering, sortable lists, analytics charts, and related-memory
discovery. The implementation is vanilla JS/HTML/CSS; no framework, no build step.

---

## Goals

| # | Requirement | Status |
|---|-------------|--------|
| 1 | Data-driven agent/project dropdowns from live data | new |
| 2 | Date-range filtering on browse tab | new |
| 3 | Analytics tab with Chart.js donut charts | new |
| 4 | Related memories panel in detail view | new |
| 5 | Sortable memory list (created_at, updated_at, title, priority) | new |
| 6 | Tabbed layout with collapsible sidebar | new |

---

## Architecture

### File responsibilities

| File | Role |
|------|------|
| `src/dashboard.js` | HTTP server — adds new route handlers for `/api/aggregates` and `/api/memories/:id/related`; extends `/api/memories` GET with query params |
| `src/store.js` | Adds `getAggregates()` method; `detectRelated()` already exists |
| `public/index.html` | Full replacement — tabbed layout, collapsible sidebar, detail panel placeholder, Chart.js CDN script tag |
| `public/app.js` | Full replacement — tab router, browse module, analytics module, detail panel, sort/filter state |
| `public/styles.css` | Extended — tab bar, collapsible sidebar toggle, analytics grid, detail panel, chart container sizing |
| `test/http.test.js` | Extended — tests for all three new/modified endpoints |

---

## 1. New and Modified API Endpoints

### 1.1  `GET /api/aggregates`

Returns dimension counts used to populate dropdowns and charts. No query parameters.

**Response schema:**

```json
{
  "agents":     [{ "value": "codex", "count": 14 }, ...],
  "projects":   [{ "value": "the-librarian", "count": 6 }, ...],
  "categories": [{ "value": "tools", "count": 22 }, ...],
  "statuses":   [{ "value": "active", "count": 40 }, ...],
  "scopes":     [{ "value": "global", "count": 18 }, ...],
  "priorities": [{ "value": "high", "count": 7 }, ...],
  "total":      54
}
```

- All counts reflect **non-deleted** memories (i.e., `status != 'deleted'`).
- Entries with `null` agent or project are omitted from those arrays.
- Arrays are sorted descending by `count`.

**Implementation in `src/store.js` — `getAggregates()`:**

```js
getAggregates() {
  const memories = this.listMemories({});          // all statuses
  const active   = memories.filter(m => m.status !== 'deleted');

  const tally = (field) => {
    const map = new Map();
    for (const m of active) {
      const v = m[field];
      if (!v) continue;
      map.set(v, (map.get(v) ?? 0) + 1);
    }
    return [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({ value, count }));
  };

  return {
    agents:     tally('agent_id'),
    projects:   tally('project_key'),
    categories: tally('category'),
    statuses:   tally('status'),
    scopes:     tally('scope'),
    priorities: tally('priority'),
    total:      active.length
  };
}
```

**Route in `src/dashboard.js`:**

```js
if (req.method === 'GET' && url.pathname === '/api/aggregates') {
  return sendJson(res, store.getAggregates());
}
```

---

### 1.2  `GET /api/memories/:id/related`

Returns memories similar to the one identified by `:id`, with similarity scores.

**URL pattern:** `/api/memories/mem_[a-z0-9]+/related`

**Response schema:**

```json
{
  "memory": { /* full memory object */ },
  "related": [
    { "memory": { /* full memory object */ }, "ratio": 0.61, "isDuplicate": true,  "isConflict": false },
    { "memory": { /* full memory object */ }, "ratio": 0.38, "isDuplicate": false, "isConflict": true  }
  ]
}
```

- `ratio` is the Jaccard-style token overlap from `detectRelated()`.
- `isDuplicate` is true when `ratio >= 0.55`.
- `isConflict` reflects `seemsConflict()` logic (shared negation signals).
- If the memory does not exist, return `{ "error": "Not found" }` with status 404.

**Implementation — `src/store.js`:**

`detectRelated()` already returns `{ duplicates, conflicts }` but does not expose individual ratios.
Add a companion method `getRelated(id)`:

```js
getRelated(id) {
  const memory = this.getMemory(id);
  if (!memory) return null;

  const terms = new Set(tokenize(`${memory.title} ${memory.body} ${memory.tags.join(' ')}`));
  if (!terms.size) return { memory, related: [] };

  const pool = this.listMemories({
    status: 'active',
    agent_id: memory.agent_id,
    project_key: memory.project_key
  }).filter(m => m.id !== id && m.category === memory.category);

  const related = pool
    .map(other => {
      const otherTerms = new Set(tokenize(`${other.title} ${other.body} ${other.tags.join(' ')}`));
      const overlap = [...terms].filter(t => otherTerms.has(t)).length;
      const ratio = overlap / Math.max(terms.size, otherTerms.size, 1);
      const isDuplicate = ratio >= 0.55;
      const isConflict  = ratio >= 0.32 && seemsConflict(memory.body, other.body);
      return { memory: other, ratio, isDuplicate, isConflict };
    })
    .filter(item => item.ratio >= 0.32)
    .sort((a, b) => b.ratio - a.ratio);

  return { memory, related };
}
```

**Route in `src/dashboard.js`:**

```js
const relatedMatch = url.pathname.match(/^\/api\/memories\/([^/]+)\/related$/);
if (req.method === 'GET' && relatedMatch) {
  const result = store.getRelated(relatedMatch[1]);
  if (!result) return sendJson(res, { error: 'Not found' }, 404);
  return sendJson(res, result);
}
```

---

### 1.3  `GET /api/memories` — new list endpoint with query params

The current `/api/state` dumps everything at once. A dedicated list endpoint supports server-side
filtering and sorting so large data sets don't force full client-side passes.

**Query parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `status` | string | Filter by status (default: all) |
| `agent_id` | string | Filter by agent |
| `project_key` | string | Filter by project |
| `category` | string | Filter by category |
| `visibility` | string | Filter by visibility |
| `scope` | string | Filter by scope |
| `from` | ISO date string | created_at ≥ value |
| `to` | ISO date string | created_at ≤ value (inclusive, up to end-of-day) |
| `sort` | `created_at\|updated_at\|title\|priority` | Sort field (default: `updated_at`) |
| `order` | `asc\|desc` | Sort direction (default: `desc`) |
| `limit` | integer | Max results, capped at 200 (default: 100) |
| `offset` | integer | Pagination offset (default: 0) |

**Response schema:**

```json
{
  "memories": [ /* memory objects */ ],
  "total": 54,
  "limit": 100,
  "offset": 0
}
```

**Implementation in `src/store.js` — extend `listMemories()`:**

Add `from`, `to`, `sort`, `order`, `limit`, and `offset` support:

```js
listMemories(filters = {}) {
  const clauses = [];
  const params  = [];

  // existing filters: status, category, visibility, agent_id, project_key …

  if (filters.from) { clauses.push('created_at >= ?'); params.push(filters.from); }
  if (filters.to)   { clauses.push('created_at <= ?'); params.push(filters.to + 'T23:59:59.999Z'); }

  const sortField = ['created_at','updated_at','title','priority'].includes(filters.sort)
    ? filters.sort : 'updated_at';
  const sortDir = filters.order === 'asc' ? 'ASC' : 'DESC';

  const safeLimit  = Math.min(Math.max(Number(filters.limit  ?? 100), 1), 200);
  const safeOffset = Math.max(Number(filters.offset ?? 0), 0);

  const prioritySql = `CASE priority WHEN 'core' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END`;
  const orderSql = sortField === 'priority'
    ? `${prioritySql} ${sortDir}`
    : `${sortField} ${sortDir}`;

  const countSql = `SELECT COUNT(*) as n FROM memories ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}`;
  const total = this.db.prepare(countSql).get(...params).n;

  const sql = `
    SELECT * FROM memories
    ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
    ORDER BY ${orderSql}
    LIMIT ? OFFSET ?
  `;
  const memories = this.db.prepare(sql).all(...params, safeLimit, safeOffset).map(rowToMemory);
  return { memories, total, limit: safeLimit, offset: safeOffset };
}
```

> **Backward-compatibility note:** All existing callers of `listMemories()` that expect a plain
> array (e.g. `store.listMemories({})` in `searchMemories`, `detectRelated`, `getAggregates`,
> `getRelated`, `writeSnapshot`, `rebuildIndex`) must be updated to destructure
> `{ memories } = store.listMemories(…)`, or a private `_listAll()` helper that returns a plain
> array can be extracted. The spec recommends the private-helper approach to keep the public
> interface clean.

**Route in `src/dashboard.js`:**

```js
if (req.method === 'GET' && url.pathname === '/api/memories') {
  const result = store.listMemories({
    status:      url.searchParams.get('status')      || '',
    agent_id:    url.searchParams.get('agent_id')    || '',
    project_key: url.searchParams.get('project_key') || '',
    category:    url.searchParams.get('category')    || '',
    visibility:  url.searchParams.get('visibility')  || '',
    scope:       url.searchParams.get('scope')       || '',
    from:        url.searchParams.get('from')        || '',
    to:          url.searchParams.get('to')          || '',
    sort:        url.searchParams.get('sort')        || 'updated_at',
    order:       url.searchParams.get('order')       || 'desc',
    limit:  Number(url.searchParams.get('limit')  || 100),
    offset: Number(url.searchParams.get('offset') || 0),
  });
  return sendJson(res, result);
}
```

`/api/state` remains unchanged for backward compatibility.

---

## 2. Frontend Layout — `public/index.html`

### Tab structure

```
┌─────────────────────────────────────────────────────┐
│  Header: title + [Refresh] [New Memory]             │
├──────────────────┬──────────────────────────────────┤
│  Sidebar         │  Tab bar                         │
│  (collapsible)   │  [Browse][Analytics][Proposals]  │
│                  │  [Conflicts][Archive][Logs]       │
│  ● Search input  ├──────────────────────────────────┤
│  ● Agent select  │  Tab content area                │
│  ● Project sel.  │                                  │
│  ● Category sel. │  Browse: sort bar + memory list  │
│  ● Visibility    │          + detail panel (right)  │
│  ● Date from/to  │                                  │
│  ● [Recall]      │  Analytics: 2×2 chart grid       │
│                  │                                  │
│                  │  Proposals: proposed cards        │
│                  │                                  │
│                  │  Conflicts: conflicted cards      │
│                  │                                  │
│                  │  Archive: archived cards          │
│                  │                                  │
│                  │  Logs: event log (existing)       │
└──────────────────┴──────────────────────────────────┘
```

### Key HTML changes from v1

- `<aside>` gains a `<button id="sidebarToggle">` that collapses/expands via a CSS class on
  `<main>`.
- `agent` and `project` inputs become `<select id="agent">` and `<select id="project">`.
  Both include an "All agents" / "All projects" empty-value option at the top; options are
  populated from `/api/aggregates` on load.
- Date inputs: `<input type="date" id="dateFrom">` and `<input type="date" id="dateTo">`.
- Sort controls (browse tab only, rendered into the content area just above the list):
  ```html
  <div id="sortBar" class="sort-bar hidden">
    <label>Sort
      <select id="sortField">
        <option value="updated_at">Last updated</option>
        <option value="created_at">Created</option>
        <option value="title">Title</option>
        <option value="priority">Priority</option>
      </select>
    </label>
    <label>
      <select id="sortOrder">
        <option value="desc">Newest first</option>
        <option value="asc">Oldest first</option>
      </select>
    </label>
  </div>
  ```
- Analytics tab content (hidden by default):
  ```html
  <div id="analyticsTab" class="tab-content hidden">
    <div class="chart-grid">
      <div class="chart-card"><canvas id="chartByAgent"></canvas></div>
      <div class="chart-card"><canvas id="chartByCategory"></canvas></div>
      <div class="chart-card"><canvas id="chartByProject"></canvas></div>
      <div class="chart-card"><canvas id="chartByStatus"></canvas></div>
      <div class="chart-card"><canvas id="chartByScope"></canvas></div>
    </div>
  </div>
  ```
- Detail panel (hidden until a memory is clicked, sits alongside the list on wide viewports):
  ```html
  <div id="detailPanel" class="detail-panel hidden">
    <button id="detailClose">×</button>
    <div id="detailContent"></div>
    <section id="relatedSection" class="hidden">
      <h3>Related memories</h3>
      <div id="relatedList"></div>
    </section>
  </div>
  ```
- Chart.js CDN (before closing `</body>`):
  ```html
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  <script src="/app.js" defer></script>
  ```

---

## 3. Client Application — `public/app.js`

### Module structure (all within a single IIFE to avoid globals)

```
app.js
├── state
│   ├── aggregates        — cached /api/aggregates response
│   ├── memories          — current page from /api/memories
│   ├── total / limit / offset
│   ├── activeTab         — 'browse'|'analytics'|'proposals'|'conflicts'|'archive'|'logs'
│   ├── selectedMemoryId  — id of memory open in detail panel, or null
│   ├── sortField / sortOrder
│   └── eventState        — unchanged from v1
│
├── init()                — on DOMContentLoaded: loadAggregates(), load()
├── loadAggregates()      — GET /api/aggregates; populate selects; store in state.aggregates
├── load()                — GET /api/memories with current filter params; render()
├── loadAnalytics()       — render charts from state.aggregates
│
├── render()              — dispatch to correct renderer for activeTab
├── renderBrowse()        — sort bar + memory cards (no inline editors — click opens detail panel)
├── renderAnalytics()     — destroy old Chart.js instances; create new ones
├── renderProposals()     — proposed cards with approve/reject buttons
├── renderConflicts()     — conflicted cards
├── renderArchive()       — archived cards
├── renderEvents()        — unchanged from v1 (paginated log)
│
├── openDetail(id)        — fetch /api/memories/:id/related; render detail panel
├── closeDetail()         — hide detail panel, clear selectedMemoryId
│
├── bindActions()         — event delegation on #list and #detailPanel
│
└── helpers
    ├── buildParams()     — assemble URLSearchParams from sidebar state
    ├── pill(text)        — unchanged
    ├── escapeHtml(value) — unchanged
    ├── attr(value)       — unchanged
    ├── showToast(msg, t) — unchanged
    └── runAction(fn)     — unchanged
```

### Data flow — browse tab

```
User changes any filter/sort control
  → load()
    → GET /api/memories?status=active&agent_id=…&from=…&to=…&sort=…&order=…
    → state.memories = response.memories
    → renderBrowse()
      → memory cards (click handler calls openDetail(id))

User clicks a memory card
  → openDetail(id)
    → GET /api/memories/:id/related
    → render detail panel (full fields + related list with ratio badges)
```

### Data flow — analytics tab

```
Tab switch to 'analytics'
  → if state.aggregates is stale (> 60 s old) → loadAggregates()
  → renderAnalytics()
    → for each dimension, destroy existing Chart.js instance if present
    → new Chart(canvas, { type: 'doughnut', data: { labels, datasets } })
```

Chart.js instances are stored in a `charts` map keyed by canvas id so they can be destroyed
before re-rendering to prevent "Canvas is already in use" errors.

### Sidebar collapse

Clicking `#sidebarToggle` toggles the CSS class `sidebar-collapsed` on `<main>`. When collapsed,
`<aside>` is hidden via CSS (width: 0, overflow: hidden) and the content area fills the full width.

### Dropdown population from aggregates

```js
function populateSelect(selectId, items, allLabel) {
  const el = $(selectId);
  el.innerHTML = `<option value="">${escapeHtml(allLabel)}</option>` +
    items.map(({ value }) =>
      `<option value="${attr(value)}">${escapeHtml(value)}</option>`
    ).join('');
}

// Called after loadAggregates():
populateSelect('agent',   state.aggregates.agents,   'All agents');
populateSelect('project', state.aggregates.projects, 'All projects');
```

The `category` and `visibility` selects remain static (their values are well-known constants).

### Related memories panel

```js
async function openDetail(id) {
  const res = await fetch(`/api/memories/${id}/related`);
  if (!res.ok) throw new Error('Could not load memory detail.');
  const { memory, related } = await res.json();
  $('detailContent').innerHTML = renderDetailBody(memory);
  $('relatedList').innerHTML = related.length
    ? related.map(r =>
        `<article class="memory related-item" data-id="${attr(r.memory.id)}">
          <h4>${escapeHtml(r.memory.title)}</h4>
          <p>${escapeHtml(r.memory.body.slice(0, 120))}…</p>
          <div class="meta">
            ${pill(r.isDuplicate ? 'duplicate' : r.isConflict ? 'conflict' : 'similar')}
            ${pill(Math.round(r.ratio * 100) + '% match')}
          </div>
        </article>`
      ).join('')
    : '<p class="status">No related memories found.</p>';
  $('relatedSection').classList.remove('hidden');
  $('detailPanel').classList.remove('hidden');
  state.selectedMemoryId = id;
}
```

Clicking a related-item card calls `openDetail(r.memory.id)` to navigate to it.

---

## 4. Styles — `public/styles.css`

### New rules needed

| Selector | Purpose |
|----------|---------|
| `.tabs` | Flex row, sticky below header, border-bottom; `.tab.active` has bottom border accent |
| `main.sidebar-collapsed aside` | `width: 0; overflow: hidden; padding: 0` |
| `#sidebarToggle` | Small icon button in the header or sidebar top edge |
| `.sort-bar` | Flex row, gap, aligns with list top; hidden on non-browse tabs |
| `.chart-grid` | CSS grid, 2 columns, auto rows, gap |
| `.chart-card` | White card with padding and border-radius; `canvas` sized to fill |
| `.detail-panel` | Fixed or flex-column aside on the right; overlaps list on narrow viewports |
| `.related-item` | Lighter background variant of `.memory` card; smaller font |
| `.related-item .pill` | Reuses existing `.pill`; `duplicate` class gets warning amber |

### Responsive breakpoints

- **< 820px**: sidebar stacks above content (existing); detail panel becomes full-screen overlay.
- **820–1200px**: sidebar + content two-column; detail panel slides in as overlay on click.
- **> 1200px**: three-column — sidebar | list | detail panel (CSS Grid with
  `grid-template-columns: 220px 1fr 320px`).

---

## 5. Test Strategy — `test/http.test.js`

Six new test cases to add (all follow existing helper pattern: `startHttpServer` + `cleanupTempDir`).

### 5.1 `GET /api/aggregates` returns dimension counts

```
- Create 3 memories: two with agent_id='codex', one with agent_id='claude'
- GET /api/aggregates
- Assert response.agents[0].value === 'codex' && response.agents[0].count === 2
- Assert response.agents[1].value === 'claude' && response.agents[1].count === 1
- Assert response.total === 3
- Assert response.categories is non-empty array with { value, count } shape
```

### 5.2 `GET /api/aggregates` excludes deleted memories

```
- Create a memory, delete it
- GET /api/aggregates
- Assert response.total does not include the deleted memory
```

### 5.3 `GET /api/memories/:id/related` returns similarity data

```
- Create two memories in same category with overlapping title/body tokens
- GET /api/memories/:id/related for the first memory
- Assert response.memory.id === first memory id
- Assert response.related.length >= 1
- Assert response.related[0].ratio is a number between 0 and 1
- Assert 'isDuplicate' and 'isConflict' are boolean fields
```

### 5.4 `GET /api/memories/:id/related` returns 404 for unknown id

```
- GET /api/memories/mem_doesnotexist/related
- Assert status 404
- Assert body.error === 'Not found'
```

### 5.5 `GET /api/memories` with date range filtering

```
- Create memory A at time T1, memory B at time T2 > T1
- GET /api/memories?from=<T2 date>
- Assert response.memories contains memory B but not memory A
- Assert response.total === 1
```

### 5.6 `GET /api/memories` with sort and pagination

```
- Create 3 memories
- GET /api/memories?sort=title&order=asc&limit=2&offset=0
- Assert response.memories.length === 2
- Assert response.total === 3
- Assert memories are in ascending title order
- GET /api/memories?sort=title&order=asc&limit=2&offset=2
- Assert response.memories.length === 1 (last page)
```

---

## 6. Implementation Order

The following order minimises the risk of breaking existing tests during development.

1. **`src/store.js`** — Extract `_listAll()` private helper. Add `getAggregates()`. Add
   `getRelated()`. Extend `listMemories()` with date, sort, limit, offset, and return
   `{ memories, total, limit, offset }`.
2. **`src/dashboard.js`** — Add routes for `GET /api/aggregates`, `GET /api/memories`,
   and `GET /api/memories/:id/related`. No changes to existing routes.
3. **`test/http.test.js`** — Add the six new tests. All existing tests should still pass.
4. **`public/index.html`** — Replace with v2 layout.
5. **`public/app.js`** — Replace with v2 application.
6. **`public/styles.css`** — Add new rules; preserve all existing rules unless superseded.

---

## 7. Constraints and Non-Goals

- No authentication changes. Dashboard endpoints remain open; MCP remains token-gated.
- No Express, no build step, no TypeScript compilation.
- Chart.js loaded from CDN (`https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js`).
- No server-side full-text search in the new `GET /api/memories` — full-text recall remains
  via the existing `POST /api/recall` endpoint.
- Existing `GET /api/state` endpoint is unchanged; `public/app.js` migrates to
  `GET /api/memories` for the browse tab but `GET /api/state` may remain as a convenience.
- The `detectRelated()` method in `src/store.js` is not modified; `getRelated()` calls its
  tokenisation and conflict logic directly (or via a shared internal helper).
- No real-time push (WebSocket); the dashboard remains pull-based with the existing Refresh button.
- No server-side pagination for the event log; that tab continues to use the existing
  `GET /api/events` with client-driven limit/offset.
