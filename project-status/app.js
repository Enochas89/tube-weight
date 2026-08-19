(() => {
  "use strict";

  const STORAGE_KEY = "projectStatus.v1";
  const STATUS_LABELS = { on_track: "On Track", at_risk: "At Risk", delayed: "Delayed", complete: "Complete", on_hold: "On Hold" };
  const TASK_STATUS_COLOR = { not_started: "#8a97a8", in_progress: "#1f5fa8", delayed: "#b3261e", complete: "#1a7f37" };

  let state = { projects: [] };
  let currentProjectId = null;

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

  // ---------- persistence ----------
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore quota errors */ }
  }
  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (raw && Array.isArray(raw.projects)) state = raw;
    } catch (e) { /* ignore */ }

    if (state.projects.length === 0) {
      seedExample();
    }
  }

  function seedExample() {
    const start = todayStr();
    const plus = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    state.projects.push({
      id: uid(),
      name: "Example Retube Job",
      client: "Sample Client, Inc.",
      status: "on_track",
      startDate: start,
      endDate: plus(30),
      description: "A sample project so you can see how the schedule, delays, and notes work. Delete it whenever.",
      tasks: [
        { id: uid(), name: "Site survey & tube count", startDate: plus(0), endDate: plus(4), responsible: "J. Alvarez", status: "complete", progress: 100 },
        { id: uid(), name: "Order tubes & materials", startDate: plus(3), endDate: plus(10), responsible: "M. Chen", status: "in_progress", progress: 60 },
        { id: uid(), name: "Crate & ship", startDate: plus(9), endDate: plus(14), responsible: "M. Chen", status: "not_started", progress: 0 },
        { id: uid(), name: "Retube on site", startDate: plus(14), endDate: plus(26), responsible: "Field Crew", status: "not_started", progress: 0 },
        { id: uid(), name: "Final inspection", startDate: plus(26), endDate: plus(30), responsible: "J. Alvarez", status: "not_started", progress: 0 },
      ],
      delays: [],
      notes: [{ id: uid(), date: start, author: "System", text: "Project created." }],
    });
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
    if (!p.tasks.length) return 0;
    return Math.round(p.tasks.reduce((a, t) => a + (t.progress || 0), 0) / p.tasks.length);
  }

  function renderList() {
    const grid = document.getElementById("projectGrid");
    if (state.projects.length === 0) {
      grid.innerHTML = `<div class="empty-state">No projects yet. Click "+ New Project" to add one.</div>`;
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

  // ---------- detail view ----------
  function renderDetail(p) {
    document.getElementById("detailName").textContent = p.name;
    document.getElementById("detailClient").textContent = p.client || "";
    document.getElementById("detailDescription").textContent = p.description || "";

    const statusSelect = document.getElementById("detailStatus");
    statusSelect.innerHTML = Object.entries(STATUS_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
    statusSelect.value = p.status;
    statusSelect.className = "status-select " + p.status;
    statusSelect.onchange = () => {
      p.status = statusSelect.value;
      statusSelect.className = "status-select " + p.status;
      save();
    };

    renderGantt(p);
    renderDelays(p);
    renderNotes(p);
  }

  document.getElementById("backToListBtn").addEventListener("click", () => { location.hash = ""; });
  document.getElementById("editProjectBtn").addEventListener("click", () => openProjectModal(getProject(currentProjectId)));
  document.getElementById("deleteProjectBtn").addEventListener("click", () => {
    if (!confirm("Delete this project? This can't be undone.")) return;
    state.projects = state.projects.filter((p) => p.id !== currentProjectId);
    save();
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

  // ---------- Gantt chart ----------
  function renderGantt(p) {
    const wrap = document.getElementById("ganttWrap");
    if (!p.tasks.length) {
      wrap.innerHTML = `<div class="gantt-empty">No tasks yet. Click "+ Add Task" to build the schedule.</div>`;
      return;
    }

    const starts = p.tasks.map((t) => new Date(t.startDate + "T00:00:00").getTime());
    const ends = p.tasks.map((t) => new Date(t.endDate + "T00:00:00").getTime());
    let rangeStart = Math.min(...starts) - 3 * 86400000;
    let rangeEnd = Math.max(...ends) + 3 * 86400000;
    const totalMs = Math.max(rangeEnd - rangeStart, 86400000);
    const pct = (ms) => ((ms - rangeStart) / totalMs) * 100;

    const months = [];
    const cursor = new Date(rangeStart);
    cursor.setDate(1);
    while (cursor.getTime() < rangeEnd) {
      months.push(new Date(cursor));
      cursor.setMonth(cursor.getMonth() + 1);
    }
    const monthLinesHtml = months.map((m) => {
      const left = pct(m.getTime());
      const label = m.toLocaleDateString(undefined, { month: "short", year: "numeric" });
      return `<div class="gantt-month-line" style="left:${left.toFixed(2)}%"></div><div class="gantt-month-label" style="left:${left.toFixed(2)}%">${label}</div>`;
    }).join("");

    const todayMs = new Date(todayStr() + "T00:00:00").getTime();
    const todayLine = (todayMs >= rangeStart && todayMs <= rangeEnd)
      ? `<div class="gantt-today-line" style="left:${pct(todayMs).toFixed(2)}%" title="Today"></div>` : "";

    const rows = p.tasks.map((t) => {
      const left = pct(new Date(t.startDate + "T00:00:00").getTime());
      const right = pct(new Date(t.endDate + "T00:00:00").getTime());
      const width = Math.max(right - left, 0.8);
      const color = TASK_STATUS_COLOR[t.status] || TASK_STATUS_COLOR.not_started;
      const hasDelay = p.delays.some((d) => d.taskId === t.id);
      return `
        <div class="gantt-row">
          <div class="gantt-label">
            <span class="task-name">${escapeHtml(t.name)}</span>
            <span class="task-owner">${escapeHtml(t.responsible || "Unassigned")}</span>
            <span class="task-actions">
              <button class="btn-icon" data-edit-task="${t.id}" title="Edit">&#9998;</button>
              <button class="btn-icon" data-delete-task="${t.id}" title="Delete">&times;</button>
            </span>
          </div>
          <div class="gantt-track">
            <div class="gantt-months">${monthLinesHtml}${todayLine}</div>
            <div class="gantt-bar ${hasDelay ? "delay-flag" : ""}" data-open-task="${t.id}" style="left:${left.toFixed(2)}%; width:${width.toFixed(2)}%; background:${color};" title="${escapeHtml(t.name)}: ${fmtDate(t.startDate)} → ${fmtDate(t.endDate)} (${t.progress || 0}%)">
              <div class="gantt-bar-fill" style="width:${t.progress || 0}%"></div>
              <span class="gantt-bar-text">${escapeHtml(t.name)}</span>
            </div>
          </div>
        </div>`;
    }).join("");

    wrap.innerHTML = `<div class="gantt-grid">
      <div class="gantt-row header-row">
        <div class="gantt-label">Task / Responsible</div>
        <div class="gantt-track" style="min-height:28px;">${monthLinesHtml}${todayLine}</div>
      </div>
      ${rows}
    </div>`;

    wrap.querySelectorAll("[data-edit-task], [data-open-task]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = el.dataset.editTask || el.dataset.openTask;
        openTaskModal(p, p.tasks.find((t) => t.id === id));
      });
    });
    wrap.querySelectorAll("[data-delete-task]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!confirm("Delete this task?")) return;
        p.tasks = p.tasks.filter((t) => t.id !== btn.dataset.deleteTask);
        p.delays.forEach((d) => { if (d.taskId === btn.dataset.deleteTask) d.taskId = null; });
        save();
        renderGantt(p);
        renderDelays(p);
        renderList();
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
      return `
        <div class="log-item delay">
          <div class="log-item-head">
            <span class="log-item-meta">${fmtDate(d.date)}${task ? " &bull; " + escapeHtml(task.name) : ""}${d.days ? " &bull; " + d.days + " day(s)" : ""}</span>
            <button class="btn-icon" data-delete-delay="${d.id}" title="Delete">&times;</button>
          </div>
          <div class="log-item-text">${escapeHtml(d.reason)}</div>
        </div>`;
    }).join("");
    list.querySelectorAll("[data-delete-delay]").forEach((btn) => {
      btn.addEventListener("click", () => {
        p.delays = p.delays.filter((d) => d.id !== btn.dataset.deleteDelay);
        save();
        renderDelays(p);
        renderGantt(p);
      });
    });
  }
  document.getElementById("addDelayBtn").addEventListener("click", () => openDelayModal(getProject(currentProjectId)));

  // ---------- Notes ----------
  function renderNotes(p) {
    const list = document.getElementById("notesList");
    if (!p.notes.length) { list.innerHTML = `<div class="empty-state">No notes yet.</div>`; return; }
    const sorted = [...p.notes].sort((a, b) => b.date.localeCompare(a.date));
    list.innerHTML = sorted.map((n) => `
      <div class="log-item note">
        <div class="log-item-head">
          <span class="log-item-meta">${fmtDate(n.date)}${n.author ? " &bull; " + escapeHtml(n.author) : ""}</span>
          <button class="btn-icon" data-delete-note="${n.id}" title="Delete">&times;</button>
        </div>
        <div class="log-item-text">${escapeHtml(n.text)}</div>
      </div>`).join("");
    list.querySelectorAll("[data-delete-note]").forEach((btn) => {
      btn.addEventListener("click", () => {
        p.notes = p.notes.filter((n) => n.id !== btn.dataset.deleteNote);
        save();
        renderNotes(p);
      });
    });
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
    modalSaveBtn.onclick = () => { if (onSave() !== false) closeModal(); };
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
    openModal(isEdit ? "Edit Project" : "New Project", body, () => {
      const name = document.getElementById("f-name").value.trim();
      if (!name) { alert("Project name is required."); return false; }
      if (isEdit) {
        project.name = name;
        project.client = document.getElementById("f-client").value.trim();
        project.startDate = document.getElementById("f-start").value;
        project.endDate = document.getElementById("f-end").value;
        project.description = document.getElementById("f-desc").value.trim();
        save();
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
        save();
        renderList();
        location.hash = "project/" + p.id;
      }
    });
  }

  function openTaskModal(project, task) {
    const isEdit = !!task;
    const body = `
      <div class="modal-field"><label>Task name</label><input type="text" id="f-name" value="${escapeHtml(task?.name || "")}"></div>
      <div class="modal-row">
        <div class="modal-field"><label>Start date</label><input type="date" id="f-start" value="${task?.startDate || todayStr()}"></div>
        <div class="modal-field"><label>End date</label><input type="date" id="f-end" value="${task?.endDate || todayStr()}"></div>
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
    `;
    openModal(isEdit ? "Edit Task" : "Add Task", body, () => {
      const name = document.getElementById("f-name").value.trim();
      const startDate = document.getElementById("f-start").value;
      const endDate = document.getElementById("f-end").value;
      if (!name || !startDate || !endDate) { alert("Task name, start, and end dates are required."); return false; }
      if (endDate < startDate) { alert("End date can't be before start date."); return false; }
      const vals = {
        name, startDate, endDate,
        responsible: document.getElementById("f-owner").value.trim(),
        status: document.getElementById("f-status").value,
        progress: Math.max(0, Math.min(100, Math.round(num(document.getElementById("f-progress").value)))),
      };
      if (isEdit) Object.assign(task, vals);
      else project.tasks.push({ id: uid(), ...vals });
      save();
      renderGantt(project);
      renderList();
    });
    document.getElementById("f-status").value = isEdit ? task.status : "not_started";
  }

  function openDelayModal(project) {
    const taskOptions = project.tasks.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("");
    const body = `
      <div class="modal-field"><label>Date</label><input type="date" id="f-date" value="${todayStr()}"></div>
      <div class="modal-field"><label>Related task (optional)</label>
        <select id="f-task"><option value="">&mdash; None &mdash;</option>${taskOptions}</select>
      </div>
      <div class="modal-field"><label>Days delayed (optional)</label><input type="number" id="f-days" min="0" value="0"></div>
      <div class="modal-field"><label>Reason</label><textarea id="f-reason" placeholder="What caused the delay?"></textarea></div>
    `;
    openModal("Log Delay", body, () => {
      const reason = document.getElementById("f-reason").value.trim();
      if (!reason) { alert("Please describe the delay."); return false; }
      project.delays.push({
        id: uid(),
        date: document.getElementById("f-date").value || todayStr(),
        taskId: document.getElementById("f-task").value || null,
        days: Math.max(0, Math.round(num(document.getElementById("f-days").value))),
        reason,
      });
      save();
      renderDelays(project);
      renderGantt(project);
    });
  }

  function openNoteModal(project) {
    const body = `
      <div class="modal-field"><label>Date</label><input type="date" id="f-date" value="${todayStr()}"></div>
      <div class="modal-field"><label>Author</label><input type="text" id="f-author" placeholder="Your name"></div>
      <div class="modal-field"><label>Note</label><textarea id="f-text" placeholder="What's the update?"></textarea></div>
    `;
    openModal("Add Note", body, () => {
      const text = document.getElementById("f-text").value.trim();
      if (!text) { alert("Note can't be empty."); return false; }
      project.notes.push({
        id: uid(),
        date: document.getElementById("f-date").value || todayStr(),
        author: document.getElementById("f-author").value.trim(),
        text,
      });
      save();
      renderNotes(project);
    });
  }

  // ---------- init ----------
  load();
  route();
})();
