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
      node.querySelector(".materials-panel").classList.toggle("hidden", !on);
      const tareInput = node.querySelector(".g-tare");
      if (on) tareInput.setAttribute("readonly", "readonly");
      else tareInput.removeAttribute("readonly");
    };
    node.querySelector(".g-auto-tare").addEventListener("change", () => {
      applyAutoTareState();
      recalcAll();
    });
    applyAutoTareState();

    node.querySelector(".g-ply-thickness").addEventListener("change", (e) => {
      node.querySelector(".g-ply-custom-wrap").classList.toggle("hidden", e.target.value !== "custom");
      recalcAll();
    });
    node.querySelector(".g-ply-custom-wrap").classList.toggle("hidden", node.querySelector(".g-ply-thickness").value !== "custom");

    node.querySelector(".g-autofit").addEventListener("click", () => {
      const forkliftCapacity = num(document.getElementById("forkliftCapacity"));
      const tare = num(node.querySelector(".g-tare"));
      const wpt = weightPerTube(node);
      if (wpt > 0) {
        const maxTubes = Math.max(1, Math.floor((forkliftCapacity - tare) / wpt));
        node.querySelector(".g-tubespercrate").value = maxTubes;
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
      document.getElementById("trailerLength").value = preset.l;
      document.getElementById("trailerWidth").value = preset.w;
      document.getElementById("trailerHeight").value = preset.h;
    }
    recalcAll();
  });

  ["trailerLength", "trailerWidth", "trailerHeight", "maxPayload", "forkliftCapacity", "forkliftLiftHeight", "bedHeight", "maxStackHeight", "maxStackCount"].forEach((id) => {
    document.getElementById(id).addEventListener("input", recalcAll);
  });

  // ---------- core calculation ----------
  function recalcAll() {
    const warnings = [];

    const trailerLength = num(document.getElementById("trailerLength"));
    const trailerWidth = num(document.getElementById("trailerWidth"));
    const trailerHeight = num(document.getElementById("trailerHeight"));
    const maxPayload = num(document.getElementById("maxPayload"));
    const forkliftCapacity = num(document.getElementById("forkliftCapacity"));
    const forkliftLiftHeight = num(document.getElementById("forkliftLiftHeight"));
    const bedHeight = num(document.getElementById("bedHeight"));
    const maxStackHeight = num(document.getElementById("maxStackHeight"));
    const maxStackCount = Math.max(1, Math.round(num(document.getElementById("maxStackCount"), 1)));

    if (bedHeight > forkliftLiftHeight) {
      warnings.push(`The forklift's max lift height (${fmt(forkliftLiftHeight, 0)}") is below the trailer bed height (${fmt(bedHeight, 0)}") — it can't reach the trailer floor at all.`);
    }

    const groupCards = Array.from(groupsContainer.querySelectorAll(".group-card"));
    const groupResults = [];

    groupCards.forEach((card, idx) => {
      const name = card.querySelector(".g-name").value || `Group ${idx + 1}`;
      const od = num(card.querySelector(".g-od"));
      const wall = num(card.querySelector(".g-wall"));
      const lengthFt = num(card.querySelector(".g-length"));
      const qty = Math.max(0, Math.round(num(card.querySelector(".g-qty"))));
      const crateL = num(card.querySelector(".g-cratel"));
      const crateW = num(card.querySelector(".g-cratew"));
      const crateH = num(card.querySelector(".g-crateh"));
      const tubesPerCrate = Math.max(1, Math.round(num(card.querySelector(".g-tubespercrate"), 1)));

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

      card.querySelector(".g-out-dims").textContent = (crateL > 0 && crateW > 0 && crateH > 0) ? `${fmt(crateL, 0)}" × ${fmt(crateW, 0)}" × ${fmt(crateH, 0)}"` : "—";
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
        warnings.push(`"${name}": crate footprint (${crateL}" x ${crateW}") does not fit within the trailer width (${trailerWidth}") in either orientation.`);
      }
      if (crateH > trailerHeight) {
        warnings.push(`"${name}": a single crate (${crateH}" tall) is taller than the trailer's interior height (${trailerHeight}").`);
      }
      if (crateH > maxStackHeight) {
        warnings.push(`"${name}": a single crate (${crateH}" tall) already exceeds the max stack height limit (${maxStackHeight}").`);
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
      const crateL = num(card.querySelector(".ge-cratel"));
      const crateW = num(card.querySelector(".ge-cratew"));
      const crateH = num(card.querySelector(".ge-crateh"));

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
        warnings.push(`"${name}": crate footprint (${crateL}" x ${crateW}") does not fit within the trailer width (${trailerWidth}") in either orientation.`);
      }
      if (crateH > trailerHeight) {
        warnings.push(`"${name}": a single crate (${crateH}" tall) is taller than the trailer's interior height (${trailerHeight}").`);
      }
      if (crateH > maxStackHeight) {
        warnings.push(`"${name}": a single crate (${crateH}" tall) already exceeds the max stack height limit (${maxStackHeight}").`);
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
        warnings.push(`"${g.name}": limited to ${stackLevels} crate(s) high because the forklift can only reach ${fmt(forkliftLiftHeight, 0)}" to get its forks under the top crate (needs ${fmt(bedHeight + (Math.min(stackLevelsByHeight, maxStackCount) - 1) * g.crateH, 0)}" for the un-limited stack).`);
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
          <span>Tallest stack: <b>${fmt(maxHeightUsed, 0)}"</b></span>
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
      sideLabel.innerHTML = `Side view (tallest stack shown: <b>${escapeHtml(tallest.groupName)}</b>, ${tallest.levels}× crates, ${fmt(tallest.height, 0)}" tall) &mdash; forklift needs to reach <b class="${overReach ? "over" : ""}">${fmt(tallest.forkliftReachNeeded, 0)}"</b> to get forks under the top crate:`;
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
            <title>${escapeHtml(it.groupName)} crate: ${fmt(it.l, 0)}" × ${fmt(it.w, 0)}" × ${fmt(it.crateH, 0)}" each, ${it.levels} high (stack height ${fmt(it.height, 0)}"), ${fmt(it.weight, 0)} lbs</title>
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
      <text x="4" y="${(forkliftLineY - 4).toFixed(1)}" font-size="9" fill="#9a6700">Forklift max reach ${fmt(forkliftLiftHeight, 0)}"</text>

      <!-- max stack height reference line (within trailer span only) -->
      <line x1="${trailerX}" y1="${maxStackLineY.toFixed(1)}" x2="${trailerX + trailerW}" y2="${maxStackLineY.toFixed(1)}" stroke="#c2703d" stroke-width="1" stroke-dasharray="3,3"/>
      <text x="${trailerX + trailerW + 4}" y="${(maxStackLineY + 3).toFixed(1)}" font-size="9" fill="#c2703d">Max stack ${fmt(maxStackHeight, 0)}"</text>

      <!-- trailer chassis/undercarriage -->
      <rect x="${trailerX + 8}" y="${bedY.toFixed(1)}" width="${trailerW - 16}" height="${(wheelY - bedY).toFixed(1)}" fill="#d8dce1"/>
      <circle cx="${trailerX + 45}" cy="${wheelY.toFixed(1)}" r="${wheelR}" fill="#2b2f38"/>
      <circle cx="${trailerX + trailerW - 45}" cy="${wheelY.toFixed(1)}" r="${wheelR}" fill="#2b2f38"/>

      <!-- trailer cargo box outline -->
      <rect x="${trailerX}" y="${trailerTopY.toFixed(1)}" width="${trailerW}" height="${(bedY - trailerTopY).toFixed(1)}" fill="none" stroke="#5b6472" stroke-width="2"/>
      <line x1="${trailerX}" y1="${bedY.toFixed(1)}" x2="${trailerX + trailerW}" y2="${bedY.toFixed(1)}" stroke="#5b6472" stroke-width="2"/>
      <text x="${trailerX + 4}" y="${(trailerTopY - 6).toFixed(1)}" font-size="9" fill="var(--text-dim, #5b6472)">Trailer interior ${fmt(trailerHeight, 0)}" tall</text>

      <!-- crate stack -->
      ${stackRects}
      <text x="${(crateX + crateW / 2).toFixed(1)}" y="${stackLabelY.toFixed(1)}" font-size="10" text-anchor="middle" fill="#fff" font-weight="600">${escapeHtml(tallest.groupName)}</text>
      <text x="${trailerX + trailerW + 4}" y="${(toY(bedHeight + tallest.height) + 10).toFixed(1)}" font-size="9" fill="var(--text-dim, #5b6472)">Stack: ${tallest.levels}× = ${fmt(tallest.height, 0)}" tall</text>

      <!-- forklift reach-needed marker, no vehicle graphic -->
      <line x1="0" y1="${forkY.toFixed(1)}" x2="${trailerX}" y2="${forkY.toFixed(1)}" stroke="${forkColor}" stroke-width="2" stroke-dasharray="2,3"/>
      <text x="4" y="${(forkY - 6).toFixed(1)}" font-size="9" fill="${forkColor}" font-weight="600">Reach needed: ${fmt(reachNeeded, 0)}"</text>

      <!-- bed height dimension -->
      <text x="${trailerX + 12}" y="${(groundY + 14).toFixed(1)}" font-size="9" fill="var(--text-dim, #5b6472)">Bed height ${fmt(bedHeight, 0)}" off ground</text>
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

  // ---------- report download ----------
  function buildReportText() {
    const lines = [];
    lines.push("BOILER / CONDENSER TUBE — SEMI TRUCK LOADING PLAN");
    lines.push(`Generated: ${new Date().toLocaleString()}`);
    lines.push("");

    lines.push("TRUCK & SITE CONSTRAINTS");
    lines.push(`  Trailer: ${presetSelect.options[presetSelect.selectedIndex].text} — ${document.getElementById("trailerLength").value}" L x ${document.getElementById("trailerWidth").value}" W x ${document.getElementById("trailerHeight").value}" H interior`);
    lines.push(`  Max payload: ${document.getElementById("maxPayload").value} lbs`);
    lines.push(`  Forklift: ${document.getElementById("forkliftCapacity").value} lb capacity, ${document.getElementById("forkliftLiftHeight").value}" max lift height`);
    lines.push(`  Trailer bed height: ${document.getElementById("bedHeight").value}" off ground`);
    lines.push(`  Max stack: ${document.getElementById("maxStackHeight").value}" or ${document.getElementById("maxStackCount").value} crate(s) high, whichever is more restrictive`);
    lines.push("");

    const groupCards = Array.from(groupsContainer.querySelectorAll(".group-card"));
    lines.push("TUBE GROUPS");
    if (groupCards.length === 0) lines.push("  (none)");
    groupCards.forEach((card, i) => {
      const matSelect = card.querySelector(".g-material");
      const matLabel = matSelect.value === "custom"
        ? `custom density ${card.querySelector(".g-density").value} lb/in³`
        : matSelect.options[matSelect.selectedIndex].text;
      lines.push(`  ${i + 1}. ${card.querySelector(".g-name").value} — ${matLabel}, ${card.querySelector(".g-od").value}" OD x ${card.querySelector(".g-wall").value}" wall x ${card.querySelector(".g-length").value} ft, qty ${card.querySelector(".g-qty").value}`);
      lines.push(`     Weight/tube: ${card.querySelector(".g-out-wpt").textContent} lbs | Group total: ${card.querySelector(".g-out-total").textContent} lbs`);
      lines.push(`     Crate: ${card.querySelector(".g-out-dims").textContent}, tare ${card.querySelector(".g-tare").value} lbs${card.querySelector(".g-auto-tare").checked ? " (calculated from plywood + 2x6)" : ""}, ${card.querySelector(".g-tubespercrate").value} tubes/crate`);
      lines.push(`     Crates needed: ${card.querySelector(".g-out-crates").textContent} | Full crate weight: ${card.querySelector(".g-out-cratewt").textContent} lbs [${card.querySelector(".g-out-forklift-badge").textContent}]`);
    });
    lines.push("");

    const genericCards = Array.from(genericContainer.querySelectorAll(".group-card"));
    if (genericCards.length > 0) {
      lines.push("GENERIC / MISC CRATES");
      genericCards.forEach((card, i) => {
        lines.push(`  ${i + 1}. ${card.querySelector(".ge-name").value} — ${card.querySelector(".ge-weight").value} lbs each x ${card.querySelector(".ge-qty").value} = ${card.querySelector(".ge-out-total").textContent} lbs, ${card.querySelector(".ge-cratel").value}"x${card.querySelector(".ge-cratew").value}"x${card.querySelector(".ge-crateh").value}" [${card.querySelector(".ge-out-forklift-badge").textContent}]`);
      });
      lines.push("");
    }

    lines.push("SUMMARY");
    document.querySelectorAll("#summaryBox .stat").forEach((s) => {
      lines.push(`  ${s.querySelector(".label").textContent}: ${s.querySelector(".value").textContent}`);
    });
    lines.push("");

    lastLayout.forEach((truck, i) => {
      const maxHeightUsed = truck.items.length ? Math.max(...truck.items.map((it) => it.height)) : 0;
      lines.push(`TRUCK ${i + 1}`);
      lines.push(`  Weight: ${fmt(truck.weight, 0)} lbs / ${fmt(lastConstraints.maxPayload, 0)} lbs payload`);
      lines.push(`  Stacks: ${truck.items.length}, tallest stack: ${fmt(maxHeightUsed, 0)}"`);
      truck.items.forEach((it) => {
        lines.push(`    - ${it.groupName}: ${it.levels}x crate(s) high = ${fmt(it.height, 0)}" tall, ${fmt(it.weight, 0)} lbs, footprint ${fmt(it.l, 0)}"x${fmt(it.w, 0)}"`);
      });
      lines.push("");
    });

    if (lastWarnings.length > 0) {
      lines.push(`WARNINGS (${lastWarnings.length})`);
      lastWarnings.forEach((w) => lines.push(`  - ${w}`));
    } else {
      lines.push("WARNINGS: none");
    }

    return lines.join("\n");
  }

  document.getElementById("downloadReportBtn").addEventListener("click", () => {
    const text = buildReportText();
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tube-loading-plan-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  loadState();
  recalcAll();
})();
