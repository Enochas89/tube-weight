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
  let currentTravelerId = null;
  let isEditor = false;
  const selectedTaskIds = new Set();

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
  function getTraveler(project, id) { return project ? project.travelers.find((t) => t.id === id) : null; }
  function allTasks(project) { return project.travelers.flatMap((t) => t.tasks); }

  // Projects created before travelers existed carried tasks/delays/notes
  // directly — wrap them into a single "General" traveler so old data keeps
  // working without a manual migration step.
  function migrateProject(p) {
    if (!Array.isArray(p.travelers)) {
      p.travelers = [{
        id: uid(),
        name: "General",
        description: "",
        status: p.status || "on_track",
        tasks: Array.isArray(p.tasks) ? p.tasks : [],
        delays: Array.isArray(p.delays) ? p.delays : [],
        notes: Array.isArray(p.notes) ? p.notes : [],
      }];
      delete p.tasks;
      delete p.delays;
      delete p.notes;
    }
  }

  function addDays(dateStr, n) {
    return new Date(new Date(dateStr + "T00:00:00").getTime() + n * 86400000).toISOString().slice(0, 10);
  }
  function daysBetween(a, b) {
    return Math.round((new Date(b + "T00:00:00").getTime() - new Date(a + "T00:00:00").getTime()) / 86400000);
  }
  function taskDuration(t) {
    return t.duration || Math.max(1, daysBetween(t.startDate, t.endDate) + 1);
  }

  // Project-level "block out Sat/Sun" — non-working days are skipped when
  // scheduling a task's span or the gap after a predecessor, but a manually
  // chosen start date is never moved on its own.
  function isBlockedDay(dateStr, project) {
    const dow = new Date(dateStr + "T00:00:00").getDay();
    return (project.excludeSat && dow === 6) || (project.excludeSun && dow === 0);
  }
  function nextWorkDay(dateStr, project) {
    let d = dateStr;
    while (isBlockedDay(d, project)) d = addDays(d, 1);
    return d;
  }
  function endDateForDuration(startDate, duration, project) {
    let d = startDate;
    let remaining = duration - 1;
    while (remaining > 0) {
      d = addDays(d, 1);
      if (!isBlockedDay(d, project)) remaining--;
    }
    return d;
  }

  // Tasks that (transitively) depend on taskId — used to keep the
  // predecessor picker from offering a choice that would create a cycle.
  // Predecessors can cross traveler boundaries within the same project, so
  // this walks every task in the project, not just one traveler's.
  function descendantsOf(project, taskId, visited) {
    visited = visited || new Set();
    allTasks(project).forEach((t) => {
      if ((t.predecessors || []).includes(taskId) && !visited.has(t.id)) {
        visited.add(t.id);
        descendantsOf(project, t.id, visited);
      }
    });
    return visited;
  }
  function successorsOf(project, taskId) {
    return allTasks(project).filter((t) => (t.predecessors || []).includes(taskId));
  }

  // Pushes every task's start/end forward to sit right after its latest
  // predecessor finishes. Repeats to a fixed point so changes cascade through
  // chains (A -> B -> C) — safe for any dependency DAG since each pass
  // resolves one more hop, and it's a no-op once nothing moves. Operates
  // across the whole project (all travelers) since predecessors can cross
  // traveler boundaries.
  function recalcSchedule(project) {
    const all = allTasks(project);
    const byId = {};
    all.forEach((t) => { byId[t.id] = t; });
    for (let pass = 0; pass <= all.length; pass++) {
      let changed = false;
      all.forEach((t) => {
        const preds = (t.predecessors || []).map((id) => byId[id]).filter(Boolean);
        if (!preds.length) return;
        const latestEnd = Math.max(...preds.map((pr) => new Date(pr.endDate + "T00:00:00").getTime()));
        const newStart = nextWorkDay(new Date(latestEnd + 86400000).toISOString().slice(0, 10), project);
        const newEnd = endDateForDuration(newStart, taskDuration(t), project);
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
  // "Responsible" holds one or more names separated by commas/semicolons —
  // multiple assignees on a task, not just one.
  function parseNames(str) {
    return String(str || "").split(/[,;]/).map((s) => s.trim()).filter(Boolean);
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
  document.getElementById("shareProjectListBtn").addEventListener("click", () => {
    copyLink(location.origin + location.pathname + "#project/" + currentProjectId);
  });
  document.getElementById("shareProjectBtn").addEventListener("click", () => {
    copyLink(location.origin + location.pathname + "#project/" + currentProjectId + "/traveler/" + currentTravelerId);
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
    route();
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
      state.projects.forEach(migrateProject);
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
    const travelerMatch = hash.match(/^project\/([^/]+)\/traveler\/([^/]+)$/);
    if ((travelerMatch ? travelerMatch[2] : null) !== currentTravelerId) selectedTaskIds.clear();
    if (travelerMatch) {
      const p = getProject(travelerMatch[1]);
      const trav = p && getTraveler(p, travelerMatch[2]);
      if (!p || !trav) { location.hash = p ? "project/" + p.id : ""; return; }
      currentProjectId = p.id;
      currentTravelerId = trav.id;
      showTravelerDetail(p, trav);
      return;
    }
    const projectMatch = hash.match(/^project\/([^/]+)$/);
    if (projectMatch) {
      const p = getProject(projectMatch[1]);
      if (!p) { location.hash = ""; return; }
      currentProjectId = p.id;
      currentTravelerId = null;
      showTravelerList(p);
      return;
    }
    currentProjectId = null;
    currentTravelerId = null;
    showList();
  }
  window.addEventListener("hashchange", route);

  function hideAllViews() {
    document.getElementById("listView").classList.add("hidden");
    document.getElementById("travelerListView").classList.add("hidden");
    document.getElementById("detailView").classList.add("hidden");
  }
  function showList() {
    hideAllViews();
    document.getElementById("listView").classList.remove("hidden");
    renderList();
  }
  function showTravelerList(p) {
    hideAllViews();
    document.getElementById("travelerListView").classList.remove("hidden");
    renderTravelerList(p);
  }
  function showTravelerDetail(p, trav) {
    hideAllViews();
    document.getElementById("detailView").classList.remove("hidden");
    renderTravelerDetail(p, trav);
  }

  // Polls for changes made elsewhere (another editor, the shop-floor QR
  // flow, a claimed traveler) and re-renders whatever's currently on screen.
  // Skipped while a modal is open so it never yanks data out from under an
  // in-progress edit; skipped quietly (no error toast) on a failed fetch
  // since this runs unattended in the background.
  async function silentRefresh() {
    if (!modalBackdrop.classList.contains("hidden")) return;
    try {
      const res = await fetch(API_URL);
      if (!res.ok) return;
      const data = await res.json();
      if (!data || !Array.isArray(data.projects)) return;
      data.projects.forEach(migrateProject);
      state = data;
      route();
    } catch (e) {
      // background poll -- fails silently, next interval will retry
    }
  }

  // ---------- project list view ----------
  function projectProgress(p) {
    const counted = allTasks(p).filter((t) => !t.noScheduleImpact);
    if (!counted.length) return 0;
    return Math.round(counted.reduce((a, t) => a + (t.progress || 0), 0) / counted.length);
  }
  function travelerProgress(trav) {
    const counted = trav.tasks.filter((t) => !t.noScheduleImpact);
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
      const taskCount = allTasks(p).length;
      const travelerCount = p.travelers.length;
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
            <span>${travelerCount} traveler${travelerCount === 1 ? "" : "s"}</span>
            <span>${taskCount} task${taskCount === 1 ? "" : "s"}</span>
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
  function directChildren(el, tag) {
    return Array.from(el.children).filter((c) => c.localName === tag);
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

    // A task is a summary/rollup (not a real work item) if explicitly
    // flagged, or if the next task nests one level deeper (i.e. has
    // children) — some MSP exports don't set <Summary>1</Summary> reliably.
    function isSummaryRow(rt, i) {
      if (rt.explicitSummary) return true;
      const next = rawTasks[i + 1];
      return !!(next && rt.outlineLevel !== null && next.outlineLevel !== null && next.outlineLevel > rt.outlineLevel);
    }

    const uidToName = {};
    const groups = [];
    let currentGroup = null;
    rawTasks.forEach((rt, i) => {
      const t = rt.el;
      if (!rt.uid || rt.uid === "0") return; // UID 0 is the whole-project rollup, not a real task
      const name = directChildText(t, "Name");
      if (name.trim().toLowerCase() === normalizedProjectName) return; // rollup row named after the project itself

      if (isSummaryRow(rt, i)) {
        // A top-level (outline 1) summary starts a new traveler group; a
        // deeper summary (sub-phase within a traveler) doesn't split further
        // — its children just fold into the current group.
        if (rt.outlineLevel === 1 || !currentGroup) {
          currentGroup = { name: name || "Traveler " + (groups.length + 1), tasks: [] };
          groups.push(currentGroup);
        }
        return;
      }

      const start = directChildText(t, "Start");
      const finish = directChildText(t, "Finish");
      if (!name || !start || !finish) return;
      const startDate = start.slice(0, 10);
      const endDate = finish.slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return;

      const pct = Math.max(0, Math.min(100, Math.round(num(directChildText(t, "PercentComplete")))));
      const status = pct >= 100 ? "complete" : pct > 0 ? "in_progress" : "not_started";
      const responsible = (taskResources[rt.uid] || []).join(", ");
      const predecessorUids = directChildren(t, "PredecessorLink").map((pl) => directChildText(pl, "PredecessorUID")).filter(Boolean);

      const task = { name, startDate, endDate, responsible, status, progress: pct, _predecessorUids: predecessorUids };
      uidToName[rt.uid] = name;
      if (!currentGroup) { currentGroup = { name: projectName, tasks: [] }; groups.push(currentGroup); }
      currentGroup.tasks.push(task);
    });

    // Resolve predecessor UIDs to names now that every task's name is known,
    // matching the same _predecessorNames convention the Excel importer uses
    // so both paths share one resolution/auto-chain step at import time.
    const travelers = groups.filter((g) => g.tasks.length).map((g) => ({
      name: g.name,
      tasks: g.tasks.map((t) => {
        const predecessorNames = t._predecessorUids.map((u) => uidToName[u]).filter(Boolean);
        const { _predecessorUids, ...rest } = t;
        return { ...rest, _predecessorNames: predecessorNames };
      }),
    }));

    return { projectName, travelers };
  }

  // Resolves each task's _predecessorNames (set by either import parser)
  // into real predecessor ids, auto-chaining sequentially within its own
  // traveler wherever no explicit predecessor was given. Shared by both the
  // new-project and add-to-existing-project import paths.
  function resolvePredecessorNames(travelers, existingProject) {
    const nameToId = {};
    if (existingProject) allTasks(existingProject).forEach((t) => { nameToId[t.name.trim().toLowerCase()] = t.id; });
    travelers.forEach((trav) => trav.tasks.forEach((t) => { nameToId[t.name.trim().toLowerCase()] = t.id; }));
    travelers.forEach((trav) => {
      trav.tasks.forEach((t, i) => {
        if (t._predecessorNames && t._predecessorNames.length) {
          t.predecessors = t._predecessorNames.map((n) => nameToId[n.trim().toLowerCase()]).filter(Boolean);
        } else if (i > 0) {
          t.predecessors = [trav.tasks[i - 1].id];
        }
        delete t._predecessorNames;
      });
    });
  }

  // Adds one traveler per {name, tasks} entry to an EXISTING project. Used
  // by the "Import from..." buttons within a project's traveler list, for
  // both MS Project and Excel sources.
  function openAddTravelersToProjectModal(project, travelersData, sourceLabel) {
    const totalTasks = travelersData.reduce((a, t) => a + t.tasks.length, 0);
    const names = travelersData.map((t) => escapeHtml(t.name)).join(", ");
    const single = travelersData.length === 1;
    const body = `<p style="font-size:0.9rem;">Found ${travelersData.length} traveler${single ? "" : "s"} (${totalTasks} tasks total): ${names}.</p><p style="font-size:0.85rem;color:var(--text-dim);">${single ? "It" : "Each"} will be added as ${single ? "a" : "its own"} traveler to <strong>${escapeHtml(project.name)}</strong>.</p>`;
    openModal(`Import from ${sourceLabel}`, body, async () => {
      const newTravelers = travelersData.map((t) => ({
        id: uid(), name: t.name, description: "", status: "on_hold",
        tasks: t.tasks.map((tk) => ({ id: uid(), ...tk, predecessors: [] })),
        delays: [], notes: [],
      }));
      resolvePredecessorNames(newTravelers, project);
      project.travelers.push(...newTravelers);
      recalcSchedule(project);
      const ok = await saveRemote();
      if (!ok) { newTravelers.forEach(() => project.travelers.pop()); return false; }
      renderTravelerList(project);
    });
  }

  // One workbook, multiple travelers: each sheet with a name/duration/predecessor
  // column becomes its own traveler under a single new project. Predecessors
  // reference other tasks BY NAME (matched across the whole workbook, so a
  // traveler's first task can depend on another traveler's last one); any
  // task without an explicit predecessor auto-chains after the previous row
  // in its own sheet.
  function openMultiTravelerImportModal(travelersData, sourceLabel) {
    const totalTasks = travelersData.reduce((a, t) => a + t.tasks.length, 0);
    const names = travelersData.map((t) => escapeHtml(t.name)).join(", ");
    const body = `
      <div class="modal-field"><label>Project name</label><input type="text" id="f-name" value=""></div>
      <div class="modal-field"><label>Client</label><input type="text" id="f-client" value=""></div>
      <p style="font-size:0.85rem;color:var(--text-dim);margin:-6px 0 12px;">Found ${travelersData.length} traveler${travelersData.length === 1 ? "" : "s"} (${totalTasks} tasks total): ${names}.</p>
    `;
    openModal(`Import from ${sourceLabel}`, body, async () => {
      const name = document.getElementById("f-name").value.trim();
      if (!name) { alert("Project name is required."); return false; }

      const travelers = travelersData.map((t) => ({
        id: uid(), name: t.name, description: "", status: "on_hold",
        tasks: t.tasks.map((tk) => ({ id: uid(), ...tk, predecessors: [] })),
        delays: [], notes: [],
      }));
      resolvePredecessorNames(travelers, null);

      const p = {
        id: uid(), name, client: document.getElementById("f-client").value.trim(),
        status: "on_track",
        startDate: todayStr(), endDate: "",
        description: `Imported from ${sourceLabel} (${travelersData.length} travelers, ${totalTasks} tasks).`,
        travelers,
      };
      recalcSchedule(p);
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
      if (!parsed.travelers.length) {
        alert("No importable tasks found in that file. Summary rows are skipped automatically, so this can happen if every row is a summary task.");
        return;
      }
      openMultiTravelerImportModal(parsed.travelers, "Microsoft Project");
    } catch (err) {
      alert("Couldn't import that file: " + err.message);
    }
  });
  document.getElementById("importMspTravelerBtn").addEventListener("click", () => {
    document.getElementById("importFileInputTraveler").click();
  });
  document.getElementById("importFileInputTraveler").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseMsProjectXml(text);
      if (!parsed.travelers.length) {
        alert("No importable tasks found in that file. Summary rows are skipped automatically, so this can happen if every row is a summary task.");
        return;
      }
      openAddTravelersToProjectModal(getProject(currentProjectId), parsed.travelers, "Microsoft Project");
    } catch (err) {
      alert("Couldn't import that file: " + err.message);
    }
  });

  // ---------- Excel import ----------
  // Parsing lives in excel-parser.js (shared with the shop-floor quick-add
  // page); it returns tasks with `predecessorNames` which resolvePredecessorNames
  // below reads as `_predecessorNames` for consistency with the MSP import path.
  function extractTravelersFromFiles(fileList) {
    return window.ExcelParser.extractTravelersFromFiles(fileList).then((travelers) => {
      travelers.forEach((t) => t.tasks.forEach((tk) => { tk._predecessorNames = tk.predecessorNames; delete tk.predecessorNames; }));
      return travelers;
    });
  }

  document.getElementById("importExcelBtn").addEventListener("click", () => {
    document.getElementById("importExcelInput").click();
  });
  document.getElementById("importExcelInput").addEventListener("change", async (e) => {
    const files = Array.from(e.target.files);
    e.target.value = "";
    if (!files.length) return;
    try {
      const travelersData = await extractTravelersFromFiles(files);
      openMultiTravelerImportModal(travelersData, "Excel");
    } catch (err) {
      alert("Couldn't import that file: " + err.message);
    }
  });
  document.getElementById("importExcelTravelerBtn").addEventListener("click", () => {
    document.getElementById("importExcelInputTraveler").click();
  });
  document.getElementById("importExcelInputTraveler").addEventListener("change", async (e) => {
    const files = Array.from(e.target.files);
    e.target.value = "";
    if (!files.length) return;
    try {
      const travelersData = await extractTravelersFromFiles(files);
      openAddTravelersToProjectModal(getProject(currentProjectId), travelersData, "Excel");
    } catch (err) {
      alert("Couldn't import that file: " + err.message);
    }
  });

  // ---------- traveler list (within a project) ----------
  // The note count in a traveler tile's meta row doubles as a hover target —
  // hovering it (desktop) shows the most recent notes without opening the
  // traveler. Plain "No notes" stays a non-interactive span when there's
  // nothing to preview.
  function notesMetaHtml(trav) {
    if (!trav.notes.length) return `<span>No notes</span>`;
    const sorted = [...trav.notes].sort((a, b) => b.date.localeCompare(a.date));
    const shown = sorted.slice(0, 4);
    const more = sorted.length - shown.length;
    const itemsHtml = shown.map((n) => `
      <div class="notes-preview-item">
        <span class="notes-preview-meta">${fmtDate(n.date)}${n.author ? " &bull; " + escapeHtml(n.author) : ""}</span>
        <div class="notes-preview-text">${escapeHtml(n.text)}</div>
      </div>`).join("");
    return `
      <span class="notes-hover-wrap">
        <span class="notes-hover-label">${trav.notes.length} note${trav.notes.length === 1 ? "" : "s"}</span>
        <div class="notes-preview">
          ${itemsHtml}
          ${more > 0 ? `<div class="notes-preview-more">+${more} more — open the traveler to see all</div>` : ""}
        </div>
      </span>`;
  }

  function renderTravelerList(p) {
    document.getElementById("travelerListProjectName").textContent = p.name;
    document.getElementById("travelerListProjectClient").textContent = p.client || "";
    document.getElementById("travelerListProjectDescription").textContent = p.description || "";

    const statusSelect = document.getElementById("travelerListProjectStatus");
    const statusBadgeReadonly = document.getElementById("travelerListProjectStatusBadge");
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

    const grid = document.getElementById("travelerGrid");
    if (!p.travelers.length) {
      grid.innerHTML = `<div class="empty-state">No travelers yet.${isEditor ? ' Click "+ New Traveler" to add one, or import from MS Project/Excel.' : ""}</div>`;
    } else {
      grid.innerHTML = p.travelers.map((trav) => {
        const progress = travelerProgress(trav);
        const deleteBtn = isEditor ? `<button class="btn-icon card-delete-btn" type="button" data-delete-traveler="${trav.id}" title="Delete traveler">&times;</button>` : "";
        return `
          <div class="project-card" data-traveler-id="${trav.id}">
            <div class="project-card-top">
              <div>
                <h3>${escapeHtml(trav.name)}</h3>
                <p class="client">${escapeHtml(trav.description || "—")}</p>
              </div>
              <div class="project-card-top-actions">
                <span class="status-badge ${trav.status}">${STATUS_LABELS[trav.status]}</span>
                ${deleteBtn}
              </div>
            </div>
            <div class="progress-bar"><div class="progress-bar-fill" style="width:${progress}%"></div></div>
            <div class="project-card-meta">
              <span>${trav.tasks.length} task${trav.tasks.length === 1 ? "" : "s"}</span>
              <span>${trav.delays.length ? trav.delays.length + " delay" + (trav.delays.length === 1 ? "" : "s") : "No delays"}</span>
              ${notesMetaHtml(trav)}
              <span>${progress}%</span>
            </div>
            <div class="card-actions-row">
              <button class="btn-secondary card-open-btn" type="button">Open &rarr;</button>
              ${isEditor ? `<button class="btn-chip" type="button" data-note-traveler="${trav.id}">+ Note</button>` : ""}
            </div>
          </div>`;
      }).join("");
    }
    grid.querySelectorAll("[data-traveler-id]").forEach((card) => {
      card.addEventListener("click", () => { location.hash = "project/" + p.id + "/traveler/" + card.dataset.travelerId; });
    });
    grid.querySelectorAll("[data-note-traveler]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const trav = p.travelers.find((t) => t.id === btn.dataset.noteTraveler);
        openNoteModal(p, trav);
      });
    });
    // Hover doesn't exist on touch devices, so the notes preview also opens
    // on tap/click — toggling one closes any other that's open, and tapping
    // anywhere else closes it too (wired once globally, not per render).
    grid.querySelectorAll(".notes-hover-label").forEach((label) => {
      label.addEventListener("click", (e) => {
        e.stopPropagation();
        const wrap = label.closest(".notes-hover-wrap");
        const wasOpen = wrap.classList.contains("open");
        document.querySelectorAll(".notes-hover-wrap.open").forEach((w) => w.classList.remove("open"));
        if (!wasOpen) wrap.classList.add("open");
      });
    });
    grid.querySelectorAll("[data-delete-traveler]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const travelerId = btn.dataset.deleteTraveler;
        const trav = p.travelers.find((t) => t.id === travelerId);
        if (!confirm(`Delete "${trav.name}"? This can't be undone.`)) return;
        p.travelers = p.travelers.filter((t) => t.id !== travelerId);
        const ok = await saveRemote();
        if (!ok) { p.travelers.push(trav); return; }
        renderTravelerList(p);
        renderList();
      });
    });
  }

  document.getElementById("backToProjectsBtn").addEventListener("click", () => { location.hash = ""; });
  document.getElementById("editProjectFromListBtn").addEventListener("click", () => openProjectModal(getProject(currentProjectId)));
  document.getElementById("deleteProjectFromListBtn").addEventListener("click", async () => {
    if (!confirm("Delete this project and all its travelers? This can't be undone.")) return;
    const removed = state.projects.find((p) => p.id === currentProjectId);
    state.projects = state.projects.filter((p) => p.id !== currentProjectId);
    const ok = await saveRemote();
    if (!ok) { state.projects.push(removed); return; }
    location.hash = "";
  });
  document.getElementById("newTravelerBtn").addEventListener("click", () => openTravelerModal(getProject(currentProjectId)));

  // ---------- traveler detail view ----------
  function renderTravelerDetail(p, trav) {
    document.getElementById("detailName").textContent = trav.name;
    document.getElementById("detailClient").textContent = "Part of " + p.name;
    document.getElementById("detailDescription").textContent = trav.description || "";

    const statusSelect = document.getElementById("detailStatus");
    const statusBadgeReadonly = document.getElementById("detailStatusBadge");
    if (isEditor) {
      statusSelect.classList.remove("hidden");
      statusBadgeReadonly.classList.add("hidden");
      statusSelect.innerHTML = Object.entries(STATUS_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
      statusSelect.value = trav.status;
      statusSelect.className = "status-select " + trav.status;
      statusSelect.onchange = async () => {
        const prev = trav.status;
        trav.status = statusSelect.value;
        statusSelect.className = "status-select " + trav.status;
        const ok = await saveRemote();
        if (!ok) { trav.status = prev; statusSelect.value = prev; statusSelect.className = "status-select " + prev; }
        renderTravelerList(p);
      };
    } else {
      statusSelect.classList.add("hidden");
      statusBadgeReadonly.classList.remove("hidden");
      statusBadgeReadonly.textContent = STATUS_LABELS[trav.status];
      statusBadgeReadonly.className = "status-badge " + trav.status;
    }

    renderTaskList(p, trav);
    renderDelays(p, trav);
    renderNotes(p, trav);
  }

  document.getElementById("backToListBtn").addEventListener("click", () => { location.hash = "project/" + currentProjectId; });
  document.getElementById("editProjectBtn").addEventListener("click", () => openTravelerModal(getProject(currentProjectId), getTraveler(getProject(currentProjectId), currentTravelerId)));
  document.getElementById("deleteProjectBtn").addEventListener("click", async () => {
    if (!confirm("Delete this traveler? This can't be undone.")) return;
    const p = getProject(currentProjectId);
    const removed = p.travelers.find((t) => t.id === currentTravelerId);
    p.travelers = p.travelers.filter((t) => t.id !== currentTravelerId);
    const ok = await saveRemote();
    if (!ok) { p.travelers.push(removed); return; }
    location.hash = "project/" + currentProjectId;
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
  function taskSubEntries(trav, taskId) {
    const delays = trav.delays.filter((d) => d.taskId === taskId).map((d) => ({ ...d, kind: "delay" }));
    const notes = trav.notes.filter((n) => n.taskId === taskId).map((n) => ({ ...n, kind: "note" }));
    return [...delays, ...notes].sort((a, b) => b.date.localeCompare(a.date));
  }

  function updateTaskBulkBar() {
    const bar = document.getElementById("taskBulkBar");
    const n = selectedTaskIds.size;
    bar.classList.toggle("hidden", n === 0);
    if (n > 0) document.getElementById("taskBulkCount").textContent = `${n} selected`;
  }

  function renderTaskList(project, trav) {
    const wrap = document.getElementById("taskListWrap");
    // Drop selections for tasks that no longer exist (e.g. deleted elsewhere).
    const liveIds = new Set(trav.tasks.map((t) => t.id));
    Array.from(selectedTaskIds).forEach((id) => { if (!liveIds.has(id)) selectedTaskIds.delete(id); });
    updateTaskBulkBar();
    if (!trav.tasks.length) {
      wrap.innerHTML = `<div class="empty-state">No tasks yet.${isEditor ? ' Click "+ Add Task" to get started.' : ""}</div>`;
      return;
    }

    const todayMs = new Date(todayStr() + "T00:00:00").getTime();
    wrap.innerHTML = trav.tasks.map((t, taskIdx) => {
      const color = TASK_STATUS_COLOR[t.status] || TASK_STATUS_COLOR.not_started;
      const isToday = todayMs >= new Date(t.startDate + "T00:00:00").getTime() && todayMs <= new Date(t.endDate + "T00:00:00").getTime();
      const actions = isEditor ? `
            <span class="task-actions">
              <button class="btn-icon" data-edit-task="${t.id}" title="Edit">&#9998;</button>
              <button class="btn-icon" data-delete-task="${t.id}" title="Delete">&times;</button>
            </span>` : "";
      const ownerNames = parseNames(t.responsible);
      const owner = ownerNames.length
        ? `<span class="avatar-group">${ownerNames.map((n) => `<span class="avatar" style="background:${avatarColor(n)}" title="${escapeHtml(n)}">${initials(n)}</span>`).join("")}</span><span class="task-owner">${ownerNames.map((n) => escapeHtml(n)).join(", ")}</span>`
        : `<span class="task-owner unassigned">Unassigned</span>`;

      // Predecessors/successors can live in a different traveler within the
      // same project, so they're looked up project-wide and tagged with
      // their traveler's name when they're not this task's own traveler.
      const preds = (t.predecessors || []).map((id) => allTasks(project).find((pt) => pt.id === id)).filter(Boolean);
      const succs = successorsOf(project, t.id);
      const labelFor = (other) => {
        const ownerTrav = project.travelers.find((tr) => tr.tasks.includes(other));
        const cross = ownerTrav && ownerTrav.id !== trav.id ? ` (${escapeHtml(ownerTrav.name)})` : "";
        return escapeHtml(other.name) + cross;
      };
      const linksHtml = (preds.length || succs.length) ? `
          <div class="task-card-links">
            ${preds.length ? `<span>After: ${preds.map(labelFor).join(", ")}</span>` : ""}
            ${succs.length ? `<span>Blocks: ${succs.map(labelFor).join(", ")}</span>` : ""}
          </div>` : "";

      const entries = taskSubEntries(trav, t.id);
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

      const currentBanner = isToday ? `<div class="current-marker">Current &bull; ${fmtDate(todayStr())}</div>` : "";
      const checkbox = isEditor ? `<input type="checkbox" class="task-select-checkbox" data-select-task="${t.id}" ${selectedTaskIds.has(t.id) ? "checked" : ""}>` : "";

      return `
        ${currentBanner}
        <div class="task-card${selectedTaskIds.has(t.id) ? " is-selected" : ""}" data-task-card="${t.id}">
          <div class="task-card-stripe" style="background:${color}"></div>
          <div class="task-card-top">
            <div class="task-card-title">
              ${checkbox}
              <span class="status-dot" style="background:${color}"></span>
              <span class="task-number" title="Task # for email updates (e.g. Tasks ${taskIdx + 1}, 100%)">#${taskIdx + 1}</span>
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

    wrap.querySelectorAll("[data-select-task]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const id = cb.dataset.selectTask;
        if (cb.checked) selectedTaskIds.add(id); else selectedTaskIds.delete(id);
        cb.closest(".task-card").classList.toggle("is-selected", cb.checked);
        updateTaskBulkBar();
      });
    });
    wrap.querySelectorAll("[data-edit-task]").forEach((el) => {
      el.addEventListener("click", () => {
        openTaskModal(project, trav, trav.tasks.find((t) => t.id === el.dataset.editTask));
      });
    });
    wrap.querySelectorAll("[data-delete-task]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this task?")) return;
        const removedId = btn.dataset.deleteTask;
        const removedTask = trav.tasks.find((t) => t.id === removedId);
        trav.tasks = trav.tasks.filter((t) => t.id !== removedId);
        const affectedDelays = trav.delays.filter((d) => d.taskId === removedId);
        affectedDelays.forEach((d) => { d.taskId = null; });
        const affectedNotes = trav.notes.filter((n) => n.taskId === removedId);
        affectedNotes.forEach((n) => { n.taskId = null; });
        const affectedPredTasks = allTasks(project).filter((t) => (t.predecessors || []).includes(removedId));
        affectedPredTasks.forEach((t) => { t.predecessors = t.predecessors.filter((id) => id !== removedId); });
        recalcSchedule(project);
        const ok = await saveRemote();
        if (!ok) {
          trav.tasks.push(removedTask);
          affectedDelays.forEach((d) => { d.taskId = removedTask.id; });
          affectedNotes.forEach((n) => { n.taskId = removedTask.id; });
          affectedPredTasks.forEach((t) => { t.predecessors.push(removedId); });
          recalcSchedule(project);
        }
        renderTaskList(project, trav);
        renderDelays(project, trav);
        renderNotes(project, trav);
        renderList();
        renderTravelerList(project);
      });
    });
    wrap.querySelectorAll("[data-add-delay-task]").forEach((btn) => {
      btn.addEventListener("click", () => {
        openDelayModal(project, trav, trav.tasks.find((t) => t.id === btn.dataset.addDelayTask));
      });
    });
    wrap.querySelectorAll("[data-add-note-task]").forEach((btn) => {
      btn.addEventListener("click", () => {
        openNoteModal(project, trav, trav.tasks.find((t) => t.id === btn.dataset.addNoteTask));
      });
    });
    wrap.querySelectorAll("[data-delete-delay]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const removed = trav.delays.find((d) => d.id === btn.dataset.deleteDelay);
        trav.delays = trav.delays.filter((d) => d.id !== btn.dataset.deleteDelay);
        const ok = await saveRemote();
        if (!ok) trav.delays.push(removed);
        renderTaskList(project, trav);
        renderDelays(project, trav);
      });
    });
    wrap.querySelectorAll("[data-delete-note]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const removed = trav.notes.find((n) => n.id === btn.dataset.deleteNote);
        trav.notes = trav.notes.filter((n) => n.id !== btn.dataset.deleteNote);
        const ok = await saveRemote();
        if (!ok) trav.notes.push(removed);
        renderTaskList(project, trav);
        renderNotes(project, trav);
      });
    });
  }

  document.getElementById("addTaskBtn").addEventListener("click", () => {
    const p = getProject(currentProjectId);
    openTaskModal(p, getTraveler(p, currentTravelerId));
  });

  async function bulkSetTaskCompletion(complete) {
    const p = getProject(currentProjectId);
    const trav = p && getTraveler(p, currentTravelerId);
    if (!trav) return;
    const targets = trav.tasks.filter((t) => selectedTaskIds.has(t.id));
    if (!targets.length) return;
    const prev = targets.map((t) => ({ id: t.id, status: t.status, progress: t.progress }));
    targets.forEach((t) => {
      t.status = complete ? "complete" : "not_started";
      t.progress = complete ? 100 : 0;
    });
    recalcSchedule(p);
    const ok = await saveRemote();
    if (!ok) {
      prev.forEach(({ id, status, progress }) => {
        const t = trav.tasks.find((tk) => tk.id === id);
        if (t) { t.status = status; t.progress = progress; }
      });
      recalcSchedule(p);
      return;
    }
    selectedTaskIds.clear();
    renderTaskList(p, trav);
    renderList();
    renderTravelerList(p);
  }
  document.getElementById("taskBulkComplete").addEventListener("click", () => bulkSetTaskCompletion(true));
  document.getElementById("taskBulkNotComplete").addEventListener("click", () => bulkSetTaskCompletion(false));
  document.getElementById("taskBulkClear").addEventListener("click", () => {
    selectedTaskIds.clear();
    const p = getProject(currentProjectId);
    const trav = p && getTraveler(p, currentTravelerId);
    if (trav) renderTaskList(p, trav);
  });

  // ---------- Delays ----------
  function renderDelays(project, trav) {
    const list = document.getElementById("delaysList");
    if (!trav.delays.length) { list.innerHTML = `<div class="empty-state">No delays logged.</div>`; return; }
    const sorted = [...trav.delays].sort((a, b) => b.date.localeCompare(a.date));
    list.innerHTML = sorted.map((d) => {
      const task = trav.tasks.find((t) => t.id === d.taskId);
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
          const removed = trav.delays.find((d) => d.id === btn.dataset.deleteDelay);
          trav.delays = trav.delays.filter((d) => d.id !== btn.dataset.deleteDelay);
          const ok = await saveRemote();
          if (!ok) trav.delays.push(removed);
          renderDelays(project, trav);
          renderTaskList(project, trav);
        });
      });
    }
  }
  document.getElementById("addDelayBtn").addEventListener("click", () => {
    const p = getProject(currentProjectId);
    openDelayModal(p, getTraveler(p, currentTravelerId));
  });

  // ---------- Notes ----------
  function renderNotes(project, trav) {
    const list = document.getElementById("notesList");
    if (!trav.notes.length) { list.innerHTML = `<div class="empty-state">No notes yet.</div>`; return; }
    const sorted = [...trav.notes].sort((a, b) => b.date.localeCompare(a.date));
    list.innerHTML = sorted.map((n) => {
      const task = trav.tasks.find((t) => t.id === n.taskId);
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
          const removed = trav.notes.find((n) => n.id === btn.dataset.deleteNote);
          trav.notes = trav.notes.filter((n) => n.id !== btn.dataset.deleteNote);
          const ok = await saveRemote();
          if (!ok) trav.notes.push(removed);
          renderNotes(project, trav);
          renderTaskList(project, trav);
        });
      });
    }
  }
  document.getElementById("addNoteBtn").addEventListener("click", () => {
    const p = getProject(currentProjectId);
    openNoteModal(p, getTraveler(p, currentTravelerId));
  });

  // Tapping/clicking anywhere outside an open notes preview closes it.
  document.addEventListener("click", (e) => {
    if (e.target.closest(".notes-hover-wrap")) return;
    document.querySelectorAll(".notes-hover-wrap.open").forEach((w) => w.classList.remove("open"));
  });

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
      <div class="modal-field">
        <label>Non-working days <span class="modal-label-hint">(skipped when scheduling task durations and predecessors)</span></label>
        <label class="checkbox-row"><input type="checkbox" id="f-exclude-sat" ${project?.excludeSat ? "checked" : ""}> Block out Saturdays</label>
        <label class="checkbox-row"><input type="checkbox" id="f-exclude-sun" ${project?.excludeSun ? "checked" : ""}> Block out Sundays</label>
      </div>
    `;
    openModal(isEdit ? "Edit Project" : "New Project", body, async () => {
      const name = document.getElementById("f-name").value.trim();
      if (!name) { alert("Project name is required."); return false; }
      const excludeSat = document.getElementById("f-exclude-sat").checked;
      const excludeSun = document.getElementById("f-exclude-sun").checked;
      if (isEdit) {
        const prev = { ...project };
        project.name = name;
        project.client = document.getElementById("f-client").value.trim();
        project.startDate = document.getElementById("f-start").value;
        project.endDate = document.getElementById("f-end").value;
        project.description = document.getElementById("f-desc").value.trim();
        project.excludeSat = excludeSat;
        project.excludeSun = excludeSun;
        recalcSchedule(project);
        const ok = await saveRemote();
        if (!ok) { Object.assign(project, prev); return false; }
        renderTravelerList(project);
        renderList();
      } else {
        const p = {
          id: uid(), name, client: document.getElementById("f-client").value.trim(),
          status: "on_track",
          startDate: document.getElementById("f-start").value,
          endDate: document.getElementById("f-end").value,
          description: document.getElementById("f-desc").value.trim(),
          excludeSat, excludeSun,
          travelers: [],
        };
        state.projects.push(p);
        const ok = await saveRemote();
        if (!ok) { state.projects.pop(); return false; }
        renderList();
        location.hash = "project/" + p.id;
      }
    });
  }

  function openTravelerModal(project, traveler) {
    const isEdit = !!traveler;
    const body = `
      <div class="modal-field"><label>Traveler name</label><input type="text" id="f-name" value="${escapeHtml(traveler?.name || "")}"></div>
      <div class="modal-field"><label>Description</label><textarea id="f-desc">${escapeHtml(traveler?.description || "")}</textarea></div>
      <div class="modal-field"><label>Status</label>
        <select id="f-status">${Object.entries(STATUS_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
      </div>
    `;
    openModal(isEdit ? "Edit Traveler" : "New Traveler", body, async () => {
      const name = document.getElementById("f-name").value.trim();
      if (!name) { alert("Traveler name is required."); return false; }
      const description = document.getElementById("f-desc").value.trim();
      const status = document.getElementById("f-status").value;
      if (isEdit) {
        const prev = { ...traveler };
        traveler.name = name;
        traveler.description = description;
        traveler.status = status;
        const ok = await saveRemote();
        if (!ok) { Object.assign(traveler, prev); return false; }
        renderTravelerList(project);
        if (currentTravelerId === traveler.id) renderTravelerDetail(project, traveler);
      } else {
        const trav = { id: uid(), name, description, status, tasks: [], delays: [], notes: [] };
        project.travelers.push(trav);
        const ok = await saveRemote();
        if (!ok) { project.travelers.pop(); return false; }
        renderTravelerList(project);
        location.hash = "project/" + project.id + "/traveler/" + trav.id;
      }
    });
    document.getElementById("f-status").value = isEdit ? traveler.status : "on_track";
  }

  function openTaskModal(project, trav, task) {
    const isEdit = !!task;
    const blocked = isEdit ? descendantsOf(project, task.id) : new Set();
    const selectedPreds = new Set(task?.predecessors || []);
    const groupsHtml = project.travelers.map((otherTrav) => {
      const candidates = otherTrav.tasks.filter((t) => t.id !== task?.id && !blocked.has(t.id));
      if (!candidates.length) return "";
      return `<div class="checkbox-group-label">${escapeHtml(otherTrav.name)}</div>` + candidates.map((t) => `
          <label class="checkbox-row"><input type="checkbox" class="f-predecessor" value="${t.id}" ${selectedPreds.has(t.id) ? "checked" : ""}> ${escapeHtml(t.name)}</label>`).join("");
    }).join("");
    const hasCandidates = project.travelers.some((ot) => ot.tasks.some((t) => t.id !== task?.id && !blocked.has(t.id)));
    const predCheckboxes = hasCandidates ? groupsHtml : `<p class="modal-hint">No other tasks to depend on yet.</p>`;
    const defaultDuration = isEdit ? taskDuration(task) : 1;

    const body = `
      <div class="modal-field"><label>Task name</label><input type="text" id="f-name" value="${escapeHtml(task?.name || "")}"></div>
      <div class="modal-row">
        <div class="modal-field"><label>Start date</label><input type="date" id="f-start" value="${task?.startDate || todayStr()}"></div>
        <div class="modal-field"><label>Duration (days)</label><input type="number" id="f-duration" min="1" value="${defaultDuration}"></div>
      </div>
      <div class="modal-field">
        <label>Predecessors <span class="modal-label-hint">(starts after these finish — can be in any traveler)</span></label>
        <div class="checkbox-list">${predCheckboxes}</div>
      </div>
      <div class="modal-field"><label>Responsible <span class="modal-label-hint">(separate multiple people with commas)</span></label><input type="text" id="f-owner" value="${escapeHtml(task?.responsible || "")}" placeholder="e.g. Jane Doe, Sam Lee"></div>
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
        const all = allTasks(project);
        const latestEnd = Math.max(...predecessors.map((id) => new Date(all.find((t) => t.id === id).endDate + "T00:00:00").getTime()));
        startDate = nextWorkDay(new Date(latestEnd + 86400000).toISOString().slice(0, 10), project);
      }
      const endDate = endDateForDuration(startDate, duration, project);
      const vals = {
        name, startDate, endDate, duration, predecessors,
        responsible: document.getElementById("f-owner").value.trim(),
        status: document.getElementById("f-status").value,
        progress: document.getElementById("f-status").value === "complete"
          ? 100
          : Math.max(0, Math.min(100, Math.round(num(document.getElementById("f-progress").value)))),
        noScheduleImpact: document.getElementById("f-no-impact").checked,
      };
      let prev = null;
      let addedTask = null;
      if (isEdit) { prev = { ...task }; Object.assign(task, vals); }
      else { addedTask = { id: uid(), ...vals }; trav.tasks.push(addedTask); }
      recalcSchedule(project);
      const ok = await saveRemote();
      if (!ok) {
        if (isEdit) Object.assign(task, prev);
        else trav.tasks.pop();
        recalcSchedule(project);
        return false;
      }
      renderTaskList(project, trav);
      renderList();
      renderTravelerList(project);
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
    document.getElementById("f-status").addEventListener("change", (e) => {
      if (e.target.value === "complete") document.getElementById("f-progress").value = 100;
    });
  }

  function openDelayModal(project, trav, presetTask) {
    const taskOptions = trav.tasks.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("");
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
      trav.delays.push(entry);
      const ok = await saveRemote();
      if (!ok) { trav.delays.pop(); return false; }
      renderDelays(project, trav);
      renderTaskList(project, trav);
    });
    if (presetTask) document.getElementById("f-task").value = presetTask.id;
  }

  function openNoteModal(project, trav, presetTask) {
    const taskOptions = trav.tasks.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("");
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
      trav.notes.push(entry);
      const ok = await saveRemote();
      if (!ok) { trav.notes.pop(); return false; }
      renderNotes(project, trav);
      renderTaskList(project, trav);
      if (!currentTravelerId) renderTravelerList(project);
    });
    if (presetTask) document.getElementById("f-task").value = presetTask.id;
  }

  // ---------- init ----------
  (async () => {
    isEditor = !!getStoredPassword();
    await loadRemote();
    updateEditorUI();
    route();
    setInterval(silentRefresh, 15000);
  })();
})();
