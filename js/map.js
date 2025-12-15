/* global L, turf */

(function () {
  const HOME = { lat: -6.914744, lng: 107.60981, zoom: 11 };

  // PATH + NAMA FILE HARUS PERSIS (case-sensitive di GitHub Pages)
  const PATH_KOTA = "Geojson/Kota_Kecamatan.GeoJSON";
  const PATH_KAB  = "Geojson/Kabupaten_Kecamatan.GeoJSON";

  // FIELD
  const FIELD_KEC = "WADMKC";
  const FIELD_POP = "Jumlah";
  const FIELD_WIL = "WADMKK"; // opsional

  // =========================
  // MAP
  // =========================
  const map = L.map("map", { zoomControl: false, doubleClickZoom: true }).setView([HOME.lat, HOME.lng], HOME.zoom);

  const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
  const sat = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19 });
  const topo = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", { maxZoom: 17 });

  L.control.scale({ position: "bottomright", metric: true, imperial: false }).addTo(map);

  // Coord box
  const CoordControl = L.Control.extend({
    options: { position: "bottomright" },
    onAdd: function () {
      this._div = L.DomUtil.create("div", "leaflet-control-coordinates");
      this._div.innerHTML = "Lat: - | Lng: -";
      return this._div;
    },
    update: function (lat, lng) {
      this._div.innerHTML = `Lat: ${lat.toFixed(5)} | Lng: ${lng.toFixed(5)}`;
    }
  });
  const coordBox = new CoordControl();
  map.addControl(coordBox);
  map.on("mousemove", (e) => coordBox.update(e.latlng.lat, e.latlng.lng));

  // =========================
  // LAYERS
  // =========================
  const adminKota = L.layerGroup();
  const adminKab  = L.layerGroup();

  const choroKota = L.layerGroup();
  const choroKab  = L.layerGroup();
  const choroAll  = L.layerGroup();

  const labelKecKota = L.layerGroup();
  const labelKecKab  = L.layerGroup();

  const labelPopKota = L.layerGroup();
  const labelPopKab  = L.layerGroup();

  let heatKota = null;
  let heatKab  = null;
  let heatAll  = null;

  const legend = L.control({ position: "bottomleft" });

  // Measure tool
  const toolGroup = L.layerGroup().addTo(map);
  let activeTool = null;
  let measurePts = [];

  // Data
  let kotaGeo = null;
  let kabGeo = null;
  let allFeatures = [];

  // =========================
  // HELPERS
  // =========================
  function showLoading(text) {
    const el = document.getElementById("loading");
    const txt = document.getElementById("loadingText");
    if (txt) txt.innerText = text || "Memuat Data & Peta...";
    el.style.display = "block";
  }
  function hideLoading() {
    document.getElementById("loading").style.display = "none";
  }

  async function safeFetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Fetch gagal: ${url} (${res.status})`);
    return await res.json();
  }

  // parsing "72.067" -> 72067
  function parseIndoNumber(v) {
    if (v === null || v === undefined) return 0;
    if (typeof v === "number") return Number.isFinite(v) ? v : 0;
    let s = String(v).trim();
    if (!s) return 0;
    s = s.replace(/\s/g, "");
    s = s.replace(/\./g, "");   // hapus ribuan
    s = s.replace(/,/g, ".");   // koma -> titik
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }

  function formatID(n) {
    const x = Math.round(Number(n) || 0);
    return x.toLocaleString("id-ID");
  }

  function getName(props) {
    return props?.[FIELD_KEC] || props?.nama || props?.NAME || "(Tanpa Nama)";
  }

  // ======= AREA FIX (UTM planar) =======
  function isProjectedMetersGeometry(feature) {
    // jika nilai koordinat jauh > 180, kemungkinan besar UTM (meter)
    const g = feature?.geometry;
    if (!g) return false;

    const sample = [];
    const pushSome = (coords) => {
      for (const c of coords) {
        if (Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number") {
          sample.push(c);
          if (sample.length >= 20) break;
        }
      }
    };

    const walk = (coords) => {
      if (!Array.isArray(coords)) return;
      if (typeof coords[0] === "number") {
        sample.push(coords);
        return;
      }
      for (const part of coords) {
        if (sample.length >= 20) break;
        walk(part);
      }
    };

    walk(g.coordinates);
    if (!sample.length) return false;

    // jika banyak x/y > 180 atau < -180 => projected
    let projectedCount = 0;
    for (const [x, y] of sample) {
      if (Math.abs(x) > 180 || Math.abs(y) > 90) projectedCount++;
    }
    return projectedCount >= Math.ceil(sample.length * 0.6);
  }

  function ringAreaShoelace(ring) {
    // ring: [[x,y],[x,y],...]
    if (!ring || ring.length < 3) return 0;
    let sum = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[i + 1];
      sum += (x1 * y2 - x2 * y1);
    }
    return Math.abs(sum) / 2;
  }

  function planarAreaMeters2(feature) {
    const g = feature.geometry;
    if (!g) return 0;

    const polyArea = (polyCoords) => {
      // polyCoords: [outerRing, hole1, hole2...]
      if (!polyCoords || !polyCoords.length) return 0;
      let a = ringAreaShoelace(polyCoords[0]);
      for (let i = 1; i < polyCoords.length; i++) a -= ringAreaShoelace(polyCoords[i]);
      return Math.max(0, a);
    };

    if (g.type === "Polygon") return polyArea(g.coordinates);
    if (g.type === "MultiPolygon") {
      let total = 0;
      for (const poly of g.coordinates) total += polyArea(poly);
      return total;
    }
    return 0;
  }

  function computeAreaKm2(feature) {
    // coba turf dulu (untuk WGS84)
    let areaM2 = 0;
    try { areaM2 = turf.area(feature); } catch { areaM2 = 0; }

    if (!Number.isFinite(areaM2) || areaM2 <= 0) {
      // fallback planar
      areaM2 = planarAreaMeters2(feature);
    } else {
      // jika ternyata projected, turf.area bisa ngawur -> pakai planar
      if (isProjectedMetersGeometry(feature)) {
        const planar = planarAreaMeters2(feature);
        if (planar > 0) areaM2 = planar;
      }
    }

    return areaM2 / 1e6;
  }

  function computeDerivedProps(feature) {
    const pop = parseIndoNumber(feature.properties?.[FIELD_POP]);
    const areaKm2 = computeAreaKm2(feature);
    const dens = areaKm2 > 0 ? (pop / areaKm2) : 0;

    feature.properties.__pop = pop;
    feature.properties.__areaKm2 = areaKm2;
    feature.properties.__dens = dens;
    return feature;
  }

  function densColor(d, minD, maxD) {
    // biru (min) -> merah (max)
    const t = (maxD > minD) ? (d - minD) / (maxD - minD) : 0;
    const clamp = (x) => Math.max(0, Math.min(1, x));
    const tt = clamp(t);

    const blue = { r: 33,  g: 150, b: 243 };
    const red  = { r: 244, g: 67,  b: 54  };

    const R = Math.round(blue.r + (red.r - blue.r) * tt);
    const G = Math.round(blue.g + (red.g - blue.g) * tt);
    const B = Math.round(blue.b + (red.b - blue.b) * tt);
    return `rgb(${R},${G},${B})`;
  }

  function addLegend(minD, maxD) {
    legend.onAdd = function () {
      const div = L.DomUtil.create("div", "legend-box");
      const steps = 5;
      let html = `<div style="font-weight:900;margin-bottom:6px;color:#6b3a00;">Kepadatan (jiwa/km²)</div>`;
      for (let i = 0; i < steps; i++) {
        const a = minD + (i / steps) * (maxD - minD);
        const b = minD + ((i + 1) / steps) * (maxD - minD);
        const mid = (a + b) / 2;
        const c = densColor(mid, minD, maxD);
        html += `
          <div class="leg-row">
            <span class="leg-swatch" style="background:${c}"></span>
            <span>${formatID(a)} – ${formatID(b)}</span>
          </div>`;
      }
      html += `<div style="margin-top:8px;color:#777;font-size:12px;">Klik kecamatan untuk detail.</div>`;
      div.innerHTML = html;
      return div;
    };
    legend.addTo(map);
  }

  function popupHTML(f, wilayahLabel) {
    const p = f.properties || {};
    const nama = getName(p);
    const pop = p.__pop ?? 0;
    const area = p.__areaKm2 ?? 0;
    const dens = p.__dens ?? 0;
    const wilayah = wilayahLabel || p[FIELD_WIL] || "";

    return `
      <div style="font-weight:900;font-size:15px;margin-bottom:6px;color:#4e2a00">${nama}</div>
      <div style="display:inline-block;background:#fb8c00;color:#fff;padding:3px 9px;border-radius:999px;font-weight:900;font-size:11px;margin-bottom:10px;">
        ${wilayah}
      </div>
      <div style="line-height:1.55">
        <b>Penduduk:</b> ${formatID(pop)}<br/>
        <b>Luas:</b> ${area.toFixed(2)} km²<br/>
        <b>Kepadatan:</b> ${formatID(dens)} jiwa/km²
      </div>
    `;
  }

  function makeLabelMarker(latlng, text, className) {
    return L.marker(latlng, {
      interactive: false,
      icon: L.divIcon({
        className: "",
        html: `<div class="${className}">${text}</div>`,
        iconSize: null
      })
    });
  }

  function buildLabelsFor(geo, isKota) {
    const grpName = isKota ? labelKecKota : labelKecKab;
    const grpPop  = isKota ? labelPopKota : labelPopKab;

    grpName.clearLayers();
    grpPop.clearLayers();

    geo.features.forEach((f) => {
      const c = turf.centroid(f).geometry.coordinates; // centroid tetap ok untuk polygon UTM/WGS
      const latlng = [c[1], c[0]];
      const nm = getName(f.properties);
      const pop = f.properties.__pop ?? 0;

      makeLabelMarker(latlng, nm, "kec-label").addTo(grpName);
      makeLabelMarker(latlng, formatID(pop), "pop-label").addTo(grpPop);
    });
  }

  function buildHeat(geo, weightField = "__dens") {
    const pts = geo.features.map((f) => {
      const c = turf.centroid(f).geometry.coordinates;
      const w = Number(f.properties?.[weightField]) || 0;
      return { lat: c[1], lng: c[0], w };
    });
    const maxW = Math.max(...pts.map(p => p.w), 1);
    const heatData = pts.map(p => [p.lat, p.lng, p.w / maxW]);

    return L.heatLayer(heatData, {
      radius: 28,
      blur: 22,
      maxZoom: 13
    });
  }

  function buildAdminOutline(geo, isKota) {
    const target = isKota ? adminKota : adminKab;
    target.clearLayers();

    L.geoJSON(geo, {
      interactive: false,
      style: {
        color: isKota ? "#0D47A1" : "#2E7D32",
        weight: 2.2,
        fillOpacity: 0
      }
    }).addTo(target);
  }

  function buildChoropleth(geo, targetGroup, labelWil, minD, maxD) {
    targetGroup.clearLayers();
    L.geoJSON(geo, {
      style: (feature) => {
        const d = feature.properties.__dens || 0;
        return {
          color: "#6b3a00",
          weight: 1.3,
          fillOpacity: 0.55,
          fillColor: densColor(d, minD, maxD)
        };
      },
      onEachFeature: (feature, layer) => {
        layer.on("click", () => map.fitBounds(layer.getBounds(), { padding: [20, 20] }));
        layer.bindPopup(popupHTML(feature, labelWil));
      }
    }).addTo(targetGroup);
  }

  function ensureLayer(layer, checked) {
    if (!layer) return;
    if (checked) map.addLayer(layer);
    else map.removeLayer(layer);
  }

  function applyInitialLayerState() {
    // ADMIN ON
    ensureLayer(adminKota, document.getElementById("chkAdminKota")?.checked);
    ensureLayer(adminKab,  document.getElementById("chkAdminKab")?.checked);

    // Kepadatan default OFF (checkbox di HTML memang default unchecked)
    ensureLayer(choroKota, document.getElementById("chkChoroKota")?.checked);
    ensureLayer(choroKab,  document.getElementById("chkChoroKab")?.checked);
    ensureLayer(choroAll,  document.getElementById("chkChoroAll")?.checked);

    ensureLayer(labelKecKota, document.getElementById("chkLabelKecKota")?.checked);
    ensureLayer(labelKecKab,  document.getElementById("chkLabelKecKab")?.checked);

    ensureLayer(labelPopKota, document.getElementById("chkLabelPopKota")?.checked);
    ensureLayer(labelPopKab,  document.getElementById("chkLabelPopKab")?.checked);

    ensureLayer(heatKota, document.getElementById("chkHeatKota")?.checked);
    ensureLayer(heatKab,  document.getElementById("chkHeatKab")?.checked);
    ensureLayer(heatAll,  document.getElementById("chkHeatAll")?.checked);
  }

  // =========================
  // INIT
  // =========================
  async function init() {
    showLoading("Memuat GeoJSON…");

    try {
      kotaGeo = await safeFetchJSON(PATH_KOTA);
      kabGeo  = await safeFetchJSON(PATH_KAB);
    } catch (err) {
      console.error(err);
      showLoading(
        "Gagal memuat GeoJSON.\n\n" +
        "Pastikan file ada & nama sama persis (huruf besar-kecil):\n" +
        `- ${PATH_KOTA}\n` +
        `- ${PATH_KAB}\n\n` +
        "Catatan: GitHub Pages case-sensitive."
      );
      return;
    }

    showLoading("Menghitung penduduk, luas (km²), kepadatan…");
    kotaGeo.features = kotaGeo.features.map(computeDerivedProps);
    kabGeo.features  = kabGeo.features.map(computeDerivedProps);

    allFeatures = [...kotaGeo.features, ...kabGeo.features];

    const densVals = allFeatures.map(f => f.properties.__dens || 0).filter(x => Number.isFinite(x));
    const minD = Math.min(...densVals);
    const maxD = Math.max(...densVals);

    showLoading("Membangun layer…");

    buildAdminOutline(kotaGeo, true);
    buildAdminOutline(kabGeo,  false);

    // choropleth 3 varian
    buildChoropleth(kotaGeo, choroKota, "Kota Bandung", minD, maxD);
    buildChoropleth(kabGeo,  choroKab,  "Kabupaten Bandung", minD, maxD);

    const merged = { type: "FeatureCollection", features: [...kotaGeo.features, ...kabGeo.features] };
    buildChoropleth(merged, choroAll, "Gabungan Bandung", minD, maxD);

    buildLabelsFor(kotaGeo, true);
    buildLabelsFor(kabGeo,  false);

    heatKota = buildHeat(kotaGeo, "__dens");
    heatKab  = buildHeat(kabGeo, "__dens");
    heatAll  = buildHeat(merged, "__dens");

    addLegend(minD, maxD);

    // default ON hanya administrasi (checkbox lain OFF)
    applyInitialLayerState();

    // fit bounds gabungan
    const b1 = L.geoJSON(kotaGeo).getBounds();
    const b2 = L.geoJSON(kabGeo).getBounds();
    map.fitBounds(b1.extend(b2), { padding: [20, 20] });

    hideLoading();
  }

  init();

  // =========================
  // UI FUNCTIONS
  // =========================
  window.toggleInfoModal = function () {
    const m = document.getElementById("infoModal");
    m.style.display = (m.style.display === "flex") ? "none" : "flex";
  };

  window.togglePrintModal = function () {
    const m = document.getElementById("printModal");
    m.style.display = (m.style.display === "flex") ? "none" : "flex";
  };

  window.executePrint = function () {
    const title = document.getElementById("inputPrintTitle")?.value || "Peta Kepadatan Penduduk";
    const layout = document.getElementById("inputPrintLayout")?.value || "landscape";
    document.title = title;

    window.togglePrintModal();
    const style = document.createElement("style");
    style.innerHTML = `@page { size: A4 ${layout}; margin: 0; }`;
    style.id = "print-page-style";
    document.head.appendChild(style);

    setTimeout(() => {
      window.print();
      document.head.removeChild(style);
    }, 350);
  };

  window.switchPanel = function (mode) {
    const layerDiv = document.getElementById("viewLayers");
    const analysisDiv = document.getElementById("viewAnalysis");
    const title = document.getElementById("panelTitle");
    const btnL = document.getElementById("navLayer");
    const btnA = document.getElementById("navAnalysis");

    if (mode === "layer") {
      layerDiv.style.display = "block";
      analysisDiv.style.display = "none";
      title.innerText = "Daftar Layer";
      btnL.classList.add("active");
      btnA.classList.remove("active");
    } else {
      layerDiv.style.display = "none";
      analysisDiv.style.display = "block";
      title.innerText = "Analisis";
      btnL.classList.remove("active");
      btnA.classList.add("active");
    }
  };

  window.toggleSidebar = function () {
    const s = document.getElementById("sidebarPanel");
    s.style.display = (s.style.display === "none") ? "flex" : "none";
  };

  window.toggleBasemapMenu = function () {
    document.getElementById("basemapDropdown")?.classList.toggle("show");
  };

  window.changeBasemap = function (v) {
    map.removeLayer(osm); map.removeLayer(sat); map.removeLayer(topo);
    if (v === "osm") osm.addTo(map);
    if (v === "sat") sat.addTo(map);
    if (v === "topo") topo.addTo(map);
    document.getElementById("basemapDropdown")?.classList.remove("show");
  };

  window.goHome = function () {
    map.setView([HOME.lat, HOME.lng], HOME.zoom);
  };

  window.handleSearch = function (e) {
    if (e.key === "Enter") window.doSearch();
  };

  window.doSearch = function () {
    const q = (document.getElementById("searchInput")?.value || "").trim().toLowerCase();
    if (!q) return alert("Masukkan nama kecamatan!");

    const findIn = (geo, wilayahLabel) => {
      for (const f of (geo?.features || [])) {
        const nm = (getName(f.properties) || "").toLowerCase();
        if (nm.includes(q)) return { f, wilayahLabel };
      }
      return null;
    };

    const hit = findIn(kotaGeo, "Kota Bandung") || findIn(kabGeo, "Kabupaten Bandung");
    if (!hit) return alert("Kecamatan tidak ditemukan.");

    const feature = hit.f;
    const bb = L.geoJSON(feature).getBounds();
    map.fitBounds(bb, { padding: [30, 30] });
    L.popup()
      .setLatLng(bb.getCenter())
      .setContent(popupHTML(feature, hit.wilayahLabel))
      .openOn(map);
  };

  window.toggleLayer = function (key) {
    const on = (id) => document.getElementById(id)?.checked;

    if (key === "adminKota") ensureLayer(adminKota, on("chkAdminKota"));
    if (key === "adminKab")  ensureLayer(adminKab,  on("chkAdminKab"));

    if (key === "choroKota") ensureLayer(choroKota, on("chkChoroKota"));
    if (key === "choroKab")  ensureLayer(choroKab,  on("chkChoroKab"));
    if (key === "choroAll")  ensureLayer(choroAll,  on("chkChoroAll"));

    if (key === "labelKecKota") ensureLayer(labelKecKota, on("chkLabelKecKota"));
    if (key === "labelKecKab")  ensureLayer(labelKecKab,  on("chkLabelKecKab"));

    if (key === "labelPopKota") ensureLayer(labelPopKota, on("chkLabelPopKota"));
    if (key === "labelPopKab")  ensureLayer(labelPopKab,  on("chkLabelPopKab"));

    if (key === "heatKota") ensureLayer(heatKota, on("chkHeatKota"));
    if (key === "heatKab")  ensureLayer(heatKab,  on("chkHeatKab"));
    if (key === "heatAll")  ensureLayer(heatAll,  on("chkHeatAll"));
  };

  // =========================
  // ANALYSIS
  // =========================
  function clearResults() {
    ["res-district", "res-top", "res-sum"].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.style.display = "none";
      el.innerHTML = "";
    });
  }

  window.runDistrictAnalysis = function () {
    clearResults();
    const res = document.getElementById("res-district");
    if (!res) return;
    res.style.display = "block";

    if (!allFeatures.length) {
      res.innerHTML = "<div style='padding:12px;'>Data belum siap.</div>";
      return;
    }

    const rows = allFeatures.map((f) => {
      const p = f.properties || {};
      const nm = getName(p);
      const pop = p.__pop || 0;
      const area = p.__areaKm2 || 0;
      const dens = p.__dens || 0;
      const wilayah = (kotaGeo?.features?.includes(f)) ? "Kota" : "Kabupaten";
      return { f, wilayah, nm, pop, area, dens };
    });

    rows.sort((a, b) => b.dens - a.dens);

    let html = `<div style="max-height:260px; overflow:auto;">
      <table class="stats-table">
        <tr>
          <th>Wilayah</th>
          <th>Kecamatan</th>
          <th>Penduduk</th>
          <th>Luas (km²)</th>
          <th>Kepadatan</th>
        </tr>`;

    rows.forEach((r, idx) => {
      html += `<tr data-idx="${idx}">
        <td>${r.wilayah}</td>
        <td>${r.nm}</td>
        <td>${formatID(r.pop)}</td>
        <td>${(r.area || 0).toFixed(2)}</td>
        <td><b>${formatID(r.dens)}</b></td>
      </tr>`;
    });

    html += `</table></div>`;
    res.innerHTML = html;

    res.querySelectorAll("tr[data-idx]").forEach((tr) => {
      tr.addEventListener("click", () => {
        const idx = Number(tr.getAttribute("data-idx"));
        const f = rows[idx].f;
        const bb = L.geoJSON(f).getBounds();
        map.fitBounds(bb, { padding: [25, 25] });
        L.popup().setLatLng(bb.getCenter()).setContent(popupHTML(f, rows[idx].wilayah + " Bandung")).openOn(map);
      });
    });
  };

  window.runTopDense = function () {
    clearResults();
    const res = document.getElementById("res-top");
    if (!res) return;
    res.style.display = "block";

    if (!allFeatures.length) {
      res.innerHTML = "Data belum siap.";
      return;
    }

    const rows = allFeatures
      .map(f => ({ nm: getName(f.properties), dens: f.properties.__dens || 0, pop: f.properties.__pop || 0 }))
      .sort((a, b) => b.dens - a.dens)
      .slice(0, 10);

    let html = "<b>Top 10 Kecamatan Terpadat</b><ol style='margin:8px 0 0 18px; padding:0;'>";
    rows.forEach(r => {
      html += `<li style="margin:6px 0;"><b>${r.nm}</b> — ${formatID(r.dens)} jiwa/km² <span style="color:#777">(pop ${formatID(r.pop)})</span></li>`;
    });
    html += "</ol>";
    res.innerHTML = html;
  };

  window.runSummary = function () {
    clearResults();
    const res = document.getElementById("res-sum");
    if (!res) return;
    res.style.display = "block";

    if (!allFeatures.length) {
      res.innerHTML = "Data belum siap.";
      return;
    }

    const totalPop = allFeatures.reduce((s, f) => s + (f.properties.__pop || 0), 0);
    const totalArea = allFeatures.reduce((s, f) => s + (f.properties.__areaKm2 || 0), 0);
    const avgDens = totalArea > 0 ? totalPop / totalArea : 0;

    res.innerHTML = `
      <b>Ringkasan (Gabungan)</b><br/><br/>
      <b>Total penduduk:</b> ${formatID(totalPop)}<br/>
      <b>Total luas:</b> ${totalArea.toFixed(2)} km²<br/>
      <b>Rata-rata kepadatan:</b> ${formatID(avgDens)} jiwa/km²
    `;
  };

  // =========================
  // MEASURE TOOL
  // =========================
  window.activateTool = function (toolName) {
    toolGroup.clearLayers();
    measurePts = [];
    document.getElementById("btnMeasure")?.classList.remove("active");

    if (toolName !== "measure") {
      activeTool = null;
      map.getContainer().style.cursor = "";
      map.doubleClickZoom.enable();
      return;
    }

    if (activeTool === "measure") {
      activeTool = null;
      map.getContainer().style.cursor = "";
      map.doubleClickZoom.enable();
      return;
    }

    activeTool = "measure";
    map.getContainer().style.cursor = "crosshair";
    map.doubleClickZoom.disable();
    document.getElementById("btnMeasure")?.classList.add("active");
  };

  map.on("click", (e) => {
    if (activeTool !== "measure") return;

    measurePts.push(e.latlng);
    L.circleMarker(e.latlng, { color: "#4e2a00", radius: 4, weight: 2, fillOpacity: 1 }).addTo(toolGroup);

    if (measurePts.length === 2) {
      const p1 = measurePts[0];
      const p2 = measurePts[1];
      L.polyline([p1, p2], { color: "#4e2a00", dashArray: "6,10", weight: 2 }).addTo(toolGroup);
      const dist = map.distance(p1, p2);
      const km = (dist / 1000).toFixed(2);
      L.popup().setLatLng(p2).setContent(`<b>Jarak:</b> ${km} km`).openOn(map);
      measurePts = [];
    }
  });

})();
