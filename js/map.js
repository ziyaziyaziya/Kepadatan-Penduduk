const map = L.map("map").setView([-6.9, 107.6], 9);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "© OpenStreetMap"
}).addTo(map);

fetch("Geojson/Kabupaten_Kecamatan.GeoJSON")
  .then(r => r.json())
  .then(gj => L.geoJSON(gj, {style:{color:"red", weight:2, fillOpacity:0.2}}).addTo(map));

fetch("Geojson/Kota_Kecamatan.GeoJSON")
  .then(r => r.json())
  .then(gj => L.geoJSON(gj, {style:{color:"blue", weight:2, fillOpacity:0.2}}).addTo(map));
