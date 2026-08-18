(() => {
  "use strict";

  const TRAILER_PRESETS = {
    dryvan53: { l: 636, w: 100, h: 110 },
    flatbed48: { l: 576, w: 102, h: 108 },
  };

  const GROUP_COLORS = [
    "#1f5fa8", "#c2703d", "#2f9e6e", "#8a4fbf",
    "#c94f6d", "#3d9ac9", "#b58b1a", "#5a6b8c",
  ];

  const STORAGE_KEY = "tubeTruckLoadingCalc.v1";

  let groupSeq = 0;
  const groupsContainer = document.getElementById("groupsContainer");
  const groupTemplate = document.getElementById("groupTemplate");

  let genericSeq = 0;
  const genericContainer = document.getElementById("genericContainer");
  const genericTemplate = document.getElementById("genericTemplate");

  let lastLayout = [];
  let lastWarnings = [];
  let lastConstraints = {};

  // ---------- utility ----------
  const num = (el, fallback = 0) => {
    const v = parseFloat(el.value);
    return Number.isFinite(v) ? v : fallback;
  };
  const fmt = (n, digits = 0) =>
    Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits }) : "—";

  // Accepts 20', 20' 6", 20'6", 20-6, 20 6, 246, 246", 246in — returns total inches.
  // A bare number is treated as inches (keeps old plain-inch values working).
  function parseFeetInches(str) {
    if (str == null) return NaN;
    const s = String(str).trim();
    if (s === "") return NaN;
    if (/^-?\d+(\.\d+)?$/.test(s)) return parseFloat(s);

    const feetMatch = s.match(/(-?\d+(?:\.\d+)?)\s*(?:'|ft|feet)/i);
    if (feetMatch) {
      const feet = parseFloat(feetMatch[1]);
      const rest = s.slice(feetMatch.index + feetMatch[0].length).trim();
      const inchMatch = rest.match(/^(-?\d+(?:\.\d+)?)/);
      const inches = inchMatch ? parseFloat(inchMatch[1]) : 0;
      return feet * 12 + inches;
    }

    const inchOnly = s.match(/^(-?\d+(?:\.\d+)?)\s*(?:"|in|inch|inches)$/i);
    if (inchOnly) return parseFloat(inchOnly[1]);

    const shorthand = s.match(/^(-?\d+(?:\.\d+)?)[\s-](\d+(?:\.\d+)?)$/);
    if (shorthand) return parseFloat(shorthand[1]) * 12 + parseFloat(shorthand[2]);

    const fallbackNum = parseFloat(s);
    return Number.isFinite(fallbackNum) ? fallbackNum : NaN;
  }

  function lenIn(el, fallback = 0) {
    const v = parseFeetInches(el.value);
    return Number.isFinite(v) ? v : fallback;
  }

  // Formats total inches as e.g. 20' 6" / 20' / 6" for display.
  function formatFeetInches(totalInches) {
    if (!Number.isFinite(totalInches)) return "";
    const neg = totalInches < 0;
    const t = Math.abs(totalInches);
    let feet = Math.floor(t / 12 + 1e-9);
    let inches = Math.round((t - feet * 12) * 100) / 100;
    if (inches >= 12) { feet += 1; inches -= 12; }
    let out = "";
    if (feet > 0) out += feet + "'";
    if (inches > 0 || feet === 0) out += (out ? " " : "") + inches + '"';
    return (neg ? "-" : "") + out;
  }

  // ---------- group card management ----------
  function addGroup(initial) {
    const id = ++groupSeq;
    const node = groupTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.id = id;

    if (initial) {
      node.querySelector(".g-name").value = initial.name ?? "Tube Group";
      setSelectByValueOrCustom(node.querySelector(".g-material"), node.querySelector(".g-density"), node.querySelector(".g-density-wrap"), initial.density);
      node.querySelector(".g-od").value = initial.od;
      node.querySelector(".g-wall").value = initial.wall;
      node.querySelector(".g-length").value = initial.lengthFt;
      node.querySelector(".g-qty").value = initial.qty;
      node.querySelector(".g-tare").value = initial.tare;
      node.querySelector(".g-cratel").value = initial.crateL;
      node.querySelector(".g-cratew").value = initial.crateW;
      node.querySelector(".g-crateh").value = initial.crateH;
      node.querySelector(".g-tubespercrate").value = initial.tubesPerCrate;
      if (initial.autoTare !== undefined) node.querySelector(".g-auto-tare").checked = initial.autoTare;
      if (initial.faceBottom !== undefined) node.querySelector(".g-face-bottom").checked = initial.faceBottom;
      if (initial.faceTop !== undefined) node.querySelector(".g-face-top").checked = initial.faceTop;
      if (initial.faceSides !== undefined) node.querySelector(".g-face-sides").checked = initial.faceSides;
      if (initial.faceEnds !== undefined) node.querySelector(".g-face-ends").checked = initial.faceEnds;
      if (initial.plyThickness !== undefined) node.querySelector(".g-ply-thickness").value = initial.plyThickness;
      if (initial.plyCustom !== undefined) node.querySelector(".g-ply-custom").value = initial.plyCustom;
      if (initial.lb2x6 !== undefined) node.querySelector(".g-2x6-lbft").value = initial.lb2x6;
      if (initial.waste !== undefined) node.querySelector(".g-waste").value = initial.waste;
      if (initial.hardware !== undefined) node.querySelector(".g-hardware").value = initial.hardware;
      if (initial.autoCrateDims !== undefined) node.querySelector(".g-auto-cratedims").checked = initial.autoCrateDims;
      if (initial.tubeGap !== undefined) node.querySelector(".g-tubegap").value = initial.tubeGap;
      if (initial.wallClearance !== undefined) node.querySelector(".g-wallclear").value = initial.wallClearance;
      if (initial.endClearance !== undefined) node.querySelector(".g-endclear").value = initial.endClearance;
    }

    // wire events
    node.querySelectorAll("input, select").forEach((el) => {
      el.addEventListener("input", recalcAll);
      el.addEventListener("change", recalcAll);
    });

    node.querySelector(".g-material").addEventListener("change", (e) => {
      const wrap = node.querySelector(".g-density-wrap");
      const densityInput = node.querySelector(".g-density");
      if (e.target.value === "custom") {
        wrap.classList.remove("hidden");
      } else {
        wrap.classList.add("hidden");
        densityInput.value = e.target.value;
      }
      recalcAll();
    });

    node.querySelector(".btn-remove").addEventListener("click", () => {
      node.remove();
      recalcAll();
    });

    const applyAutoTareState = () => {
      const on = node.querySelector(".g-auto-tare").checked;
      node.querySelector(".g-tare-panel").classList.toggle("hidden", !on);
      const tareInput = node.querySelector(".g-tare");
      if (on) tareInput.setAttribute("readonly", "readonly");
      else tareInput.removeAttribute("readonly");
    };
    node.querySelector(".g-auto-tare").addEventListener("change", () => {
      applyAutoTareState();
      recalcAll();
    });
    applyAutoTareState();

    const applyAutoCrateDimsState = () => {
      const on = node.querySelector(".g-auto-cratedims").checked;
      node.querySelector(".g-cratedims-panel").classList.toggle("hidden", !on);
      ["g-cratel", "g-cratew", "g-crateh"].forEach((cls) => {
        const el = node.querySelector("." + cls);
        if (on) el.setAttribute("readonly", "readonly");
        else el.removeAttribute("readonly");
      });
    };
    node.querySelector(".g-auto-cratedims").addEventListener("change", () => {
      applyAutoCrateDimsState();
      recalcAll();
    });
    applyAutoCrateDimsState();

    node.querySelector(".g-ply-thickness").addEventListener("change", (e) => {
      node.querySelector(".g-ply-custom-wrap").classList.toggle("hidden", e.target.value !== "custom");
      recalcAll();
    });
    node.querySelector(".g-ply-custom-wrap").classList.toggle("hidden", node.querySelector(".g-ply-thickness").value !== "custom");

    node.querySelector(".g-autofit").addEventListener("click", () => {
      const forkliftCapacity = num(document.getElementById("forkliftCapacity"));
      const wpt = weightPerTube(node);
      if (wpt <= 0) { recalcAll(); return; }

      const autoOn = node.querySelector(".g-auto-cratedims").checked;
      if (!autoOn) {
        const tare = num(node.querySelector(".g-tare"));
        node.querySelector(".g-tubespercrate").value = Math.max(1, Math.floor((forkliftCapacity - tare) / wpt));
      } else {
        // tare depends on crate size, which depends on tubes/crate — search down until it fits
        const od = num(node.querySelector(".g-od"));
        const lengthFt = num(node.querySelector(".g-length"));
        const gap = num(node.querySelector(".g-tubegap"));
        const wallClearance = num(node.querySelector(".g-wallclear"));
        const endClearance = num(node.querySelector(".g-endclear"));
        const autoTareOn = node.querySelector(".g-auto-tare").checked;
        const manualTare = num(node.querySelector(".g-tare"));

        let n = Math.max(1, Math.round(num(node.querySelector(".g-tubespercrate"), 1)));
        for (; n > 1; n--) {
          const dims = computeAutoCrateDims(od, lengthFt, n, gap, wallClearance, endClearance);
          const tare = autoTareOn ? calcCrateMaterials(node, dims.crateL, dims.crateW, dims.crateH).total : manualTare;
          if (tare + n * wpt <= forkliftCapacity) break;
        }
        node.querySelector(".g-tubespercrate").value = n;
      }
      recalcAll();
    });

    groupsContainer.appendChild(node);
    return node;
  }

  // ---------- generic crate management ----------
  function addGenericItem(initial) {
    const id = ++genericSeq;
    const node = genericTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.id = id;

    if (initial) {
      node.querySelector(".ge-name").value = initial.name ?? "Misc Crate";
      node.querySelector(".ge-weight").value = initial.weight;
      node.querySelector(".ge-qty").value = initial.qty;
      node.querySelector(".ge-cratel").value = initial.crateL;
      node.querySelector(".ge-cratew").value = initial.crateW;
      node.querySelector(".ge-crateh").value = initial.crateH;
    }

    node.querySelectorAll("input").forEach((el) => {
      el.addEventListener("input", recalcAll);
      el.addEventListener("change", recalcAll);
    });

    node.querySelector(".btn-remove").addEventListener("click", () => {
      node.remove();
      recalcAll();
    });

    genericContainer.appendChild(node);
    return node;
  }

  function setSelectByValueOrCustom(select, densityInput, wrapEl, density) {
    const match = Array.from(select.options).find((o) => o.value !== "custom" && Math.abs(parseFloat(o.value) - density) < 0.0005);
    if (match) {
      select.value = match.value;
      wrapEl.classList.add("hidden");
    } else {
      select.value = "custom";
      wrapEl.classList.remove("hidden");
    }
    densityInput.value = density;
  }

  function weightPerTube(card) {
    const density = num(card.querySelector(".g-density"));
    const od = num(card.querySelector(".g-od"));
    const wall = num(card.querySelector(".g-wall"));
    const lengthFt = num(card.querySelector(".g-length"));
    const id = od - 2 * wall;
    if (id <= 0 || od <= 0 || lengthFt <= 0) return 0;
    const area = (Math.PI / 4) * (od * od - id * id);
    const lengthIn = lengthFt * 12;
    return area * lengthIn * density;
  }

  // Find the rows x cols grid (as close to square as possible, no wasted slots beyond
  // rounding up) for packing n round tubes into a bundle.
  function bestGrid(n) {
    n = Math.max(1, Math.round(n));
    let best = { rows: 1, cols: n };
    let bestSlots = Infinity;
    for (let r = 1; r <= n; r++) {
      const c = Math.ceil(n / r);
      const slots = r * c;
      if (slots < bestSlots || (slots === bestSlots && Math.abs(r - c) < Math.abs(best.rows - best.cols))) {
        bestSlots = slots;
        best = { rows: r, cols: c };
      }
    }
    return best;
  }

  // Derive crate outer dimensions from the tube's own size: a grid of tubes (each on
  // OD + a small gap for blocking/banding) plus a clearance margin for the crate walls,
  // and tube length plus end clearance for blocking.
  function computeAutoCrateDims(od, lengthFt, tubesPerCrate, gap, wallClearance, endClearance) {
    const { rows, cols } = bestGrid(tubesPerCrate);
    const pitch = od + gap;
    return {
      crateL: lengthFt * 12 + 2 * endClearance,
      crateW: cols * pitch + 2 * wallClearance,
      crateH: rows * pitch + 2 * wallClearance,
      rows, cols,
    };
  }

  // 4x8 plywood sheathing + 2x6 framing, built up from crate outer dimensions
  const PLYWOOD_SHEET_SQFT = 32; // 4ft x 8ft
  function calcCrateMaterials(card, crateL, crateW, crateH) {
    const Lf = crateL / 12, Wf = crateW / 12, Hf = crateH / 12;

    const plySel = card.querySelector(".g-ply-thickness").value;
    const plyLbSqft = plySel === "custom" ? num(card.querySelector(".g-ply-custom")) : parseFloat(plySel);
    const lbPerFt2x6 = num(card.querySelector(".g-2x6-lbft"));
    const wastePct = num(card.querySelector(".g-waste"));
    const hardwarePct = num(card.querySelector(".g-hardware"));

    const bottom = card.querySelector(".g-face-bottom").checked;
    const top = card.querySelector(".g-face-top").checked;
    const sides = card.querySelector(".g-face-sides").checked;
    const ends = card.querySelector(".g-face-ends").checked;

    if (!(Lf > 0 && Wf > 0 && Hf > 0)) {
      return { sheets: 0, areaWithWaste: 0, plyWeight: 0, framingFt: 0, framingWeight: 0, total: 0 };
    }

    let area = 0;
    if (bottom) area += Lf * Wf;
    if (top) area += Lf * Wf;
    if (sides) area += 2 * Lf * Hf;
    if (ends) area += 2 * Wf * Hf;

    const areaWithWaste = area * (1 + wastePct / 100);
    const sheets = area > 0 ? Math.ceil(areaWithWaste / PLYWOOD_SHEET_SQFT) : 0;
    const plyWeight = sheets * plyLbSqft * PLYWOOD_SHEET_SQFT;

    // 2x6: base perimeter (+ top perimeter if lidded) + corner posts + a seam brace every 8ft along the deck/lid run
    let framingFt = 2 * (Lf + Wf);
    if (top) framingFt += 2 * (Lf + Wf);
    if (sides || ends) framingFt += 4 * Hf;
    if (bottom) framingFt += Math.max(0, Math.ceil(Lf / 8) - 1) * Wf;
    if (top) framingFt += Math.max(0, Math.ceil(Lf / 8) - 1) * Wf;
    const framingWeight = framingFt * lbPerFt2x6;

    const total = (plyWeight + framingWeight) * (1 + hardwarePct / 100);

    return { sheets, areaWithWaste, plyWeight, framingFt, framingWeight, total };
  }

  document.getElementById("addGroupBtn").addEventListener("click", () => {
    addGroup();
    recalcAll();
    saveState();
  });

  document.getElementById("addGenericBtn").addEventListener("click", () => {
    addGenericItem();
    recalcAll();
    saveState();
  });

  // ---------- trailer preset ----------
  const presetSelect = document.getElementById("trailerPreset");
  presetSelect.addEventListener("change", () => {
    const preset = TRAILER_PRESETS[presetSelect.value];
    if (preset) {
      document.getElementById("trailerLength").value = formatFeetInches(preset.l);
      document.getElementById("trailerWidth").value = formatFeetInches(preset.w);
      document.getElementById("trailerHeight").value = formatFeetInches(preset.h);
    }
    recalcAll();
  });

  ["trailerLength", "trailerWidth", "trailerHeight", "maxPayload", "forkliftCapacity", "forkliftLiftHeight", "bedHeight", "maxStackHeight", "maxStackCount"].forEach((id) => {
    document.getElementById(id).addEventListener("input", recalcAll);
  });

  // ---------- core calculation ----------
  function recalcAll() {
    const warnings = [];

    const trailerLength = lenIn(document.getElementById("trailerLength"));
    const trailerWidth = lenIn(document.getElementById("trailerWidth"));
    const trailerHeight = lenIn(document.getElementById("trailerHeight"));
    const maxPayload = num(document.getElementById("maxPayload"));
    const forkliftCapacity = num(document.getElementById("forkliftCapacity"));
    const forkliftLiftHeight = lenIn(document.getElementById("forkliftLiftHeight"));
    const bedHeight = lenIn(document.getElementById("bedHeight"));
    const maxStackHeight = lenIn(document.getElementById("maxStackHeight"));
    const maxStackCount = Math.max(1, Math.round(num(document.getElementById("maxStackCount"), 1)));

    if (bedHeight > forkliftLiftHeight) {
      warnings.push(`The forklift's max lift height (${formatFeetInches(forkliftLiftHeight)}) is below the trailer bed height (${formatFeetInches(bedHeight)}) — it can't reach the trailer floor at all.`);
    }

    const groupCards = Array.from(groupsContainer.querySelectorAll(".group-card"));
    const groupResults = [];

    groupCards.forEach((card, idx) => {
      const name = card.querySelector(".g-name").value || `Group ${idx + 1}`;
      const od = num(card.querySelector(".g-od"));
      const wall = num(card.querySelector(".g-wall"));
      const lengthFt = num(card.querySelector(".g-length"));
      const qty = Math.max(0, Math.round(num(card.querySelector(".g-qty"))));
      const tubesPerCrate = Math.max(1, Math.round(num(card.querySelector(".g-tubespercrate"), 1)));

      const autoCrateDims = card.querySelector(".g-auto-cratedims").checked;
      let bundleInfo = null;
      if (autoCrateDims) {
        const gap = num(card.querySelector(".g-tubegap"));
        const wallClearance = num(card.querySelector(".g-wallclear"));
        const endClearance = num(card.querySelector(".g-endclear"));
        const dims = computeAutoCrateDims(od, lengthFt, tubesPerCrate, gap, wallClearance, endClearance);
        card.querySelector(".g-cratel").value = formatFeetInches(dims.crateL);
        card.querySelector(".g-cratew").value = formatFeetInches(dims.crateW);
        card.querySelector(".g-crateh").value = formatFeetInches(dims.crateH);
        bundleInfo = dims;
      }
      card.querySelector(".g-out-bundle").textContent = bundleInfo
        ? `${bundleInfo.rows} row(s) × ${bundleInfo.cols} col(s) = ${bundleInfo.rows * bundleInfo.cols} slots for ${tubesPerCrate} tubes`
        : "manual crate dimensions";

      const crateL = lenIn(card.querySelector(".g-cratel"));
      const crateW = lenIn(card.querySelector(".g-cratew"));
      const crateH = lenIn(card.querySelector(".g-crateh"));

      const mat = calcCrateMaterials(card, crateL, crateW, crateH);
      const autoTare = card.querySelector(".g-auto-tare").checked;
      if (autoTare) {
        card.querySelector(".g-tare").value = Math.round(mat.total);
      }
      card.querySelector(".g-out-ply").textContent = mat.sheets > 0 ? `${mat.sheets} sheet(s), ${fmt(mat.areaWithWaste, 0)} sqft ≈ ${fmt(mat.plyWeight, 0)} lbs` : "—";
      card.querySelector(".g-out-2x6").textContent = mat.framingFt > 0 ? `${fmt(mat.framingFt, 0)} linear ft ≈ ${fmt(mat.framingWeight, 0)} lbs` : "—";
      card.querySelector(".g-out-calcwt").textContent = mat.total > 0 ? fmt(mat.total, 0) : "—";

      const tare = num(card.querySelector(".g-tare"));

      const id = od - 2 * wall;
      const wpt = weightPerTube(card);
      const totalWeight = wpt * qty;

      card.querySelector(".g-out-wpt").textContent = wpt > 0 ? fmt(wpt, 2) : "—";
      card.querySelector(".g-out-total").textContent = wpt > 0 ? fmt(totalWeight, 0) : "—";

      if (id <= 0) {
        warnings.push(`"${name}": wall thickness is too large for the OD (inside diameter would be zero or negative). Fix before this group can be calculated.`);
      }

      const cratesNeeded = qty > 0 ? Math.ceil(qty / tubesPerCrate) : 0;
      const fullCrateWeight = tare + tubesPerCrate * wpt;

      card.querySelector(".g-out-dims").textContent = (crateL > 0 && crateW > 0 && crateH > 0) ? `${formatFeetInches(crateL)} × ${formatFeetInches(crateW)} × ${formatFeetInches(crateH)}` : "—";
      card.querySelector(".g-out-crates").textContent = cratesNeeded || "—";
      card.querySelector(".g-out-cratewt").textContent = fullCrateWeight > 0 ? fmt(fullCrateWeight, 0) : "—";

      const badge = card.querySelector(".g-out-forklift-badge");
      const overForklift = fullCrateWeight > forkliftCapacity;
      if (fullCrateWeight > 0) {
        badge.textContent = overForklift
          ? `Over forklift capacity by ${fmt(fullCrateWeight - forkliftCapacity, 0)} lbs`
          : `OK for forklift (${fmt(forkliftCapacity - fullCrateWeight, 0)} lbs to spare)`;
        badge.className = "g-out-forklift-badge badge " + (overForklift ? "bad" : "ok");
      } else {
        badge.textContent = "—";
        badge.className = "g-out-forklift-badge badge";
      }
      if (overForklift) {
        warnings.push(`"${name}": a full crate weighs ${fmt(fullCrateWeight, 0)} lbs, over the forklift's ${fmt(forkliftCapacity, 0)} lb capacity. Reduce tubes/crate (try "Auto-set") or use tare/crate size adjustments.`);
      }

      const overFloorFootprint = crateL > trailerLength || crateW > trailerLength;
      const fitsWidthNormal = crateW <= trailerWidth;
      const fitsWidthRotated = crateL <= trailerWidth;
      if (!fitsWidthNormal && !fitsWidthRotated) {
        warnings.push(`"${name}": crate footprint (${formatFeetInches(crateL)} x ${formatFeetInches(crateW)}) does not fit within the trailer width (${formatFeetInches(trailerWidth)}) in either orientation.`);
      }
      if (crateH > trailerHeight) {
        warnings.push(`"${name}": a single crate (${formatFeetInches(crateH)} tall) is taller than the trailer's interior height (${formatFeetInches(trailerHeight)}).`);
      }
      if (crateH > maxStackHeight) {
        warnings.push(`"${name}": a single crate (${formatFeetInches(crateH)} tall) already exceeds the max stack height limit (${formatFeetInches(maxStackHeight)}).`);
      }

      if (cratesNeeded > 0 && id > 0) {
        // per-crate weights: full crates then one partial remainder crate
        const crateWeights = [];
        const fullCrates = Math.floor(qty / tubesPerCrate);
        const remainderTubes = qty - fullCrates * tubesPerCrate;
        for (let i = 0; i < fullCrates; i++) crateWeights.push(tare + tubesPerCrate * wpt);
        if (remainderTubes > 0) crateWeights.push(tare + remainderTubes * wpt);

        groupResults.push({
          name,
          color: GROUP_COLORS[idx % GROUP_COLORS.length],
          crateL, crateW, crateH,
          crateWeights,
          totalWeight,
          cratesNeeded,
        });
      }
    });

    const genericCards = Array.from(genericContainer.querySelectorAll(".group-card"));
    genericCards.forEach((card, idx) => {
      const name = card.querySelector(".ge-name").value || `Misc Crate ${idx + 1}`;
      const weight = num(card.querySelector(".ge-weight"));
      const qty = Math.max(0, Math.round(num(card.querySelector(".ge-qty"), 1)));
      const crateL = lenIn(card.querySelector(".ge-cratel"));
      const crateW = lenIn(card.querySelector(".ge-cratew"));
      const crateH = lenIn(card.querySelector(".ge-crateh"));

      const totalWeight = weight * qty;
      card.querySelector(".ge-out-total").textContent = totalWeight > 0 ? fmt(totalWeight, 0) : "—";

      const badge = card.querySelector(".ge-out-forklift-badge");
      const overForklift = weight > forkliftCapacity;
      if (weight > 0) {
        badge.textContent = overForklift
          ? `Over forklift capacity by ${fmt(weight - forkliftCapacity, 0)} lbs`
          : `OK for forklift (${fmt(forkliftCapacity - weight, 0)} lbs to spare)`;
        badge.className = "ge-out-forklift-badge badge " + (overForklift ? "bad" : "ok");
      } else {
        badge.textContent = "—";
        badge.className = "ge-out-forklift-badge badge";
      }
      if (overForklift) {
        warnings.push(`"${name}": each crate weighs ${fmt(weight, 0)} lbs, over the forklift's ${fmt(forkliftCapacity, 0)} lb capacity.`);
      }

      const fitsWidthNormal = crateW <= trailerWidth;
      const fitsWidthRotated = crateL <= trailerWidth;
      if (!fitsWidthNormal && !fitsWidthRotated) {
        warnings.push(`"${name}": crate footprint (${formatFeetInches(crateL)} x ${formatFeetInches(crateW)}) does not fit within the trailer width (${formatFeetInches(trailerWidth)}) in either orientation.`);
      }
      if (crateH > trailerHeight) {
        warnings.push(`"${name}": a single crate (${formatFeetInches(crateH)} tall) is taller than the trailer's interior height (${formatFeetInches(trailerHeight)}).`);
      }
      if (crateH > maxStackHeight) {
        warnings.push(`"${name}": a single crate (${formatFeetInches(crateH)} tall) already exceeds the max stack height limit (${formatFeetInches(maxStackHeight)}).`);
      }

      if (qty > 0 && weight > 0 && crateL > 0 && crateW > 0 && crateH > 0) {
        groupResults.push({
          name,
          color: GROUP_COLORS[(groupCards.length + idx) % GROUP_COLORS.length],
          crateL, crateW, crateH,
          crateWeights: Array(qty).fill(weight),
          totalWeight,
          cratesNeeded: qty,
        });
      }
    });

    const layout = buildLoadingPlan(groupResults, {
      trailerLength, trailerWidth, trailerHeight,
      maxPayload, maxStackHeight, maxStackCount,
      forkliftLiftHeight, bedHeight,
    }, warnings);

    renderSummary(groupResults, layout, maxPayload);
    renderWarnings(warnings);
    renderTrucks(layout, { trailerLength, trailerWidth, trailerHeight, maxPayload, maxStackHeight, maxStackCount, forkliftLiftHeight, bedHeight });

    lastLayout = layout;
    lastWarnings = warnings;
    lastConstraints = { trailerLength, trailerWidth, trailerHeight, maxPayload, maxStackHeight, maxStackCount, forkliftLiftHeight, bedHeight };

    saveState();
  }

  // ---------- packing ----------
  function buildLoadingPlan(groupResults, constraints, warnings) {
    const { trailerHeight, maxStackHeight, maxStackCount, forkliftLiftHeight, bedHeight } = constraints;
    const effectiveMaxStackHeight = Math.min(maxStackHeight, trailerHeight);

    // Build "columns" (a vertical stack of same-type crates) per group
    const columns = [];
    groupResults.forEach((g) => {
      const stackLevelsByHeight = Math.max(1, Math.floor(effectiveMaxStackHeight / g.crateH));
      // forklift must slide its forks in under the top crate: reach needed = bedHeight + (levels-1)*crateH
      const stackLevelsByForklift = Math.max(1, 1 + Math.floor((forkliftLiftHeight - bedHeight) / g.crateH));
      const stackLevels = Math.min(stackLevelsByHeight, maxStackCount, stackLevelsByForklift);

      if (stackLevelsByForklift < stackLevelsByHeight && stackLevelsByForklift < maxStackCount) {
        warnings.push(`"${g.name}": limited to ${stackLevels} crate(s) high because the forklift can only reach ${formatFeetInches(forkliftLiftHeight)} to get its forks under the top crate (needs ${formatFeetInches(bedHeight + (Math.min(stackLevelsByHeight, maxStackCount) - 1) * g.crateH)} for the un-limited stack).`);
      }

      for (let i = 0; i < g.crateWeights.length; i += stackLevels) {
        const chunk = g.crateWeights.slice(i, i + stackLevels);
        columns.push({
          groupName: g.name,
          color: g.color,
          l: g.crateL,
          w: g.crateW,
          crateH: g.crateH,
          levels: chunk.length,
          height: chunk.length * g.crateH,
          weight: chunk.reduce((a, b) => a + b, 0),
          crateCount: chunk.length,
          forkliftReachNeeded: bedHeight + (chunk.length - 1) * g.crateH,
        });
      }
    });

    // sort largest footprint first for a tighter shelf pack
    columns.sort((a, b) => (b.l * b.w) - (a.l * a.w));

    const trucks = [];
    let truck = newTruck();

    columns.forEach((col) => {
      // choose orientation: (w along trailer-width axis, l along trailer-length axis) or swapped
      let cw = col.w, cl = col.l;
      const fitsNormal = cw <= constraints.trailerWidth;
      const fitsRotated = col.l <= constraints.trailerWidth;

      if (!fitsNormal && fitsRotated) {
        cw = col.l; cl = col.w;
      } else if (fitsNormal && fitsRotated) {
        // prefer orientation that leaves less leftover width in the current row
        const remaining = constraints.trailerWidth - truck.x;
        const wasteNormal = remaining - col.w >= 0 ? remaining - col.w : Infinity;
        const wasteRotated = remaining - col.l >= 0 ? remaining - col.l : Infinity;
        if (wasteRotated < wasteNormal) { cw = col.l; cl = col.w; }
      } else if (!fitsNormal && !fitsRotated) {
        warnings.push(`"${col.groupName}": crate footprint doesn't fit the trailer width in either orientation — excluded from the loading diagram.`);
        return;
      }

      if (truck.x + cw > constraints.trailerWidth) {
        truck.y += truck.rowDepth;
        truck.x = 0;
        truck.rowDepth = 0;
        truck.row += 1;
      }

      const wouldExceedLength = truck.y + cl > constraints.trailerLength;
      const wouldExceedWeight = truck.weight + col.weight > constraints.maxPayload;

      if ((wouldExceedLength || wouldExceedWeight) && truck.items.length > 0) {
        trucks.push(truck);
        truck = newTruck();
      }

      if (truck.y + cl > constraints.trailerLength) {
        warnings.push(`"${col.groupName}": a crate stack doesn't fit within the trailer length even on an empty truck — check crate dimensions.`);
      }
      if (col.weight > constraints.maxPayload) {
        warnings.push(`"${col.groupName}": a single stack weighs ${fmt(col.weight, 0)} lbs, more than the trailer's max payload (${fmt(constraints.maxPayload, 0)} lbs) by itself.`);
      }

      truck.items.push({ x: truck.x, y: truck.y, w: cw, l: cl, row: truck.row, ...col });
      truck.weight += col.weight;
      truck.x += cw;
      truck.rowDepth = Math.max(truck.rowDepth, cl);
    });

    if (truck.items.length > 0) trucks.push(truck);

    trucks.forEach((t) => centerTruckItems(t, constraints.trailerWidth, constraints.trailerLength));

    return trucks;
  }

  function newTruck() {
    return { items: [], weight: 0, x: 0, y: 0, rowDepth: 0, row: 0 };
  }

  // center each row left-right, then center the whole load top-to-bottom
  function centerTruckItems(truck, trailerWidth, trailerLength) {
    if (truck.items.length === 0) return;

    const rows = new Map();
    truck.items.forEach((it) => {
      if (!rows.has(it.row)) rows.set(it.row, []);
      rows.get(it.row).push(it);
    });
    rows.forEach((rowItems) => {
      const rowMinX = Math.min(...rowItems.map((it) => it.x));
      const rowMaxX = Math.max(...rowItems.map((it) => it.x + it.w));
      const offsetX = (trailerWidth - (rowMaxX - rowMinX)) / 2 - rowMinX;
      rowItems.forEach((it) => { it.x += offsetX; });
    });

    const minY = Math.min(...truck.items.map((it) => it.y));
    const maxY = Math.max(...truck.items.map((it) => it.y + it.l));
    const offsetY = (trailerLength - (maxY - minY)) / 2 - minY;
    truck.items.forEach((it) => { it.y += offsetY; });
  }

  // ---------- rendering ----------
  function renderSummary(groupResults, trucks, maxPayload) {
    const totalWeight = groupResults.reduce((a, g) => a + g.totalWeight, 0);
    const totalCrates = groupResults.reduce((a, g) => a + g.cratesNeeded, 0);
    const trucksNeeded = trucks.length;

    const box = document.getElementById("summaryBox");
    box.innerHTML = "";
    const stats = [
      { label: "Total tube weight", value: `${fmt(totalWeight, 0)} lbs` },
      { label: "Total crates", value: fmt(totalCrates, 0) },
      { label: "Trucks required", value: fmt(trucksNeeded, 0) },
    ];
    stats.forEach((s) => {
      const el = document.createElement("div");
      el.className = "stat";
      el.innerHTML = `<div class="label">${s.label}</div><div class="value">${s.value}</div>`;
      box.appendChild(el);
    });
  }

  function renderWarnings(warnings) {
    const box = document.getElementById("warningsBox");
    if (warnings.length === 0) {
      box.classList.add("hidden");
      box.innerHTML = "";
      return;
    }
    box.classList.remove("hidden");
    box.innerHTML = `<strong>${warnings.length} issue${warnings.length > 1 ? "s" : ""} need attention:</strong><ul>${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>`;
  }

  function renderTrucks(trucks, constraints) {
    const container = document.getElementById("trucksContainer");
    container.innerHTML = "";

    if (trucks.length === 0) {
      container.innerHTML = `<p class="note">Add tube groups with a quantity above zero to generate a loading plan.</p>`;
      return;
    }

    const usedColors = new Map();

    trucks.forEach((truck, i) => {
      const block = document.createElement("div");
      block.className = "truck-block";

      const overWeight = truck.weight > constraints.maxPayload;
      const maxHeightUsed = Math.max(...truck.items.map((it) => it.height));

      block.innerHTML = `
        <h3>Truck ${i + 1}</h3>
        <div class="truck-meta">
          <span>Weight: <b class="${overWeight ? "over" : ""}">${fmt(truck.weight, 0)} lbs</b> / ${fmt(constraints.maxPayload, 0)} lbs payload</span>
          <span>Stacks: <b>${truck.items.length}</b></span>
          <span>Tallest stack: <b>${formatFeetInches(maxHeightUsed)}</b></span>
        </div>
      `;

      const topLabel = document.createElement("p");
      topLabel.className = "note";
      topLabel.style.marginTop = "10px";
      topLabel.textContent = "Top-down floor plan:";
      block.appendChild(topLabel);

      const svgWrap = document.createElement("div");
      svgWrap.className = "floor-diagram";
      svgWrap.innerHTML = buildFloorSvg(truck, constraints, usedColors);
      block.appendChild(svgWrap);

      const tallest = truck.items.reduce((a, b) => (b.height > a.height ? b : a), truck.items[0]);
      const overReach = tallest.forkliftReachNeeded > constraints.forkliftLiftHeight;
      const sideLabel = document.createElement("p");
      sideLabel.className = "note";
      sideLabel.style.marginTop = "14px";
      sideLabel.innerHTML = `Side view (tallest stack shown: <b>${escapeHtml(tallest.groupName)}</b>, ${tallest.levels}× crates, ${formatFeetInches(tallest.height)} tall) &mdash; forklift needs to reach <b class="${overReach ? "over" : ""}">${formatFeetInches(tallest.forkliftReachNeeded)}</b> to get forks under the top crate:`;
      block.appendChild(sideLabel);

      const sideWrap = document.createElement("div");
      sideWrap.className = "floor-diagram";
      sideWrap.innerHTML = buildSideViewSvg(truck, constraints);
      block.appendChild(sideWrap);

      container.appendChild(block);
    });

    // legend (union of all groups across trucks)
    const legend = document.createElement("div");
    legend.className = "legend";
    usedColors.forEach((color, name) => {
      const item = document.createElement("span");
      item.innerHTML = `<span class="swatch" style="background:${color}"></span>${escapeHtml(name)}`;
      legend.appendChild(item);
    });
    container.appendChild(legend);
  }

  function buildFloorSvg(truck, constraints, usedColors) {
    const scale = 500 / constraints.trailerLength; // px per inch, width axis
    const svgWidth = constraints.trailerLength * scale;
    const svgHeight = constraints.trailerWidth * scale;

    let rects = "";
    truck.items.forEach((it) => {
      usedColors.set(it.groupName, it.color);
      const x = it.y * scale; // trailer length axis -> svg x
      const y = it.x * scale; // trailer width axis -> svg y
      const w = it.l * scale;
      const h = it.w * scale;
      rects += `
        <g>
          <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"
                fill="${it.color}" fill-opacity="0.75" stroke="#1f2430" stroke-width="1">
            <title>${escapeHtml(it.groupName)} crate: ${formatFeetInches(it.l)} × ${formatFeetInches(it.w)} × ${formatFeetInches(it.crateH)} each, ${it.levels} high (stack height ${formatFeetInches(it.height)}), ${fmt(it.weight, 0)} lbs</title>
          </rect>
          <text x="${(x + w / 2).toFixed(1)}" y="${(y + h / 2 - 4).toFixed(1)}" font-size="10" text-anchor="middle" fill="#fff" font-weight="600">${escapeHtml(it.groupName)}</text>
          <text x="${(x + w / 2).toFixed(1)}" y="${(y + h / 2 + 9).toFixed(1)}" font-size="9" text-anchor="middle" fill="#fff">${it.levels}× · ${fmt(it.weight, 0)} lbs</text>
        </g>`;
    });

    return `<svg viewBox="0 0 ${svgWidth.toFixed(1)} ${svgHeight.toFixed(1)}" width="100%" height="${Math.max(80, svgHeight).toFixed(0)}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${svgWidth.toFixed(1)}" height="${svgHeight.toFixed(1)}" fill="none" stroke="#5b6472" stroke-width="2" stroke-dasharray="6,4"/>
      ${rects}
    </svg>`;
  }

  function buildSideViewSvg(truck, constraints) {
    const tallest = truck.items.reduce((a, b) => (b.height > a.height ? b : a), truck.items[0]);
    const { bedHeight, trailerHeight, forkliftLiftHeight, maxStackHeight } = constraints;

    const topOfInterior = bedHeight + trailerHeight;
    const maxDim = Math.max(topOfInterior, forkliftLiftHeight, bedHeight + maxStackHeight) + 25;
    const pxPerIn = 250 / maxDim;
    const groundY = 300;
    const toY = (heightIn) => groundY - heightIn * pxPerIn;

    const trailerX = 30, trailerW = 300;
    const trailerTopY = toY(topOfInterior);
    const bedY = toY(bedHeight);
    const wheelR = 16;
    const wheelY = groundY - wheelR;

    const crateX = trailerX + 20;
    const crateW = trailerW - 40;
    let stackRects = "";
    for (let lvl = 0; lvl < tallest.levels; lvl++) {
      const bottom = bedHeight + lvl * tallest.crateH;
      const top = bottom + tallest.crateH;
      const y1 = toY(top);
      const y2 = toY(bottom);
      stackRects += `<rect x="${crateX}" y="${y1.toFixed(1)}" width="${crateW}" height="${(y2 - y1).toFixed(1)}" fill="${tallest.color}" fill-opacity="0.82" stroke="#1f2430" stroke-width="1"/>`;
    }
    const stackLabelY = toY(bedHeight + tallest.height / 2);

    const reachNeeded = tallest.forkliftReachNeeded;
    const overReach = reachNeeded > forkliftLiftHeight;
    const forkColor = overReach ? "#b3261e" : "#1a7f37";
    const forkY = toY(reachNeeded);

    const maxStackLineY = toY(bedHeight + maxStackHeight);
    const forkliftLineY = toY(forkliftLiftHeight);

    const svgW = trailerX + trailerW + 40;
    const svgH = groundY + 20;

    return `<svg viewBox="0 0 ${svgW} ${svgH}" width="100%" height="${Math.min(340, svgH)}" xmlns="http://www.w3.org/2000/svg" font-family="inherit">
      <!-- ground -->
      <line x1="0" y1="${groundY}" x2="${svgW}" y2="${groundY}" stroke="#5b6472" stroke-width="2"/>

      <!-- forklift max reach reference line -->
      <line x1="0" y1="${forkliftLineY.toFixed(1)}" x2="${svgW}" y2="${forkliftLineY.toFixed(1)}" stroke="#9a6700" stroke-width="1" stroke-dasharray="5,4"/>
      <text x="4" y="${(forkliftLineY - 4).toFixed(1)}" font-size="9" fill="#9a6700">Forklift max reach ${formatFeetInches(forkliftLiftHeight)}</text>

      <!-- max stack height reference line (within trailer span only) -->
      <line x1="${trailerX}" y1="${maxStackLineY.toFixed(1)}" x2="${trailerX + trailerW}" y2="${maxStackLineY.toFixed(1)}" stroke="#c2703d" stroke-width="1" stroke-dasharray="3,3"/>
      <text x="${trailerX + trailerW + 4}" y="${(maxStackLineY + 3).toFixed(1)}" font-size="9" fill="#c2703d">Max stack ${formatFeetInches(maxStackHeight)}</text>

      <!-- trailer chassis/undercarriage -->
      <rect x="${trailerX + 8}" y="${bedY.toFixed(1)}" width="${trailerW - 16}" height="${(wheelY - bedY).toFixed(1)}" fill="#d8dce1"/>
      <circle cx="${trailerX + 45}" cy="${wheelY.toFixed(1)}" r="${wheelR}" fill="#2b2f38"/>
      <circle cx="${trailerX + trailerW - 45}" cy="${wheelY.toFixed(1)}" r="${wheelR}" fill="#2b2f38"/>

      <!-- trailer cargo box outline -->
      <rect x="${trailerX}" y="${trailerTopY.toFixed(1)}" width="${trailerW}" height="${(bedY - trailerTopY).toFixed(1)}" fill="none" stroke="#5b6472" stroke-width="2"/>
      <line x1="${trailerX}" y1="${bedY.toFixed(1)}" x2="${trailerX + trailerW}" y2="${bedY.toFixed(1)}" stroke="#5b6472" stroke-width="2"/>
      <text x="${trailerX + 4}" y="${(trailerTopY - 6).toFixed(1)}" font-size="9" fill="var(--text-dim, #5b6472)">Trailer interior ${formatFeetInches(trailerHeight)} tall</text>

      <!-- crate stack -->
      ${stackRects}
      <text x="${(crateX + crateW / 2).toFixed(1)}" y="${stackLabelY.toFixed(1)}" font-size="10" text-anchor="middle" fill="#fff" font-weight="600">${escapeHtml(tallest.groupName)}</text>
      <text x="${trailerX + trailerW + 4}" y="${(toY(bedHeight + tallest.height) + 10).toFixed(1)}" font-size="9" fill="var(--text-dim, #5b6472)">Stack: ${tallest.levels}× = ${formatFeetInches(tallest.height)} tall</text>

      <!-- forklift reach-needed marker, no vehicle graphic -->
      <line x1="0" y1="${forkY.toFixed(1)}" x2="${trailerX}" y2="${forkY.toFixed(1)}" stroke="${forkColor}" stroke-width="2" stroke-dasharray="2,3"/>
      <text x="4" y="${(forkY - 6).toFixed(1)}" font-size="9" fill="${forkColor}" font-weight="600">Reach needed: ${formatFeetInches(reachNeeded)}</text>

      <!-- bed height dimension -->
      <text x="${trailerX + 12}" y="${(groundY + 14).toFixed(1)}" font-size="9" fill="var(--text-dim, #5b6472)">Bed height ${formatFeetInches(bedHeight)} off ground</text>
    </svg>`;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------- persistence ----------
  function saveState() {
    const state = {
      truck: {
        preset: presetSelect.value,
        length: document.getElementById("trailerLength").value,
        width: document.getElementById("trailerWidth").value,
        height: document.getElementById("trailerHeight").value,
        maxPayload: document.getElementById("maxPayload").value,
        forkliftCapacity: document.getElementById("forkliftCapacity").value,
        forkliftLiftHeight: document.getElementById("forkliftLiftHeight").value,
        bedHeight: document.getElementById("bedHeight").value,
        maxStackHeight: document.getElementById("maxStackHeight").value,
        maxStackCount: document.getElementById("maxStackCount").value,
      },
      groups: Array.from(groupsContainer.querySelectorAll(".group-card")).map((card) => ({
        name: card.querySelector(".g-name").value,
        density: num(card.querySelector(".g-density")),
        od: card.querySelector(".g-od").value,
        wall: card.querySelector(".g-wall").value,
        lengthFt: card.querySelector(".g-length").value,
        qty: card.querySelector(".g-qty").value,
        tare: card.querySelector(".g-tare").value,
        crateL: card.querySelector(".g-cratel").value,
        crateW: card.querySelector(".g-cratew").value,
        crateH: card.querySelector(".g-crateh").value,
        tubesPerCrate: card.querySelector(".g-tubespercrate").value,
        autoTare: card.querySelector(".g-auto-tare").checked,
        faceBottom: card.querySelector(".g-face-bottom").checked,
        faceTop: card.querySelector(".g-face-top").checked,
        faceSides: card.querySelector(".g-face-sides").checked,
        faceEnds: card.querySelector(".g-face-ends").checked,
        plyThickness: card.querySelector(".g-ply-thickness").value,
        plyCustom: card.querySelector(".g-ply-custom").value,
        lb2x6: card.querySelector(".g-2x6-lbft").value,
        waste: card.querySelector(".g-waste").value,
        hardware: card.querySelector(".g-hardware").value,
        autoCrateDims: card.querySelector(".g-auto-cratedims").checked,
        tubeGap: card.querySelector(".g-tubegap").value,
        wallClearance: card.querySelector(".g-wallclear").value,
        endClearance: card.querySelector(".g-endclear").value,
      })),
      generic: Array.from(genericContainer.querySelectorAll(".group-card")).map((card) => ({
        name: card.querySelector(".ge-name").value,
        weight: card.querySelector(".ge-weight").value,
        qty: card.querySelector(".ge-qty").value,
        crateL: card.querySelector(".ge-cratel").value,
        crateW: card.querySelector(".ge-cratew").value,
        crateH: card.querySelector(".ge-crateh").value,
      })),
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) { /* ignore quota errors */ }
  }

  function loadState() {
    let state = null;
    try {
      state = JSON.parse(localStorage.getItem(STORAGE_KEY));
    } catch (e) { /* ignore */ }

    if (state?.truck) {
      presetSelect.value = state.truck.preset ?? "dryvan53";
      document.getElementById("trailerLength").value = state.truck.length;
      document.getElementById("trailerWidth").value = state.truck.width;
      document.getElementById("trailerHeight").value = state.truck.height;
      document.getElementById("maxPayload").value = state.truck.maxPayload;
      document.getElementById("forkliftCapacity").value = state.truck.forkliftCapacity;
      document.getElementById("forkliftLiftHeight").value = state.truck.forkliftLiftHeight ?? 130;
      document.getElementById("bedHeight").value = state.truck.bedHeight ?? 50;
      document.getElementById("maxStackHeight").value = state.truck.maxStackHeight;
      document.getElementById("maxStackCount").value = state.truck.maxStackCount;
    }

    if (state?.groups?.length) {
      state.groups.forEach((g) => addGroup(g));
    } else {
      addGroup({
        name: "Condenser Tubes",
        density: 0.2836,
        od: 0.75,
        wall: 0.065,
        lengthFt: 20,
        qty: 200,
        tare: 150,
        crateL: 252,
        crateW: 40,
        crateH: 36,
        tubesPerCrate: 50,
      });
    }

    if (state?.generic?.length) {
      state.generic.forEach((g) => addGenericItem(g));
    }
  }

  // ---------- report data ----------
  const LOGO_B64 = "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";

  function currentGroupData(card) {
    const matSelect = card.querySelector(".g-material");
    const matLabel = matSelect.value === "custom"
      ? `Custom (${card.querySelector(".g-density").value} lb/in³)`
      : matSelect.options[matSelect.selectedIndex].text;
    return {
      name: card.querySelector(".g-name").value,
      material: matLabel,
      od: card.querySelector(".g-od").value,
      wall: card.querySelector(".g-wall").value,
      length: card.querySelector(".g-length").value,
      qty: card.querySelector(".g-qty").value,
      weightPerTube: card.querySelector(".g-out-wpt").textContent,
      groupTotal: card.querySelector(".g-out-total").textContent,
      crateDims: card.querySelector(".g-out-dims").textContent,
      tare: card.querySelector(".g-tare").value,
      autoTare: card.querySelector(".g-auto-tare").checked,
      tubesPerCrate: card.querySelector(".g-tubespercrate").value,
      cratesNeeded: card.querySelector(".g-out-crates").textContent,
      fullCrateWeight: card.querySelector(".g-out-cratewt").textContent,
      forkliftStatus: card.querySelector(".g-out-forklift-badge").textContent,
      forkliftOver: card.querySelector(".g-out-forklift-badge").classList.contains("bad"),
    };
  }

  function currentGenericData(card) {
    return {
      name: card.querySelector(".ge-name").value,
      weight: card.querySelector(".ge-weight").value,
      qty: card.querySelector(".ge-qty").value,
      total: card.querySelector(".ge-out-total").textContent,
      crateL: card.querySelector(".ge-cratel").value,
      crateW: card.querySelector(".ge-cratew").value,
      crateH: card.querySelector(".ge-crateh").value,
      forkliftStatus: card.querySelector(".ge-out-forklift-badge").textContent,
      forkliftOver: card.querySelector(".ge-out-forklift-badge").classList.contains("bad"),
    };
  }

  function gatherReportData() {
    return {
      generated: new Date().toLocaleString(),
      constraints: {
        trailer: presetSelect.options[presetSelect.selectedIndex].text,
        length: document.getElementById("trailerLength").value,
        width: document.getElementById("trailerWidth").value,
        height: document.getElementById("trailerHeight").value,
        maxPayload: document.getElementById("maxPayload").value,
        forkliftCapacity: document.getElementById("forkliftCapacity").value,
        forkliftLiftHeight: document.getElementById("forkliftLiftHeight").value,
        bedHeight: document.getElementById("bedHeight").value,
        maxStackHeight: document.getElementById("maxStackHeight").value,
        maxStackCount: document.getElementById("maxStackCount").value,
      },
      groups: Array.from(groupsContainer.querySelectorAll(".group-card")).map(currentGroupData),
      generics: Array.from(genericContainer.querySelectorAll(".group-card")).map(currentGenericData),
      summary: Array.from(document.querySelectorAll("#summaryBox .stat")).map((s) => ({
        label: s.querySelector(".label").textContent,
        value: s.querySelector(".value").textContent,
      })),
      trucks: lastLayout.map((truck, i) => ({
        index: i + 1,
        weight: truck.weight,
        maxHeightUsed: truck.items.length ? Math.max(...truck.items.map((it) => it.height)) : 0,
        items: truck.items.map((it) => ({
          groupName: it.groupName, levels: it.levels, height: it.height, weight: it.weight, l: it.l, w: it.w,
        })),
      })),
      maxPayload: lastConstraints.maxPayload,
      warnings: lastWarnings,
    };
  }

  // ---------- branded HTML report (used for both the print/PDF view and the downloadable file) ----------
  function buildReportHtml(data) {
    const esc = escapeHtml;
    const groupRows = data.groups.length
      ? data.groups.map((g) => `
        <tr>
          <td>${esc(g.name)}</td>
          <td>${esc(g.material)}</td>
          <td>${esc(g.od)}" x ${esc(g.wall)}" x ${esc(g.length)}ft</td>
          <td>${esc(g.qty)}</td>
          <td>${esc(g.weightPerTube)} lbs</td>
          <td>${esc(g.groupTotal)} lbs</td>
          <td>${esc(g.crateDims)}</td>
          <td>${esc(g.tare)} lbs${g.autoTare ? " (calc.)" : ""}</td>
          <td>${esc(g.tubesPerCrate)}</td>
          <td>${esc(g.cratesNeeded)}</td>
          <td>${esc(g.fullCrateWeight)} lbs</td>
          <td class="${g.forkliftOver ? "status-bad" : "status-ok"}">${esc(g.forkliftStatus)}</td>
        </tr>`).join("")
      : `<tr><td colspan="12" class="empty-row">No tube groups added.</td></tr>`;

    const genericSection = data.generics.length ? `
      <h2>Generic / Miscellaneous Crates</h2>
      <table>
        <thead><tr><th>Name</th><th>Weight/Crate</th><th>Qty</th><th>Total Weight</th><th>Crate Dims</th><th>Forklift</th></tr></thead>
        <tbody>
          ${data.generics.map((g) => `
            <tr>
              <td>${esc(g.name)}</td>
              <td>${esc(g.weight)} lbs</td>
              <td>${esc(g.qty)}</td>
              <td>${esc(g.total)} lbs</td>
              <td>${esc(g.crateL)}" x ${esc(g.crateW)}" x ${esc(g.crateH)}"</td>
              <td class="${g.forkliftOver ? "status-bad" : "status-ok"}">${esc(g.forkliftStatus)}</td>
            </tr>`).join("")}
        </tbody>
      </table>` : "";

    const truckSections = data.trucks.length ? data.trucks.map((t) => `
      <h3>Truck ${t.index}</h3>
      <p class="truck-meta">Weight: <b>${fmt(t.weight, 0)} lbs</b> / ${fmt(data.maxPayload, 0)} lbs payload &nbsp;&bull;&nbsp; Stacks: <b>${t.items.length}</b> &nbsp;&bull;&nbsp; Tallest stack: <b>${formatFeetInches(t.maxHeightUsed)}</b></p>
      <table>
        <thead><tr><th>Item</th><th>Crates High</th><th>Stack Height</th><th>Stack Weight</th><th>Footprint</th></tr></thead>
        <tbody>
          ${t.items.map((it) => `
            <tr>
              <td>${esc(it.groupName)}</td>
              <td>${it.levels}</td>
              <td>${formatFeetInches(it.height)}</td>
              <td>${fmt(it.weight, 0)} lbs</td>
              <td>${formatFeetInches(it.l)} x ${formatFeetInches(it.w)}</td>
            </tr>`).join("")}
        </tbody>
      </table>`).join("") : `<p class="empty-row">No trucks planned yet — add a tube group or crate with a quantity above zero.</p>`;

    const warningsSection = data.warnings.length ? `
      <h2>Warnings (${data.warnings.length})</h2>
      <ul class="warn-list">${data.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : `
      <h2>Warnings</h2>
      <p class="ok-note">No issues found.</p>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Tube Shipment Loading Plan</title>
<style>
  :root { --brand-yellow:#f4b400; --brand-black:#1a1a1a; --text:#1f2430; --text-dim:#5b6472; --border:#d8dce1; --accent-dim:#eaf1fb; --ok:#1a7f37; --ok-bg:#e6f6ea; --bad:#b3261e; --bad-bg:#fdeceb; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--text); margin: 0; padding: 0 0 40px; background: white; }
  .report-header { display:flex; align-items:center; gap:20px; background: var(--brand-black); color: white; padding: 18px 32px; border-bottom: 4px solid var(--brand-yellow); }
  .report-header img { height: 44px; background: white; padding: 6px 10px; border-radius: 4px; }
  .report-header h1 { margin: 0; font-size: 1.3rem; }
  .report-header .meta { margin: 2px 0 0; font-size: 0.82rem; opacity: 0.85; }
  main { max-width: 980px; margin: 0 auto; padding: 24px 32px; }
  h2 { font-size: 1.05rem; border-bottom: 2px solid var(--brand-yellow); padding-bottom: 6px; margin: 28px 0 12px; }
  h3 { font-size: 0.95rem; margin: 20px 0 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.82rem; margin-bottom: 4px; }
  th, td { border: 1px solid var(--border); padding: 6px 8px; text-align: left; }
  th { background: var(--accent-dim); font-weight: 700; }
  .status-ok { color: var(--ok); font-weight: 600; }
  .status-bad { color: var(--bad); font-weight: 600; }
  .empty-row { color: var(--text-dim); font-style: italic; }
  .constraints-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px 24px; font-size: 0.86rem; }
  .constraints-grid div b { color: var(--text-dim); font-weight: 600; }
  .summary-row { display: flex; gap: 16px; flex-wrap: wrap; margin: 12px 0 4px; }
  .summary-row .stat { background: var(--accent-dim); border-radius: 8px; padding: 10px 16px; }
  .summary-row .stat .label { font-size: 0.72rem; color: var(--text-dim); text-transform: uppercase; }
  .summary-row .stat .value { font-size: 1.2rem; font-weight: 700; }
  .truck-meta { font-size: 0.85rem; color: var(--text-dim); margin: 0 0 8px; }
  .warn-list { background: var(--bad-bg); border: 1px solid var(--bad); border-radius: 8px; padding: 12px 16px 12px 32px; color: var(--bad); font-size: 0.85rem; }
  .ok-note { color: var(--ok); font-size: 0.9rem; }
  footer { max-width: 980px; margin: 30px auto 0; padding: 0 32px; font-size: 0.75rem; color: var(--text-dim); }
  .print-bar { position: sticky; top: 0; background: white; border-bottom: 1px solid var(--border); padding: 10px 32px; text-align: right; }
  .print-bar button { background: var(--brand-black); color: white; border: none; border-radius: 6px; padding: 8px 16px; font-size: 0.85rem; cursor: pointer; }
  @media print {
    .print-bar { display: none; }
    body { padding: 0; }
    table { page-break-inside: avoid; }
    h2, h3 { page-break-after: avoid; }
  }
</style>
</head>
<body>
  <div class="print-bar screen-only"><button onclick="window.print()">Print / Save as PDF</button></div>
  <div class="report-header">
    <img src="data:image/png;base64,${LOGO_B64}" alt="RetubeCo, Inc.">
    <div>
      <h1>Tube Shipment Loading Plan</h1>
      <p class="meta">Generated ${esc(data.generated)}</p>
    </div>
  </div>
  <main>
    <h2>Truck &amp; Site Constraints</h2>
    <div class="constraints-grid">
      <div><b>Trailer:</b> ${esc(data.constraints.trailer)} &mdash; ${esc(data.constraints.length)}" L x ${esc(data.constraints.width)}" W x ${esc(data.constraints.height)}" H interior</div>
      <div><b>Max payload:</b> ${esc(data.constraints.maxPayload)} lbs</div>
      <div><b>Forklift:</b> ${esc(data.constraints.forkliftCapacity)} lb capacity, ${esc(data.constraints.forkliftLiftHeight)}" max lift height</div>
      <div><b>Trailer bed height:</b> ${esc(data.constraints.bedHeight)}" off ground</div>
      <div><b>Max stack:</b> ${esc(data.constraints.maxStackHeight)}" or ${esc(data.constraints.maxStackCount)} crate(s) high, whichever is more restrictive</div>
    </div>

    <h2>Tube Groups</h2>
    <table>
      <thead><tr><th>Group</th><th>Material</th><th>OD x Wall x Length</th><th>Qty</th><th>Wt/Tube</th><th>Group Total</th><th>Crate Dims</th><th>Tare</th><th>Tubes/Crate</th><th>Crates Needed</th><th>Full Crate Wt</th><th>Forklift</th></tr></thead>
      <tbody>${groupRows}</tbody>
    </table>

    ${genericSection}

    <h2>Summary</h2>
    <div class="summary-row">
      ${data.summary.map((s) => `<div class="stat"><div class="label">${esc(s.label)}</div><div class="value">${esc(s.value)}</div></div>`).join("")}
    </div>

    <h2>Per-Truck Breakdown</h2>
    ${truckSections}

    ${warningsSection}
  </main>
  <footer>All figures are estimates for planning purposes &mdash; verify against actual crate builds, scale weights, and DOT/carrier requirements before shipping.</footer>
</body>
</html>`;
  }

  // ---------- CSV (Excel) export ----------
  function csvEscape(v) {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function csvRow(cells) { return cells.map(csvEscape).join(",") + "\r\n"; }

  function buildReportCsv(data) {
    let out = "";
    out += csvRow(["Tube Shipment Loading Plan", data.generated]);
    out += "\r\n";

    out += csvRow(["TUBE GROUPS"]);
    out += csvRow(["Group", "Material", "OD (in)", "Wall (in)", "Length (ft)", "Qty", "Weight/Tube (lbs)", "Group Total (lbs)", "Crate Dims", "Tare (lbs)", "Tubes/Crate", "Crates Needed", "Full Crate Weight (lbs)", "Forklift Status"]);
    data.groups.forEach((g) => {
      out += csvRow([g.name, g.material, g.od, g.wall, g.length, g.qty, g.weightPerTube, g.groupTotal, g.crateDims, g.tare, g.tubesPerCrate, g.cratesNeeded, g.fullCrateWeight, g.forkliftStatus]);
    });
    out += "\r\n";

    if (data.generics.length) {
      out += csvRow(["GENERIC / MISC CRATES"]);
      out += csvRow(["Name", "Weight/Crate (lbs)", "Qty", "Total Weight (lbs)", "Crate L (in)", "Crate W (in)", "Crate H (in)", "Forklift Status"]);
      data.generics.forEach((g) => {
        out += csvRow([g.name, g.weight, g.qty, g.total, g.crateL, g.crateW, g.crateH, g.forkliftStatus]);
      });
      out += "\r\n";
    }

    out += csvRow(["SUMMARY"]);
    data.summary.forEach((s) => out += csvRow([s.label, s.value]));
    out += "\r\n";

    out += csvRow(["TRUCK LOADING"]);
    out += csvRow(["Truck", "Truck Weight (lbs)", "Item", "Crates High", "Stack Height (in)", "Stack Weight (lbs)", "Footprint L (in)", "Footprint W (in)"]);
    data.trucks.forEach((t) => {
      t.items.forEach((it) => {
        out += csvRow([`Truck ${t.index}`, fmt(t.weight, 0), it.groupName, it.levels, fmt(it.height, 0), fmt(it.weight, 0), fmt(it.l, 0), fmt(it.w, 0)]);
      });
    });
    out += "\r\n";

    out += csvRow(["WARNINGS"]);
    if (data.warnings.length) {
      data.warnings.forEach((w) => out += csvRow([w]));
    } else {
      out += csvRow(["None"]);
    }

    return out;
  }

  function downloadBlob(content, mime, filename) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  document.getElementById("printReportBtn").addEventListener("click", () => {
    const html = buildReportHtml(gatherReportData());
    const win = window.open("", "_blank");
    if (!win) {
      downloadBlob(html, "text/html", `tube-loading-plan-${new Date().toISOString().slice(0, 10)}.html`);
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
  });

  document.getElementById("downloadCsvBtn").addEventListener("click", () => {
    const csv = buildReportCsv(gatherReportData());
    downloadBlob(csv, "text/csv", `tube-loading-plan-${new Date().toISOString().slice(0, 10)}.csv`);
  });

  loadState();
  recalcAll();
})();
