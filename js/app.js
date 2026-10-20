(function () {
  const CENTRO = [44.4175, 12.2035];
  const COLORI = { alto: '#c62828', medio: '#ef8a17', basso: '#e3c22b' };
  const RAGGIO_MARKER = { alto: 11, medio: 8, basso: 6 };
  // Incertezza della posizione in metri, in base a cosa cita la notizia.
  const INCERTEZZA = { indirizzo: 40, incrocio: 60, via: 200, localita: 700, area: 1800 };
  const CHIAVE_LOCALI = 'reteidricaravenna.segnalazioni';

  const fmtData = new Intl.DateTimeFormat('it-IT', { day: '2-digit', month: 'short', year: 'numeric' });

  // --- Mappa -------------------------------------------------------------
  const mappa = L.map('mappa', { zoomControl: true }).setView(CENTRO, 12);

  const basi = {
    'OpenStreetMap': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }),
    'Chiara (CARTO)': L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 20,
      attribution: '© OpenStreetMap contributors © <a href="https://carto.com/attributions">CARTO</a>'
    }),
    'Scura (CARTO)': L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 20,
      attribution: '© OpenStreetMap contributors © <a href="https://carto.com/attributions">CARTO</a>'
    })
  };
  const scuro = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  (scuro ? basi['Scura (CARTO)'] : basi['Chiara (CARTO)']).addTo(mappa);

  const livelloCondotte = L.layerGroup().addTo(mappa);
  const livelloImpianti = L.layerGroup().addTo(mappa);
  const livelloFontanelle = L.markerClusterGroup({ disableClusteringAtZoom: 17 });
  const livelloIdranti = L.markerClusterGroup({ disableClusteringAtZoom: 17 });
  // Riquadro sotto gli altri livelli vettoriali (overlayPane ha z-index 400).
  mappa.createPane('eta').style.zIndex = 350;
  const livelloEta = L.layerGroup();
  const livelloRischio = L.layerGroup().addTo(mappa);
  const livelloIncertezza = L.layerGroup().addTo(mappa);
  const livelloGuasti = L.layerGroup().addTo(mappa);

  L.control.layers(basi, {
    'Guasti dalle notizie': livelloGuasti,
    'Rischio relativo (previsione)': livelloRischio,
    'Età probabile della rete (ISTAT)': livelloEta,
    'Area di incertezza': livelloIncertezza,
    'Condotte (OSM)': livelloCondotte,
    'Impianti (OSM)': livelloImpianti,
    'Fontanelle (OSM)': livelloFontanelle,
    'Idranti (OSM)': livelloIdranti
  }, { collapsed: true }).addTo(mappa);
  L.control.scale({ imperial: false }).addTo(mappa);

  // --- Utilità -----------------------------------------------------------
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function urlSicuro(u) {
    try {
      const p = new URL(u);
      return p.protocol === 'https:' || p.protocol === 'http:' ? p.href : null;
    } catch (_) { return null; }
  }
  function dataLeggibile(iso) {
    const d = new Date(iso + 'T12:00:00');
    return isNaN(d) ? iso : fmtData.format(d);
  }

  // --- Guasti ------------------------------------------------------------
  let guasti = [];
  const markerPerId = new Map();

  function segnalazioniLocali() {
    try { return JSON.parse(localStorage.getItem(CHIAVE_LOCALI)) || []; } catch (_) { return []; }
  }
  function salvaSegnalazioniLocali(lista) {
    try { localStorage.setItem(CHIAVE_LOCALI, JSON.stringify(lista)); } catch (_) { /* storage non disponibile */ }
  }

  function popupGuasto(p) {
    const fonti = (p.fonti || [])
      .map(f => {
        const u = urlSicuro(f.url);
        return u ? `<li><a href="${esc(u)}" target="_blank" rel="noopener">${esc(f.titolo || u)}</a></li>` : '';
      })
      .join('');
    const dettagli = [
      p.indirizzo && `<b>Dove:</b> ${esc(p.indirizzo)} (${esc(p.localita || '')})`,
      p.causa && `<b>Causa:</b> ${esc(p.causa)}`,
      p.materiale && `<b>Materiale:</b> ${esc(p.materiale)}`,
      p.utenze && `<b>Utenze coinvolte:</b> circa ${esc(p.utenze)}`
    ].filter(Boolean).map(r => `<p>${r}</p>`).join('');
    return `<div class="popup">
      <h3>${esc(p.titolo)}</h3>
      <p class="meta">${esc(dataLeggibile(p.data))} · impatto ${esc(p.impatto)} · posizione per ${esc(p.precisione)}${p.origine === 'auto' ? ' · <b>da verificare</b>' : ''}</p>
      ${dettagli}
      ${p.descrizione ? `<p>${esc(p.descrizione)}</p>` : ''}
      ${fonti ? `<p><b>Fonti:</b></p><ul>${fonti}</ul>` : ''}
    </div>`;
  }

  function filtri() {
    const impatti = [...document.querySelectorAll('#filtro-impatto input:checked')].map(i => i.value);
    return {
      testo: document.getElementById('filtro-testo').value.trim().toLowerCase(),
      dal: document.getElementById('filtro-dal').value,
      al: document.getElementById('filtro-al').value,
      impatti,
      auto: document.getElementById('filtro-auto').checked
    };
  }

  function passaFiltri(p, f) {
    if (!f.impatti.includes(p.impatto)) return false;
    if (!f.auto && p.origine === 'auto') return false;
    if (f.dal && p.data < f.dal) return false;
    if (f.al && p.data > f.al) return false;
    if (f.testo) {
      const testo = [p.titolo, p.localita, p.indirizzo, p.causa, p.descrizione].join(' ').toLowerCase();
      if (!testo.includes(f.testo)) return false;
    }
    return true;
  }

  function disegnaGuasti() {
    livelloGuasti.clearLayers();
    livelloIncertezza.clearLayers();
    markerPerId.clear();
    const f = filtri();
    const visibili = guasti
      .filter(g => passaFiltri(g.properties, f))
      .sort((a, b) => b.properties.data.localeCompare(a.properties.data));

    for (const g of visibili) {
      const p = g.properties;
      const [lon, lat] = g.geometry.coordinates;
      const colore = COLORI[p.impatto] || COLORI.medio;
      L.circle([lat, lon], {
        radius: INCERTEZZA[p.precisione] || 300,
        color: colore, weight: 1, dashArray: '4 4', fillOpacity: 0.06, interactive: false
      }).addTo(livelloIncertezza);
      const m = L.circleMarker([lat, lon], {
        radius: RAGGIO_MARKER[p.impatto] || 8,
        color: '#fff', weight: 2, fillColor: colore, fillOpacity: 0.95,
        dashArray: p.origine === 'auto' ? '3 3' : null
      }).bindPopup(popupGuasto(p), { maxWidth: 320 })
        .bindTooltip(`${dataLeggibile(p.data)} · ${p.titolo}`)
        .addTo(livelloGuasti);
      markerPerId.set(p.id, m);
    }
    disegnaLista(visibili);
    disegnaStatistiche(visibili);
  }

  function disegnaLista(visibili) {
    const ol = document.getElementById('lista-guasti');
    document.getElementById('conteggio').textContent = `(${visibili.length})`;
    ol.innerHTML = visibili.map(g => {
      const p = g.properties;
      return `<li class="${esc(p.impatto)}" tabindex="0" data-id="${esc(p.id)}">
        <span class="data">${esc(dataLeggibile(p.data))}</span>
        ${p.origine === 'auto' ? '<span class="badge auto">da verificare</span>' : ''}
        ${p.origine === 'locale' ? '<span class="badge">tua segnalazione</span>' : ''}
        <span class="titolo">${esc(p.titolo)}</span>
        <span class="luogo">${esc(p.localita || p.indirizzo || '')}</span>
      </li>`;
    }).join('') || '<li>Nessun guasto con questi filtri.</li>';
  }

  function disegnaStatistiche(visibili) {
    const ultimo = visibili[0];
    const giorni = ultimo ? Math.round((Date.now() - new Date(ultimo.properties.data)) / 86400000) : null;
    document.getElementById('statistiche').innerHTML = `
      <div class="stat"><b>${visibili.length}</b><span>guasti</span></div>
      <div class="stat"><b>${visibili.filter(g => g.properties.impatto === 'alto').length}</b><span>ad alto impatto</span></div>
      <div class="stat"><b>${giorni ?? '–'}</b><span>giorni dall'ultimo</span></div>`;
  }

  function vaiAlGuasto(id) {
    const m = markerPerId.get(id);
    if (!m) return;
    mappa.flyTo(m.getLatLng(), Math.max(mappa.getZoom(), 15), { duration: 0.6 });
    m.openPopup();
    if (window.matchMedia('(max-width: 760px)').matches) document.getElementById('mappa').scrollIntoView();
  }

  document.getElementById('lista-guasti').addEventListener('click', e => {
    const li = e.target.closest('li[data-id]');
    if (li) vaiAlGuasto(li.dataset.id);
  });
  document.getElementById('lista-guasti').addEventListener('keydown', e => {
    const li = e.target.closest('li[data-id]');
    if (li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); vaiAlGuasto(li.dataset.id); }
  });
  for (const id of ['filtro-testo', 'filtro-dal', 'filtro-al', 'filtro-auto']) {
    document.getElementById(id).addEventListener('input', disegnaGuasti);
  }
  document.getElementById('filtro-impatto').addEventListener('change', disegnaGuasti);

  async function caricaGuasti() {
    const r = await fetch('data/guasti.geojson', { cache: 'no-cache' });
    const fc = await r.json();
    guasti = fc.features.concat(segnalazioniLocali());
    disegnaGuasti();
    aggiornaPrevisione();
    if (markerPerId.size) mappa.fitBounds(L.featureGroup([...markerPerId.values()]).getBounds(), { padding: [30, 30] });
  }

  // --- Segnalazioni manuali con geocodifica Nominatim --------------------
  async function geocodifica(testo) {
    const params = new URLSearchParams({
      q: /ravenna/i.test(testo) ? testo : `${testo}, Ravenna`,
      format: 'jsonv2',
      limit: '1',
      countrycodes: 'it',
      viewbox: '11.95,44.62,12.40,44.25',
      bounded: '1'
    });
    const r = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { headers: { 'Accept-Language': 'it' } });
    if (!r.ok) throw new Error(`Nominatim HTTP ${r.status}`);
    const [hit] = await r.json();
    return hit || null;
  }

  function precisioneDa(hit) {
    if (hit.addresstype === 'house' || hit.type === 'house') return 'indirizzo';
    if (hit.category === 'highway' || hit.class === 'highway') return 'via';
    if (['village', 'hamlet', 'suburb', 'quarter', 'neighbourhood'].includes(hit.addresstype)) return 'localita';
    return 'area';
  }

  document.getElementById('form-segnalazione').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target;
    const esito = document.getElementById('esito-segnalazione');
    const dati = Object.fromEntries(new FormData(form));
    esito.textContent = 'Geolocalizzazione in corso…';
    try {
      const hit = await geocodifica(dati.indirizzo);
      if (!hit) { esito.textContent = 'Indirizzo non trovato nel comune di Ravenna.'; return; }
      const url = urlSicuro(dati.url);
      const feature = {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [Number(hit.lon), Number(hit.lat)] },
        properties: {
          id: `locale-${Date.now()}`,
          titolo: dati.titolo,
          data: dati.data,
          localita: hit.display_name.split(',').slice(1, 3).join(',').trim(),
          indirizzo: hit.name || dati.indirizzo,
          precisione: precisioneDa(hit),
          impatto: dati.impatto,
          stato: 'da verificare',
          origine: 'locale',
          fonti: url ? [{ titolo: 'Notizia', url }] : []
        }
      };
      const locali = segnalazioniLocali();
      locali.push(feature);
      salvaSegnalazioniLocali(locali);
      guasti.push(feature);
      disegnaGuasti();
      aggiornaPrevisione();
      vaiAlGuasto(feature.properties.id);
      esito.textContent = `Aggiunto: ${hit.display_name}`;
      form.reset();
    } catch (err) {
      esito.textContent = `Errore: ${err.message}`;
    }
  });

  document.getElementById('esporta').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ type: 'FeatureCollection', features: guasti }, null, 2)], { type: 'application/geo+json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'guasti.geojson';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // --- Rete OSM -----------------------------------------------------------
  function nomeImpianto(p) {
    const tipi = {
      water_tower: 'Torre piezometrica', water_works: 'Impianto di potabilizzazione',
      reservoir_covered: 'Serbatoio interrato', water_well: 'Pozzo', storage_tank: 'Serbatoio',
      pumping_station: 'Stazione di pompaggio', wastewater_plant: 'Depuratore'
    };
    return p.name || tipi[p.man_made] || (p.landuse === 'reservoir' ? 'Bacino di accumulo' : 'Impianto');
  }

  function popupOSM(p) {
    const righe = Object.entries(p)
      .filter(([k]) => !['categoria', 'osm_id'].includes(k))
      .slice(0, 12)
      .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('');
    return `<div class="popup"><h3>${esc(p.categoria === 'impianto' ? nomeImpianto(p) : p.name || p.categoria)}</h3>
      <table class="meta">${righe}</table>
      <p><a href="https://www.openstreetmap.org/${esc(p.osm_id)}" target="_blank" rel="noopener">Vedi su OpenStreetMap</a></p></div>`;
  }

  function puntoOSM(lat, lon, colore, raggio) {
    return L.circleMarker([lat, lon], { radius: raggio, color: '#fff', weight: 1.5, fillColor: colore, fillOpacity: 0.9 });
  }

  async function caricaReteOSM() {
    const stato = document.getElementById('stato-rete');
    try {
      const { dati, fonte } = await window.ReteOSM.caricaRete();
      const conta = { condotta: 0, impianto: 0, fontanella: 0, idrante: 0 };
      for (const f of dati.features) {
        const p = f.properties;
        conta[p.categoria] = (conta[p.categoria] || 0) + 1;
        if (f.geometry.type === 'LineString') {
          L.polyline(f.geometry.coordinates.map(([x, y]) => [y, x]), { color: '#1a73e8', weight: 3, opacity: 0.8 })
            .bindPopup(popupOSM(p)).addTo(livelloCondotte);
          continue;
        }
        const [lon, lat] = f.geometry.coordinates;
        if (p.categoria === 'impianto') {
          puntoOSM(lat, lon, '#0d47a1', 7).bindPopup(popupOSM(p)).bindTooltip(nomeImpianto(p)).addTo(livelloImpianti);
        } else if (p.categoria === 'fontanella') {
          livelloFontanelle.addLayer(puntoOSM(lat, lon, '#00acc1', 5).bindPopup(popupOSM(p)));
        } else if (p.categoria === 'idrante') {
          livelloIdranti.addLayer(puntoOSM(lat, lon, '#d81b60', 4).bindPopup(popupOSM(p)));
        }
      }
      stato.textContent = `${fonte === 'live' ? 'Dati live da Overpass' : 'Snapshot locale'}: ` +
        `${conta.condotta} condotte, ${conta.impianto} impianti, ${conta.fontanella} fontanelle, ${conta.idrante} idranti ` +
        '(fontanelle e idranti si attivano dal selettore livelli).';
    } catch (err) {
      stato.textContent = `Rete OSM non disponibile (${err.message}). I guasti restano consultabili.`;
    }
  }

  // --- Previsione ------------------------------------------------------------
  const P = window.Previsione;
  const datiEsterni = {};
  const caricamentoEsterni = Promise.all([
    P.caricaMeteo().then(d => { datiEsterni.meteo = d; }).catch(() => {}),
    P.caricaTerremoti().then(d => { datiEsterni.terremoti = d; }).catch(() => {})
  ]);

  function coloreRischio(v) {
    // da giallo (basso) a rosso (alto)
    const g = Math.round(235 - 168 * v);
    return `rgb(${Math.round(255 - 11 * v)},${g},${Math.round(59 - 5 * v)})`;
  }

  function disegnaGrigliaRischio() {
    livelloRischio.clearLayers();
    for (const c of P.grigliaRischio(guasti, new Date(), { incertezza: INCERTEZZA })) {
      L.rectangle([[c.sud, c.ovest], [c.nord, c.est]], {
        stroke: false, fillColor: coloreRischio(c.valore), fillOpacity: 0.12 + 0.43 * c.valore, interactive: false
      }).addTo(livelloRischio);
    }
  }

  function disegnaAllerta() {
    const a = P.calcolaAllerta(guasti, datiEsterni.meteo, datiEsterni.terremoti);
    const box = document.getElementById('allerta');
    box.className = `allerta ${a.livello}`;
    box.innerHTML = `<span class="livello">Allerta ${esc({ basso: 'bassa', moderato: 'moderata', elevato: 'elevata' }[a.livello])}</span>
      <span class="punteggio">${Math.round(a.totale)}/100 · prossimi 7 giorni</span>
      <span class="prob">Probabilità di almeno un guasto riportato dalla stampa: <b>${Math.round(a.probabilita7 * 100)}%</b> in 7 giorni, <b>${Math.round(a.probabilita30 * 100)}%</b> in 30 giorni.</span>`;
    const massimi = { 'Effetto cascata': 40, 'Frequenza storica': 20, 'Meteo (7 giorni)': 50, 'Meteo': 50, 'Sismicità (14 giorni)': 40, 'Sismicità': 40 };
    document.getElementById('fattori').innerHTML = a.fattori.map(f => `<li>
      <b>${esc(f.nome)}</b> +${Math.round(f.punti)}
      <div class="barra"><i style="width:${Math.min(100, 100 * f.punti / (massimi[f.nome] || 40))}%"></i></div>
      <span class="testo">${esc(f.testo)}</span></li>`).join('');
  }

  function disegnaZoneCalde() {
    const zone = P.zoneCalde(guasti).slice(0, 5);
    const ol = document.getElementById('zone-calde');
    ol.innerHTML = zone.map((z, i) => `<li data-i="${i}" tabindex="0">${esc(z.nome)} — ${z.conteggio} ${z.conteggio === 1 ? 'guasto' : 'guasti'}, ultimo ${esc(dataLeggibile(z.ultimo))}</li>`).join('');
    ol.onclick = e => {
      const li = e.target.closest('li[data-i]');
      if (li) { const [lon, lat] = zone[li.dataset.i].centro; mappa.flyTo([lat, lon], 14, { duration: 0.6 }); }
    };
  }

  function aggiornaPrevisione() {
    disegnaGrigliaRischio();
    disegnaZoneCalde();
    disegnaAllerta();
    caricamentoEsterni.then(disegnaAllerta);
  }

  // --- Età probabile della rete (ISTAT) -------------------------------------
  // Classi sull'anno medio di costruzione degli edifici, con i materiali tipici
  // posati in quell'epoca nelle reti italiane.
  const CLASSI_ETA = [
    { fino: 1945, colore: '#7f2704', nome: 'prima del 1946', materiali: 'ghisa grigia, acciaio' },
    { fino: 1960, colore: '#b63c02', nome: '1946–1960', materiali: 'ghisa grigia, acciaio, primo fibrocemento' },
    { fino: 1975, colore: '#e5590f', nome: '1961–1975', materiali: 'fibrocemento (cemento-amianto), acciaio' },
    { fino: 1990, colore: '#fd9243', nome: '1976–1990', materiali: 'fibrocemento, PVC' },
    { fino: 2005, colore: '#fdc28c', nome: '1991–2005', materiali: 'PVC, PEAD, ghisa sferoidale' },
    { fino: Infinity, colore: '#feedde', nome: 'dopo il 2005', materiali: 'PEAD, ghisa sferoidale' }
  ];
  const classeEta = anno => CLASSI_ETA.find(c => anno <= c.fino);

  function popupEta(p) {
    const c = classeEta(p.anno_medio);
    const epoche = Object.entries(p.epoche || {})
      .filter(([, n]) => n > 0)
      .map(([e, n]) => `<tr><td>${esc(e)}</td><td>${esc(n)}</td></tr>`).join('');
    return `<div class="popup"><h3>Rete stimata: anni ${esc(c.nome)}</h3>
      <p class="meta">Sezione di censimento ${esc(p.sez2011)} · ${esc(p.edifici)} edifici residenziali</p>
      <p><b>Anno medio di costruzione:</b> ${esc(p.anno_medio)} · ${Math.round(p.quota_pre1961 * 100)}% prima del 1961</p>
      <p><b>Materiali tipici dell'epoca:</b> ${esc(c.materiali)}</p>
      <table class="meta">${epoche}</table>
      <p class="meta">Stima dall'età degli edifici (ISTAT 2011): non considera le sostituzioni successive.</p></div>`;
  }

  async function caricaEta() {
    const stato = document.getElementById('stato-eta');
    document.getElementById('legenda-eta').innerHTML = CLASSI_ETA.map(c =>
      `<li><i style="background:${c.colore}"></i>${esc(c.nome)} <small>${esc(c.materiali)}</small></li>`).join('');
    try {
      const r = await fetch('data/eta_rete.geojson', { cache: 'no-cache' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const fc = await r.json();
      L.geoJSON(fc, {
        pane: 'eta',
        style: f => ({ color: '#fff', weight: 0.4, fillColor: classeEta(f.properties.anno_medio).colore, fillOpacity: 0.6 }),
        onEachFeature: (f, l) => l.bindPopup(popupEta(f.properties), { maxWidth: 300 })
      }).addTo(livelloEta);
      const vecchie = fc.features.filter(f => f.properties.anno_medio <= 1960).length;
      stato.textContent = `${fc.features.length} sezioni di censimento; ${vecchie} con edifici mediamente costruiti prima del 1961.`;
    } catch (err) {
      stato.textContent = `Dati ISTAT non ancora disponibili (${err.message}).`;
      document.getElementById('mostra-eta').disabled = true;
    }
  }

  const casellaEta = document.getElementById('mostra-eta');
  casellaEta.addEventListener('change', () => {
    if (casellaEta.checked) livelloEta.addTo(mappa); else livelloEta.remove();
  });
  mappa.on('overlayadd overlayremove', e => {
    if (e.layer === livelloEta) casellaEta.checked = e.type === 'overlayadd';
  });

  // --- Pannello -----------------------------------------------------------
  document.getElementById('toggle-pannello').addEventListener('click', e => {
    const pannello = document.getElementById('pannello');
    const chiuso = pannello.classList.toggle('chiuso');
    e.currentTarget.setAttribute('aria-expanded', String(!chiuso));
    setTimeout(() => mappa.invalidateSize(), 50);
  });

  caricaGuasti();
  caricaReteOSM();
  caricaEta();
})();
