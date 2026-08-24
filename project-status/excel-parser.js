// Shared Excel-parsing logic used by both the main app (app.js) and the
// shop-floor quick-add page. Self-contained (no dependency on app.js) so
// either page can include it standalone, alongside vendor/xlsx.core.min.js.
(() => {
  "use strict";

  function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; }
  function todayStr() { return new Date().toISOString().slice(0, 10); }
  function addDays(dateStr, n) {
    return new Date(new Date(dateStr + "T00:00:00").getTime() + n * 86400000).toISOString().slice(0, 10);
  }
  function daysBetween(a, b) {
    return Math.round((new Date(b + "T00:00:00").getTime() - new Date(a + "T00:00:00").getTime()) / 86400000);
  }

  const EXCEL_HEADER_ALIASES = {
    name: ["task name", "task", "name", "activity", "activity name"],
    start: ["start", "start date", "begin", "begin date"],
    finish: ["finish", "end", "end date", "finish date", "due", "due date"],
    percent: ["% complete", "percent complete", "% work complete", "progress", "complete", "% done"],
    responsible: ["resource names", "resource", "resources", "assigned to", "responsible", "owner", "assignee"],
    duration: ["duration (days)", "duration", "days"],
    predecessors: ["predecessors", "predecessor", "predecessor task names", "depends on"],
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
      const d = new Date(Math.round((val - 25569) * 86400 * 1000));
      if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
    if (typeof val === "string" && val.trim()) {
      const d = new Date(val.trim());
      if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
    return null;
  }

  function parseSheetRows(rows) {
    const headers = Object.keys(rows[0]);
    const nameKey = findColumnKey(headers, EXCEL_HEADER_ALIASES.name);
    const startKey = findColumnKey(headers, EXCEL_HEADER_ALIASES.start);
    const finishKey = findColumnKey(headers, EXCEL_HEADER_ALIASES.finish);
    const percentKey = findColumnKey(headers, EXCEL_HEADER_ALIASES.percent);
    const responsibleKey = findColumnKey(headers, EXCEL_HEADER_ALIASES.responsible);
    const durationKey = findColumnKey(headers, EXCEL_HEADER_ALIASES.duration);
    const predKey = findColumnKey(headers, EXCEL_HEADER_ALIASES.predecessors);
    if (!nameKey) return null;
    // Dates are only required when there's no Duration column to fall back
    // on — a duration + predecessor chain can schedule itself with no dates
    // in the sheet at all.
    if (!durationKey && (!startKey || !finishKey)) return null;

    const tasks = [];
    rows.forEach((row) => {
      const name = String(row[nameKey] || "").trim();
      if (!name) return;
      let startDate = startKey ? excelDateToYMD(row[startKey]) : null;
      let endDate = finishKey ? excelDateToYMD(row[finishKey]) : null;
      let duration = durationKey ? Math.max(1, Math.round(num(row[durationKey])) || 1) : null;
      if (!durationKey && (!startDate || !endDate)) return;
      if (!startDate) startDate = todayStr();
      if (!duration) duration = Math.max(1, daysBetween(startDate, endDate || startDate) + 1);
      if (!endDate) endDate = addDays(startDate, duration - 1);

      let pct = 0;
      if (percentKey) {
        const raw = row[percentKey];
        const n = typeof raw === "number" ? raw : parseFloat(String(raw).replace("%", ""));
        if (Number.isFinite(n)) pct = n <= 1 ? Math.round(n * 100) : Math.round(n);
      }
      pct = Math.max(0, Math.min(100, pct));
      const status = pct >= 100 ? "complete" : pct > 0 ? "in_progress" : "not_started";
      const responsible = responsibleKey ? String(row[responsibleKey] || "").trim() : "";
      const predecessorNames = predKey
        ? String(row[predKey] || "").split(",").map((s) => s.trim()).filter(Boolean)
        : [];

      tasks.push({ name, startDate, endDate, duration, responsible, status, progress: pct, predecessorNames });
    });
    return tasks;
  }

  // Recognizes RetubeCo's actual shop-traveler layout: a header row
  // somewhere in the sheet containing "OPER" (not necessarily row 1), an
  // operation-number column that must be numeric, a description column,
  // and a work-center column. Rows without a numeric op number are section
  // headers or sub-tables (e.g. a tolerance table) and are skipped. No
  // dates/durations exist in this format, so every op defaults to 1 day and
  // auto-chains sequentially (the caller resolves predecessorNames).
  function parseRetubeCoTravelerSheet(rows2D, fallbackName) {
    let headerIdx = -1;
    let opCol = -1;
    for (let i = 0; i < rows2D.length; i++) {
      const row = rows2D[i] || [];
      const idx = row.findIndex((c) => String(c || "").toUpperCase().includes("OPER"));
      if (idx !== -1) { headerIdx = i; opCol = idx; break; }
    }
    if (headerIdx === -1) return null;
    const header = (rows2D[headerIdx] || []).map((c) => String(c || "").toUpperCase());
    let descCol = header.findIndex((h) => h.includes("DESCRIPTION"));
    if (descCol === -1) descCol = opCol + 1;
    let workCenterCol = header.findIndex((h) => h.includes("WORK") && h.includes("CENTER"));
    if (workCenterCol === -1) workCenterCol = header.findIndex((h) => h.includes("CENTER"));

    let travelerName = fallbackName;
    for (const row of rows2D) {
      const idx = (row || []).findIndex((c) => String(c || "").toUpperCase().includes("TRAVELER NUMBER"));
      if (idx === -1) continue;
      for (let j = idx + 1; j < row.length; j++) {
        if (row[j] !== null && row[j] !== undefined && String(row[j]).trim()) { travelerName = String(row[j]).trim(); break; }
      }
      break;
    }

    const tasks = [];
    for (let i = headerIdx + 1; i < rows2D.length; i++) {
      const row = rows2D[i] || [];
      const opNo = row[opCol];
      const desc = row[descCol];
      if (typeof opNo !== "number" || !desc || !String(desc).trim()) continue;
      const startDate = todayStr();
      tasks.push({
        name: String(desc).trim().replace(/\s*\n\s*/g, " "),
        startDate, endDate: startDate, duration: 1,
        responsible: workCenterCol !== -1 ? String(row[workCenterCol] || "").trim() : "",
        status: "not_started", progress: 0,
        predecessorNames: [],
      });
    }
    if (!tasks.length) return null;
    return { name: travelerName, tasks };
  }

  // Extracts one traveler per matching sheet from a single workbook, trying
  // the simple Task-Name/Start-Finish-or-Duration format first and falling
  // back to the raw RetubeCo traveler layout. Sheets matching neither (e.g.
  // a "Shop Order - Traveler Cover" sheet) are silently skipped.
  function extractTravelersFromWorkbook(wb, baseName) {
    const travelers = [];
    wb.SheetNames.forEach((sheetName) => {
      const sheet = wb.Sheets[sheetName];
      const rowsObj = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      let tasks = rowsObj.length ? parseSheetRows(rowsObj) : null;
      let name = sheetName;
      if (!tasks || !tasks.length) {
        const rows2D = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
        const fallback = wb.SheetNames.length > 1 ? baseName + " – " + sheetName : baseName;
        const parsed = parseRetubeCoTravelerSheet(rows2D, fallback);
        if (parsed) { tasks = parsed.tasks; name = parsed.name; }
      }
      if (tasks && tasks.length) travelers.push({ name, tasks });
    });
    return travelers;
  }

  // Reads one or more uploaded workbooks and returns every traveler found
  // across all of them — lets a user select all of their separate shop
  // traveler files at once instead of needing them combined into one workbook.
  async function extractTravelersFromFiles(fileList) {
    if (typeof XLSX === "undefined") throw new Error("Excel import library failed to load — try reloading the page.");
    const travelers = [];
    for (const file of Array.from(fileList)) {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array", cellDates: true });
      const baseName = file.name.replace(/\.(xlsx|xls)$/i, "");
      travelers.push(...extractTravelersFromWorkbook(wb, baseName));
    }
    if (!travelers.length) {
      throw new Error("No sheets with a task name column (plus start/finish dates or a duration column), and no shop-traveler-style OPER. NO. layout, were found in the selected file(s).");
    }
    return travelers;
  }

  window.ExcelParser = { extractTravelersFromFiles };
})();
