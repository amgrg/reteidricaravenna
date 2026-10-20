// Caricamento della rete idrica da OpenStreetMap: prima lo snapshot locale
// (data/rete_osm.geojson, generato da scripts/scarica_rete_osm.py), altrimenti
// query live a Overpass con la stessa query di config/rete_osm.overpassql.
(function () {
  const OVERPASS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
  ];

  function categoria(tags) {
    if (tags.man_made === 'pipeline') return 'condotta';
    if (tags.amenity === 'drinking_water' || tags.amenity === 'water_point') return 'fontanella';
    if (tags.emergency === 'fire_hydrant') return 'idrante';
    return 'impianto';
  }

  // Overpass JSON -> GeoJSON (solo i casi prodotti dalla nostra query).
  function overpassToGeoJSON(json) {
    const features = [];
    for (const el of json.elements || []) {
      const tags = el.tags || {};
      let geometry = null;
      if (el.type === 'node') {
        geometry = { type: 'Point', coordinates: [el.lon, el.lat] };
      } else if (el.geometry && tags.man_made === 'pipeline') {
        geometry = { type: 'LineString', coordinates: el.geometry.map(p => [p.lon, p.lat]) };
      } else if (el.center) {
        geometry = { type: 'Point', coordinates: [el.center.lon, el.center.lat] };
      }
      if (!geometry) continue;
      features.push({
        type: 'Feature',
        geometry,
        properties: Object.assign({ osm_id: `${el.type}/${el.id}`, categoria: categoria(tags) }, tags)
      });
    }
    return { type: 'FeatureCollection', features };
  }

  async function caricaRete() {
    try {
      const r = await fetch('data/rete_osm.geojson', { cache: 'no-cache' });
      if (r.ok) return { dati: await r.json(), fonte: 'snapshot' };
    } catch (_) { /* nessuno snapshot: si passa a Overpass */ }

    const query = await (await fetch('config/rete_osm.overpassql')).text();
    let ultimoErrore;
    for (const url of OVERPASS) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          body: 'data=' + encodeURIComponent(query),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
        return { dati: overpassToGeoJSON(await r.json()), fonte: 'live' };
      } catch (e) {
        ultimoErrore = e;
      }
    }
    throw ultimoErrore;
  }

  window.ReteOSM = { caricaRete, overpassToGeoJSON };
})();
