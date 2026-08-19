const { kv } = require("@vercel/kv");

const KV_KEY = "projectStatus:data";

// GET  -> returns the current project-status data, open to anyone with the link.
// POST -> { password, data } — password is checked against the EDIT_PASSWORD env var
//         before any write happens. Pass data: null to just verify a password
//         (used by the "sign in to edit" flow) without changing anything.
module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    try {
      const data = await kv.get(KV_KEY);
      res.status(200).json(data && Array.isArray(data.projects) ? data : { projects: [] });
    } catch (err) {
      res.status(500).json({ error: "Failed to load data." });
    }
    return;
  }

  if (req.method === "POST") {
    const body = req.body || {};
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
        await kv.set(KV_KEY, data);
      } catch (err) {
        res.status(500).json({ error: "Failed to save data." });
        return;
      }
    }

    res.status(200).json({ ok: true });
    return;
  }

  res.setHeader("Allow", "GET, POST");
  res.status(405).json({ error: "Method not allowed." });
};
