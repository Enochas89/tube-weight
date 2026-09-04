#!/usr/bin/env node
// Usage: RETUBECO_ASSISTANT_KEY=<key> node apply_traveler_update.js '<subject>' '<body>'
//
// Used by the scheduled email-processing routine to turn a RetubeCo
// traveler-update email into status updates on ergontools.com. ALL parsing
// (subject -> traveler number, body -> command) happens here, deterministically,
// rather than leaving it to the calling agent to hand-build structured input
// each run — production shop-floor data is at stake, so the interpretation
// needs to be reproducible and testable, not a fresh judgment call per email.
//
// Supported body formats (checked in this order):
//   1. "All tasks NN%"                    -> every task on the traveler set to NN%
//   2. "Tasks 1, 100%, 2, 50%" (or         -> task #1 (1-indexed, matches the
//      one "<index>, <percent>%" pair         order shown in the app / on the
//      per line)                              printed traveler) -> 100%, #2 -> 50%, etc.
//   3. Anything else: one task per line,   -> fuzzy-matched by name against
//      "<task description> -NN%"              the traveler's task list
//
// The credential is read from RETUBECO_ASSISTANT_KEY, a narrow-scope key
// (server-side env var ASSISTANT_KEY) that can only move a traveler/task
// status or progress — never the full whole-project overwrite that the
// human "sign in to edit" password also gates.
const https = require('https');

const API_URL = 'https://www.ergontools.com/api/data';

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

function leadingToken(rawName) {
  const first = String(rawName || '').trim().split(/\s+/)[0] || '';
  return first.toLowerCase().replace(/[^a-z0-9-]/g, '');
}

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

function findTaskByName(traveler, taskText) {
  const scored = (traveler.tasks || [])
    .map((task) => ({ task, score: similarity(taskText, task.name) }))
    .sort((a, b) => b.score - a.score);
  if (!scored.length || scored[0].score === 0) return null;
  const top = scored[0];
  const runnerUp = scored[1] ? scored[1].score : 0;
  return { task: top.task, score: top.score, margin: top.score - runnerUp };
}

function parseSubject(subject) {
  const m = String(subject || '').match(/traveler\s+([^\s].*)$/i);
  return m ? m[1].trim().replace(/[.,;:]+$/, '') : null;
}

// Returns { mode: 'allTasks', percent } | { mode: 'indexed', pairs: [{index, percent}] }
// | { mode: 'byName', lines: [{taskText, percent}] }
function parseCommand(body) {
  const text = String(body || '');
  const trimmed = text.trim();

  const allTasksMatch = trimmed.match(/^all\s+tasks\b[\s\S]*?(-?\d{1,3})\s*%/i);
  if (allTasksMatch) {
    return { mode: 'allTasks', percent: clampPercent(allTasksMatch[1]) };
  }

  if (/^tasks?\b/i.test(trimmed)) {
    const rest = trimmed.replace(/^tasks?\b/i, '');
    const pairs = [];
    const re = /(\d+)\D+?(-?\d{1,3})\s*%/g;
    let m;
    while ((m = re.exec(rest)) !== null) {
      pairs.push({ index: parseInt(m[1], 10), percent: clampPercent(m[2]) });
    }
    if (pairs.length) return { mode: 'indexed', pairs };
  }

  const lines = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(/^(.+?)\s*-?\s*(\d{1,3})\s*%\s*$/);
    if (m) lines.push({ taskText: m[1].trim(), percent: clampPercent(m[2]) });
  }
  return { mode: 'byName', lines };
}

function clampPercent(n) {
  return Math.max(0, Math.min(100, Math.round(Math.abs(Number(n)))));
}

(async () => {
  const [, , subject, body] = process.argv;
  const password = process.env.RETUBECO_ASSISTANT_KEY;
  if (!password) {
    console.log(JSON.stringify({ ok: false, error: 'RETUBECO_ASSISTANT_KEY env var is not set.' }));
    process.exit(1);
  }

  const travelerQuery = parseSubject(subject);
  if (!travelerQuery) {
    console.log(JSON.stringify({ ok: false, error: `Subject "${subject}" doesn't contain "Traveler <number>".` }));
    process.exit(1);
  }

  const command = parseCommand(body);
  if (command.mode === 'byName' && !command.lines.length) {
    console.log(JSON.stringify({ ok: false, error: 'No parseable task/percent lines found in the body.', travelerQuery }));
    process.exit(1);
  }

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

  if (command.mode === 'allTasks') {
    for (const task of match.traveler.tasks || []) {
      results.push({ command: { allTasks: true, percent: command.percent }, ...(await applyProgress(task.id, task.name, command.percent)) });
    }
  } else if (command.mode === 'indexed') {
    for (const { index, percent } of command.pairs) {
      const task = (match.traveler.tasks || [])[index - 1];
      if (!task) {
        results.push({ command: { taskIndex: index, percent }, ok: false, error: `Task index ${index} out of range (traveler has ${(match.traveler.tasks || []).length} tasks).` });
        continue;
      }
      results.push({ command: { taskIndex: index, percent }, ...(await applyProgress(task.id, task.name, percent)) });
    }
  } else {
    for (const line of command.lines) {
      const found = findTaskByName(match.traveler, line.taskText);
      if (!found) {
        results.push({ command: line, ok: false, error: 'No task matched at all' });
        continue;
      }
      results.push({
        command: line,
        matchScore: Math.round(found.score * 100) / 100,
        matchMargin: Math.round(found.margin * 100) / 100,
        lowConfidence: found.score < 0.6 || found.margin < 0.15,
        ...(await applyProgress(found.task.id, found.task.name, line.percent)),
      });
    }
  }

  console.log(JSON.stringify({
    ok: true,
    commandMode: command.mode,
    travelerMatched: match.traveler.name,
    projectName: match.project.name,
    results,
  }, null, 2));
})().catch((err) => {
  console.log(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
