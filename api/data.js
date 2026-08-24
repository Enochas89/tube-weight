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
