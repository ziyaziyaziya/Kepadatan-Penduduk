// =========================
// PATH GEOJSON (case-sensitive di GitHub Pages)
// =========================
const GEO_KAB_URL  = 'Geojson/Kabupaten_Kecamatan.GeoJSON';
const GEO_KOTA_URL = 'Geojson/Kota_Kecamatan.GeoJSON';

// =========================
// 1) INIT MAP
// =========================
const map = L.map('map', { zoomControl: true, doubleClickZoom: true }).setView([-6.914744, 107.609810], 11);

const osm  = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
const sat  = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 });
const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17 });

L.control.scale({ position: 'bottomright', metric: true, imperial: false }).addTo(map);

// Coordinate control
const CoordControl = L.Control.extend({
  options: { position: 'bottomright' },
  onAdd: function () {
    this._div = L.DomUtil.create('div', 'leaflet-control-coordinates');
    this._div.innerHTML = "Lat: - | Lng: -";
    return this._div;
  },
  update: function (lat, lng) {
    this._div.innerHTML = `Lat: ${lat.toFixed(5)} | Lng: ${lng.toFixed(5)}`;
  }
});
const coordBox = new CoordControl();
map.addControl(coordBox);
map.on('mousemove', (e) => coordBox.update(e.latlng.lat, e.latlng.lng));

// =========================
// 2) LAYER GROUPS (ADMIN + KEPADATAN DIPISAH)
// =========================

// Admin (kota/kab)
const adminKota = L.layerGroup();
const adminKab  = L.layerGroup();

// Choropleth (kota/kab)
const choroKota = L.layerGroup();
const choroKab  = L.layerGroup();

// Labels (kota/kab)
const labelKecKota = L.layerGroup();
const labelKecKab  = L.layerGroup();

const labelPopKota = L.layerGroup();
const labelPopKab  = L.layerGroup();

// Buffer (3)
const bufferKota = L.layerGroup();
const bufferKab  = L.layerGroup();
const bufferAll  = L.layerGroup();

// Highlight dipisah biar aman
const highlightLayer = L.layerGroup().addTo(map);

// Tools
const toolGroup = L.layerGroup().addTo(map);

// Data holders
let FC_KOTA = null;
let FC_KAB  = null;

let FEATURES_KOTA = [];
let FEATURES_KAB  = [];
let ALL_KEC_FEATURES = [];
let HOME_BOUNDS = null;

let activeTool = null;
let measurePoints = [];

// =========================
// 3) UTIL
// =========================
function fmtInt(n){ return (Number(n)||0).toLocaleString('id-ID'); }
function fmt2(n){ return (Number(n)||0).toLocaleString('id-ID', { maximumFractionDigits: 2 }); }

function getNama(props){
  return props.WADMKC || props.NAMOBJ || props.nama || props.NAMA || '(Tanpa Nama)';
}

// Penduduk dari atribut "Penduduk" (robust: string/angka)
function getPenduduk(props){
  const raw = props?.Penduduk ?? props?.penduduk ?? 0;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
  const s = String(raw).trim();
  if (!s) return 0;
  const cleaned = s.replace(/[^\d.-]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function clearHighlight(){
  highlightLayer.clearLayers();
}
function highlightFeature(feature){
  clearHighlight();
  L.geoJSON(feature, {
    style: { color:'#212121', weight:3, fillOpacity:0.10, fillColor:'#ffffff' }
  }).addTo(highlightLayer);
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

// =========================
// 4) CHOROPLETH STYLE + BREAKS
// =========================
let DENS_BREAKS = [];

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

// palet merah
function getColor(d){
  if (!DENS_BREAKS.length) return '#ffcdd2';
  if (d <= DENS_BREAKS[0]) return '#ffebee';
  if (d <= DENS_BREAKS[1]) return '#ffcdd2';
  if (d <= DENS_BREAKS[2]) return '#ef9a9a';
  if (d <= DENS_BREAKS[3]) return '#e57373';
  return '#d32f2f';
}

function styleChoro(feature){
  const d = feature.properties.__dens || 0;
  return { color:'#b71c1c', weight:1, fillOpacity:0.75, fillColor:getColor(d) };
}

function styleAdminKota(){
  return { color:'#1565C0', weight:2, fillOpacity:0.00 };
}
function styleAdminKab(){
  return { color:'#2E7D32', weight:2, fillOpacity:0.00 };
}

function styleBuffer(){
  return { color:'#ff6f00', weight:1, fillOpacity:0.12 };
}

function popupHtml(feature){
  const p = feature.properties || {};
  return `
    <b style="font-size:15px; color:#b71c1c">${getNama(p)}</b><br>
    <span style="background:#D32F2F; color:white; padding:2px 6px; border-radius:4px; font-size:11px;">
      Kepadatan Penduduk
    </span>
    <hr style="margin:8px 0; border:0; border-top:1px solid #eee">
    Penduduk: <b>${fmtInt(p.__pop)}</b> jiwa<br>
    Luas: <b>${fmt2(p.__areaKm2)}</b> km²<br>
    Kepadatan: <b>${fmtInt(Math.round(p.__dens))}</b> jiwa/km²
  `;
}

// =========================
// 5) LEGEND
// =========================
let legendControl = null;

function buildLegend(){
  if (legendControl) legendControl.remove();
  legendControl = L.control({ position:'bottomleft' });
  legendControl.onAdd = function(){
    const div = L.DomUtil.create('div', 'legend-box');
    div.innerHTML = `<b style="color:#b71c1c">Kepadatan (jiwa/km²)</b>`;

    const b = DENS_BREAKS.slice().sort((a,b)=>a-b);
    const ranges = [
      {from:0,   to:b[0] || 0},
      {from:b[0]||0, to:b[1]||0},
      {from:b[1]||0, to:b[2]||0},
      {from:b[2]||0, to:b[3]||0},
      {from:b[3]||0, to:(b[4] ?? (b[3]||0))}
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

    div.innerHTML += `<div style="margin-top:6px;color:#666">Klik kecamatan untuk detail.</div>`;
    div.innerHTML += `
      <div style="margin-top:8px;color:#555;font-size:11px;">
        <span style="display:inline-block;width:10px;height:10px;background:#1565C0;margin-right:6px;border-radius:2px;"></span>Kota Bandung
        &nbsp;&nbsp;
        <span style="display:inline-block;width:10px;height:10px;background:#2E7D32;margin-right:6px;border-radius:2px;"></span>Kabupaten Bandung
      </div>
    `;
    return div;
  };
  legendControl.addTo(map);
}

// =========================
// 6) LOAD DATA
// =========================
async function loadData(){
  const loading = document.getElementById('loading');
  loading.style.display = 'block';
  loading.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin" style="margin-right:10px;color:#D32F2F"></i> Memuat Data & Peta...`;

  const kabKec  = await safeFetch(GEO_KAB_URL);
  const kotaKec = await safeFetch(GEO_KOTA_URL);

  if (!kabKec && !kotaKec){
    loading.innerHTML = `
      <b>Gagal memuat GeoJSON.</b><br><br>
      Pastikan file ada di repo (case-sensitive):<br>
      - <code>${GEO_KAB_URL}</code><br>
      - <code>${GEO_KOTA_URL}</code><br><br>
      Lalu refresh (Ctrl+Shift+R).
    `;
    return;
  }

  FEATURES_KAB  = kabKec?.features  ? kabKec.features  : [];
  FEATURES_KOTA = kotaKec?.features ? kotaKec.features : [];

  FC_KAB  = { type:'FeatureCollection', features: FEATURES_KAB };
  FC_KOTA = { type:'FeatureCollection', features: FEATURES_KOTA };

  ALL_KEC_FEATURES = [...FEATURES_KAB, ...FEATURES_KOTA];

  // hitung pop / luas / dens (pop dari atribut Penduduk)
  const densVals = [];
  ALL_KEC_FEATURES.forEach(f=>{
    const pop = getPenduduk(f.properties || {});
    const areaKm2 = turf.area(f) / 1e6;
    const dens = areaKm2 > 0 ? pop/areaKm2 : 0;

    f.properties.__pop = pop;
    f.properties.__areaKm2 = areaKm2;
    f.properties.__dens = dens;
    densVals.push(dens);
  });

  DENS_BREAKS = quantileBreaks(densVals, 5);
  if (DENS_BREAKS.length < 5){
    const sorted = densVals.slice().sort((a,b)=>a-b);
    const mx = sorted[sorted.length-1] || 0;
    DENS_BREAKS = [mx*0.2, mx*0.4, mx*0.6, mx*0.8, mx];
  }

  buildAllLayers();
  initLayersFromCheckbox();
  buildLegend();

  // bounds gabungan
  HOME_BOUNDS = L.geoJSON({type:'FeatureCollection', features: ALL_KEC_FEATURES}).getBounds();
  map.fitBounds(HOME_BOUNDS, { padding:[20,20] });

  loading.style.display = 'none';
}

// =========================
// 7) BUILD LAYERS (ADMIN + CHORO + LABEL + BUFFER) TERPISAH
// =========================
function buildAllLayers(){
  // clear
  adminKota.clearLayers();
  adminKab.clearLayers();

  choroKota.clearLayers();
  choroKab.clearLayers();

  labelKecKota.clearLayers();
  labelKecKab.clearLayers();

  labelPopKota.clearLayers();
  labelPopKab.clearLayers();

  bufferKota.clearLayers();
  bufferKab.clearLayers();
  bufferAll.clearLayers();

  // ADMIN (tampilkan sebagai batas dari kumpulan kecamatan)
  if (FEATURES_KOTA.length){
    L.geoJSON(FC_KOTA, { style: styleAdminKota, interactive:false }).addTo(adminKota);
  }
  if (FEATURES_KAB.length){
    L.geoJSON(FC_KAB, { style: styleAdminKab, interactive:false }).addTo(adminKab);
  }

  // helper build set
  function buildSet(features, targetChoro, targetLabelKec, targetLabelPop, targetBuffer){
    // choropleth
    L.geoJSON({type:'FeatureCollection', features}, {
      style: styleChoro,
      onEachFeature: (f, layer)=>{
        layer.on('click', ()=>{
          highlightFeature(f);
          layer.bindPopup(popupHtml(f)).openPopup();
        });
      }
    }).addTo(targetChoro);

    // label kecamatan
    L.geoJSON({type:'FeatureCollection', features}, {
      style:{opacity:0, fillOpacity:0},
      onEachFeature:(f, layer)=>{
        layer.bindTooltip(getNama(f.properties||{}), {
          permanent:true, direction:'center', className:'kec-label'
        });
      }
    }).addTo(targetLabelKec);

    // label penduduk
    L.geoJSON({type:'FeatureCollection', features}, {
      style:{opacity:0, fillOpacity:0},
      onEachFeature:(f, layer)=>{
        layer.bindTooltip(fmtInt(f.properties.__pop), {
          permanent:true, direction:'center', className:'distance-label'
        });
      }
    }).addTo(targetLabelPop);

    // buffer centroid 3km
    const radiusKm = 3;
    features.forEach(f=>{
      const c = turf.centroid(f);
      const circ = turf.circle(c.geometry.coordinates, radiusKm, { steps:48, units:'kilometers' });
      L.geoJSON(circ, { style: styleBuffer, interactive:false }).addTo(targetBuffer);
      L.geoJSON(circ, { style: styleBuffer, interactive:false }).addTo(bufferAll);
    });
  }

  if (FEATURES_KOTA.length){
    buildSet(FEATURES_KOTA, choroKota, labelKecKota, labelPopKota, bufferKota);
  }
  if (FEATURES_KAB.length){
    buildSet(FEATURES_KAB,  choroKab,  labelKecKab,  labelPopKab,  bufferKab);
  }
}

function initLayersFromCheckbox(){
  const on = (id)=>document.getElementById(id)?.checked;

  if (on('chkAdminKota')) map.addLayer(adminKota);
  if (on('chkAdminKab'))  map.addLayer(adminKab);

  if (on('chkChoroKota')) map.addLayer(choroKota);
  if (on('chkChoroKab'))  map.addLayer(choroKab);

  if (on('chkLabelKecKota')) map.addLayer(labelKecKota);
  if (on('chkLabelKecKab'))  map.addLayer(labelKecKab);

  if (on('chkLabelPopKota')) map.addLayer(labelPopKota);
  if (on('chkLabelPopKab'))  map.addLayer(labelPopKab);

  if (on('chkBufferKota')) map.addLayer(bufferKota);
  if (on('chkBufferKab'))  map.addLayer(bufferKab);
  if (on('chkBufferAll'))  map.addLayer(bufferAll);
}

// =========================
// 8) SEARCH
// =========================
function handleSearch(e){ if (e.key === 'Enter') doSearch(); }

function doSearch(){
  const q = document.getElementById('searchInput').value.trim().toLowerCase();
  if (!q) return alert('Masukkan nama kecamatan!');

  const f = ALL_KEC_FEATURES.find(x => getNama(x.properties||{}).toLowerCase().includes(q));
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

// =========================
// 9) ANALISIS (GABUNGAN)
// =========================
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

  if (!ALL_KEC_FEATURES.length){
    resDiv.innerHTML = "<div style='padding:12px'>Data belum siap.</div>";
    return;
  }

  const rows = ALL_KEC_FEATURES.map(f=>({
    nama: getNama(f.properties||{}),
    pop: f.properties.__pop,
    area: f.properties.__areaKm2,
    dens: f.properties.__dens,
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

  const top = ALL_KEC_FEATURES
    .map(f=>({ nama:getNama(f.properties||{}), dens:f.properties.__dens, feature:f }))
    .sort((a,b)=>b.dens-a.dens)
    .slice(0,10);

  let html = `<b>Top 10 Kecamatan Terpadat (Gabungan)</b><ol style="padding-left:18px;margin:8px 0">`;
  top.forEach(t=>{
    html += `<li style="margin:6px 0;">
      <span class="top-item" data-name="${t.nama}" style="cursor:pointer;text-decoration:underline;color:#b71c1c">${t.nama}</span>
      <span style="float:right"><b>${fmtInt(Math.round(t.dens))}</b></span>
    </li>`;
  });
  html += `</ol><div style="color:#666;font-size:12px">Klik nama untuk zoom.</div>`;
  resDiv.innerHTML = html;

  resDiv.querySelectorAll('.top-item').forEach(el=>{
    el.addEventListener('click', ()=>{
      const name = el.getAttribute('data-name').toLowerCase();
      const f = ALL_KEC_FEATURES.find(x => getNama(x.properties||{}).toLowerCase() === name);
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
  ALL_KEC_FEATURES.forEach(f=>{
    totalPop += Number(f.properties.__pop || 0);
    totalArea += Number(f.properties.__areaKm2 || 0);
  });
  const avgDens = totalArea > 0 ? totalPop/totalArea : 0;

  resDiv.innerHTML = `
    <b>Ringkasan (Gabungan)</b><br><br>
    Total penduduk: <b>${fmtInt(totalPop)}</b> jiwa<br>
    Total luas: <b>${fmt2(totalArea)}</b> km²<br>
    Rata-rata kepadatan: <b>${fmtInt(Math.round(avgDens))}</b> jiwa/km²<br>
    Jumlah kecamatan: <b>${fmtInt(ALL_KEC_FEATURES.length)}</b>
  `;
}

// =========================
// 10) TOOL: MEASURE
// =========================
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

// =========================
// 11) UI HELPERS
// =========================
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

// =========================
// 12) LAYER TOGGLE
// =========================
function toggleLayer(t){
  const isOn = (id)=>document.getElementById(id)?.checked;

  if (t === 'adminKota') isOn('chkAdminKota') ? map.addLayer(adminKota) : map.removeLayer(adminKota);
  if (t === 'adminKab')  isOn('chkAdminKab')  ? map.addLayer(adminKab)  : map.removeLayer(adminKab);

  if (t === 'choroKota') isOn('chkChoroKota') ? map.addLayer(choroKota) : map.removeLayer(choroKota);
  if (t === 'choroKab')  isOn('chkChoroKab')  ? map.addLayer(choroKab)  : map.removeLayer(choroKab);

  if (t === 'labelKecKota') isOn('chkLabelKecKota') ? map.addLayer(labelKecKota) : map.removeLayer(labelKecKota);
  if (t === 'labelKecKab')  isOn('chkLabelKecKab')  ? map.addLayer(labelKecKab)  : map.removeLayer(labelKecKab);

  if (t === 'labelPopKota') isOn('chkLabelPopKota') ? map.addLayer(labelPopKota) : map.removeLayer(labelPopKota);
  if (t === 'labelPopKab')  isOn('chkLabelPopKab')  ? map.addLayer(labelPopKab)  : map.removeLayer(labelPopKab);

  if (t === 'bufferKota') isOn('chkBufferKota') ? map.addLayer(bufferKota) : map.removeLayer(bufferKota);
  if (t === 'bufferKab')  isOn('chkBufferKab')  ? map.addLayer(bufferKab)  : map.removeLayer(bufferKab);
  if (t === 'bufferAll')  isOn('chkBufferAll')  ? map.addLayer(bufferAll)  : map.removeLayer(bufferAll);

  // kalau choropleth dimatikan semua, hapus highlight
  if (!map.hasLayer(choroKota) && !map.hasLayer(choroKab)){
    clearHighlight();
  }
}

// =========================
// START
// =========================
loadData();
