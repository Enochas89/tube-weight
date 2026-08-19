(() => {
  "use strict";

  const API_URL = "/api/data";
  const AUTH_KEY = "projectStatus.editPassword";
  const STATUS_LABELS = { on_track: "On Track", at_risk: "At Risk", delayed: "Delayed", complete: "Complete", on_hold: "On Hold" };
  // Monday/ClickUp-style vibrant status colors rather than muted ones.
  const TASK_STATUS_COLOR = { not_started: "#c4c4c4", in_progress: "#fdab3d", delayed: "#e2445c", complete: "#00c875" };
  const AVATAR_PALETTE = ["#579bfc", "#a25ddc", "#ff642e", "#fdab3d", "#00c875", "#66ccff", "#e2445c", "#7e5efd"];

  let state = { projects: [] };
  let currentProjectId = null;
  let isEditor = false;

  // ---------- utility ----------
  function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
  function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; }
  function todayStr() { return new Date().toISOString().slice(0, 10); }
  function fmtDate(d) {
    if (!d) return "—";
    const dt = new Date(d + "T00:00:00");
    if (isNaN(dt.getTime())) return "—";
    return dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str ?? "";
    return div.innerHTML;
  }
  function getProject(id) { return state.projects.find((p) => p.id === id); }

  function addDays(dateStr, n) {
    return new Date(new Date(dateStr + "T00:00:00").getTime() + n * 86400000).toISOString().slice(0, 10);
  }
  function daysBetween(a, b) {
    return Math.round((new Date(b + "T00:00:00").getTime() - new Date(a + "T00:00:00").getTime()) / 86400000);
  }
  function taskDuration(t) {
    return t.duration || Math.max(1, daysBetween(t.startDate, t.endDate) + 1);
  }

  // Tasks that (transitively) depend on taskId — used to keep the
  // predecessor picker from offering a choice that would create a cycle.
  function descendantsOf(project, taskId, visited) {
    visited = visited || new Set();
    project.tasks.forEach((t) => {
      if ((t.predecessors || []).includes(taskId) && !visited.has(t.id)) {
        visited.add(t.id);
        descendantsOf(project, t.id, visited);
      }
    });
    return visited;
  }
  function successorsOf(project, taskId) {
    return project.tasks.filter((t) => (t.predecessors || []).includes(taskId));
  }

  // Pushes every task's start/end forward to sit right after its latest
  // predecessor finishes. Repeats to a fixed point so changes cascade through
  // chains (A -> B -> C) — safe for any dependency DAG since each pass
  // resolves one more hop, and it's a no-op once nothing moves.
  function recalcSchedule(project) {
    const byId = {};
    project.tasks.forEach((t) => { byId[t.id] = t; });
    for (let pass = 0; pass <= project.tasks.length; pass++) {
      let changed = false;
      project.tasks.forEach((t) => {
        const preds = (t.predecessors || []).map((id) => byId[id]).filter(Boolean);
        if (!preds.length) return;
        const latestEnd = Math.max(...preds.map((pr) => new Date(pr.endDate + "T00:00:00").getTime()));
        const newStart = new Date(latestEnd + 86400000).toISOString().slice(0, 10);
        const newEnd = addDays(newStart, taskDuration(t) - 1);
        if (t.startDate !== newStart || t.endDate !== newEnd) {
          t.startDate = newStart;
          t.endDate = newEnd;
          changed = true;
        }
      });
      if (!changed) break;
    }
  }

  function initials(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  function avatarColor(name) {
    const s = String(name || "");
    let hash = 0;
    for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
    return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
  }

  async function copyLink(url) {
    try {
      await navigator.clipboard.writeText(url);
      showStatus("Link copied to clipboard", "success");
    } catch (e) {
      window.prompt("Copy this link:", url);
    }
  }
  document.getElementById("shareListBtn").addEventListener("click", () => {
    copyLink(location.origin + location.pathname);
  });
  document.getElementById("shareProjectBtn").addEventListener("click", () => {
    copyLink(location.origin + location.pathname + "#project/" + currentProjectId);
  });

  // ---------- status toast ----------
  const toastEl = document.getElementById("statusToast");
  let toastTimer = null;
  function showStatus(msg, type, sticky) {
    clearTimeout(toastTimer);
    toastEl.textContent = msg;
    toastEl.className = "status-toast " + type;
    if (!sticky) {
      toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 2200);
    }
  }
  function hideStatus() { toastEl.classList.add("hidden"); }

  // ---------- auth ----------
  function getStoredPassword() { return localStorage.getItem(AUTH_KEY) || ""; }
  function setStoredPassword(pw) {
    if (pw) localStorage.setItem(AUTH_KEY, pw);
    else localStorage.removeItem(AUTH_KEY);
  }

  async function verifyPassword(pw) {
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw, data: null }),
      });
      return res.ok;
    } catch (e) {
      return false;
    }
  }

  function updateEditorUI() {
    document.getElementById("signInBtn").classList.toggle("hidden", isEditor);
    document.getElementById("editorBadge").classList.toggle("hidden", !isEditor);
    document.querySelectorAll(".editor-only").forEach((el) => el.classList.toggle("hidden", !isEditor));
    if (currentProjectId) renderDetail(getProject(currentProjectId));
    else renderList();
  }

  document.getElementById("signInBtn").addEventListener("click", () => {
    const body = `
      <div class="modal-field"><label>Edit password</label><input type="password" id="f-password" autocomplete="off"></div>
      <p class="modal-error hidden" id="f-password-error">Incorrect password.</p>
    `;
    openModal("Sign In to Edit", body, async () => {
      const pw = document.getElementById("f-password").value;
      const ok = await verifyPassword(pw);
      if (!ok) {
        document.getElementById("f-password-error").classList.remove("hidden");
        return false;
      }
      setStoredPassword(pw);
      isEditor = true;
      updateEditorUI();
      showStatus("Signed in", "success");
    });
  });

  document.getElementById("signOutBtn").addEventListener("click", () => {
    setStoredPassword("");
    isEditor = false;
    updateEditorUI();
    showStatus("Signed out", "info");
  });

  // ---------- persistence ----------
  async function loadRemote() {
    showStatus("Loading…", "info", true);
    try {
      const res = await fetch(API_URL);
      if (!res.ok) throw new Error("load failed");
      const data = await res.json();
      state = (data && Array.isArray(data.projects)) ? data : { projects: [] };
      hideStatus();
    } catch (e) {
      state = { projects: [] };
      showStatus("Could not load data — check your connection and reload the page.", "error", true);
    }
  }

  async function saveRemote() {
    showStatus("Saving…", "info", true);
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: getStoredPassword(), data: state }),
      });
      const result = await res.json().catch(() => ({}));
      if (res.status === 401) {
        isEditor = false;
        setStoredPassword("");
        updateEditorUI();
        showStatus("Your edit session expired — sign in again to keep editing.", "error", true);
        return false;
      }
      if (!res.ok) {
        showStatus(result.error || "Save failed.", "error", true);
        return false;
      }
      showStatus("Saved", "success");
      return true;
    } catch (e) {
      showStatus("Save failed — check your connection and try again.", "error", true);
      return false;
    }
  }

  // ---------- routing ----------
  function route() {
    const hash = location.hash.slice(1);
    if (hash.startsWith("project/")) {
      currentProjectId = hash.slice(8);
      const p = getProject(currentProjectId);
      if (!p) { location.hash = ""; return; }
      showDetail(p);
    } else {
      currentProjectId = null;
      showList();
    }
  }
  window.addEventListener("hashchange", route);

  function showList() {
    document.getElementById("listView").classList.remove("hidden");
    document.getElementById("detailView").classList.add("hidden");
    renderList();
  }
  function showDetail(p) {
    document.getElementById("listView").classList.add("hidden");
    document.getElementById("detailView").classList.remove("hidden");
    renderDetail(p);
  }

  // ---------- list view ----------
  function projectProgress(p) {
    const counted = p.tasks.filter((t) => !t.noScheduleImpact);
    if (!counted.length) return 0;
    return Math.round(counted.reduce((a, t) => a + (t.progress || 0), 0) / counted.length);
  }

  function renderList() {
    const grid = document.getElementById("projectGrid");
    if (state.projects.length === 0) {
      grid.innerHTML = `<div class="empty-state">No projects yet.${isEditor ? ' Click "+ New Project" to add one.' : " Check back once the project manager has added one."}</div>`;
      return;
    }
    grid.innerHTML = state.projects.map((p) => {
      const progress = projectProgress(p);
      return `
        <div class="project-card" data-id="${p.id}">
          <div class="project-card-top">
            <div>
              <h3>${escapeHtml(p.name)}</h3>
              <p class="client">${escapeHtml(p.client || "—")}</p>
            </div>
            <span class="status-badge ${p.status}">${STATUS_LABELS[p.status]}</span>
          </div>
          <p class="project-card-dates">${fmtDate(p.startDate)} &rarr; ${fmtDate(p.endDate)}</p>
          <div class="progress-bar"><div class="progress-bar-fill" style="width:${progress}%"></div></div>
          <div class="project-card-meta">
            <span>${p.tasks.length} task${p.tasks.length === 1 ? "" : "s"}</span>
            <span>${p.delays.length ? p.delays.length + " delay" + (p.delays.length === 1 ? "" : "s") : "No delays"}</span>
            <span>${progress}%</span>
          </div>
        </div>`;
    }).join("");
    grid.querySelectorAll(".project-card").forEach((card) => {
      card.addEventListener("click", () => { location.hash = "project/" + card.dataset.id; });
    });
  }

  document.getElementById("newProjectBtn").addEventListener("click", () => openProjectModal());

  // ---------- MS Project XML import ----------
  // Reads only direct children by local name — namespace-agnostic (MSP XML
  // typically declares xmlns="http://schemas.microsoft.com/project"), and
  // avoids accidentally matching a same-named descendant deeper in the tree.
  function directChildText(el, tag) {
    for (let i = 0; i < el.children.length; i++) {
      if (el.children[i].localName === tag) return (el.children[i].textContent || "").trim();
    }
    return "";
  }

  function parseMsProjectXml(xmlText) {
    const dom = new DOMParser().parseFromString(xmlText, "application/xml");
    if (dom.getElementsByTagName("parsererror").length) {
      throw new Error("That's not valid XML — make sure you exported from Microsoft Project using Save As > XML.");
    }

    const root = dom.documentElement;
    const projectName = directChildText(root, "Title") || directChildText(root, "Name") || "Imported Project";

    const tasksContainer = Array.from(root.children).find((c) => c.localName === "Tasks");
    const resourcesContainer = Array.from(root.children).find((c) => c.localName === "Resources");
    const assignmentsContainer = Array.from(root.children).find((c) => c.localName === "Assignments");

    const resources = {};
    if (resourcesContainer) {
      Array.from(resourcesContainer.children).forEach((r) => {
        if (r.localName !== "Resource") return;
        resources[directChildText(r, "UID")] = directChildText(r, "Name");
      });
    }

    const taskResources = {};
    if (assignmentsContainer) {
      Array.from(assignmentsContainer.children).forEach((a) => {
        if (a.localName !== "Assignment") return;
        const taskUid = directChildText(a, "TaskUID");
        const resName = resources[directChildText(a, "ResourceUID")];
        if (!resName) return;
        (taskResources[taskUid] = taskResources[taskUid] || []).push(resName);
      });
    }

    // Collect every <Task> first, in document order, with its outline level —
    // some MSP exports don't set <Summary>1</Summary> reliably, so a task is
    // ALSO treated as a summary/rollup if the next task nests one level
    // deeper than it (i.e. it has children). Combined with the UID-0 and
    // project-name checks below, this catches summary rows even when the
    // explicit flag is missing.
    const rawTasks = [];
    if (tasksContainer) {
      Array.from(tasksContainer.children).forEach((t) => {
        if (t.localName !== "Task") return;
        const outline = parseInt(directChildText(t, "OutlineLevel"), 10);
        rawTasks.push({
          el: t,
          uid: directChildText(t, "UID"),
          outlineLevel: Number.isFinite(outline) ? outline : null,
          explicitSummary: directChildText(t, "Summary") === "1",
        });
      });
    }

    const normalizedProjectName = projectName.trim().toLowerCase();
    const tasks = [];
    rawTasks.forEach((rt, i) => {
      const t = rt.el;
      if (!rt.uid || rt.uid === "0") return; // UID 0 is the whole-project rollup, not a real task
      if (rt.explicitSummary) return;
      const next = rawTasks[i + 1];
      if (next && rt.outlineLevel !== null && next.outlineLevel !== null && next.outlineLevel > rt.outlineLevel) return; // has children -> it's a summary row

      const name = directChildText(t, "Name");
      if (name.trim().toLowerCase() === normalizedProjectName) return; // rollup row named after the project itself
      const start = directChildText(t, "Start");
      const finish = directChildText(t, "Finish");
      if (!name || !start || !finish) return;
      const startDate = start.slice(0, 10);
      const endDate = finish.slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return;

      const pct = Math.max(0, Math.min(100, Math.round(num(directChildText(t, "PercentComplete")))));
      const status = pct >= 100 ? "complete" : pct > 0 ? "in_progress" : "not_started";
      const responsible = (taskResources[rt.uid] || []).join(", ");

      tasks.push({ name, startDate, endDate, responsible, status, progress: pct });
    });

    return { projectName, tasks };
  }

  function openImportConfirmModal(parsed, sourceLabel, extraNote) {
    const count = parsed.tasks.length;
    const body = `
      <div class="modal-field"><label>Project name</label><input type="text" id="f-name" value="${escapeHtml(parsed.projectName)}"></div>
      <div class="modal-field"><label>Client</label><input type="text" id="f-client" value=""></div>
      <p style="font-size:0.85rem;color:var(--text-dim);margin:-6px 0 12px;">Found ${count} task${count === 1 ? "" : "s"} to import${extraNote ? " — " + escapeHtml(extraNote) : ""}.</p>
    `;
    openModal(`Import from ${sourceLabel}`, body, async () => {
      const name = document.getElementById("f-name").value.trim();
      if (!name) { alert("Project name is required."); return false; }
      const dates = parsed.tasks.map((t) => [t.startDate, t.endDate]).flat();
      const p = {
        id: uid(), name, client: document.getElementById("f-client").value.trim(),
        status: "on_track",
        startDate: dates.length ? dates.reduce((a, b) => (b < a ? b : a)) : todayStr(),
        endDate: dates.length ? dates.reduce((a, b) => (b > a ? b : a)) : "",
        description: `Imported from ${sourceLabel} (${count} task${count === 1 ? "" : "s"}).`,
        tasks: parsed.tasks.map((t) => ({ id: uid(), ...t })),
        delays: [], notes: [],
      };
      state.projects.push(p);
      const ok = await saveRemote();
      if (!ok) { state.projects.pop(); return false; }
      renderList();
      location.hash = "project/" + p.id;
    });
  }

  document.getElementById("importMspBtn").addEventListener("click", () => {
    document.getElementById("importFileInput").click();
  });
  document.getElementById("importFileInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseMsProjectXml(text);
      if (!parsed.tasks.length) {
        alert("No importable tasks found in that file. Summary rows are skipped automatically, so this can happen if every row is a summary task.");
        return;
      }
      openImportConfirmModal(parsed, "Microsoft Project", "summary/rollup rows are skipped");
    } catch (err) {
      alert("Couldn't import that file: " + err.message);
    }
  });

  // ---------- Excel import ----------
  const EXCEL_HEADER_ALIASES = {
    name: ["task name", "task", "name", "activity", "activity name"],
    start: ["start", "start date", "begin", "begin date"],
    finish: ["finish", "end", "end date", "finish date", "due", "due date"],
    percent: ["% complete", "percent complete", "% work complete", "progress", "complete", "% done"],
    responsible: ["resource names", "resource", "resources", "assigned to", "responsible", "owner", "assignee"],
  };

  function normalizeHeader(h) { return String(h || "").trim().toLowerCase().replace(/\s+/g, " "); }

  function findColumnKey(headers, aliasList) {
    const normalizedMap = {};
    headers.forEach((h) => { normalizedMap[normalizeHeader(h)] = h; });
    for (const alias of aliasList) {
      if (normalizedMap[alias] !== undefined) return normalizedMap[alias];
    }
    return null;
  }

  function excelDateToYMD(val) {
    if (val instanceof Date && !isNaN(val.getTime())) return val.toISOString().slice(0, 10);
    if (typeof val === "number") {
      // Excel serial date, in case cellDates didn't convert this particular cell
      const d = new Date(Math.round((val - 25569) * 86400 * 1000));
      if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
    if (typeof val === "string" && val.trim()) {
      const d = new Date(val.trim());
      if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
    return null;
  }

  function parseExcelWorkbook(arrayBuffer) {
    if (typeof XLSX === "undefined") throw new Error("Excel import library failed to load — try reloading the page.");
    const wb = XLSX.read(arrayBuffer, { type: "array", cellDates: true });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) throw new Error("This workbook has no sheets.");
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    if (!rows.length) throw new Error(`The "${sheetName}" sheet has no data rows.`);

    const headers = Object.keys(rows[0]);
    const nameKey = findColumnKey(headers, EXCEL_HEADER_ALIASES.name);
    const startKey = findColumnKey(headers, EXCEL_HEADER_ALIASES.start);
    const finishKey = findColumnKey(headers, EXCEL_HEADER_ALIASES.finish);
    const percentKey = findColumnKey(headers, EXCEL_HEADER_ALIASES.percent);
    const responsibleKey = findColumnKey(headers, EXCEL_HEADER_ALIASES.responsible);

    if (!nameKey || !startKey || !finishKey) {
      throw new Error(`Couldn't find the required columns in "${sheetName}" — need a task name column, a start date column, and a finish/end date column. Found: ${headers.join(", ")}`);
    }

    const tasks = [];
    rows.forEach((row) => {
      const name = String(row[nameKey] || "").trim();
      const startDate = excelDateToYMD(row[startKey]);
      const endDate = excelDateToYMD(row[finishKey]);
      if (!name || !startDate || !endDate) return;

      let pct = 0;
      if (percentKey) {
        const raw = row[percentKey];
        const n = typeof raw === "number" ? raw : parseFloat(String(raw).replace("%", ""));
        if (Number.isFinite(n)) pct = n <= 1 ? Math.round(n * 100) : Math.round(n);
      }
      pct = Math.max(0, Math.min(100, pct));
      const status = pct >= 100 ? "complete" : pct > 0 ? "in_progress" : "not_started";
      const responsible = responsibleKey ? String(row[responsibleKey] || "").trim() : "";

      tasks.push({ name, startDate, endDate, responsible, status, progress: pct });
    });

    const projectName = sheetName && normalizeHeader(sheetName) !== "sheet1" ? sheetName : "Imported Project";
    return { projectName, tasks };
  }

  document.getElementById("importExcelBtn").addEventListener("click", () => {
    document.getElementById("importExcelInput").click();
  });
  document.getElementById("importExcelInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const parsed = parseExcelWorkbook(buf);
      if (!parsed.tasks.length) {
        alert("No importable rows found in that sheet. Each row needs a task name, a start date, and a finish/end date.");
        return;
      }
      openImportConfirmModal(parsed, "Excel", null);
    } catch (err) {
      alert("Couldn't import that file: " + err.message);
    }
  });

  // ---------- detail view ----------
  function renderDetail(p) {
    document.getElementById("detailName").textContent = p.name;
    document.getElementById("detailClient").textContent = p.client || "";
    document.getElementById("detailDescription").textContent = p.description || "";

    const statusSelect = document.getElementById("detailStatus");
    const statusBadgeReadonly = document.getElementById("detailStatusBadge");
    if (isEditor) {
      statusSelect.classList.remove("hidden");
      statusBadgeReadonly.classList.add("hidden");
      statusSelect.innerHTML = Object.entries(STATUS_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
      statusSelect.value = p.status;
      statusSelect.className = "status-select " + p.status;
      statusSelect.onchange = async () => {
        const prev = p.status;
        p.status = statusSelect.value;
        statusSelect.className = "status-select " + p.status;
        const ok = await saveRemote();
        if (!ok) { p.status = prev; statusSelect.value = prev; statusSelect.className = "status-select " + prev; }
        renderList();
      };
    } else {
      statusSelect.classList.add("hidden");
      statusBadgeReadonly.classList.remove("hidden");
      statusBadgeReadonly.textContent = STATUS_LABELS[p.status];
      statusBadgeReadonly.className = "status-badge " + p.status;
    }

    renderTaskList(p);
    renderDelays(p);
    renderNotes(p);
  }

  document.getElementById("backToListBtn").addEventListener("click", () => { location.hash = ""; });
  document.getElementById("editProjectBtn").addEventListener("click", () => openProjectModal(getProject(currentProjectId)));
  document.getElementById("deleteProjectBtn").addEventListener("click", async () => {
    if (!confirm("Delete this project? This can't be undone.")) return;
    const removed = state.projects.find((p) => p.id === currentProjectId);
    state.projects = state.projects.filter((p) => p.id !== currentProjectId);
    const ok = await saveRemote();
    if (!ok) { state.projects.push(removed); return; }
    location.hash = "";
  });

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      document.querySelectorAll(".tab-panel").forEach((panel) => {
        panel.classList.toggle("hidden", panel.dataset.tabPanel !== tab);
      });
    });
  });

  // ---------- task list ----------
  function taskSubEntries(p, taskId) {
    const delays = p.delays.filter((d) => d.taskId === taskId).map((d) => ({ ...d, kind: "delay" }));
    const notes = p.notes.filter((n) => n.taskId === taskId).map((n) => ({ ...n, kind: "note" }));
    return [...delays, ...notes].sort((a, b) => b.date.localeCompare(a.date));
  }

  function renderTaskList(p) {
    const wrap = document.getElementById("taskListWrap");
    if (!p.tasks.length) {
      wrap.innerHTML = `<div class="empty-state">No tasks yet.${isEditor ? ' Click "+ Add Task" to get started.' : ""}</div>`;
      return;
    }

    const todayMs = new Date(todayStr() + "T00:00:00").getTime();
    wrap.innerHTML = p.tasks.map((t) => {
      const color = TASK_STATUS_COLOR[t.status] || TASK_STATUS_COLOR.not_started;
      const isToday = todayMs >= new Date(t.startDate + "T00:00:00").getTime() && todayMs <= new Date(t.endDate + "T00:00:00").getTime();
      const actions = isEditor ? `
            <span class="task-actions">
              <button class="btn-icon" data-edit-task="${t.id}" title="Edit">&#9998;</button>
              <button class="btn-icon" data-delete-task="${t.id}" title="Delete">&times;</button>
            </span>` : "";
      const owner = t.responsible
        ? `<span class="avatar" style="background:${avatarColor(t.responsible)}" title="${escapeHtml(t.responsible)}">${initials(t.responsible)}</span><span class="task-owner">${escapeHtml(t.responsible)}</span>`
        : `<span class="task-owner unassigned">Unassigned</span>`;

      const preds = (t.predecessors || []).map((id) => p.tasks.find((pt) => pt.id === id)).filter(Boolean);
      const succs = successorsOf(p, t.id);
      const linksHtml = (preds.length || succs.length) ? `
          <div class="task-card-links">
            ${preds.length ? `<span>After: ${preds.map((pt) => escapeHtml(pt.name)).join(", ")}</span>` : ""}
            ${succs.length ? `<span>Blocks: ${succs.map((st) => escapeHtml(st.name)).join(", ")}</span>` : ""}
          </div>` : "";

      const entries = taskSubEntries(p, t.id);
      const entriesHtml = entries.map((e) => {
        const del = isEditor ? `<button class="btn-icon" data-delete-${e.kind}="${e.id}" title="Delete">&times;</button>` : "";
        const meta = e.kind === "delay"
          ? `${fmtDate(e.date)}${e.days ? " &bull; " + e.days + " day(s)" : ""}`
          : `${fmtDate(e.date)}${e.author ? " &bull; " + escapeHtml(e.author) : ""}`;
        return `
          <div class="task-sub-item ${e.kind}">
            <div class="task-sub-item-head">
              <span class="log-item-meta">${meta}</span>
              ${del}
            </div>
            <div class="log-item-text">${escapeHtml(e.kind === "delay" ? e.reason : e.text)}</div>
          </div>`;
      }).join("");
      const subActions = isEditor ? `
          <div class="task-card-actions">
            <button class="btn-chip" data-add-delay-task="${t.id}">+ Delay</button>
            <button class="btn-chip" data-add-note-task="${t.id}">+ Note</button>
          </div>` : "";

      return `
        <div class="task-card">
          <div class="task-card-stripe" style="background:${color}"></div>
          <div class="task-card-top">
            <div class="task-card-title">
              <span class="status-dot" style="background:${color}"></span>
              <span class="task-name">${escapeHtml(t.name)}</span>
              ${t.noScheduleImpact ? `<span class="no-impact-badge" title="Excluded from overall % complete">No impact</span>` : ""}
            </div>
            ${actions}
          </div>
          <div class="task-card-owner-row">${owner}</div>
          <div class="task-card-progress">
            <div class="progress-bar"><div class="progress-bar-fill" style="width:${t.progress || 0}%;"></div></div>
            <span class="task-card-pct">${t.progress || 0}%</span>
          </div>
          <div class="task-card-dates${isToday ? " is-today" : ""}">${fmtDate(t.startDate)} &rarr; ${fmtDate(t.endDate)} &bull; ${taskDuration(t)} day${taskDuration(t) === 1 ? "" : "s"}</div>
          ${linksHtml}
          ${entries.length || isEditor ? `<div class="task-card-sub">${entriesHtml}${subActions}</div>` : ""}
        </div>`;
    }).join("");

    wrap.querySelectorAll("[data-edit-task]").forEach((el) => {
      el.addEventListener("click", () => {
        openTaskModal(p, p.tasks.find((t) => t.id === el.dataset.editTask));
      });
    });
    wrap.querySelectorAll("[data-delete-task]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this task?")) return;
        const removedId = btn.dataset.deleteTask;
        const removedTask = p.tasks.find((t) => t.id === removedId);
        p.tasks = p.tasks.filter((t) => t.id !== removedId);
        const affectedDelays = p.delays.filter((d) => d.taskId === removedId);
        affectedDelays.forEach((d) => { d.taskId = null; });
        const affectedNotes = p.notes.filter((n) => n.taskId === removedId);
        affectedNotes.forEach((n) => { n.taskId = null; });
        const affectedPredTasks = p.tasks.filter((t) => (t.predecessors || []).includes(removedId));
        affectedPredTasks.forEach((t) => { t.predecessors = t.predecessors.filter((id) => id !== removedId); });
        recalcSchedule(p);
        const ok = await saveRemote();
        if (!ok) {
          p.tasks.push(removedTask);
          affectedDelays.forEach((d) => { d.taskId = removedTask.id; });
          affectedNotes.forEach((n) => { n.taskId = removedTask.id; });
          affectedPredTasks.forEach((t) => { t.predecessors.push(removedId); });
          recalcSchedule(p);
        }
        renderTaskList(p);
        renderDelays(p);
        renderNotes(p);
        renderList();
      });
    });
    wrap.querySelectorAll("[data-add-delay-task]").forEach((btn) => {
      btn.addEventListener("click", () => {
        openDelayModal(p, p.tasks.find((t) => t.id === btn.dataset.addDelayTask));
      });
    });
    wrap.querySelectorAll("[data-add-note-task]").forEach((btn) => {
      btn.addEventListener("click", () => {
        openNoteModal(p, p.tasks.find((t) => t.id === btn.dataset.addNoteTask));
      });
    });
    wrap.querySelectorAll("[data-delete-delay]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const removed = p.delays.find((d) => d.id === btn.dataset.deleteDelay);
        p.delays = p.delays.filter((d) => d.id !== btn.dataset.deleteDelay);
        const ok = await saveRemote();
        if (!ok) p.delays.push(removed);
        renderTaskList(p);
        renderDelays(p);
      });
    });
    wrap.querySelectorAll("[data-delete-note]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const removed = p.notes.find((n) => n.id === btn.dataset.deleteNote);
        p.notes = p.notes.filter((n) => n.id !== btn.dataset.deleteNote);
        const ok = await saveRemote();
        if (!ok) p.notes.push(removed);
        renderTaskList(p);
        renderNotes(p);
      });
    });
  }

  document.getElementById("addTaskBtn").addEventListener("click", () => openTaskModal(getProject(currentProjectId)));

  // ---------- Delays ----------
  function renderDelays(p) {
    const list = document.getElementById("delaysList");
    if (!p.delays.length) { list.innerHTML = `<div class="empty-state">No delays logged.</div>`; return; }
    const sorted = [...p.delays].sort((a, b) => b.date.localeCompare(a.date));
    list.innerHTML = sorted.map((d) => {
      const task = p.tasks.find((t) => t.id === d.taskId);
      const del = isEditor ? `<button class="btn-icon" data-delete-delay="${d.id}" title="Delete">&times;</button>` : "";
      return `
        <div class="log-item delay">
          <div class="log-item-head">
            <span class="log-item-meta">${fmtDate(d.date)}${task ? " &bull; " + escapeHtml(task.name) : ""}${d.days ? " &bull; " + d.days + " day(s)" : ""}</span>
            ${del}
          </div>
          <div class="log-item-text">${escapeHtml(d.reason)}</div>
        </div>`;
    }).join("");
    if (isEditor) {
      list.querySelectorAll("[data-delete-delay]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const removed = p.delays.find((d) => d.id === btn.dataset.deleteDelay);
          p.delays = p.delays.filter((d) => d.id !== btn.dataset.deleteDelay);
          const ok = await saveRemote();
          if (!ok) p.delays.push(removed);
          renderDelays(p);
          renderTaskList(p);
        });
      });
    }
  }
  document.getElementById("addDelayBtn").addEventListener("click", () => openDelayModal(getProject(currentProjectId)));

  // ---------- Notes ----------
  function renderNotes(p) {
    const list = document.getElementById("notesList");
    if (!p.notes.length) { list.innerHTML = `<div class="empty-state">No notes yet.</div>`; return; }
    const sorted = [...p.notes].sort((a, b) => b.date.localeCompare(a.date));
    list.innerHTML = sorted.map((n) => {
      const task = p.tasks.find((t) => t.id === n.taskId);
      const del = isEditor ? `<button class="btn-icon" data-delete-note="${n.id}" title="Delete">&times;</button>` : "";
      return `
      <div class="log-item note">
        <div class="log-item-head">
          <span class="log-item-meta">${fmtDate(n.date)}${task ? " &bull; " + escapeHtml(task.name) : ""}${n.author ? " &bull; " + escapeHtml(n.author) : ""}</span>
          ${del}
        </div>
        <div class="log-item-text">${escapeHtml(n.text)}</div>
      </div>`;
    }).join("");
    if (isEditor) {
      list.querySelectorAll("[data-delete-note]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const removed = p.notes.find((n) => n.id === btn.dataset.deleteNote);
          p.notes = p.notes.filter((n) => n.id !== btn.dataset.deleteNote);
          const ok = await saveRemote();
          if (!ok) p.notes.push(removed);
          renderNotes(p);
          renderTaskList(p);
        });
      });
    }
  }
  document.getElementById("addNoteBtn").addEventListener("click", () => openNoteModal(getProject(currentProjectId)));

  // ---------- modal system ----------
  const modalBackdrop = document.getElementById("modalBackdrop");
  const modalTitle = document.getElementById("modalTitle");
  const modalBody = document.getElementById("modalBody");
  const modalSaveBtn = document.getElementById("modalSaveBtn");
  const modalCancelBtn = document.getElementById("modalCancelBtn");

  function closeModal() { modalBackdrop.classList.add("hidden"); modalSaveBtn.onclick = null; }
  modalCancelBtn.addEventListener("click", closeModal);
  modalBackdrop.addEventListener("click", (e) => { if (e.target === modalBackdrop) closeModal(); });

  function openModal(title, bodyHtml, onSave) {
    modalTitle.textContent = title;
    modalBody.innerHTML = bodyHtml;
    modalBackdrop.classList.remove("hidden");
    modalSaveBtn.onclick = async () => {
      modalSaveBtn.disabled = true;
      let result;
      try {
        result = await onSave();
      } finally {
        modalSaveBtn.disabled = false;
      }
      if (result !== false) closeModal();
    };
  }

  function openProjectModal(project) {
    const isEdit = !!project;
    const body = `
      <div class="modal-field"><label>Project name</label><input type="text" id="f-name" value="${escapeHtml(project?.name || "")}"></div>
      <div class="modal-field"><label>Client</label><input type="text" id="f-client" value="${escapeHtml(project?.client || "")}"></div>
      <div class="modal-row">
        <div class="modal-field"><label>Start date</label><input type="date" id="f-start" value="${project?.startDate || todayStr()}"></div>
        <div class="modal-field"><label>Target end date</label><input type="date" id="f-end" value="${project?.endDate || ""}"></div>
      </div>
      <div class="modal-field"><label>Description</label><textarea id="f-desc">${escapeHtml(project?.description || "")}</textarea></div>
    `;
    openModal(isEdit ? "Edit Project" : "New Project", body, async () => {
      const name = document.getElementById("f-name").value.trim();
      if (!name) { alert("Project name is required."); return false; }
      if (isEdit) {
        const prev = { ...project };
        project.name = name;
        project.client = document.getElementById("f-client").value.trim();
        project.startDate = document.getElementById("f-start").value;
        project.endDate = document.getElementById("f-end").value;
        project.description = document.getElementById("f-desc").value.trim();
        const ok = await saveRemote();
        if (!ok) { Object.assign(project, prev); return false; }
        renderDetail(project);
        renderList();
      } else {
        const p = {
          id: uid(), name, client: document.getElementById("f-client").value.trim(),
          status: "on_track",
          startDate: document.getElementById("f-start").value,
          endDate: document.getElementById("f-end").value,
          description: document.getElementById("f-desc").value.trim(),
          tasks: [], delays: [], notes: [],
        };
        state.projects.push(p);
        const ok = await saveRemote();
        if (!ok) { state.projects.pop(); return false; }
        renderList();
        location.hash = "project/" + p.id;
      }
    });
  }

  function openTaskModal(project, task) {
    const isEdit = !!task;
    const blocked = isEdit ? descendantsOf(project, task.id) : new Set();
    const candidates = project.tasks.filter((t) => t.id !== task?.id && !blocked.has(t.id));
    const selectedPreds = new Set(task?.predecessors || []);
    const predCheckboxes = candidates.length
      ? candidates.map((t) => `
          <label class="checkbox-row"><input type="checkbox" class="f-predecessor" value="${t.id}" ${selectedPreds.has(t.id) ? "checked" : ""}> ${escapeHtml(t.name)}</label>`).join("")
      : `<p class="modal-hint">No other tasks to depend on yet.</p>`;
    const defaultDuration = isEdit ? taskDuration(task) : 1;

    const body = `
      <div class="modal-field"><label>Task name</label><input type="text" id="f-name" value="${escapeHtml(task?.name || "")}"></div>
      <div class="modal-row">
        <div class="modal-field"><label>Start date</label><input type="date" id="f-start" value="${task?.startDate || todayStr()}"></div>
        <div class="modal-field"><label>Duration (days)</label><input type="number" id="f-duration" min="1" value="${defaultDuration}"></div>
      </div>
      <div class="modal-field">
        <label>Predecessors <span class="modal-label-hint">(starts after these finish)</span></label>
        <div class="checkbox-list">${predCheckboxes}</div>
      </div>
      <div class="modal-field"><label>Responsible</label><input type="text" id="f-owner" value="${escapeHtml(task?.responsible || "")}" placeholder="Who owns this task"></div>
      <div class="modal-row">
        <div class="modal-field"><label>Status</label>
          <select id="f-status">
            <option value="not_started">Not Started</option>
            <option value="in_progress">In Progress</option>
            <option value="delayed">Delayed</option>
            <option value="complete">Complete</option>
          </select>
        </div>
        <div class="modal-field"><label>Progress (%)</label><input type="number" id="f-progress" min="0" max="100" value="${task?.progress ?? 0}"></div>
      </div>
      <label class="checkbox-row"><input type="checkbox" id="f-no-impact" ${task?.noScheduleImpact ? "checked" : ""}> No impact on schedule <span class="modal-label-hint">(excluded from overall % complete)</span></label>
    `;
    openModal(isEdit ? "Edit Task" : "Add Task", body, async () => {
      const name = document.getElementById("f-name").value.trim();
      const duration = Math.max(1, Math.round(num(document.getElementById("f-duration").value)) || 1);
      const predecessors = Array.from(document.querySelectorAll(".f-predecessor:checked")).map((el) => el.value);
      let startDate = document.getElementById("f-start").value;
      if (!name || !startDate) { alert("Task name and start date are required."); return false; }
      if (predecessors.length) {
        const latestEnd = Math.max(...predecessors.map((id) => new Date(project.tasks.find((t) => t.id === id).endDate + "T00:00:00").getTime()));
        startDate = new Date(latestEnd + 86400000).toISOString().slice(0, 10);
      }
      const endDate = addDays(startDate, duration - 1);
      const vals = {
        name, startDate, endDate, duration, predecessors,
        responsible: document.getElementById("f-owner").value.trim(),
        status: document.getElementById("f-status").value,
        progress: Math.max(0, Math.min(100, Math.round(num(document.getElementById("f-progress").value)))),
        noScheduleImpact: document.getElementById("f-no-impact").checked,
      };
      let prev = null;
      let addedTask = null;
      if (isEdit) { prev = { ...task }; Object.assign(task, vals); }
      else { addedTask = { id: uid(), ...vals }; project.tasks.push(addedTask); }
      recalcSchedule(project);
      const ok = await saveRemote();
      if (!ok) {
        if (isEdit) Object.assign(task, prev);
        else project.tasks.pop();
        recalcSchedule(project);
        return false;
      }
      renderTaskList(project);
      renderList();
    });

    const startInput = document.getElementById("f-start");
    const syncStartDisabled = () => {
      const hasPreds = document.querySelectorAll(".f-predecessor:checked").length > 0;
      startInput.disabled = hasPreds;
      startInput.title = hasPreds ? "Auto-calculated from predecessor end date" : "";
    };
    document.querySelectorAll(".f-predecessor").forEach((cb) => cb.addEventListener("change", syncStartDisabled));
    syncStartDisabled();
    document.getElementById("f-status").value = isEdit ? task.status : "not_started";
  }

  function openDelayModal(project, presetTask) {
    const taskOptions = project.tasks.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("");
    const body = `
      <div class="modal-field"><label>Date</label><input type="date" id="f-date" value="${todayStr()}"></div>
      <div class="modal-field"><label>Related task (optional)</label>
        <select id="f-task"><option value="">&mdash; None &mdash;</option>${taskOptions}</select>
      </div>
      <div class="modal-field"><label>Days delayed (optional)</label><input type="number" id="f-days" min="0" value="0"></div>
      <div class="modal-field"><label>Reason</label><textarea id="f-reason" placeholder="What caused the delay?"></textarea></div>
    `;
    openModal("Log Delay", body, async () => {
      const reason = document.getElementById("f-reason").value.trim();
      if (!reason) { alert("Please describe the delay."); return false; }
      const entry = {
        id: uid(),
        date: document.getElementById("f-date").value || todayStr(),
        taskId: document.getElementById("f-task").value || null,
        days: Math.max(0, Math.round(num(document.getElementById("f-days").value))),
        reason,
      };
      project.delays.push(entry);
      const ok = await saveRemote();
      if (!ok) { project.delays.pop(); return false; }
      renderDelays(project);
      renderTaskList(project);
    });
    if (presetTask) document.getElementById("f-task").value = presetTask.id;
  }

  function openNoteModal(project, presetTask) {
    const taskOptions = project.tasks.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("");
    const body = `
      <div class="modal-field"><label>Date</label><input type="date" id="f-date" value="${todayStr()}"></div>
      <div class="modal-field"><label>Related task (optional)</label>
        <select id="f-task"><option value="">&mdash; None &mdash;</option>${taskOptions}</select>
      </div>
      <div class="modal-field"><label>Author</label><input type="text" id="f-author" placeholder="Your name"></div>
      <div class="modal-field"><label>Note</label><textarea id="f-text" placeholder="What's the update?"></textarea></div>
    `;
    openModal("Add Note", body, async () => {
      const text = document.getElementById("f-text").value.trim();
      if (!text) { alert("Note can't be empty."); return false; }
      const entry = {
        id: uid(),
        date: document.getElementById("f-date").value || todayStr(),
        taskId: document.getElementById("f-task").value || null,
        author: document.getElementById("f-author").value.trim(),
        text,
      };
      project.notes.push(entry);
      const ok = await saveRemote();
      if (!ok) { project.notes.pop(); return false; }
      renderNotes(project);
      renderTaskList(project);
    });
    if (presetTask) document.getElementById("f-task").value = presetTask.id;
  }

  // ---------- init ----------
  (async () => {
    isEditor = !!getStoredPassword();
    await loadRemote();
    updateEditorUI();
    route();
  })();
})();
