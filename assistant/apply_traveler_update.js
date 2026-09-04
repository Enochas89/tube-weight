#!/usr/bin/env node
// Usage: RETUBECO_ASSISTANT_KEY=<key> node apply_traveler_update.js '<travelerQuery>' '<linesJSON>'
// linesJSON: JSON array of {taskText, percent}
//
// Used by the scheduled email-processing routine to turn parsed email lines
// into status updates on ergontools.com. Matching is deterministic (not a
// model judgment call each run) so production shop-floor data updates are
// auditable and reproducible — see the score/margin fields in the output.
//
// The credential is read from RETUBECO_ASSISTANT_KEY, a narrow-scope key
// (server-side env var ASSISTANT_KEY) that can only move a traveler/task
// status or progress — never the full whole-project overwrite that the
// human "sign in to edit" password also gates.
const https = require('https');

const API_URL = 'https://www.ergontools.com/api/data';

// Common filler words only — deliberately does NOT drop short numeric/
// alphanumeric tokens (e.g. drawing rev numbers, traveler suffixes) since
// those are exactly what distinguishes near-duplicate names like
// "Dwg 7533-1 Rev 1" vs "Dwg 7533-2 Rev 0", or traveler "11322-1" vs "11322-2".
const STOPWORDS = new Set(['a', 'an', 'the', 'to', 'of', 'per', 'and', 'or', 'in', 'on', 'for', 'is', 'be', 'that', 'this', 'with', 'without', 'as']);

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function post(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function words(s) {
  return normalize(s).split(' ').filter((w) => w.length && !STOPWORDS.has(w));
}

function similarity(a, b) {
  const wa = words(a);
  const wb = new Set(words(b));
  if (!wa.length || !wb.size) return 0;
  const hits = wa.filter((w) => wb.has(w)).length;
  return hits / wa.length;
}

// Hyphen-PRESERVING token extraction, used only for traveler-number
// identity — the general normalize()/words() strip hyphens to spaces (fine
// for word-overlap scoring), but that would turn "11322-1" into two tokens
// and lose the distinguishing suffix.
function leadingToken(rawName) {
  const first = String(rawName || '').trim().split(/\s+/)[0] || '';
  return first.toLowerCase().replace(/[^a-z0-9-]/g, '');
}

// Traveler identity is high-stakes (wrong job entirely) so this is
// deliberately strict: exact match on the leading number token only. No
// fuzzy fallback — an unrecognized traveler number should fail loudly.
function findTraveler(data, query) {
  const q = leadingToken(query);
  const matches = [];
  for (const project of data.projects || []) {
    for (const trav of project.travelers || []) {
      if (leadingToken(trav.name) === q) {
        matches.push({ project, traveler: trav });
      }
    }
  }
  if (matches.length === 1) return matches[0];
  return null;
}

function findTask(traveler, taskText) {
  const scored = (traveler.tasks || [])
    .map((task) => ({ task, score: similarity(taskText, task.name) }))
    .sort((a, b) => b.score - a.score);
  if (!scored.length || scored[0].score === 0) return null;
  const top = scored[0];
  const runnerUp = scored[1] ? scored[1].score : 0;
  return { task: top.task, score: top.score, margin: top.score - runnerUp };
}

(async () => {
  const [, , travelerQuery, linesJson] = process.argv;
  const password = process.env.RETUBECO_ASSISTANT_KEY;
  if (!password) {
    console.log(JSON.stringify({ ok: false, error: 'RETUBECO_ASSISTANT_KEY env var is not set.' }));
    process.exit(1);
  }
  const lines = JSON.parse(linesJson);

  const data = await get(API_URL);
  const match = findTraveler(data, travelerQuery);
  if (!match) {
    console.log(JSON.stringify({ ok: false, error: `No unambiguous traveler found matching "${travelerQuery}"`, travelerQuery }));
    process.exit(1);
  }

  async function applyProgress(taskId, taskName, progress) {
    const r = await post({
      action: 'setTaskStatus',
      password,
      projectId: match.project.id,
      travelerId: match.traveler.id,
      taskId,
      progress,
    });
    return { matchedTask: taskName, progress, ok: r.status === 200, response: r.body };
  }

  const results = [];
  for (const line of lines) {
    // Whole-traveler command: {"allTasks": true, "percent": NN} applies to
    // every task on the traveler, no per-task name matching involved.
    if (line.allTasks) {
      const progress = Math.max(0, Math.min(100, Math.round(Number(line.percent))));
      for (const task of match.traveler.tasks || []) {
        const r = await applyProgress(task.id, task.name, progress);
        results.push({ line: { allTasks: true, percent: progress }, ...r });
      }
      continue;
    }

    const found = findTask(match.traveler, line.taskText);
    if (!found) {
      results.push({ line, ok: false, error: 'No task matched at all' });
      continue;
    }
    const progress = Math.max(0, Math.min(100, Math.round(Number(line.percent))));
    const r = await applyProgress(found.task.id, found.task.name, progress);
    results.push({
      line,
      matchScore: Math.round(found.score * 100) / 100,
      matchMargin: Math.round(found.margin * 100) / 100,
      lowConfidence: found.score < 0.6 || found.margin < 0.15,
      ...r,
    });
  }

  console.log(JSON.stringify({
    ok: true,
    travelerMatched: match.traveler.name,
    projectName: match.project.name,
    results,
  }, null, 2));
})().catch((err) => {
  console.log(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
