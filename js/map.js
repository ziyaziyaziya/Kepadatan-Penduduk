// =========================
// WebGIS Kepadatan Penduduk
// Kota Bandung vs Kabupaten Bandung
// Choropleth + Heatmap + Labels + Analysis
// =========================

// 1) INIT MAP
const map = L.map('map', { zoomControl: true, doubleClickZoom: true })
  .setView([-6.914744, 107.609810], 11);

// Basemaps
const osm  = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
const sat  = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 });
const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17 });

// Scale
L.control.scale({ position: 'bottomright', metric: true, imperial: false }).addTo(map);

// Coordinate control
const CoordControl = L.Control.extend({
  options: { position: 'bottomright' },
  onAdd: function() {
    this._div = L.DomUtil.create('div', 'leaflet-control-coordinates');
    this._div.innerHTML = "Lat: - | Lng: -";
    return this._div;
  },
  update: function(lat, lng) {
    this._div.innerHTML = `Lat: ${lat.toFixed(5)} | Lng: ${lng.toFixed(5)}`;
  }
});
const coordBox = new CoordControl();
map.addControl(coordBox);
map.on('mousemove', (e) => coordBox.update(e.latlng.lat, e.latlng.lng));

// 2) LAYER GROUPS
const adminKota = L.layerGroup();
const adminKab  = L.layerGroup();

const choroKota = L.layerGroup();
const choroKab  = L.layerGroup();

const labelKecKota = L.layerGroup();
const labelKecKab  = L.layerGroup();

const labelPopKota = L.layerGroup();
const labelPopKab  = L.layerGroup();

let heatKota = null;
let heatKab  = null;
let heatAll  = null;

const toolGroup = L.layerGroup().addTo(map);

let HOME_BOUNDS = null;
let highlight = null;

let FC_KOTA = null;
let FC_KAB  = null;
let FEAT_KOTA = [];
let FEAT_KAB  = [];
let FEAT_ALL  = [];

let DENS_BREAKS = [];
let legendControl = null;

// measure tool
let activeTool = null;
let measurePoints = [];

// 3) UTIL
function fmtInt(n){ return (Number(n)||0).toLocaleString('id-ID'); }
function fmt2(n){ return (Number(n)||0).toLocaleString('id-ID', { maximumFractionDigits: 2 }); }

function getNama(props){
  return props.WADMKC || props.NAMOBJ || props.nama || props.NAMA || props.nm_kecamatan || props.NM_KECAMAT || '(Tanpa Nama)';
}

// penting: penduduk bisa "Penduduk" atau "Jumlah"
function getPenduduk(props){
  const candidates = [
    props.Penduduk, props.penduduk,
    props.Jumlah, props.JUMLAH, props.jumlah,
    props.JML_PDDK, props.JUMLAH_PDDK, props.JML_PENDUDUK,
    props.POP, props.pop
  ];
  for (const v of candidates){
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

async function safeFetch(url){
  try{
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    return await res.json();
  }catch(e){
    return null;
  }
}

function clearHighlight(){
  if (highlight){
    // highlight selalu kita taruh di toolGroup biar aman
    toolGroup.removeLayer(highlight);
    highlight = null;
  }
}
function highlightFeature(feature){
  clearHighlight();
  highlight = L.geoJSON(feature, {
    style: { color:'#212121', weight:3, fillOpacity:0.10, fillColor:'#ffffff' }
  }).addTo(toolGroup);
}

// 4) CHOROPLETH CLASSIFICATION
function quantileBreaks(values, k){
  const v = values.slice().filter(x => Number.isFinite(x)).sort((a,b)=>a-b);
  if (!v.length) return [];
  const out = [];
  for (let i=1;i<=k;i++){
    const q = i/k;
    const idx = Math.min(v.length-1, Math.max(0, Math.round(q*(v.length-1))));
    out.push(v[idx]);
  }
  return Array.from(new Set(out)).sort((a,b)=>a-b);
}

function getColor(d){
  // 5 kelas (oranye muda -> oranye tua)
  if (!DENS_BREAKS.length) return '#ffe0b2';
  if (d <= DENS_BREAKS[0]) return '#fff3e0';
  if (d <= DENS_BREAKS[1]) return '#ffe0b2';
  if (d <= DENS_BREAKS[2]) return '#ffcc80';
  if (d <= DENS_BREAKS[3]) return '#ffb74d';
  return '#fb8c00';
}

function styleChoro(feature){
  const d = feature.properties.__dens || 0;
  return { color:'#6d4c41', weight:1, fillOpacity:0.70, fillColor:getColor(d) };
}

function styleAdminKota(){
  return { color:'#1565C0', weight:2, fillOpacity:0.0 };
}
function styleAdminKab(){
  return { color:'#2E7D32', weight:2, fillOpacity:0.0 };
}

function popupHtml(feature){
  const p = feature.properties || {};
  return `
    <b style="font-size:15px; color:#ef6c00">${getNama(p)}</b><br>
    <span style="background:#fb8c00; color:white; padding:2px 6px; border-radius:4px; font-size:11px;">
      Kepadatan Penduduk
    </span>
    <hr style="margin:8px 0; border:0; border-top:1px solid #eee">
    Penduduk: <b>${fmtInt(p.__pop)}</b> jiwa<br>
    Luas: <b>${fmt2(p.__areaKm2)}</b> km²<br>
    Kepadatan: <b>${fmtInt(Math.round(p.__dens))}</b> jiwa/km²
  `;
}

// 5) LEGEND
function buildLegend(){
  if (legendControl) legendControl.remove();
  legendControl = L.control({ position:'bottomleft' });
  legendControl.onAdd = function(){
    const div = L.DomUtil.create('div', 'legend-box');
    div.innerHTML = `<b style="color:#ef6c00">Kepadatan (jiwa/km²)</b>`;

    const b = DENS_BREAKS.slice().sort((a,b)=>a-b);
    const ranges = [
      {from:0,   to:b[0] ?? 0},
      {from:b[0] ?? 0,to:b[1] ?? (b[0] ?? 0)},
      {from:b[1] ?? 0,to:b[2] ?? (b[1] ?? 0)},
      {from:b[2] ?? 0,to:b[3] ?? (b[2] ?? 0)},
      {from:b[3] ?? 0,to:(b[4] ?? b[3] ?? 0)}
    ];

    ranges.forEach(r=>{
      const mid = (r.from+r.to)/2;
      div.innerHTML += `
        <div class="leg-row">
          <span class="leg-swatch" style="background:${getColor(mid)}"></span>
          <span>${fmt2(r.from)} – ${fmt2(r.to)}</span>
        </div>
      `;
    });

    div.innerHTML += `
      <div style="margin-top:6px;color:#666">
        Klik kecamatan untuk detail.
        <div style="margin-top:6px">
          <span style="display:inline-block;width:10px;height:10px;background:#1565C0;border-radius:2px;margin-right:6px"></span>Kota Bandung
          &nbsp;&nbsp;
          <span style="display:inline-block;width:10px;height:10px;background:#2E7D32;border-radius:2px;margin-right:6px"></span>Kabupaten Bandung
        </div>
      </div>
    `;
    return div;
  };
  legendControl.addTo(map);
}

// 6) BUILD LAYERS FROM DATA
function computeStatsForFeatures(features){
  const densVals = [];
  features.forEach(f=>{
    const pop = getPenduduk(f.properties || {});
    const areaKm2 = turf.area(f) / 1e6;
    const dens = areaKm2 > 0 ? pop/areaKm2 : 0;

    f.properties = f.properties || {};
    f.properties.__pop = pop;
    f.properties.__areaKm2 = areaKm2;
    f.properties.__dens = dens;

    densVals.push(dens);
  });
  return densVals;
}

function makeLabels(fc, targetKecLayer, targetPopLayer){
  // label kecamatan
  L.geoJSON(fc, {
    style:{opacity:0, fillOpacity:0},
    onEachFeature:(f, layer)=>{
      layer.bindTooltip(getNama(f.properties||{}), {
        permanent:true, direction:'center', className:'kec-label'
      });
    }
  }).addTo(targetKecLayer);

  // label penduduk
  L.geoJSON(fc, {
    style:{opacity:0, fillOpacity:0},
    onEachFeature:(f, layer)=>{
      layer.bindTooltip(fmtInt((f.properties||{}).__pop || 0), {
        permanent:true, direction:'center', className:'distance-label'
      });
    }
  }).addTo(targetPopLayer);
}

function makeChoro(fc, targetLayer){
  L.geoJSON(fc, {
    style: styleChoro,
    onEachFeature: (f, layer)=>{
      layer.on('click', ()=>{
        highlightFeature(f);
        layer.bindPopup(popupHtml(f)).openPopup();
      });
    }
  }).addTo(targetLayer);
}

function buildHeat(features){
  // heatmap pakai centroid tiap kecamatan, intensity dari dens (dinormalisasi)
  const dens = features.map(f => (f.properties||{}).__dens || 0);
  const maxD = Math.max(...dens, 1);

  const pts = features.map(f=>{
    const c = turf.centroid(f);
    const lat = c.geometry.coordinates[1];
    const lng = c.geometry.coordinates[0];
    const d = (f.properties||{}).__dens || 0;
    const intensity = Math.max(0.05, d / maxD); // 0..1 (min 0.05 biar muncul)
    return [lat, lng, intensity];
  });

  // radius & blur bisa kamu adjust
  return L.heatLayer(pts, { radius: 28, blur: 22, maxZoom: 12 });
}

function buildAllLayers(){
  // clear all
  adminKota.clearLayers(); adminKab.clearLayers();
  choroKota.clearLayers(); choroKab.clearLayers();
  labelKecKota.clearLayers(); labelKecKab.clearLayers();
  labelPopKota.clearLayers(); labelPopKab.clearLayers();

  if (heatKota) map.removeLayer(heatKota);
  if (heatKab)  map.removeLayer(heatKab);
  if (heatAll)  map.removeLayer(heatAll);

  // admin boundaries (pakai outline dari polygon kecamatan, biar gak butuh file admin terpisah)
  L.geoJSON(FC_KOTA, { style: styleAdminKota, interactive:false }).addTo(adminKota);
  L.geoJSON(FC_KAB,  { style: styleAdminKab,  interactive:false }).addTo(adminKab);

  // choropleth
  makeChoro(FC_KOTA, choroKota);
  makeChoro(FC_KAB,  choroKab);

  // labels
  makeLabels(FC_KOTA, labelKecKota, labelPopKota);
  makeLabels(FC_KAB,  labelKecKab,  labelPopKab);

  // heatmaps
  heatKota = buildHeat(FEAT_KOTA);
  heatKab  = buildHeat(FEAT_KAB);
  heatAll  = buildHeat(FEAT_ALL);
}

// 7) LOAD DATA
async function loadData(){
  const loading = document.getElementById('loading');
  loading.style.display = 'block';

  // >>> INI YANG PENTING: PATH HARUS PERSIS sama repo kamu <<<
  const kota = await safeFetch('Geojson/Kota_Kecamatan.GeoJSON');
  const kab  = await safeFetch('Geojson/Kabupaten_Kecamatan.GeoJSON');

  if (!kota || !kab){
    loading.innerHTML = `
      <div style="font-weight:800;font-size:18px;margin-bottom:6px">Gagal memuat GeoJSON.</div>
      <div style="color:#555">
        Pastikan file ada di folder <b>Geojson</b> dan namanya <b>persis sama</b> (huruf besar-kecil).
        <div style="margin-top:10px;font-family:monospace;background:#fafafa;border:1px solid #eee;padding:10px;border-radius:8px">
          Geojson/Kota_Kecamatan.GeoJSON<br/>
          Geojson/Kabupaten_Kecamatan.GeoJSON
        </div>
        <div style="margin-top:10px;font-size:12px;color:#777">
          Kalau kamu rename jadi huruf kecil semua, ubah juga path di map.js.
        </div>
      </div>
    `;
    return;
  }

  FC_KOTA = kota;
  FC_KAB  = kab;

  FEAT_KOTA = (kota.features || []);
  FEAT_KAB  = (kab.features || []);
  FEAT_ALL  = [...FEAT_KOTA, ...FEAT_KAB];

  // hitung pop/area/dens untuk masing-masing
  const densValsAll = [];
  densValsAll.push(...computeStatsForFeatures(FEAT_KOTA));
  densValsAll.push(...computeStatsForFeatures(FEAT_KAB));

  // breaks gabungan agar warna konsisten
  DENS_BREAKS = quantileBreaks(densValsAll, 5);
  if (DENS_BREAKS.length < 5){
    const sorted = densValsAll.slice().sort((a,b)=>a-b);
    const mx = sorted[sorted.length-1] || 0;
    DENS_BREAKS = [mx*0.2, mx*0.4, mx*0.6, mx*0.8, mx];
  }

  buildAllLayers();

  // bounds gabungan
  HOME_BOUNDS = L.geoJSON({ type:'FeatureCollection', features: FEAT_ALL }).getBounds();
  map.fitBounds(HOME_BOUNDS, { padding:[20,20] });

  // default layer state from checkbox
  initLayersFromCheckbox();
  buildLegend();

  loading.style.display = 'none';
}

// 8) INIT LAYERS FROM CHECKBOX
function initLayersFromCheckbox(){
  const on = (id)=>document.getElementById(id)?.checked;

  if (on('chkAdminKota')) map.addLayer(adminKota);
  if (on('chkAdminKab'))  map.addLayer(adminKab);

  if (on('chkChoroKota')) map.addLayer(choroKota);
  if (on('chkChoroKab'))  map.addLayer(choroKab);

  if (on('chkHeatKota')) heatKota && map.addLayer(heatKota);
  if (on('chkHeatKab'))  heatKab && map.addLayer(heatKab);
  if (on('chkHeatAll'))  heatAll && map.addLayer(heatAll);

  if (on('chkLabelKecKota')) map.addLayer(labelKecKota);
  if (on('chkLabelKecKab'))  map.addLayer(labelKecKab);

  if (on('chkLabelPopKota')) map.addLayer(labelPopKota);
  if (on('chkLabelPopKab'))  map.addLayer(labelPopKab);
}

// 9) SEARCH
function handleSearch(e){ if (e.key === 'Enter') doSearch(); }

function doSearch(){
  const q = document.getElementById('searchInput').value.trim().toLowerCase();
  if (!q) return alert('Masukkan nama kecamatan!');
  const f = FEAT_ALL.find(x => getNama(x.properties||{}).toLowerCase().includes(q));
  if (!f) return alert('Kecamatan tidak ditemukan.');

  const b = L.geoJSON(f).getBounds();
  map.fitBounds(b, { padding:[30,30] });
  highlightFeature(f);
  L.popup().setLatLng(b.getCenter()).setContent(popupHtml(f)).openOn(map);
}

function goHome(){
  if (HOME_BOUNDS) map.fitBounds(HOME_BOUNDS, { padding:[20,20] });
  clearHighlight();
  map.closePopup();
}

// 10) ANALYSIS
function clearResults(){
  ['res-district','res-top','res-sum'].forEach(id=>{
    const el = document.getElementById(id);
    if (!el) return;
    el.style.display = 'none';
    el.innerHTML = '';
  });
}

function runDistrictAnalysis(){
  clearResults();
  const resDiv = document.getElementById('res-district');
  resDiv.style.display = 'block';

  if (!FEAT_ALL.length){
    resDiv.innerHTML = "<div style='padding:12px'>Data belum siap.</div>";
    return;
  }

  const rows = FEAT_ALL.map(f=>({
    nama: getNama(f.properties||{}),
    pop: (f.properties||{}).__pop || 0,
    area: (f.properties||{}).__areaKm2 || 0,
    dens: (f.properties||{}).__dens || 0,
    feature: f
  })).sort((a,b)=>b.dens - a.dens);

  let html = `<div style="max-height:260px; overflow-y:auto;">
    <table class="stats-table">
      <tr><th>Kecamatan</th><th>Penduduk</th><th>Luas</th><th>Kepadatan</th></tr>`;

  rows.forEach((r, idx)=>{
    html += `<tr data-idx="${idx}">
      <td>${r.nama}</td>
      <td>${fmtInt(r.pop)}</td>
      <td>${fmt2(r.area)} km²</td>
      <td><b>${fmtInt(Math.round(r.dens))}</b></td>
    </tr>`;
  });

  html += `</table></div>`;
  resDiv.innerHTML = html;

  resDiv.querySelectorAll('tr[data-idx]').forEach(tr=>{
    tr.addEventListener('click', ()=>{
      const idx = Number(tr.getAttribute('data-idx'));
      const f = rows[idx].feature;
      const b = L.geoJSON(f).getBounds();
      map.fitBounds(b, { padding:[30,30] });
      highlightFeature(f);
      L.popup().setLatLng(b.getCenter()).setContent(popupHtml(f)).openOn(map);
    });
  });
}

function runTopDense(){
  clearResults();
  const resDiv = document.getElementById('res-top');
  resDiv.style.display = 'block';

  const top = FEAT_ALL
    .map(f=>({ nama:getNama(f.properties||{}), dens:(f.properties||{}).__dens || 0, feature:f }))
    .sort((a,b)=>b.dens-a.dens)
    .slice(0,10);

  let html = `<b>Top 10 Kecamatan Terpadat</b><ol style="padding-left:18px;margin:8px 0">`;
  top.forEach(t=>{
    html += `<li style="margin:6px 0;">
      <span class="top-item" data-name="${t.nama}" style="cursor:pointer;text-decoration:underline;color:#ef6c00">${t.nama}</span>
      <span style="float:right"><b>${fmtInt(Math.round(t.dens))}</b></span>
    </li>`;
  });
  html += `</ol><div style="color:#666;font-size:12px">Klik nama untuk zoom.</div>`;
  resDiv.innerHTML = html;

  resDiv.querySelectorAll('.top-item').forEach(el=>{
    el.addEventListener('click', ()=>{
      const name = el.getAttribute('data-name').toLowerCase();
      const f = FEAT_ALL.find(x => getNama(x.properties||{}).toLowerCase() === name);
      if (!f) return;
      const b = L.geoJSON(f).getBounds();
      map.fitBounds(b, { padding:[30,30] });
      highlightFeature(f);
      L.popup().setLatLng(b.getCenter()).setContent(popupHtml(f)).openOn(map);
    });
  });
}

function runSummary(){
  clearResults();
  const resDiv = document.getElementById('res-sum');
  resDiv.style.display = 'block';

  let totalPop = 0, totalArea = 0;
  FEAT_ALL.forEach(f=>{
    totalPop += Number((f.properties||{}).__pop || 0);
    totalArea += Number((f.properties||{}).__areaKm2 || 0);
  });
  const avgDens = totalArea > 0 ? totalPop/totalArea : 0;

  resDiv.innerHTML = `
    <b>Ringkasan (Gabungan)</b><br><br>
    Total penduduk: <b>${fmtInt(totalPop)}</b> jiwa<br>
    Total luas: <b>${fmt2(totalArea)}</b> km²<br>
    Rata-rata kepadatan: <b>${fmtInt(Math.round(avgDens))}</b> jiwa/km²<br>
    Jumlah kecamatan: <b>${fmtInt(FEAT_ALL.length)}</b>
  `;
}

// 11) TOOL: MEASURE
function activateTool(toolName){
  toolGroup.clearLayers();
  measurePoints = [];
  document.getElementById('btnMeasure').classList.remove('active');

  if (toolName === 'measure'){
    if (activeTool === 'measure'){
      activeTool = null;
      map.getContainer().style.cursor = '';
      map.doubleClickZoom.enable();
    }else{
      activeTool = 'measure';
      map.getContainer().style.cursor = 'crosshair';
      map.doubleClickZoom.disable();
      document.getElementById('btnMeasure').classList.add('active');
    }
  }
}

map.on('click', function(e){
  if (activeTool !== 'measure') return;

  measurePoints.push(e.latlng);
  L.circleMarker(e.latlng, { color:'#444', radius:4 }).addTo(toolGroup);

  if (measurePoints.length === 2){
    const p1 = measurePoints[0], p2 = measurePoints[1];
    L.polyline([p1,p2], { color:'#444', dashArray:'5,10' }).addTo(toolGroup);
    const dist = map.distance(p1,p2);
    const km = (dist/1000).toFixed(2);
    L.popup().setLatLng(p2).setContent(`<b>Jarak: ${km} km</b>`).openOn(map);
    measurePoints = [];
  }
});

// 12) UI HELPERS (dipanggil dari HTML)
function toggleInfoModal(){
  const m = document.getElementById('infoModal');
  m.style.display = (m.style.display === 'flex') ? 'none' : 'flex';
}
function togglePrintModal(){
  const m = document.getElementById('printModal');
  m.style.display = (m.style.display === 'flex') ? 'none' : 'flex';
}
function switchPanel(mode){
  const sidebar = document.getElementById('sidebarPanel');
  const layerDiv = document.getElementById('viewLayers');
  const analysisDiv = document.getElementById('viewAnalysis');
  const title = document.getElementById('panelTitle');
  const btnL = document.getElementById('navLayer');
  const btnA = document.getElementById('navAnalysis');

  sidebar.style.display = 'flex';
  if (mode === 'layer'){
    layerDiv.style.display = 'block';
    analysisDiv.style.display = 'none';
    title.innerText = 'Daftar Layer';
    btnL.classList.add('active');
    btnA.classList.remove('active');
  }else{
    layerDiv.style.display = 'none';
    analysisDiv.style.display = 'block';
    title.innerText = 'Analisis Spasial';
    btnL.classList.remove('active');
    btnA.classList.add('active');
  }
}
function toggleSidebar(){
  const s = document.getElementById('sidebarPanel');
  s.style.display = (s.style.display === 'none') ? 'flex' : 'none';
}

function toggleBasemapMenu(){
  document.getElementById('basemapDropdown').classList.toggle('show');
}
function changeBasemap(v){
  map.removeLayer(osm);
  map.removeLayer(sat);
  map.removeLayer(topo);
  if (v === 'osm') osm.addTo(map);
  if (v === 'sat') sat.addTo(map);
  if (v === 'topo') topo.addTo(map);
  document.getElementById('basemapDropdown').classList.remove('show');
}

function executePrint(){
  const layout = document.getElementById('inputPrintLayout').value;
  const style = document.createElement('style');
  style.innerHTML = `@page { size: A4 ${layout}; margin: 0; }`;
  style.id = 'print-page-style';
  document.head.appendChild(style);

  togglePrintModal();
  setTimeout(()=>{
    window.print();
    document.head.removeChild(style);
  }, 500);
}

// 13) LAYER TOGGLE (dipanggil checkbox)
function toggleLayer(t){
  const on = (id)=>document.getElementById(id)?.checked;

  if (t === 'adminKota') on('chkAdminKota') ? map.addLayer(adminKota) : map.removeLayer(adminKota);
  if (t === 'adminKab')  on('chkAdminKab')  ? map.addLayer(adminKab)  : map.removeLayer(adminKab);

  if (t === 'choroKota') on('chkChoroKota') ? map.addLayer(choroKota) : map.removeLayer(choroKota);
  if (t === 'choroKab')  on('chkChoroKab')  ? map.addLayer(choroKab)  : map.removeLayer(choroKab);

  if (t === 'heatKota'){
    if (!heatKota) return;
    on('chkHeatKota') ? map.addLayer(heatKota) : map.removeLayer(heatKota);
  }
  if (t === 'heatKab'){
    if (!heatKab) return;
    on('chkHeatKab') ? map.addLayer(heatKab) : map.removeLayer(heatKab);
  }
  if (t === 'heatAll'){
    if (!heatAll) return;
    on('chkHeatAll') ? map.addLayer(heatAll) : map.removeLayer(heatAll);
  }

  if (t === 'labelKecKota') on('chkLabelKecKota') ? map.addLayer(labelKecKota) : map.removeLayer(labelKecKota);
  if (t === 'labelKecKab')  on('chkLabelKecKab')  ? map.addLayer(labelKecKab)  : map.removeLayer(labelKecKab);

  if (t === 'labelPopKota') on('chkLabelPopKota') ? map.addLayer(labelPopKota) : map.removeLayer(labelPopKota);
  if (t === 'labelPopKab')  on('chkLabelPopKab')  ? map.addLayer(labelPopKab)  : map.removeLayer(labelPopKab);

  // kalau choropleth dimatikan semua, highlight ikut hilang
  if (!map.hasLayer(choroKota) && !map.hasLayer(choroKab)) clearHighlight();
}

// START
loadData();
