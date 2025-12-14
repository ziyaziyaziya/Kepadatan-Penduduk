/* =========================================================
   WebGIS Kepadatan Penduduk (Kota vs Kabupaten Bandung)
   - Choropleth Kota/Kab
   - Label Kecamatan & Jumlah Penduduk (dipisah)
   - Heatmap Kota/Kab/Gabungan
   - Search, Measure, Print
   ========================================================= */

(function () {
  // ====== CONFIG PATH (sesuaikan kalau folder beda) ======
  const PATH_KOTA = "Geojson/Kota_Kecamatan.GeoJSON";
  const PATH_KAB  = "Geojson/Kabupaten_Kecamatan.GeoJSON";

  // ====== INIT MAP ======
  const HOME = { center: [-6.914744, 107.60981], zoom: 10.6 };

  const map = L.map("map", { zoomControl: true }).setView(HOME.center, HOME.zoom);

  // Basemaps
  const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
  const sat = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19 });
  const topo = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", { maxZoom: 17 });

  // Coordinates control
  const CoordControl = L.Control.extend({
    options: { position: "bottomright" },
    onAdd: function () {
      this._div = L.DomUtil.create("div", "leaflet-control-coordinates");
      this._div.innerHTML = "Lat: - | Lng: -";
      return this._div;
    },
    update: function (lat, lng) {
      this._div.innerHTML = `Lat: ${lat.toFixed(5)} | Lng: ${lng.toFixed(5)}`;
    },
  });
  const coordBox = new CoordControl();
  map.addControl(coordBox);
  map.on("mousemove", (e) => coordBox.update(e.latlng.lat, e.latlng.lng));

  // ====== LAYERS ======
  const adminKota = L.layerGroup();
  const adminKab  = L.layerGroup();

  const choroKota = L.geoJSON(null);
  const choroKab  = L.geoJSON(null);

  const labelKecKota = L.layerGroup();
  const labelKecKab  = L.layerGroup();
  const labelPopKota = L.layerGroup();
  const labelPopKab  = L.layerGroup();

  // Heat layers (Leaflet.heat)
  let heatKota = null;
  let heatKab  = null;
  let heatAll  = null;

  // Measure tool
  const toolGroup = L.layerGroup().addTo(map);
  let activeTool = null;
  let measurePoints = [];

  // ====== STATE DATA ======
  let FC_KOTA = null;
  let FC_KAB  = null;

  // For analysis/search
  let FEATURES_ALL = []; // { f, region: "Kota"/"Kab", dens, pop, areaKm2 }

  // Legend control (for choropleth)
  let legendControl = null;

  // ====== HELPERS ======
  function $(id) { return document.getElementById(id); }

  function showLoading(msg) {
    const box = $("loading");
    const txt = $("loadingText");
    if (txt) txt.textContent = msg || "Memuat...";
    box.style.display = "block";
  }

  function hideLoading() {
    $("loading").style.display = "none";
  }

  function safeNumber(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "string") {
      const s = v.trim();
      if (!s) return null;
      // remove separators: "1.234.567" or "1,234,567"
      const cleaned = s.replace(/\./g, "").replace(/,/g, "");
      const n = Number(cleaned);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  function getPopulation(props) {
    // GEOJSON kamu pakai "Jumlah"
    const candidates = [
      props.Penduduk, props.penduduk,
      props.Jumlah, props.jumlah,
      props.JUMLAH, props.JML, props.Populasi, props.populasi,
      props["Jumlah Penduduk"], props["JUMLAH_PDDK"]
    ];
    for (const c of candidates) {
      const n = safeNumber(c);
      if (n !== null) return n;
    }
    // last resort: cari key yang mengandung "jumlah" atau "penduduk"
    for (const k of Object.keys(props)) {
      const lk = k.toLowerCase();
      if (lk.includes("jumlah") || lk.includes("penduduk")) {
        const n = safeNumber(props[k]);
        if (n !== null) return n;
      }
    }
    return 0;
  }

  function getKecamatanName(props) {
    return props.WADMKC || props.nm_kecamatan || props.NAMOBJ || props.nama || props.NAME || "(Tanpa Nama)";
  }

  function formatInt(n) {
    try { return new Intl.NumberFormat("id-ID").format(Math.round(n)); }
    catch { return String(Math.round(n)); }
  }

  function formatDensity(d) {
    // jiwa/km2
    if (!Number.isFinite(d)) return "-";
    if (d >= 1000) return formatInt(d);
    return d.toFixed(2);
  }

  function centroidLatLng(feature) {
    const c = turf.centroid(feature);
    const [lng, lat] = c.geometry.coordinates;
    return [lat, lng];
  }

  function areaKm2(feature) {
    // Turf area in m2
    const a = turf.area(feature);
    return a / 1e6;
  }

  function computeDensity(feature) {
    const pop = getPopulation(feature.properties || {});
    const aKm2 = areaKm2(feature);
    if (!aKm2 || aKm2 <= 0) return { pop, aKm2: 0, dens: 0 };
    return { pop, aKm2, dens: pop / aKm2 };
  }

  // Choropleth palette (light -> dark)
  function getColor(d, breaks) {
    // breaks: [b0,b1,b2,b3,b4,b5] 6 bins -> 6 colors
    if (d >= breaks[5]) return "#4e342e";
    if (d >= breaks[4]) return "#6d4c41";
    if (d >= breaks[3]) return "#8d6e63";
    if (d >= breaks[2]) return "#bcaaa4";
    if (d >= breaks[1]) return "#e0d6d1";
    return "#f5f1ee";
  }

  function quantile(sorted, q) {
    const pos = (sorted.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    if (sorted[base + 1] !== undefined) {
      return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
    }
    return sorted[base];
  }

  function buildBreaks(densValues) {
    // robust breaks using quantiles (biar tidak rusak oleh outlier)
    const vals = densValues.filter(Number.isFinite).sort((a, b) => a - b);
    if (!vals.length) return [0, 1, 2, 3, 4, 5];
    const q10 = quantile(vals, 0.10);
    const q30 = quantile(vals, 0.30);
    const q50 = quantile(vals, 0.50);
    const q70 = quantile(vals, 0.70);
    const q90 = quantile(vals, 0.90);
    const max  = vals[vals.length - 1];
    // ensure monotonic
    return [0, q10, q30, q50, q70, q90, max].slice(0, 6).concat([max]).slice(0, 6); // keep 6
  }

  function setLegend(breaks) {
    if (legendControl) {
      map.removeControl(legendControl);
      legendControl = null;
    }
    legendControl = L.control({ position: "bottomleft" });
    legendControl.onAdd = function () {
      const div = L.DomUtil.create("div", "legend-box");
      const title = `<div style="font-weight:900;color:#6d4c41;margin-bottom:8px;">Kepadatan (jiwa/km²)</div>`;
      const rows = [];
      const labels = [
        [breaks[0], breaks[1]],
        [breaks[1], breaks[2]],
        [breaks[2], breaks[3]],
        [breaks[3], breaks[4]],
        [breaks[4], breaks[5]],
      ];
      for (let i = 0; i < labels.length; i++) {
        const a = labels[i][0];
        const b = labels[i][1];
        const mid = (a + b) / 2;
        rows.push(`
          <div class="leg-row">
            <span class="leg-swatch" style="background:${getColor(mid, breaks)}"></span>
            <span>${formatDensity(a)} – ${formatDensity(b)}</span>
          </div>
        `);
      }
      div.innerHTML = title + rows.join("") + `<div style="margin-top:8px;color:#777;font-size:11px;">Klik kecamatan untuk detail.</div>`;
      return div;
    };
    legendControl.addTo(map);
  }

  function styleChoro(feature, breaks, borderColor) {
    const { dens } = computeDensity(feature);
    return {
      color: borderColor,
      weight: 1.2,
      opacity: 1,
      fillColor: getColor(dens, breaks),
      fillOpacity: 0.55,
    };
  }

  function bindPopup(layer, feature, region) {
    const props = feature.properties || {};
    const nm = getKecamatanName(props);
    const { pop, aKm2, dens } = computeDensity(feature);

    layer.bindPopup(`
      <div style="font-weight:900;font-size:15px;color:#ef6c00;margin-bottom:6px;">${nm}</div>
      <div><b>Wilayah:</b> ${region}</div>
      <div><b>Penduduk:</b> ${formatInt(pop)}</div>
      <div><b>Luas:</b> ${aKm2.toFixed(2)} km²</div>
      <div><b>Kepadatan:</b> ${formatDensity(dens)} jiwa/km²</div>
      <hr style="border:none;border-top:1px solid #eee;margin:10px 0">
      <div style="color:#777;font-size:12px;">Sumber: GeoJSON kecamatan (atribut <b>Jumlah</b>)</div>
    `);
  }

  function rebuildHeatLayers() {
    // Build points using centroid + weight (normalized density, clipped by p95)
    const kota = FEATURES_ALL.filter(x => x.region === "Kota");
    const kab  = FEATURES_ALL.filter(x => x.region === "Kabupaten");
    const all  = FEATURES_ALL.slice();

    function buildHeat(items) {
      const densVals = items.map(x => x.dens).filter(Number.isFinite);
      if (!densVals.length) return L.heatLayer([], { radius: 28, blur: 18, maxZoom: 12 });
      densVals.sort((a, b) => a - b);
      const p95 = quantile(densVals, 0.95);
      const p05 = quantile(densVals, 0.05);
      const min = Math.max(0, p05);
      const max = Math.max(min + 1e-9, p95);

      const pts = items.map(x => {
        // clamp density to [min,max], normalize -> [0,1]
        const d = Math.min(max, Math.max(min, x.dens));
        const w = (d - min) / (max - min);
        // boost a bit so kelihatan
        const weight = Math.max(0.05, Math.min(1, w));
        return [x.lat, x.lng, weight];
      });

      return L.heatLayer(pts, {
        radius: 30,
        blur: 22,
        maxZoom: 12
      });
    }

    heatKota = buildHeat(kota);
    heatKab  = buildHeat(kab);
    heatAll  = buildHeat(all);

    // default: heatAll ON (checkbox chkHeatAll checked)
    syncHeatVisibility();
  }

  function syncHeatVisibility() {
    // remove existing
    if (heatKota) map.removeLayer(heatKota);
    if (heatKab) map.removeLayer(heatKab);
    if (heatAll) map.removeLayer(heatAll);

    if ($("chkHeatKota")?.checked && heatKota) heatKota.addTo(map);
    if ($("chkHeatKab")?.checked && heatKab) heatKab.addTo(map);
    if ($("chkHeatAll")?.checked && heatAll) heatAll.addTo(map);
  }

  function clearResults() {
    ["res-district", "res-top", "res-sum"].forEach(id => {
      const el = $(id);
      if (!el) return;
      el.style.display = "none";
      el.innerHTML = "";
    });
  }

  // ====== LOAD DATA ======
  async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Gagal fetch: ${url}`);
    return await res.json();
  }

  async function init() {
    showLoading("Memuat GeoJSON Kota & Kabupaten...");

    try {
      const [kota, kab] = await Promise.all([fetchJSON(PATH_KOTA), fetchJSON(PATH_KAB)]);
      FC_KOTA = kota;
      FC_KAB  = kab;

      // Build data summary for heat/analysis/search
      FEATURES_ALL = [];
      function pushFeatures(fc, region) {
        (fc.features || []).forEach(f => {
          const { pop, aKm2, dens } = computeDensity(f);
          const [lat, lng] = centroidLatLng(f);
          FEATURES_ALL.push({ f, region, pop, areaKm2: aKm2, dens, lat, lng });
        });
      }
      pushFeatures(FC_KOTA, "Kota");
      pushFeatures(FC_KAB, "Kabupaten");

      // breaks computed from combined density (stable)
      const densAll = FEATURES_ALL.map(x => x.dens).filter(Number.isFinite);
      const breaks = buildBreaks(densAll);
      setLegend(breaks);

      // ADMIN (outline only)
      L.geoJSON(FC_KOTA, {
        style: { color: "#1976D2", weight: 2.5, fillOpacity: 0 }
      }).addTo(adminKota);

      L.geoJSON(FC_KAB, {
        style: { color: "#2E7D32", weight: 2.5, fillOpacity: 0 }
      }).addTo(adminKab);

      // CHOROPLETH KOTA
      choroKota.addData(FC_KOTA);
      choroKota.setStyle((feat) => styleChoro(feat, breaks, "#1976D2"));
      choroKota.eachLayer(layer => bindPopup(layer, layer.feature, "Kota Bandung"));
      choroKota.on("click", (e) => {
        if (e.layer && e.layer.getBounds) map.fitBounds(e.layer.getBounds(), { padding: [30, 30] });
      });

      // CHOROPLETH KAB
      choroKab.addData(FC_KAB);
      choroKab.setStyle((feat) => styleChoro(feat, breaks, "#2E7D32"));
      choroKab.eachLayer(layer => bindPopup(layer, layer.feature, "Kabupaten Bandung"));
      choroKab.on("click", (e) => {
        if (e.layer && e.layer.getBounds) map.fitBounds(e.layer.getBounds(), { padding: [30, 30] });
      });

      // LABELS
      function addLabels(fc, region, grpKec, grpPop) {
        (fc.features || []).forEach(f => {
          const props = f.properties || {};
          const nm = getKecamatanName(props);
          const pop = getPopulation(props);
          const [lat, lng] = centroidLatLng(f);

          // KEC label
          L.circleMarker([lat, lng], { radius: 1, opacity: 0, fillOpacity: 0 })
            .bindTooltip(nm, { permanent: true, direction: "center", className: "kec-label" })
            .addTo(grpKec);

          // POP label
          L.circleMarker([lat, lng], { radius: 1, opacity: 0, fillOpacity: 0 })
            .bindTooltip(String(formatInt(pop)), { permanent: true, direction: "bottom", offset: [0, 14], className: "pop-label" })
            .addTo(grpPop);
        });
      }
      addLabels(FC_KOTA, "Kota", labelKecKota, labelPopKota);
      addLabels(FC_KAB, "Kabupaten", labelKecKab, labelPopKab);

      // HEATMAP
      rebuildHeatLayers();

      // Default layers ON (ikuti checkbox awal)
      if ($("chkAdminKota")?.checked) adminKota.addTo(map);
      if ($("chkAdminKab")?.checked) adminKab.addTo(map);

      if ($("chkChoroKota")?.checked) choroKota.addTo(map);
      if ($("chkChoroKab")?.checked) choroKab.addTo(map);

      if ($("chkLabelKecKota")?.checked) labelKecKota.addTo(map);
      if ($("chkLabelKecKab")?.checked) labelKecKab.addTo(map);

      if ($("chkLabelPopKota")?.checked) labelPopKota.addTo(map);
      if ($("chkLabelPopKab")?.checked) labelPopKab.addTo(map);

      // heat visibility based on checkbox
      syncHeatVisibility();

      hideLoading();
    } catch (err) {
      console.error(err);
      showLoading("Gagal memuat data. Cek nama file & folder Geojson.");
    }
  }

  // ====== UI FUNCTIONS (dipanggil dari HTML) ======
  window.toggleInfoModal = function () {
    const m = $("infoModal");
    m.style.display = (m.style.display === "flex") ? "none" : "flex";
  };

  window.togglePrintModal = function () {
    const m = $("printModal");
    m.style.display = (m.style.display === "flex") ? "none" : "flex";
  };

  window.switchPanel = function (mode) {
    const layerDiv = $("viewLayers");
    const analysisDiv = $("viewAnalysis");
    const title = $("panelTitle");
    const btnL = $("navLayer");
    const btnA = $("navAnalysis");

    if (mode === "layer") {
      layerDiv.style.display = "block";
      analysisDiv.style.display = "none";
      title.textContent = "Daftar Layer";
      btnL.classList.add("active");
      btnA.classList.remove("active");
      clearResults();
    } else {
      layerDiv.style.display = "none";
      analysisDiv.style.display = "block";
      title.textContent = "Analisis";
      btnL.classList.remove("active");
      btnA.classList.add("active");
    }
  };

  window.toggleSidebar = function () {
    const s = $("sidebarPanel");
    s.style.display = (s.style.display === "none") ? "flex" : "none";
  };

  window.toggleBasemapMenu = function () {
    $("basemapDropdown").classList.toggle("show");
  };

  window.changeBasemap = function (v) {
    map.removeLayer(osm);
    map.removeLayer(sat);
    map.removeLayer(topo);
    if (v === "osm") osm.addTo(map);
    if (v === "sat") sat.addTo(map);
    if (v === "topo") topo.addTo(map);
    $("basemapDropdown").classList.remove("show");
  };

  window.goHome = function () {
    map.setView(HOME.center, HOME.zoom);
  };

  window.handleSearch = function (e) {
    if (e.key === "Enter") window.doSearch();
  };

  window.doSearch = function () {
    const q = ($("searchInput").value || "").trim().toLowerCase();
    if (!q) return alert("Masukkan nama kecamatan!");
    const found = FEATURES_ALL.find(x => getKecamatanName(x.f.properties || {}).toLowerCase().includes(q));
    if (!found) return alert("Kecamatan tidak ditemukan.");

    // zoom to polygon bounds
    const layer = L.geoJSON(found.f);
    const b = layer.getBounds();
    map.fitBounds(b, { padding: [30, 30] });

    // popup
    const nm = getKecamatanName(found.f.properties || {});
    const pop = found.pop;
    const dens = found.dens;
    const aKm2 = found.areaKm2;

    L.popup()
      .setLatLng([found.lat, found.lng])
      .setContent(`
        <div style="font-weight:900;font-size:15px;color:#ef6c00;margin-bottom:6px;">${nm}</div>
        <div><b>Wilayah:</b> ${found.region}</div>
        <div><b>Penduduk:</b> ${formatInt(pop)}</div>
        <div><b>Luas:</b> ${aKm2.toFixed(2)} km²</div>
        <div><b>Kepadatan:</b> ${formatDensity(dens)} jiwa/km²</div>
      `)
      .openOn(map);
  };

  window.toggleLayer = function (t) {
    const on = (id) => $(id)?.checked;

    if (t === "adminKota") on("chkAdminKota") ? adminKota.addTo(map) : map.removeLayer(adminKota);
    if (t === "adminKab")  on("chkAdminKab")  ? adminKab.addTo(map)  : map.removeLayer(adminKab);

    if (t === "choroKota") on("chkChoroKota") ? choroKota.addTo(map) : map.removeLayer(choroKota);
    if (t === "choroKab")  on("chkChoroKab")  ? choroKab.addTo(map)  : map.removeLayer(choroKab);

    if (t === "labelKecKota") on("chkLabelKecKota") ? labelKecKota.addTo(map) : map.removeLayer(labelKecKota);
    if (t === "labelKecKab")  on("chkLabelKecKab")  ? labelKecKab.addTo(map)  : map.removeLayer(labelKecKab);

    if (t === "labelPopKota") on("chkLabelPopKota") ? labelPopKota.addTo(map) : map.removeLayer(labelPopKota);
    if (t === "labelPopKab")  on("chkLabelPopKab")  ? labelPopKab.addTo(map)  : map.removeLayer(labelPopKab);

    if (t === "heatKota" || t === "heatKab" || t === "heatAll") {
      syncHeatVisibility();
    }
  };

  // ====== MEASURE TOOL ======
  window.activateTool = function (toolName) {
    toolGroup.clearLayers();
    measurePoints = [];
    $("btnMeasure").classList.remove("active");

    if (toolName === "measure") {
      activeTool = (activeTool === "measure") ? null : "measure";
      if (activeTool === "measure") {
        map.getContainer().style.cursor = "crosshair";
        $("btnMeasure").classList.add("active");
      } else {
        map.getContainer().style.cursor = "";
      }
    }
  };

  map.on("click", function (e) {
    if (activeTool !== "measure") return;

    measurePoints.push(e.latlng);
    L.circleMarker(e.latlng, { radius: 4, color: "#444" }).addTo(toolGroup);

    if (measurePoints.length === 2) {
      const p1 = measurePoints[0];
      const p2 = measurePoints[1];
      L.polyline([p1, p2], { color: "#444", dashArray: "6,10" }).addTo(toolGroup);

      const dist = map.distance(p1, p2);
      const km = (dist / 1000).toFixed(2);
      L.popup().setLatLng(p2).setContent(`<b>Jarak: ${km} km</b>`).openOn(map);

      measurePoints = [];
    }
  });

  // ====== PRINT ======
  window.executePrint = function () {
    const layout = $("inputPrintLayout").value;
    const style = document.createElement("style");
    style.innerHTML = `@page { size: A4 ${layout}; margin: 0; }`;
    style.id = "print-page-style";
    document.head.appendChild(style);

    setTimeout(() => {
      window.print();
      const s = document.getElementById("print-page-style");
      if (s) document.head.removeChild(s);
    }, 250);

    window.togglePrintModal();
  };

  // ====== ANALYSIS ======
  window.runDistrictAnalysis = function () {
    clearResults();
    const el = $("res-district");
    el.style.display = "block";

    const rows = FEATURES_ALL.map(x => ({
      region: x.region,
      nama: getKecamatanName(x.f.properties || {}),
      pop: x.pop,
      area: x.areaKm2,
      dens: x.dens,
      lat: x.lat,
      lng: x.lng
    }));

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

    rows.forEach(r => {
      html += `<tr onclick="window.__zoomRow(${r.lat},${r.lng})">
        <td>${r.region}</td>
        <td>${r.nama}</td>
        <td>${formatInt(r.pop)}</td>
        <td>${r.area.toFixed(2)}</td>
        <td><b>${formatDensity(r.dens)}</b></td>
      </tr>`;
    });

    html += `</table></div>`;
    el.innerHTML = html;
  };

  window.__zoomRow = function (lat, lng) {
    map.setView([lat, lng], 12.5);
  };

  window.runTopDense = function () {
    clearResults();
    const el = $("res-top");
    el.style.display = "block";

    const top = FEATURES_ALL
      .slice()
      .sort((a, b) => b.dens - a.dens)
      .slice(0, 10);

    let html = `<b>Top 10 Kecamatan Terpadat</b><ol style="margin:8px 0 0 18px;">`;
    top.forEach(x => {
      const nm = getKecamatanName(x.f.properties || {});
      html += `<li><b>${nm}</b> (${x.region}) — ${formatDensity(x.dens)} jiwa/km²</li>`;
    });
    html += `</ol>`;
    el.innerHTML = html;
  };

  window.runSummary = function () {
    clearResults();
    const el = $("res-sum");
    el.style.display = "block";

    const totPop = FEATURES_ALL.reduce((s, x) => s + (x.pop || 0), 0);
    const totArea = FEATURES_ALL.reduce((s, x) => s + (x.areaKm2 || 0), 0);
    const avgDens = totArea > 0 ? (totPop / totArea) : 0;

    el.innerHTML = `
      <div><b>Total Penduduk:</b> ${formatInt(totPop)}</div>
      <div><b>Total Luas:</b> ${totArea.toFixed(2)} km²</div>
      <div><b>Rata-rata Kepadatan:</b> ${formatDensity(avgDens)} jiwa/km²</div>
      <hr style="border:none;border-top:1px solid #eee;margin:10px 0">
      <div style="font-size:12px;color:#777">Catatan: kepadatan dihitung dari <b>Jumlah</b> / luas geometri (Turf area).</div>
    `;
  };

  // ====== INIT ======
  init();
})();
