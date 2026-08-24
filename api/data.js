const { createClient } = require("redis");
const crypto = require("crypto");

const KV_KEY = "projectStatus:data";
const FAB_SHOP_PROJECT_NAME = "Fab Shop Floor";

// The connected store exposes a standard TCP connection string, not a REST
// API. Connect fresh per request and close it afterward — simplest thing
// that's safe across serverless cold/warm starts for this app's low traffic.
async function withRedis(fn) {
  const url = process.env.REDIS_URL || process.env.KV_URL;
  if (!url) {
    const seen = Object.keys(process.env).filter((k) => /REDIS|KV_/i.test(k));
    throw new Error(
      "No REDIS_URL found in environment variables. " +
      (seen.length ? `Found these related env vars instead: ${seen.join(", ")}` : "No Redis-related env vars found at all — is a store connected to this project?")
    );
  }
  const client = createClient({ url });
  client.on("error", () => { /* surfaced via the outer try/catch instead */ });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.quit();
  }
}

// ---- scheduling helpers, ported from the client's app.js so a batch import
// can auto-chain predecessors and cascade dates server-side too ----
function addDays(dateStr, n) {
  return new Date(new Date(dateStr + "T00:00:00").getTime() + n * 86400000).toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  return Math.round((new Date(b + "T00:00:00").getTime() - new Date(a + "T00:00:00").getTime()) / 86400000);
}
function taskDuration(t) {
  return t.duration || Math.max(1, daysBetween(t.startDate, t.endDate) + 1);
}
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
function allProjectTasks(project) {
  return project.travelers.flatMap((t) => t.tasks);
}
function recalcSchedule(project) {
  const all = allProjectTasks(project);
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

// GET  -> returns the current project-status data, open to anyone with the link.
// POST -> { password, data } — password is checked against the EDIT_PASSWORD env var
//         before any write happens. Pass data: null to just verify a password
//         (used by the "sign in to edit" flow) without changing anything.
module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    try {
      const raw = await withRedis((client) => client.get(KV_KEY));
      const data = raw ? JSON.parse(raw) : null;
      res.status(200).json(data && Array.isArray(data.projects) ? data : { projects: [] });
    } catch (err) {
      res.status(500).json({ error: "Failed to load data: " + err.message });
    }
    return;
  }

  if (req.method === "POST") {
    const body = req.body || {};

    // Deliberately unauthenticated — the shop-floor quick-add flow (QR code
    // on the fab shop floor) needs zero friction. This path can ONLY ever
    // append a new traveler (one task) to the single fixed Fab Shop Floor
    // project; it never touches the password-gated full-state write below,
    // so it can't edit, delete, or replace anything else.
    if (body.action === "quickAddTraveler") {
      const name = String(body.name || "").trim().slice(0, 200);
      const responsible = String(body.responsible || "").trim().slice(0, 300);
      const notes = String(body.notes || "").trim().slice(0, 1000);
      if (!name) {
        res.status(400).json({ error: "What are you working on? is required." });
        return;
      }
      try {
        const today = new Date().toISOString().slice(0, 10);
        await withRedis(async (client) => {
          const raw = await client.get(KV_KEY);
          const data = raw ? JSON.parse(raw) : { projects: [] };
          if (!Array.isArray(data.projects)) data.projects = [];
          let fab = data.projects.find((p) => p.name === FAB_SHOP_PROJECT_NAME);
          if (!fab) {
            fab = {
              id: crypto.randomUUID(), name: FAB_SHOP_PROJECT_NAME, client: "", status: "on_track",
              startDate: today, endDate: "", description: "Auto-created by the shop floor quick-add form.",
              travelers: [],
            };
            data.projects.push(fab);
          }
          if (!Array.isArray(fab.travelers)) fab.travelers = [];
          const taskId = crypto.randomUUID();
          fab.travelers.push({
            id: crypto.randomUUID(), name, description: notes, status: "in_progress",
            tasks: [{
              id: taskId, name, startDate: today, endDate: today, duration: 1,
              predecessors: [], responsible, status: "in_progress", progress: 0,
            }],
            delays: [], notes: [],
          });
          await client.set(KV_KEY, JSON.stringify(data));
        });
        res.status(200).json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: "Failed to add traveler: " + err.message });
      }
      return;
    }

    // Same unauthenticated boundary as quickAddTraveler above, but for a
    // whole batch parsed from an uploaded spreadsheet (the shop floor
    // Excel-upload flow) — one or more travelers, each with its own tasks
    // and optional predecessor names, resolved and cascaded server-side.
    if (body.action === "quickAddTravelers") {
      const incoming = Array.isArray(body.travelers) ? body.travelers.slice(0, 50) : [];
      if (!incoming.length) {
        res.status(400).json({ error: "No travelers to add." });
        return;
      }
      try {
        const today = new Date().toISOString().slice(0, 10);
        const dateRe = /^\d{4}-\d{2}-\d{2}$/;
        const allowedStatus = ["not_started", "in_progress", "delayed", "complete"];

        await withRedis(async (client) => {
          const raw = await client.get(KV_KEY);
          const data = raw ? JSON.parse(raw) : { projects: [] };
          if (!Array.isArray(data.projects)) data.projects = [];
          let fab = data.projects.find((p) => p.name === FAB_SHOP_PROJECT_NAME);
          if (!fab) {
            fab = {
              id: crypto.randomUUID(), name: FAB_SHOP_PROJECT_NAME, client: "", status: "on_track",
              startDate: today, endDate: "", description: "Auto-created by the shop floor quick-add form.",
              travelers: [],
            };
            data.projects.push(fab);
          }
          if (!Array.isArray(fab.travelers)) fab.travelers = [];

          const newTravelers = incoming.map((t) => {
            const travName = String(t?.name || "").trim().slice(0, 200) || "Imported Traveler";
            const rawTasks = Array.isArray(t?.tasks) ? t.tasks.slice(0, 2000) : [];
            const tasks = rawTasks.map((tk) => {
              const name = String(tk?.name || "").trim().slice(0, 500);
              if (!name) return null;
              const duration = Math.max(1, Math.min(3650, Math.round(Number(tk?.duration)) || 1));
              const startDate = dateRe.test(tk?.startDate) ? tk.startDate : today;
              const endDate = dateRe.test(tk?.endDate) ? tk.endDate : addDays(startDate, duration - 1);
              const responsible = String(tk?.responsible || "").trim().slice(0, 300);
              const status = allowedStatus.includes(tk?.status) ? tk.status : "not_started";
              const progress = Math.max(0, Math.min(100, Math.round(Number(tk?.progress)) || 0));
              const predecessorNames = Array.isArray(tk?.predecessorNames)
                ? tk.predecessorNames.map((n) => String(n).trim()).filter(Boolean).slice(0, 20)
                : [];
              return { id: crypto.randomUUID(), name, startDate, endDate, duration, responsible, status, progress, predecessorNames };
            }).filter(Boolean);
            return { id: crypto.randomUUID(), name: travName, description: "", status: "on_track", tasks, delays: [], notes: [] };
          }).filter((t) => t.tasks.length);

          if (!newTravelers.length) throw new Error("No valid tasks found in the uploaded file(s).");

          // Resolve predecessor names to ids across both the existing Fab
          // Shop Floor tasks and this batch, falling back to a sequential
          // auto-chain within each new traveler when no name was given.
          const nameToId = {};
          allProjectTasks(fab).forEach((t) => { nameToId[t.name.trim().toLowerCase()] = t.id; });
          newTravelers.forEach((trav) => trav.tasks.forEach((t) => { nameToId[t.name.trim().toLowerCase()] = t.id; }));
          newTravelers.forEach((trav) => {
            trav.tasks.forEach((t, i) => {
              if (t.predecessorNames.length) {
                t.predecessors = t.predecessorNames.map((n) => nameToId[n.toLowerCase()]).filter(Boolean);
              } else if (i > 0) {
                t.predecessors = [trav.tasks[i - 1].id];
              } else {
                t.predecessors = [];
              }
              delete t.predecessorNames;
            });
          });

          fab.travelers.push(...newTravelers);
          recalcSchedule(fab);
          await client.set(KV_KEY, JSON.stringify(data));
        });
        res.status(200).json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: "Failed to add travelers: " + err.message });
      }
      return;
    }

    const password = body.password;
    const data = body.data;

    const expected = process.env.EDIT_PASSWORD;
    if (!expected) {
      res.status(500).json({ error: "Server is not configured with an edit password (EDIT_PASSWORD env var is missing)." });
      return;
    }
    if (password !== expected) {
      res.status(401).json({ error: "Invalid password." });
      return;
    }

    if (data !== undefined && data !== null) {
      if (!Array.isArray(data.projects)) {
        res.status(400).json({ error: "Malformed data — expected { projects: [...] }." });
        return;
      }
      try {
        await withRedis((client) => client.set(KV_KEY, JSON.stringify(data)));
      } catch (err) {
        res.status(500).json({ error: "Failed to save data: " + err.message });
        return;
      }
    }

    res.status(200).json({ ok: true });
    return;
  }

  res.setHeader("Allow", "GET, POST");
  res.status(405).json({ error: "Method not allowed." });
};
