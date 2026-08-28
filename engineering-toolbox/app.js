(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // ---------- shared data ----------
  // Typical room-temperature values for estimating.
  const MATERIALS = [
    { name: "Carbon Steel", density: 0.2836, alpha: 6.5 },
    { name: "Stainless 304", density: 0.289, alpha: 9.6 },
    { name: "Stainless 316", density: 0.289, alpha: 8.9 },
    { name: "Copper", density: 0.3232, alpha: 9.8 },
    { name: "Admiralty Brass", density: 0.308, alpha: 11.2 },
    { name: "Aluminum Brass", density: 0.301, alpha: 10.3 },
    { name: "90/10 Cupronickel", density: 0.3216, alpha: 9.5 },
    { name: "70/30 Cupronickel", density: 0.323, alpha: 8.5 },
    { name: "Titanium Gr. 2", density: 0.163, alpha: 4.8 },
    { name: "Monel 400", density: 0.319, alpha: 7.7 },
    { name: "Aluminum 6061", density: 0.0975, alpha: 13.0 },
  ];

  const BWG = [
    ["00", 0.38], ["0", 0.34], ["1", 0.3], ["2", 0.284], ["3", 0.259],
    ["4", 0.238], ["5", 0.22], ["6", 0.203], ["7", 0.18], ["8", 0.165],
    ["9", 0.148], ["10", 0.134], ["11", 0.12], ["12", 0.109], ["13", 0.095],
    ["14", 0.083], ["15", 0.072], ["16", 0.065], ["17", 0.058], ["18", 0.049],
    ["19", 0.042], ["20", 0.035], ["21", 0.032], ["22", 0.028], ["23", 0.025],
    ["24", 0.022],
  ];

  // NPS, OD, Sch10, Sch40, Sch80 (ASME B36.10, inches)
  const PIPE = [
    ["1/8", 0.405, 0.049, 0.068, 0.095],
    ["1/4", 0.54, 0.065, 0.088, 0.119],
    ["3/8", 0.675, 0.065, 0.091, 0.126],
    ["1/2", 0.84, 0.083, 0.109, 0.147],
    ["3/4", 1.05, 0.083, 0.113, 0.154],
    ["1", 1.315, 0.109, 0.133, 0.179],
    ["1-1/4", 1.66, 0.109, 0.14, 0.191],
    ["1-1/2", 1.9, 0.109, 0.145, 0.2],
    ["2", 2.375, 0.109, 0.154, 0.218],
    ["2-1/2", 2.875, 0.12, 0.203, 0.276],
    ["3", 3.5, 0.12, 0.216, 0.3],
    ["3-1/2", 4.0, 0.12, 0.226, 0.318],
    ["4", 4.5, 0.12, 0.237, 0.337],
    ["5", 5.563, 0.134, 0.258, 0.375],
    ["6", 6.625, 0.134, 0.28, 0.432],
    ["8", 8.625, 0.148, 0.322, 0.5],
    ["10", 10.75, 0.165, 0.365, 0.594],
    ["12", 12.75, 0.18, 0.406, 0.688],
    ["14", 14.0, 0.25, 0.438, 0.75],
    ["16", 16.0, 0.25, 0.5, 0.844],
    ["18", 18.0, 0.25, 0.562, 0.938],
    ["20", 20.0, 0.25, 0.594, 1.031],
    ["24", 24.0, 0.25, 0.688, 1.219],
  ];

  // ---------- helpers ----------
  const num = (el, fallback = 0) => {
    const v = parseFloat(el.value);
    return Number.isFinite(v) ? v : fallback;
  };
  const fmt = (n, digits = 2) =>
    Number.isFinite(n)
      ? n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits > 0 && Math.abs(n) < 1000 ? Math.min(digits, 3) : 0 })
      : "—";
  const fmtInt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString() : "—");

  // Accepts 20', 20' 6", 20'6", 20-6, 240, 240" — returns inches.
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
      return feet * 12 + (inchMatch ? parseFloat(inchMatch[1]) : 0);
    }
    const inchOnly = s.match(/^(-?\d+(?:\.\d+)?)\s*(?:"|in|inch|inches)$/i);
    if (inchOnly) return parseFloat(inchOnly[1]);
    const shorthand = s.match(/^(-?\d+(?:\.\d+)?)[\s-](\d+(?:\.\d+)?)$/);
    if (shorthand) return parseFloat(shorthand[1]) * 12 + parseFloat(shorthand[2]);
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : NaN;
  }

  function tile(label, value, sub, tone) {
    return `<div class="result-tile ${tone || ""}">
      <div class="rt-label">${label}</div>
      <div class="rt-value">${value}</div>
      ${sub ? `<div class="rt-sub">${sub}</div>` : ""}
    </div>`;
  }

  function fillMaterialSelect(select, withCustom) {
    select.innerHTML = MATERIALS.map((m, i) => `<option value="${i}">${m.name}</option>`).join("") +
      (withCustom ? '<option value="custom">Custom&hellip;</option>' : "");
  }

  function fillBwgSelect(select, withCustom) {
    select.innerHTML = BWG.map(([g, w]) => `<option value="${w}">BWG ${g} (${w.toFixed(3)}")</option>`).join("") +
      (withCustom ? '<option value="custom">Wall in inches&hellip;</option>' : "");
  }

  function materialControl(selectId, customWrapId, customInputId, prop) {
    const select = $(selectId);
    fillMaterialSelect(select, true);
    select.addEventListener("change", () => {
      const custom = select.value === "custom";
      $(customWrapId).classList.toggle("hidden", !custom);
      if (!custom) $(customInputId).value = MATERIALS[select.value][prop];
      recalcAll();
    });
    return () => (select.value === "custom" ? num($(customInputId)) : MATERIALS[select.value][prop]);
  }

  function sectionNav() {
    const items = document.querySelectorAll(".nav-item");
    items.forEach((btn) => {
      btn.addEventListener("click", () => {
        items.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        document.querySelectorAll(".tool-section").forEach((s) => s.classList.add("hidden"));
        $(btn.dataset.section).classList.remove("hidden");
        window.scrollTo({ top: 0 });
      });
    });
  }

  const recalcFns = [];
  function recalcAll() { recalcFns.forEach((fn) => fn()); }

  // ---------- Tube Weight ----------
  const twDensity = materialControl("twMaterial", "twDensityWrap", "twDensity", "density");
  const twBwg = $("twBwg");
  fillBwgSelect(twBwg, true);
  twBwg.value = "0.049";
  twBwg.addEventListener("change", () => {
    $("twWallWrap").classList.toggle("hidden", twBwg.value !== "custom");
    recalcAll();
  });
  function calcTubeWeight() {
    const od = num($("twOd"));
    const wall = twBwg.value === "custom" ? num($("twWall")) : parseFloat(twBwg.value);
    const lengthIn = parseFeetInches($("twLength").value);
    const count = Math.max(1, num($("twCount"), 1));
    const density = twDensity();
    if (!(od > 0) || !(wall > 0) || !(lengthIn > 0) || wall * 2 >= od) {
      $("twResults").innerHTML = tile("Per tube", "—");
      return;
    }
    const id = od - 2 * wall;
    const area = (Math.PI / 4) * (od * od - id * id);
    const perTube = area * lengthIn * density;
    const perFoot = area * 12 * density;
    $("twResults").innerHTML =
      tile("Weight per foot", `${fmt(perFoot, 3)} lb/ft`) +
      tile("Weight per tube", `${fmt(perTube, 1)} lb`, `${fmt(lengthIn / 12, 2)} ft long`) +
      tile(`Total (${fmtInt(count)} tubes)`, `${fmtInt(perTube * count)} lb`, `${fmt((perTube * count) / 2000, 2)} tons`) +
      tile("Tube ID", `${id.toFixed(3)}"`);
  }
  recalcFns.push(calcTubeWeight);

  // ---------- Tube ID & Gauge ----------
  const tgBwg = $("tgBwg");
  fillBwgSelect(tgBwg, false);
  tgBwg.value = "0.049";
  function calcTubeGauge() {
    const od = num($("tgOd"));
    const wall = parseFloat(tgBwg.value);
    if (!(od > 0) || wall * 2 >= od) {
      $("tgResults").innerHTML = tile("Tube ID", "—");
      return;
    }
    const id = od - 2 * wall;
    const flowArea = (Math.PI / 4) * id * id;
    $("tgResults").innerHTML =
      tile("Tube ID", `${id.toFixed(3)}"`, `${(id * 25.4).toFixed(2)} mm`) +
      tile("Wall", `${wall.toFixed(3)}"`, `${(wall * 25.4).toFixed(2)} mm`) +
      tile("Flow area per tube", `${flowArea.toFixed(4)} in²`) +
      tile("OD/ID ratio", (od / id).toFixed(3));
  }
  recalcFns.push(calcTubeGauge);

  // ---------- Tube Rolling ----------
  function calcRolling() {
    const od = num($("rlOd"));
    const wall = num($("rlWall"));
    const idBefore = num($("rlIdBefore"));
    const hole = num($("rlHole"));
    const idAfter = num($("rlIdAfter"));
    if (!(od > 0) || !(wall > 0) || !(idBefore > 0) || !(hole > 0) || !(idAfter > 0)) {
      $("rlResults").innerHTML = tile("Wall reduction", "—");
      return;
    }
    const clearance = hole - od;
    const expansion = idAfter - idBefore;
    const reduction = ((expansion - clearance) / (2 * wall)) * 100;
    let tone = "good";
    let verdict = "within the typical 4–8% range";
    if (reduction < 4) { tone = "warn"; verdict = "below the typical 4% minimum — joint may be loose"; }
    if (reduction > 8) { tone = "bad"; verdict = "above the typical 8% maximum — risk of over-rolling"; }
    if (reduction < 0) { tone = "bad"; verdict = "tube has not yet contacted the tubesheet hole"; }
    $("rlResults").innerHTML =
      tile("Apparent wall reduction", `${reduction.toFixed(1)}%`, verdict, tone) +
      tile("Hole clearance", `${clearance.toFixed(3)}"`, "hole ID − tube OD") +
      tile("Total ID growth", `${expansion.toFixed(3)}"`) +
      tile("Growth into wall", `${Math.max(0, expansion - clearance).toFixed(3)}"`, "after closing the clearance");
  }
  recalcFns.push(calcRolling);

  // ---------- Tube-Side Velocity ----------
  function calcVelocity() {
    const gpm = num($("vlGpm"));
    const tubes = num($("vlTubes"));
    const passes = Math.max(1, num($("vlPasses"), 1));
    const id = num($("vlId"));
    if (!(gpm > 0) || !(tubes > 0) || !(id > 0)) {
      $("vlResults").innerHTML = tile("Velocity", "—");
      return;
    }
    const tubesPerPass = tubes / passes;
    const gpmPerTube = gpm / tubesPerPass;
    const velocity = (0.4085 * gpmPerTube) / (id * id);
    let tone = "good";
    if (velocity < 3) tone = "warn";
    if (velocity > 8) tone = "bad";
    $("vlResults").innerHTML =
      tile("Velocity", `${velocity.toFixed(2)} ft/s`, "", tone) +
      tile("Tubes per pass", fmtInt(tubesPerPass)) +
      tile("Flow per tube", `${gpmPerTube.toFixed(2)} GPM`);
  }
  recalcFns.push(calcVelocity);

  // ---------- Surface Area ----------
  function calcSurface() {
    const od = num($("saOd"));
    const lengthIn = parseFeetInches($("saLength").value);
    const count = num($("saCount"));
    if (!(od > 0) || !(lengthIn > 0) || !(count > 0)) {
      $("saResults").innerHTML = tile("Surface area", "—");
      return;
    }
    const perTube = Math.PI * (od / 12) * (lengthIn / 12);
    $("saResults").innerHTML =
      tile("Per tube", `${fmt(perTube, 2)} ft²`) +
      tile("Bundle total", `${fmtInt(perTube * count)} ft²`, `${fmt((perTube * count) * 0.092903, 1)} m²`);
  }
  recalcFns.push(calcSurface);

  // ---------- LMTD ----------
  function calcLmtd() {
    const mode = $("lmMode").value;
    const hi = num($("lmHotIn")), ho = num($("lmHotOut"));
    const ci = num($("lmColdIn")), co = num($("lmColdOut"));
    const dt1 = mode === "counter" ? hi - co : hi - ci;
    const dt2 = mode === "counter" ? ho - ci : ho - co;
    if (dt1 <= 0 || dt2 <= 0) {
      $("lmResults").innerHTML = tile("LMTD", "—", "temperature cross or invalid inputs");
      return;
    }
    const lmtd = Math.abs(dt1 - dt2) < 1e-9 ? dt1 : (dt1 - dt2) / Math.log(dt1 / dt2);
    $("lmResults").innerHTML =
      tile("LMTD", `${lmtd.toFixed(2)} °F`) +
      tile("ΔT₁", `${dt1.toFixed(1)} °F`) +
      tile("ΔT₂", `${dt2.toFixed(1)} °F`);
  }
  recalcFns.push(calcLmtd);

  // ---------- Heat Duty ----------
  function calcDuty() {
    const gpm = num($("hdGpm")), dt = num($("hdDt"));
    const q = 500 * gpm * dt; // 8.33 lb/gal x 60 min/hr x 1 BTU/lb-F
    $("hdWaterResults").innerHTML =
      tile("Heat duty", `${fmtInt(q)} BTU/hr`, `${fmt(q / 12000, 1)} tons refrigeration`) +
      tile("In megawatts", `${fmt(q / 3412142, 3)} MW`);
    const m = num($("hdMass")), cp = num($("hdCp")), dt2 = num($("hdDt2"));
    const q2 = m * cp * dt2;
    $("hdAnyResults").innerHTML =
      tile("Heat duty", `${fmtInt(q2)} BTU/hr`) +
      tile("In megawatts", `${fmt(q2 / 3412142, 3)} MW`);
  }
  recalcFns.push(calcDuty);

  // ---------- Thermal Expansion ----------
  const teAlpha = materialControl("teMaterial", "teAlphaWrap", "teAlpha", "alpha");
  function calcThermal() {
    const alpha = teAlpha() * 1e-6;
    const lengthIn = parseFeetInches($("teLength").value);
    const dt = num($("teT2")) - num($("teT1"));
    if (!(lengthIn > 0)) {
      $("teResults").innerHTML = tile("Growth", "—");
      return;
    }
    const growth = alpha * lengthIn * dt;
    $("teResults").innerHTML =
      tile("Length change", `${growth.toFixed(3)}"`, `${(growth * 25.4).toFixed(2)} mm`) +
      tile("ΔT", `${fmt(dt, 0)} °F`) +
      tile("Per 100 ft", `${(alpha * 1200 * dt).toFixed(3)}"`);
  }
  recalcFns.push(calcThermal);

  // ---------- Metal Weight ----------
  const mwDensity = materialControl("mwMaterial", "mwDensityWrap", "mwDensity", "density");
  const MW_SHAPES = {
    plate: { d1: "Thickness (in)", d2: "Width (in)", area: (t, w) => t * w },
    round: { d1: "Diameter (in)", d2: null, area: (d) => (Math.PI / 4) * d * d },
    tube: { d1: "OD (in)", d2: "Wall (in)", area: (od, wall) => (Math.PI / 4) * (od * od - Math.pow(od - 2 * wall, 2)) },
    hex: { d1: "Across flats (in)", d2: null, area: (af) => 0.866 * af * af },
  };
  $("mwShape").addEventListener("change", () => {
    const shape = MW_SHAPES[$("mwShape").value];
    $("mwDim1Wrap").firstChild.textContent = shape.d1;
    $("mwDim2Wrap").classList.toggle("hidden", !shape.d2);
    if (shape.d2) $("mwDim2Wrap").firstChild.textContent = shape.d2;
    recalcAll();
  });
  function calcMetalWeight() {
    const shape = MW_SHAPES[$("mwShape").value];
    const d1 = num($("mwDim1")), d2 = num($("mwDim2"));
    const lengthIn = parseFeetInches($("mwLength").value);
    const count = Math.max(1, num($("mwCount"), 1));
    const density = mwDensity();
    const area = shape.d2 ? shape.area(d1, d2) : shape.area(d1);
    if (!(area > 0) || !(lengthIn > 0)) {
      $("mwResults").innerHTML = tile("Weight", "—");
      return;
    }
    const perPiece = area * lengthIn * density;
    $("mwResults").innerHTML =
      tile("Per piece", `${fmt(perPiece, 1)} lb`, `${fmt(perPiece * 0.453592, 1)} kg`) +
      tile("Per foot", `${fmt(area * 12 * density, 2)} lb/ft`) +
      tile(`Total (${fmtInt(count)} pcs)`, `${fmtInt(perPiece * count)} lb`, `${fmt((perPiece * count) / 2000, 2)} tons`);
  }
  recalcFns.push(calcMetalWeight);

  // ---------- Cylinder Volume ----------
  function calcCylinder() {
    const id = num($("cyId"));
    const lengthIn = parseFeetInches($("cyLength").value);
    if (!(id > 0) || !(lengthIn > 0)) {
      $("cyResults").innerHTML = tile("Volume", "—");
      return;
    }
    const volIn3 = (Math.PI / 4) * id * id * lengthIn;
    const gal = volIn3 / 231;
    $("cyResults").innerHTML =
      tile("Volume", `${fmt(gal, 1)} gal`, `${fmt(volIn3 / 1728, 2)} ft³`) +
      tile("Gallons per inch", `${fmt(((Math.PI / 4) * id * id) / 231, 2)} gal/in`) +
      tile("Water weight (full)", `${fmtInt(gal * 8.34)} lb`);
  }
  recalcFns.push(calcCylinder);

  // ---------- Bolt Torque ----------
  $("btK").addEventListener("change", () => {
    $("btKCustomWrap").classList.toggle("hidden", $("btK").value !== "custom");
    recalcAll();
  });
  function calcTorque() {
    const d = num($("btDia"));
    const f = num($("btLoad"));
    const k = $("btK").value === "custom" ? num($("btKCustom")) : parseFloat($("btK").value);
    if (!(d > 0) || !(f > 0) || !(k > 0)) {
      $("btResults").innerHTML = tile("Torque", "—");
      return;
    }
    const torqueFtLb = (k * d * f) / 12;
    $("btResults").innerHTML =
      tile("Tightening torque", `${fmt(torqueFtLb, 1)} ft-lb`, `${fmt(torqueFtLb * 1.35582, 1)} N·m`) +
      tile("Clamp load", `${fmtInt(f)} lbf`) +
      tile("K factor", k.toFixed(2));
  }
  recalcFns.push(calcTorque);

  // ---------- Reference tables ----------
  $("bwgTable").querySelector("tbody").innerHTML = BWG.map(
    ([g, w]) => `<tr><td>${g}</td><td>${w.toFixed(3)}</td><td>${(w * 25.4).toFixed(2)}</td></tr>`
  ).join("");

  $("pipeTable").querySelector("tbody").innerHTML = PIPE.map(
    ([nps, od, s10, s40, s80]) =>
      `<tr><td>${nps}</td><td>${od.toFixed(3)}</td><td>${s10.toFixed(3)}</td><td>${s40.toFixed(3)}</td><td>${s80.toFixed(3)}</td></tr>`
  ).join("");

  (function buildFractionTable() {
    const rows = [];
    for (let i = 1; i <= 64; i++) {
      let n = i, d = 64;
      while (n % 2 === 0 && d > 1) { n /= 2; d /= 2; }
      const frac = d === 1 ? `${n}` : `${n}/${d}`;
      const dec = i / 64;
      rows.push(`<tr><td>${frac}${d === 1 ? '"' : '"'}</td><td>${dec.toFixed(4)}</td><td>${(dec * 25.4).toFixed(3)}</td></tr>`);
    }
    $("fractionTable").querySelector("tbody").innerHTML = rows.join("");
  })();

  $("materialTable").querySelector("tbody").innerHTML = MATERIALS.map(
    (m) => `<tr><td>${m.name}</td><td>${m.density.toFixed(4)}</td><td>${(m.density * 1728).toFixed(0)}</td><td>${m.alpha.toFixed(1)}</td></tr>`
  ).join("");

  // ---------- Converters ----------
  // factor = multiplier to the base unit
  const CONVERTERS = [
    { name: "Length", units: { in: 0.0254, ft: 0.3048, yd: 0.9144, mm: 0.001, cm: 0.01, m: 1 }, a: "in", b: "mm" },
    { name: "Weight", units: { oz: 0.0283495, lb: 0.453592, "short ton": 907.185, g: 0.001, kg: 1, "metric ton": 1000 }, a: "lb", b: "kg" },
    { name: "Pressure", units: { psi: 6894.76, ksi: 6894760, bar: 100000, kPa: 1000, MPa: 1000000, atm: 101325, "in Hg": 3386.39, "ft H2O": 2989.07 }, a: "psi", b: "bar" },
    { name: "Temperature", special: "temp", units: { "°F": 1, "°C": 1, K: 1 }, a: "°F", b: "°C" },
    { name: "Flow", units: { GPM: 1, GPH: 1 / 60, "L/min": 0.264172, "m³/hr": 4.40287, "ft³/min": 7.48052 }, a: "GPM", b: "m³/hr" },
    { name: "Volume", units: { "in³": 0.0163871, "ft³": 28.3168, gal: 3.78541, L: 1, "m³": 1000, "bbl (42 gal)": 158.987 }, a: "gal", b: "L" },
    { name: "Area", units: { "in²": 0.00064516, "ft²": 0.092903, "mm²": 0.000001, "cm²": 0.0001, "m²": 1 }, a: "ft²", b: "m²" },
  ];

  function tempConvert(value, from, to) {
    let c;
    if (from === "°F") c = (value - 32) / 1.8;
    else if (from === "K") c = value - 273.15;
    else c = value;
    if (to === "°F") return c * 1.8 + 32;
    if (to === "K") return c + 273.15;
    return c;
  }

  const convertersRoot = $("converters");
  CONVERTERS.forEach((conv, idx) => {
    const div = document.createElement("div");
    div.className = "converter";
    const options = Object.keys(conv.units).map((u) => `<option value="${u}">${u}</option>`).join("");
    div.innerHTML = `
      <h3>${conv.name}</h3>
      <div class="conv-row">
        <input type="number" id="convA${idx}" value="1" step="any">
        <select id="convAU${idx}">${options}</select>
        <span class="conv-eq">=</span>
        <input type="number" id="convB${idx}" step="any">
        <select id="convBU${idx}">${options}</select>
      </div>`;
    convertersRoot.appendChild(div);
    const aIn = $(`convA${idx}`), bIn = $(`convB${idx}`);
    const aU = $(`convAU${idx}`), bU = $(`convBU${idx}`);
    aU.value = conv.a;
    bU.value = conv.b;
    const convert = (fromInput, toInput, fromU, toU) => {
      const v = parseFloat(fromInput.value);
      if (!Number.isFinite(v)) { toInput.value = ""; return; }
      let out;
      if (conv.special === "temp") out = tempConvert(v, fromU.value, toU.value);
      else out = (v * conv.units[fromU.value]) / conv.units[toU.value];
      toInput.value = Number(out.toPrecision(8));
    };
    const fwd = () => convert(aIn, bIn, aU, bU);
    const back = () => convert(bIn, aIn, bU, aU);
    aIn.addEventListener("input", fwd);
    bIn.addEventListener("input", back);
    aU.addEventListener("change", fwd);
    bU.addEventListener("change", fwd);
    fwd();
  });

  // ---------- global wiring ----------
  sectionNav();
  document.querySelectorAll(".field-grid input, .field-grid select").forEach((el) => {
    el.addEventListener("input", recalcAll);
    el.addEventListener("change", recalcAll);
  });
  recalcAll();
})();
