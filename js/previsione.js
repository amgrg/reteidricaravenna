// Previsione indicativa dei prossimi guasti, calcolata nel browser da dati aperti:
// storico dei guasti (questo progetto), meteo (Open-Meteo) e terremoti (INGV).
// Non è un modello addestrato: con pochi eventi pubblici si usano regole
// esplicite, ciascuna mostrata all'utente con il proprio contributo.
(function (radice) {
  const GIORNO = 86400000;
  const PESO_IMPATTO = { alto: 3, medio: 2, basso: 1 };
  const SIGMA_MIN = 500;          // metri: raggio minimo di influenza di un guasto
  const EMIVITA_GIORNI = 730;     // un tratto che si è rotto resta fragile per anni
  const CENTRO = [12.2035, 44.4175];

  function giorniTra(a, b) {
    return (b - a) / GIORNO;
  }

  function distanzaM([lon1, lat1], [lon2, lat2]) {
    const x = (lon2 - lon1) * Math.PI / 180 * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
    const y = (lat2 - lat1) * Math.PI / 180;
    return 6371000 * Math.hypot(x, y);
  }

  function dataGuasto(f) {
    return new Date(f.properties.data + 'T12:00:00');
  }

  // Probabilità di almeno un guasto riportato dalla stampa nei prossimi `giorni`,
  // assumendo un processo di Poisson con il tasso osservato negli ultimi 365 giorni.
  function probabilitaBase(guasti, oggi, giorni = 7) {
    const recenti = guasti.filter(f => {
      const d = giorniTra(dataGuasto(f), oggi);
      return d >= 0 && d <= 365;
    }).length;
    const lambda = recenti / 365;
    return { eventi12mesi: recenti, probabilita: 1 - Math.exp(-lambda * giorni) };
  }

  function fattoreCascata(guasti, oggi) {
    // Dopo una rottura importante la rimessa in pressione stressa le condotte vecchie:
    // a gennaio 2026, dopo viale Farini, si sono rotte altre 4 tubazioni in 24 ore.
    let migliore = null;
    for (const f of guasti) {
      const p = f.properties;
      const d = giorniTra(dataGuasto(f), oggi);
      if (d < 0 || d > 10 || p.impatto === 'basso') continue;
      const punti = (p.impatto === 'alto' ? 40 : 20) * Math.exp(-d / 3);
      if (!migliore || punti > migliore.punti) migliore = { punti, guasto: p, giorni: d };
    }
    if (!migliore) return { nome: 'Effetto cascata', punti: 0, testo: 'Nessun guasto rilevante negli ultimi 10 giorni.' };
    const g = Math.max(0, Math.round(migliore.giorni));
    return {
      nome: 'Effetto cascata',
      punti: migliore.punti,
      testo: `${migliore.guasto.titolo} (${g === 0 ? 'oggi' : g === 1 ? 'ieri' : g + ' giorni fa'}): ` +
        'le manovre di rimessa in pressione aumentano il rischio di nuove rotture nei giorni successivi.'
    };
  }

  function fattoreFrequenza(base) {
    return {
      nome: 'Frequenza storica',
      punti: 20 * Math.min(1, base.probabilita / 0.3),
      testo: `${base.eventi12mesi} guasti riportati negli ultimi 12 mesi.`
    };
  }

  function fattoreMeteo(meteo) {
    if (!meteo || !meteo.daily) return { nome: 'Meteo', punti: 0, testo: 'Previsioni meteo non disponibili.', mancante: true };
    const min = meteo.daily.temperature_2m_min || [];
    const max = meteo.daily.temperature_2m_max || [];
    const gelo = min.filter(t => t <= 0).length;
    const caldo = max.filter(t => t >= 33).length;
    let sbalzi = 0;
    for (let i = 1; i < min.length; i++) if (Math.abs(min[i] - min[i - 1]) >= 6) sbalzi++;
    const punti = Math.min(30, gelo * 10) + Math.min(10, caldo * 5) + Math.min(10, sbalzi * 5);
    const parti = [];
    if (gelo) parti.push(`${gelo} giorni con gelo`);
    if (caldo) parti.push(`${caldo} giorni oltre 33 °C (picchi di consumo)`);
    if (sbalzi) parti.push(`${sbalzi} sbalzi termici di almeno 6 °C`);
    const tmin = min.length ? Math.min(...min) : null;
    const tmax = max.length ? Math.max(...max) : null;
    return {
      nome: 'Meteo (7 giorni)',
      punti,
      testo: (parti.length ? parti.join(', ') : 'Nessun gelo, caldo estremo o sbalzo termico forte') +
        (tmin !== null ? ` · minime ${tmin.toFixed(0)} °C, massime ${tmax.toFixed(0)} °C.` : '.')
    };
  }

  function fattoreSismico(terremoti, oggi) {
    if (!terremoti || !terremoti.features) return { nome: 'Sismicità', punti: 0, testo: 'Dati INGV non disponibili.', mancante: true };
    let forti = 0, vicini = 0;
    const elenco = [];
    for (const f of terremoti.features) {
      const giorni = giorniTra(new Date(f.properties.time + 'Z'), oggi);
      if (giorni > 14) continue;
      const dist = distanzaM(f.geometry.coordinates, CENTRO) / 1000;
      const mag = f.properties.mag;
      if (mag >= 3 && dist <= 60) { forti++; elenco.push(`M${mag} ${f.properties.place}`); }
      else if (mag >= 2 && dist <= 25) { vicini++; elenco.push(`M${mag} ${f.properties.place}`); }
    }
    return {
      nome: 'Sismicità (14 giorni)',
      punti: Math.min(30, forti * 15) + Math.min(10, vicini * 5),
      testo: elenco.length ? elenco.slice(0, 3).join('; ') + '.' : 'Nessuna scossa significativa vicino a Ravenna.'
    };
  }

  function calcolaAllerta(guasti, meteo, terremoti, oggi = new Date()) {
    const base = probabilitaBase(guasti, oggi, 7);
    const fattori = [fattoreCascata(guasti, oggi), fattoreFrequenza(base), fattoreMeteo(meteo), fattoreSismico(terremoti, oggi)];
    const totale = Math.min(100, fattori.reduce((s, f) => s + f.punti, 0));
    const livello = totale >= 50 ? 'elevato' : totale >= 25 ? 'moderato' : 'basso';
    return { totale, livello, fattori, probabilita7: base.probabilita, probabilita30: probabilitaBase(guasti, oggi, 30).probabilita };
  }

  // Densità dei guasti passati (kernel gaussiano pesato per impatto e anzianità),
  // normalizzata 0..1. Le celle restituite sono quelle sopra la soglia.
  function grigliaRischio(guasti, oggi = new Date(), opzioni = {}) {
    const passo = opzioni.passoM || 400;
    const soglia = opzioni.soglia ?? 0.08;
    const incertezza = opzioni.incertezza || {};
    const punti = guasti.map(f => {
      const eta = Math.max(0, giorniTra(dataGuasto(f), oggi));
      const sigma = Math.max(SIGMA_MIN, incertezza[f.properties.precisione] || 0);
      return {
        c: f.geometry.coordinates,
        // una posizione incerta distribuisce lo stesso peso su un'area più ampia
        peso: (PESO_IMPATTO[f.properties.impatto] || 1) * Math.pow(0.5, eta / EMIVITA_GIORNI) * (SIGMA_MIN / sigma),
        sigma
      };
    });
    if (!punti.length) return [];
    const lats = punti.map(p => p.c[1]), lons = punti.map(p => p.c[0]);
    const margine = 3 * Math.max(...punti.map(p => p.sigma));
    const dLat = passo / 111320;
    const latMin = Math.min(...lats) - margine / 111320, latMax = Math.max(...lats) + margine / 111320;
    const dLon = passo / (111320 * Math.cos(((latMin + latMax) / 2) * Math.PI / 180));
    const kLon = margine / passo * dLon;
    const lonMin = Math.min(...lons) - kLon, lonMax = Math.max(...lons) + kLon;

    const celle = [];
    let massimo = 0;
    for (let lat = latMin; lat <= latMax; lat += dLat) {
      for (let lon = lonMin; lon <= lonMax; lon += dLon) {
        const centro = [lon + dLon / 2, lat + dLat / 2];
        let v = 0;
        for (const p of punti) {
          const d = distanzaM(centro, p.c);
          if (d < 3 * p.sigma) v += p.peso * Math.exp(-(d * d) / (2 * p.sigma * p.sigma));
        }
        if (v > 0) celle.push({ sud: lat, ovest: lon, nord: lat + dLat, est: lon + dLon, valore: v });
        massimo = Math.max(massimo, v);
      }
    }
    return celle
      .map(c => Object.assign(c, { valore: c.valore / massimo }))
      .filter(c => c.valore >= soglia);
  }

  // Raggruppa i guasti vicini (entro `raggioM`) per indicare le zone con più rotture ripetute.
  function zoneCalde(guasti, oggi = new Date(), raggioM = 1500) {
    const gruppi = [];
    const ordinati = [...guasti].sort((a, b) => b.properties.data.localeCompare(a.properties.data));
    for (const f of ordinati) {
      const g = gruppi.find(g => distanzaM(g.centro, f.geometry.coordinates) <= raggioM);
      if (g) g.guasti.push(f);
      else gruppi.push({ centro: f.geometry.coordinates, guasti: [f] });
    }
    return gruppi
      .map(g => {
        const peso = g.guasti.reduce((s, f) =>
          s + (PESO_IMPATTO[f.properties.impatto] || 1) * Math.pow(0.5, Math.max(0, giorniTra(dataGuasto(f), oggi)) / EMIVITA_GIORNI), 0);
        return {
          centro: g.centro,
          nome: g.guasti[0].properties.localita || g.guasti[0].properties.indirizzo,
          conteggio: g.guasti.length,
          ultimo: g.guasti[0].properties.data,
          peso
        };
      })
      .sort((a, b) => b.peso - a.peso);
  }

  async function caricaMeteo() {
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=44.4175&longitude=12.2035' +
      '&daily=temperature_2m_min,temperature_2m_max&timezone=Europe%2FRome&forecast_days=7';
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Open-Meteo HTTP ${r.status}`);
    return r.json();
  }

  async function caricaTerremoti(oggi = new Date()) {
    const inizio = new Date(oggi - 14 * GIORNO).toISOString().slice(0, 19);
    const url = 'https://webservices.ingv.it/fdsnws/event/1/query?format=geojson&minmag=2' +
      `&lat=44.42&lon=12.2&maxradius=0.6&starttime=${inizio}`;
    const r = await fetch(url);
    if (r.status === 204) return { features: [] };
    if (!r.ok) throw new Error(`INGV HTTP ${r.status}`);
    return r.json();
  }

  const api = { calcolaAllerta, grigliaRischio, zoneCalde, probabilitaBase, caricaMeteo, caricaTerremoti };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else radice.Previsione = api;
})(typeof window !== 'undefined' ? window : globalThis);
