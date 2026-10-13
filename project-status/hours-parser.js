// Parses the vIDix Labor payroll PDFs (after pdf.js has turned them into
// text lines) into man-hours per job per employee. Two report layouts are
// understood:
//   - "Hours Report" (weekly): per-employee pages with an "Account Totals
//     for <name>" block -- account "11352/11352.125/1101/No", pay code, hours.
//   - "Hours Consolidated Report" (any date range, e.g. year to date): one
//     row per job+employee with Hrly / OT / DT / PTO / Hol / Total columns.
// Self-contained (no dependency on app.js) and also loadable from Node so the
// parsing can be checked against real reports outside the browser.
(() => {
  "use strict";

  function round2(n) { return Math.round(n * 100) / 100; }
  function toIso(mdY) {
    const m = String(mdY).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
    if (!m) return null;
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return `${year}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  function findPeriod(lines) {
    for (const l of lines) {
      const m = l.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{2,4})$/);
      if (m) return { from: toIso(m[1]), to: toIso(m[2]) };
    }
    return { from: null, to: null };
  }
  // Groups raw rows into one entry per job + employee.
  function aggregate(rows) {
    const byKey = new Map();
    rows.forEach((r) => {
      const key = r.job + "|" + r.employee;
      if (!byKey.has(key)) byKey.set(key, { job: r.job, employee: r.employee, hours: 0, ot: 0, dt: 0 });
      const a = byKey.get(key);
      a.hours += r.hours || 0; a.ot += r.ot || 0; a.dt += r.dt || 0;
    });
    return Array.from(byKey.values()).map((a) => ({ ...a, hours: round2(a.hours), ot: round2(a.ot), dt: round2(a.dt) }));
  }

  function parseWeekly(lines) {
    const rows = [];
    const warnings = [];
    let employee = null;
    let inAccounts = false;
    let sum = 0;
    lines.forEach((line) => {
      const head = line.match(/^Account Totals for (.+)$/);
      if (head) { employee = head[1].trim(); inAccounts = true; sum = 0; return; }
      if (!inAccounts) return;
      const tot = line.match(/^Totals\s+(-?[\d,]+\.\d+)/);
      if (tot) {
        const reported = parseFloat(tot[1].replace(/,/g, ""));
        if (Math.abs(reported - sum) > 0.015) warnings.push(`${employee}: account lines add to ${round2(sum)} but the report total is ${reported}`);
        inAccounts = false;
        return;
      }
      const m = line.match(/^([^\s/]+)\/\S+\s+(.+?)\s+(-?[\d,]+\.\d+)(?:\s+\S+)?$/);
      if (!m) return;
      const job = m[1];
      const payCode = m[2].trim();
      const hrs = parseFloat(m[3].replace(/,/g, ""));
      sum += hrs;
      const r = { job, employee, hours: 0, ot: 0, dt: 0 };
      if (/^over/i.test(payCode)) r.ot = hrs;
      else if (/^double/i.test(payCode)) r.dt = hrs;
      else r.hours = hrs;
      rows.push(r);
    });
    return { rows: aggregate(rows), warnings };
  }

  function parseConsolidated(lines) {
    const warnings = [];
    const skip = /^(RetubeCo Inc|Hours Consolidated Report|Sorted by|\d{1,2}\/\d{1,2}\/\d{4} .*Page \d+|\d{1,2}\/\d{1,2}\/\d{2,4}\s*-\s*\d{1,2}\/\d{1,2}\/\d{2,4}$)/;
    const kept = [];
    let afterHeader = false;
    lines.forEach((l) => {
      if (/^Dept#\s+Dept Name/.test(l)) { afterHeader = true; return; }
      if (skip.test(l)) return;
      if (afterHeader) {
        // A department name that wraps across a page break is repeated as a
        // bare fragment at the top of the next page -- drop it until the
        // next real row (which always starts with a department code).
        if (!/^(\d+|JOB\?|All)\s/.test(l)) return;
        afterHeader = false;
      }
      kept.push(l);
    });
    const text = kept.join(" ");
    const N = "-?[\\d,]+\\.\\d\\d";
    const rec = new RegExp(`(\\S+) (.*?) ((?:${N} ){5}${N})(?= |$)`, "g");
    const rows = [];
    const deptTotals = {};
    let grand = null;
    let m;
    while ((m = rec.exec(text))) {
      const dept = m[1];
      const rest = m[2];
      const nums = m[3].split(" ").map((x) => parseFloat(x.replace(/,/g, "")));
      if (dept === "All") { grand = nums[5]; continue; }
      if (/Dept Total$/.test(rest)) { deptTotals[dept] = nums[5]; continue; }
      const emps = Array.from(rest.matchAll(/\b(\d{3,4}) ([A-Z][A-Za-z'\-]+, .+)$/g));
      const e = emps.length ? emps[emps.length - 1] : null;
      // Employee names wrap too ("Eiseman, Timothy" / "Robert"); with the
      // lazy match above they come through whole, just space-joined.
      if (!e) { warnings.push(`Could not read a row under ${dept}: "${rest.slice(0, 60)}"`); continue; }
      rows.push({ job: dept, employee: e[2].trim(), hours: nums[0] + nums[3] + nums[4], ot: nums[1], dt: nums[2] });
    }
    const sumAll = round2(rows.reduce((a, r) => a + r.hours + r.ot + r.dt, 0));
    if (grand !== null && Math.abs(sumAll - grand) > 0.5) warnings.push(`Rows add to ${sumAll} but the report grand total is ${grand}`);
    return { rows: aggregate(rows), warnings };
  }

  // lines: text lines in content order (one per visual line, as produced by
  // linesFromPdfTextContent below). Returns { kind, from, to, rows, warnings }
  // where rows are { job, employee, hours, ot, dt } -- hours = regular time.
  function parseHoursReport(lines) {
    const clean = lines.map((l) => String(l).replace(/\s+/g, " ").trim()).filter(Boolean);
    const all = clean.join("\n");
    const { from, to } = findPeriod(clean);
    let kind, res;
    if (/Hours Consolidated Report/.test(all)) { kind = "consolidated"; res = parseConsolidated(clean); }
    else if (/Account Totals for /.test(all)) { kind = "weekly"; res = parseWeekly(clean); }
    else return { kind: null, from, to, rows: [], warnings: ["This doesn't look like a vIDix Hours Report or Hours Consolidated Report."] };
    if (!from || !to) res.warnings.push("Couldn't find the report's date range.");
    return { kind, from, to, rows: res.rows, warnings: res.warnings };
  }

  // Turns pdf.js getTextContent() pages into text lines: a new line whenever
  // the baseline moves or pdf.js flags an end-of-line.
  function linesFromPdfTextContent(pages) {
    const out = [];
    pages.forEach((tc) => {
      let line = [];
      let lastY = null;
      const flush = () => { if (line.length) out.push(line.join(" ")); line = []; };
      tc.items.forEach((it) => {
        const y = Math.round(it.transform[5]);
        if (lastY !== null && Math.abs(y - lastY) > 2) flush();
        if (it.str && it.str.trim()) line.push(it.str);
        lastY = y;
        if (it.hasEOL) { flush(); lastY = null; }
      });
      flush();
    });
    return out;
  }

  const api = { parseHoursReport, linesFromPdfTextContent };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else window.HoursParser = api;
})();
