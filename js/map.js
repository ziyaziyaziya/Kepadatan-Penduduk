// =========================
// 0) CANDIDATE FILES (auto-detect)
// =========================
const KOTA_CANDIDATES = [
  'Geojson/Kota_Kecamatan.geojson',
  'Geojson/Kota_Bandung.geojson',
  'Geojson/kecamatan_kota.geojson',
  'Geojson/Kota_Bandung_Kecamatan.geojson',
];

const KAB_CANDIDATES = [
  'Geojson/Kabupaten_Kecamatan.geojson',
  'Geojson/Kab_Bandung.geojson',
  'Geojson/kecamatan_kab.geojson',
  'Geojson/Kabupaten_Bandung_Kecamatan.geojson',
];

// =========================
// 1) INIT MAP
// =========================
const map = L.map('map', { zoomControl: true, doubleClickZoom: true }).setView([-6.914744, 107.609810], 11);

// basemaps
const osm  = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
const sat  = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 });
const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17 });

L.control.scale({ position: 'bottomright', metric: true, imperial: false }).addTo(map);

// coord control
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
// 2) LAYER GROUPS
// =========================
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

const highlightLayer = L.layerGroup().addTo(map);
const toolGroup = L.layerGroup().addTo(map);

// =========================
// 3) DATA HOLDERS
// =========================
let FC_KOTA = null;
let FC_KAB  = null;
let FEATURES_KOTA = [];
let FEATURES_KAB  = [];
let ALL_KEC_FEATURES = [];
let HOME_BOUNDS = null;

let DENS_BREAKS = [];
let legendControl = null;

let activeTool = null;
let measurePoints = [];

// =========================
// 4) UTILS
// =========================
function fmtInt(n){ return (Number(n)||0).toLocaleString('id-ID'); }
function fmt2(n){ return (Number(n)||0).toLocaleString('id-ID', { maximumFractionDigits: 2 }); }

function getNama(props){
  return props.WADMKC || props.nm_kecamatan || props.NAMOBJ || props.nama || props.NAMA || '(Tanpa Nama)';
}

// ambil penduduk: prioritas Jumlah, lalu variasi lain
function getPenduduk(props){
  if (!props) return 0;
  const candidates = [
    props.Jumlah, props.jumlah,
    props.JUMLAH, props.Jumlah_Penduduk, props.jumlah_penduduk,
    props.Penduduk, props.penduduk,
    props.PENDUDUK, props.Populasi, props.populasi,
    props.Total, props.total
  ];

  let raw = 0;
  for (const v of candidates){
    if (v !== undefined && v !== null && String(v).trim() !== ''){
      raw = v; break;
    }
  }

  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;

  const s = String(raw).trim();
  if (!s) return 0;
  const cleaned = s.replace(/[^\d.-]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

async function safeFetch(url){
  try{
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    return await res.json();
  }catch(e){
    return null;
  }
}

async function fetchFirstAvailable(list){
  for (const url of list){
    const data = await safeFetch(url);
    if (data && data.type === 'FeatureCollection' && Array.isArray(data.features)){
      return { url, data };
    }
  }
  return null;
}

function clearHighlight(){ highlightLayer.clearLayers(); }

function highlightFeature(feature){
  clearHighlight();
  L.geoJSON(feature, {
    style: { color:'#212121', weight:3, fillOpacity:0.10, fillColor:'#ffffff' }
  }).addTo(highlightLayer);
}

// =========================
// 5) CHOROPLETH BREAKS & COLOR
// =========================
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
  if (!DENS_BREAKS.length) return '#FFE0B2';
  if (d <= DENS_BREAKS[0]) return '#FFF3E0';
  if (d <= DENS_BREAKS[1]) return '#FFE0B2';
  if (d <= DENS_BREAKS[2]) return '#FFCC80';
  if (d <= DENS_BREAKS[3]) return '#FFB74D';
  return '#FB8C00';
}

function styleChoro(feature){
  const d = feature.properties.__dens || 0;
  return { color:'#E65100', weight:1, fillOpacity:0.72, fillColor:getColor(d) };
}

function styleAdminKota(){ return { color:'#1565C0', weight:2, fillOpacity:0.00 }; }
function styleAdminKab(){  return { color:'#2E7D32', weight:2, fillOpacity:0.00 }; }

function popupHtml(feature){
  const p = feature.properties || {};
  return `
    <b style="font-size:15px; color:#EF6C00">${getNama(p)}</b><br>
    <span style="background:#FB8C00; color:white; padding:2px 6px; border-radius:4px; font-size:11px;">
      Kepadatan Penduduk
    </span>
    <hr style="margin:8px 0; border:0; border-top:1px solid #eee">
    Jumlah Penduduk: <b>${fmtInt(p.__pop)}</b> jiwa<br>
    Luas: <b>${fmt2(p.__areaKm2)}</b> km²<br>
    Kepadatan: <b>${fmtInt(Math.round(p.__dens))}</b> jiwa/km²
  `;
}

// =========================
// 6) LEGEND
// =========================
function buildLegend(){
  if (legendControl) legendControl.remove();
  legendControl = L.control({ position:'bottomleft' });

  legendControl.onAdd = function(){
    const div = L.DomUtil.create('div', 'legend-box');
    div.innerHTML = `<b style="color:#EF6C00">Kepadatan (jiwa/km²)</b>`;

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
    return div;
  };

  legendControl.addTo(map);
}

// =========================
// 7) HEATMAP BUILDER
// =========================
function makeHeatData(features, maxDensRef){
  // centroid points with intensity 0..1 (based on dens)
  const pts = [];
  features.forEach(f=>{
    const dens = Number(f.properties?.__dens || 0);
    if (!Number.isFinite(dens) || dens <= 0) return;

    const c = turf.centroid(f);
    const lng = c.geometry.coordinates[0];
    const lat = c.geometry.coordinates[1];

    // normalize intensity
    const intensity = maxDensRef > 0 ? Math.min(1, dens / maxDensRef) : 0.2;
    pts.push([lat, lng, intensity]);
  });
  return pts;
}

function buildHeatmaps(){
  // remove old heat layers if any
  if (heatKota && map.hasLayer(heatKota)) map.removeLayer(heatKota);
  if (heatKab  && map.hasLayer(heatKab))  map.removeLayer(heatKab);
  if (heatAll  && map.hasLayer(heatAll))  map.removeLayer(heatAll);

  // max dens references
  const densAll = ALL_KEC_FEATURES.map(f=>Number(f.properties.__dens||0)).filter(Number.isFinite);
  const densKota = FEATURES_KOTA.map(f=>Number(f.properties.__dens||0)).filter(Number.isFinite);
  const densKab  = FEATURES_KAB.map(f=>Number(f.properties.__dens||0)).filter(Number.isFinite);

  const maxAll  = Math.max(1, ...densAll);
  const maxKota = Math.max(1, ...densKota);
  const maxKab  = Math.max(1, ...densKab);

  const ptsKota = makeHeatData(FEATURES_KOTA, maxKota);
  const ptsKab  = makeHeatData(FEATURES_KAB,  maxKab);
  const ptsAll  = makeHeatData(ALL_KEC_FEATURES, maxAll);

  // heat options (silakan ubah radius/blur kalau mau)
  const opts = { radius: 28, blur: 22, maxZoom: 15 };

  heatKota = L.heatLayer(ptsKota, opts);
  heatKab  = L.heatLayer(ptsKab,  opts);
  heatAll  = L.heatLayer(ptsAll,  opts);
}

// =========================
// 8) BUILD ALL LAYERS
// =========================
function buildAllLayers(){
  adminKota.clearLayers(); adminKab.clearLayers();
  choroKota.clearLayers(); choroKab.clearLayers();
  labelKecKota.clearLayers(); labelKecKab.clearLayers();
  labelPopKota.clearLayers(); labelPopKab.clearLayers();

  if (FEATURES_KOTA.length) L.geoJSON(FC_KOTA, { style: styleAdminKota, interactive:false }).addTo(adminKota);
  if (FEATURES_KAB.length)  L.geoJSON(FC_KAB,  { style: styleAdminKab,  interactive:false }).addTo(adminKab);

  function buildSet(features, targetChoro, targetLabelKec, targetLabelPop){
    L.geoJSON({type:'FeatureCollection', features}, {
      style: styleChoro,
      onEachFeature: (f, layer)=>{
        layer.on('click', ()=>{
          highlightFeature(f);
          layer.bindPopup(popupHtml(f)).openPopup();
        });
      }
    }).addTo(targetChoro);

    L.geoJSON({type:'FeatureCollection', features}, {
      style:{opacity:0, fillOpacity:0},
      onEachFeature:(f, layer)=>{
        layer.bindTooltip(getNama(f.properties||{}), {
          permanent:true, direction:'center', className:'kec-label'
        });
      }
    }).addTo(targetLabelKec);

    L.geoJSON({type:'FeatureCollection', features}, {
      style:{opacity:0, fillOpacity:0},
      onEachFeature:(f, layer)=>{
        layer.bindTooltip(fmtInt((f.properties||{}).__pop || 0), {
          permanent:true, direction:'center', className:'distance-label'
        });
      }
    }).addTo(targetLabelPop);
  }

  if (FEATURES_KOTA.length) buildSet(FEATURES_KOTA, choroKota, labelKecKota, labelPopKota);
  if (FEATURES_KAB.length)  buildSet(FEATURES_KAB,  choroKab,  labelKecKab,  labelPopKab);

  buildHeatmaps();
}

// =========================
// 9) INIT LAYERS FROM CHECKBOX
// =========================
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

  // heatmap default: Gabungan ON
  if (on('chkHeatKota') && heatKota) map.addLayer(heatKota);
  if (on('chkHeatKab')  && heatKab)  map.addLayer(heatKab);
  if (on('chkHeatAll')  && heatAll)  map.addLayer(heatAll);
}

// =========================
// 10) LOAD DATA
// =========================
async function loadData(){
  const loading = document.getElementById('loading');
  if (loading){
    loading.style.display = 'block';
    loading.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin" style="margin-right:10px;color:var(--primary-theme)"></i> Memuat Data & Peta...`;
  }

  const kotaPick = await fetchFirstAvailable(KOTA_CANDIDATES);
  const kabPick  = await fetchFirstAvailable(KAB_CANDIDATES);

  if (!kotaPick && !kabPick){
    if (loading){
      loading.innerHTML = `
        <b>Gagal memuat GeoJSON.</b><br><br>
        Pastikan file ada di folder <b>Geojson</b> dan namanya benar.<br>
        Contoh nama aman:<br>
        <code>Geojson/Kota_Kecamatan.geojson</code><br>
        <code>Geojson/Kabupaten_Kecamatan.geojson</code>
      `;
    }
    return;
  }

  FEATURES_KOTA = kotaPick?.data?.features ? kotaPick.data.features : [];
  FEATURES_KAB  = kabPick?.data?.features  ? kabPick.data.features  : [];

  FC_KOTA = { type:'FeatureCollection', features: FEATURES_KOTA };
  FC_KAB  = { type:'FeatureCollection', features: FEATURES_KAB };

  ALL_KEC_FEATURES = [...FEATURES_KOTA, ...FEATURES_KAB];

  // compute pop/area/dens
  const densVals = [];
  let popNonZero = 0;

  ALL_KEC_FEATURES.forEach(f=>{
    const pop = getPenduduk(f.properties || {});
    const areaKm2 = turf.area(f) / 1e6;
    const dens = areaKm2 > 0 ? pop/areaKm2 : 0;

    f.properties.__pop = pop;
    f.properties.__areaKm2 = areaKm2;
    f.properties.__dens = dens;

    densVals.push(dens);
    if (pop > 0) popNonZero++;
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

  HOME_BOUNDS = L.geoJSON({type:'FeatureCollection', features: ALL_KEC_FEATURES}).getBounds();
  map.fitBounds(HOME_BOUNDS, { padding:[20,20] });

  if (loading){
    if (popNonZero === 0){
      const sampleProps = ALL_KEC_FEATURES[0]?.properties || {};
      const keys = Object.keys(sampleProps).slice(0, 25).join(', ');
      loading.innerHTML = `
        <b>GeoJSON terbaca, tapi jumlah penduduk masih 0 semua.</b><br><br>
        Aku sudah cek kolom: <code>Jumlah</code>, <code>JUMLAH</code>, <code>Penduduk</code>, dll.<br>
        Kolom yang ada (contoh 25 pertama):<br>
        <code style="font-size:12px">${keys || '(tidak ada atribut)'}</code><br><br>
        Rename kolom penduduk jadi <b>Jumlah</b> atau kirim nama kolom yang benar.
      `;
      setTimeout(()=>{ loading.style.display='none'; }, 3000);
    }else{
      loading.style.display = 'none';
    }
  }
}

// =========================
// 11) SEARCH
// =========================
window.handleSearch = function(e){ if (e.key === 'Enter') window.doSearch(); };

window.doSearch = function(){
  const el = document.getElementById('searchInput');
  const q = (el ? el.value : '').trim().toLowerCase();
  if (!q) return alert('Masukkan nama kecamatan!');

  const f = ALL_KEC_FEATURES.find(x => getNama(x.properties||{}).toLowerCase().includes(q));
  if (!f) return alert('Kecamatan tidak ditemukan.');

  const b = L.geoJSON(f).getBounds();
  map.fitBounds(b, { padding:[30,30] });
  highlightFeature(f);
  L.popup().setLatLng(b.getCenter()).setContent(popupHtml(f)).openOn(map);
};

window.goHome = function(){
  if (HOME_BOUNDS) map.fitBounds(HOME_BOUNDS, { padding:[20,20] });
  clearHighlight();
  map.closePopup();
};

// =========================
// 12) ANALISIS
// =========================
function clearResults(){
  ['res-district','res-top','res-sum'].forEach(id=>{
    const el = document.getElementById(id);
    if (!el) return;
    el.style.display = 'none';
    el.innerHTML = '';
  });
}

window.runDistrictAnalysis = function(){
  clearResults();
  const resDiv = document.getElementById('res-district');
  if (!resDiv) return;

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
      <tr><th>Kecamatan</th><th>Jumlah</th><th>Luas</th><th>Kepadatan</th></tr>`;

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
};

window.runTopDense = function(){
  clearResults();
  const resDiv = document.getElementById('res-top');
  if (!resDiv) return;

  resDiv.style.display = 'block';
  const top = ALL_KEC_FEATURES
    .map(f=>({ nama:getNama(f.properties||{}), dens:f.properties.__dens, feature:f }))
    .sort((a,b)=>b.dens-a.dens)
    .slice(0,10);

  let html = `<b>Top 10 Kecamatan Terpadat (Gabungan)</b><ol style="padding-left:18px;margin:8px 0">`;
  top.forEach(t=>{
    html += `<li style="margin:6px 0;">
      <span class="top-item" data-name="${t.nama}" style="cursor:pointer;text-decoration:underline;color:#EF6C00">${t.nama}</span>
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
};

window.runSummary = function(){
  clearResults();
  const resDiv = document.getElementById('res-sum');
  if (!resDiv) return;

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
};

// =========================
// 13) TOOL: MEASURE
// =========================
window.activateTool = function(toolName){
  toolGroup.clearLayers();
  measurePoints = [];
  const btn = document.getElementById('btnMeasure');
  if (btn) btn.classList.remove('active');

  if (toolName === 'measure'){
    if (activeTool === 'measure'){
      activeTool = null;
      map.getContainer().style.cursor = '';
      map.doubleClickZoom.enable();
    }else{
      activeTool = 'measure';
      map.getContainer().style.cursor = 'crosshair';
      map.doubleClickZoom.disable();
      if (btn) btn.classList.add('active');
    }
  }
};

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
// 14) UI HELPERS
// =========================
window.toggleBasemapMenu = function(){
  document.getElementById('basemapDropdown')?.classList.toggle('show');
};
window.changeBasemap = function(v){
  map.removeLayer(osm); map.removeLayer(sat); map.removeLayer(topo);
  if (v === 'osm') osm.addTo(map);
  if (v === 'sat') sat.addTo(map);
  if (v === 'topo') topo.addTo(map);
  document.getElementById('basemapDropdown')?.classList.remove('show');
};

window.toggleInfoModal = function(){
  const m = document.getElementById('infoModal');
  if (!m) return;
  m.style.display = (m.style.display === 'flex') ? 'none' : 'flex';
};
window.togglePrintModal = function(){
  const m = document.getElementById('printModal');
  if (!m) return;
  m.style.display = (m.style.display === 'flex') ? 'none' : 'flex';
};

window.switchPanel = function(mode){
  const layerDiv = document.getElementById('viewLayers');
  const analysisDiv = document.getElementById('viewAnalysis');
  const title = document.getElementById('panelTitle');
  const btnL = document.getElementById('navLayer');
  const btnA = document.getElementById('navAnalysis');

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
};

window.toggleSidebar = function(){
  const s = document.getElementById('sidebarPanel');
  if (!s) return;
  s.style.display = (s.style.display === 'none') ? 'flex' : 'none';
};

window.executePrint = function(){
  const layout = document.getElementById('inputPrintLayout')?.value || 'landscape';
  const style = document.createElement('style');
  style.innerHTML = `@page { size: A4 ${layout}; margin: 0; }`;
  style.id = 'print-page-style';
  document.head.appendChild(style);
  window.togglePrintModal();
  setTimeout(()=>{
    window.print();
    document.head.removeChild(style);
  }, 400);
};

// =========================
// 15) TOGGLE LAYER
// =========================
window.toggleLayer = function(t){
  const on = (id)=>document.getElementById(id)?.checked;

  if (t === 'adminKota') on('chkAdminKota') ? map.addLayer(adminKota) : map.removeLayer(adminKota);
  if (t === 'adminKab')  on('chkAdminKab')  ? map.addLayer(adminKab)  : map.removeLayer(adminKab);

  if (t === 'choroKota') on('chkChoroKota') ? map.addLayer(choroKota) : map.removeLayer(choroKota);
  if (t === 'choroKab')  on('chkChoroKab')  ? map.addLayer(choroKab)  : map.removeLayer(choroKab);

  if (t === 'labelKecKota') on('chkLabelKecKota') ? map.addLayer(labelKecKota) : map.removeLayer(labelKecKota);
  if (t === 'labelKecKab')  on('chkLabelKecKab')  ? map.addLayer(labelKecKab)  : map.removeLayer(labelKecKab);

  if (t === 'labelPopKota') on('chkLabelPopKota') ? map.addLayer(labelPopKota) : map.removeLayer(labelPopKota);
  if (t === 'labelPopKab')  on('chkLabelPopKab')  ? map.addLayer(labelPopKab)  : map.removeLayer(labelPopKab);

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
};

// =========================
// START
// =========================
loadData();
