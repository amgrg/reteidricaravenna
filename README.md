# Rete Idrica Ravenna

Visualizzatore web, interamente open source, della rete idrica del Comune di Ravenna con i **guasti geolocalizzati a partire dalle notizie online**.

![Leaflet](https://img.shields.io/badge/mappa-Leaflet-199900) ![OSM](https://img.shields.io/badge/dati-OpenStreetMap-7ebc6f)

## Cosa mostra

- **Guasti dalle notizie** (`data/guasti.geojson`): rotture e disservizi riportati dalla stampa locale (Ravenna Notizie, RavennaToday, il Resto del Carlino, La Cronaca di Ravenna, Comune di Ravenna…), ciascuno con data, causa, utenze coinvolte, impatto e link alle fonti. Un cerchio tratteggiato indica l'incertezza della posizione: le notizie citano una via o una località, non il punto esatto della rottura.
- **Rete idrica da OpenStreetMap**: condotte (`man_made=pipeline` + `substance=water`), impianti (torri piezometriche, potabilizzatori, serbatoi, pozzi, stazioni di pompaggio, depuratori), fontanelle e idranti. La rete di distribuzione del gestore (Hera) non è pubblica: la mappa mostra solo ciò che è mappato in OSM.
- Filtri per periodo, impatto e testo; lista cronologica; statistiche.
- **Aggiunta manuale** di un guasto da una notizia: si inserisce l'indirizzo, viene geocodificato con Nominatim e salvato nel browser; «Esporta GeoJSON» permette di riportarlo nel repository.

## Previsione dei prossimi guasti

Il pannello «Previsione prossimi guasti» (`js/previsione.js`) calcola nel browser:

- un **indice di allerta a 7 giorni** (0–100: bassa, moderata, elevata), somma di fattori espliciti:
  - **effetto cascata**: dopo una rottura importante, la rimessa in pressione causa spesso nuove rotture (gennaio 2026: quattro rotture in 24 ore dopo viale Farini);
  - **frequenza storica** dei guasti negli ultimi 12 mesi;
  - **meteo** da [Open-Meteo](https://open-meteo.com): gelo, caldo estremo, sbalzi termici;
  - **sismicità** da [INGV](https://terremoti.ingv.it): scosse recenti vicino a Ravenna;
- la **probabilità** di almeno un guasto riportato dalla stampa in 7 e 30 giorni (processo di Poisson sul tasso osservato);
- una **mappa di rischio relativo**: densità dei guasti passati, pesata per impatto, con emivita di 2 anni e con un peso ridotto per le posizioni incerte;
- l'elenco delle **zone con più rotture ripetute**.

È una stima trasparente su pochi dati pubblici, non un modello addestrato: indica dove la rete si è già dimostrata fragile e quando le condizioni sono sfavorevoli. Più guasti vengono registrati, più la stima diventa affidabile.

## Strumenti open source usati

| Componente | Strumento | Licenza |
|---|---|---|
| Mappa | [Leaflet](https://leafletjs.com) 1.9.4 + [Leaflet.markercluster](https://github.com/Leaflet/Leaflet.markercluster) (in `vendor/`) | BSD-2 / MIT |
| Cartografia | [OpenStreetMap](https://www.openstreetmap.org), basemap CARTO | ODbL |
| Rete idrica | [Overpass API](https://overpass-api.de) | ODbL |
| Geocodifica | [Nominatim](https://nominatim.org) | ODbL |
| Notizie | Google News RSS + feed RSS configurabili | – |
| Meteo | [Open-Meteo](https://open-meteo.com) | CC BY 4.0 |
| Terremoti | [INGV FDSN web services](https://webservices.ingv.it) | CC BY 4.0 |
| Script | Python 3, solo libreria standard | – |

## Avvio

È un sito statico, non serve compilare nulla:

```bash
python3 -m http.server 8000
# poi apri http://localhost:8000
```

Si può pubblicare così com'è su GitHub Pages, oppure su Railway (online su https://web-production-869e9.up.railway.app): il `Dockerfile` serve il sito con Caddy sulla porta `$PORT` (configurazione in `railway.json`).

## Aggiornare i dati

```bash
# Cerca nuove notizie di guasti (ultimi 30 giorni), geolocalizza e aggiorna data/guasti.geojson
python3 scripts/aggiorna_guasti.py --dry-run   # anteprima
python3 scripts/aggiorna_guasti.py

# Snapshot della rete OSM in data/rete_osm.geojson (altrimenti il sito interroga Overpass live)
python3 scripts/scarica_rete_osm.py
```

Come funziona `aggiorna_guasti.py`:

1. legge i feed RSS definiti in `config/fonti_notizie.json`;
2. tiene solo le notizie che parlano di acqua/rete idrica **e** di guasti (rottura, perdita, senz'acqua…), escludendo i lavori programmati;
3. estrae vie e piazze («via Baccarini», «viale dei Navigatori») e le località del comune (Marina Romea, Classe, Mezzano…);
4. le geocodifica con Nominatim limitandosi al territorio comunale (max 1 richiesta/s, con cache in `data/geocache.json`);
5. unisce le notizie sullo stesso guasto (entro 400 m e 2 giorni) e aggiunge i nuovi guasti con `origine: "auto"` e stato **da verificare**.

Il workflow `.github/workflows/aggiorna-dati.yml` esegue entrambi gli script ogni giorno e committa i dati aggiornati.

I guasti verificati a mano hanno `origine: "manuale"`. Quando controlli un guasto automatico, correggi posizione, causa e impatto e cambia `origine` in `manuale`.

## Test

```bash
python3 -m unittest discover -s tests
```

## Note

- Per segnalare un guasto in corso: Pronto Intervento Hera **800 713 900** (gratuito, 24 ore su 24).
- Dati © OpenStreetMap contributors, licenza ODbL. Le notizie appartengono alle rispettive testate: il progetto ne riporta solo titolo e link.
