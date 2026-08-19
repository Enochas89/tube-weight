const { Redis } = require("@upstash/redis");

const KV_KEY = "projectStatus:data";

// Different Vercel storage integrations (the old "KV" product, the current
// "Redis" first-party option, or the Upstash marketplace listing) inject
// differently-named REST env vars. Try the known naming conventions rather
// than assuming one.
function getRedisClient() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    const seen = Object.keys(process.env).filter((k) => /REDIS|KV_/i.test(k));
    throw new Error(
      "No Redis REST URL/token found in environment variables. " +
      (seen.length ? `Found these related env vars instead: ${seen.join(", ")}` : "No Redis-related env vars found at all — is a store connected to this project?")
    );
  }
  return new Redis({ url, token });
}

// GET  -> returns the current project-status data, open to anyone with the link.
// POST -> { password, data } — password is checked against the EDIT_PASSWORD env var
//         before any write happens. Pass data: null to just verify a password
//         (used by the "sign in to edit" flow) without changing anything.
module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    try {
      const redis = getRedisClient();
      const data = await redis.get(KV_KEY);
      res.status(200).json(data && Array.isArray(data.projects) ? data : { projects: [] });
    } catch (err) {
      res.status(500).json({ error: "Failed to load data: " + err.message });
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
        const redis = getRedisClient();
        await redis.set(KV_KEY, data);
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
