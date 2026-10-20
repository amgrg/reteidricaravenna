#!/usr/bin/env python3
"""Stima l'età probabile della rete idrica di Ravenna dall'epoca di costruzione
degli edifici (Censimento ISTAT 2011, per sezione di censimento) e la salva in
data/eta_rete.geojson.

Le condotte di distribuzione si posano di norma quando si urbanizza un isolato:
l'epoca prevalente degli edifici è quindi un indicatore dell'età dei tubi, al
netto delle sostituzioni fatte nel frattempo (che i dati pubblici non riportano).

Fonti (licenza CC BY 4.0):
  - basi territoriali 2011, Emilia-Romagna, WGS84 UTM 32N
  - variabili censuarie 2011 per sezione di censimento
Richiede pyshp (pip install pyshp).
"""
import argparse
import csv
import io
import json
import math
import re
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

import shapefile  # pyshp

RADICE = Path(__file__).resolve().parent.parent
USCITA = RADICE / "data" / "eta_rete.geojson"
USER_AGENT = "reteidricaravenna/1.0 (+https://github.com/amgrg/reteidricaravenna)"
URL_BASI = "https://www.istat.it/storage/cartografia/basi_territoriali/WGS_84_UTM/2011/R08_11_WGS84.zip"
URL_DATI = "https://www.istat.it/storage/cartografia/variabili-censimento/dati-cpa_2011.zip"
PROCOM_RAVENNA = 39014

# Classi di epoca del censimento 2011, con l'anno usato come valore centrale e il
# testo con cui riconoscerle nel tracciato record ISTAT.
EPOCHE = [
    ("prima del 1919", 1905, r"prima del 1919"),
    ("1919-1945", 1932, r"1919.{1,6}1945"),
    ("1946-1960", 1953, r"1946.{1,6}1960"),
    ("1961-1970", 1965, r"1961.{1,6}1970"),
    ("1971-1980", 1975, r"1971.{1,6}1980"),
    ("1981-1990", 1985, r"1981.{1,6}1990"),
    ("1991-2000", 1995, r"1991.{1,6}2000"),
    ("2001-2005", 2003, r"2001.{1,6}2005"),
    ("dopo il 2005", 2008, r"dopo il 2005"),
]
# Ripiego se il tracciato non è nell'archivio: E8..E16 sono le epoche nel 2011.
COLONNE_DEFAULT = [f"E{i}" for i in range(8, 17)]


# --- Proiezione UTM 32N -> WGS84 (formule di Snyder, ellissoide WGS84) --------

A = 6378137.0
F = 1 / 298.257223563
E2 = F * (2 - F)
K0 = 0.9996
LON0 = math.radians(9)  # meridiano centrale fuso 32


def utm32_a_wgs84(x, y):
    ep2 = E2 / (1 - E2)
    m = y / K0
    mu = m / (A * (1 - E2 / 4 - 3 * E2 ** 2 / 64 - 5 * E2 ** 3 / 256))
    e1 = (1 - math.sqrt(1 - E2)) / (1 + math.sqrt(1 - E2))
    phi1 = (mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * math.sin(2 * mu)
            + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * math.sin(4 * mu)
            + (151 * e1 ** 3 / 96) * math.sin(6 * mu)
            + (1097 * e1 ** 4 / 512) * math.sin(8 * mu))
    s, c, t = math.sin(phi1), math.cos(phi1), math.tan(phi1)
    n1 = A / math.sqrt(1 - E2 * s * s)
    t1 = t * t
    c1 = ep2 * c * c
    r1 = A * (1 - E2) / (1 - E2 * s * s) ** 1.5
    d = (x - 500000) / (n1 * K0)
    lat = phi1 - (n1 * t / r1) * (
        d ** 2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep2) * d ** 4 / 24
        + (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep2 - 3 * c1 ** 2) * d ** 6 / 720)
    lon = LON0 + (d - (1 + 2 * t1 + c1) * d ** 3 / 6
                  + (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ep2 + 24 * t1 ** 2) * d ** 5 / 120) / c
    return math.degrees(lon), math.degrees(lat)


# --- Geometria -----------------------------------------------------------------

def semplifica(punti, tolleranza):
    """Douglas-Peucker iterativo (coordinate proiettate, metri)."""
    if len(punti) < 4:
        return punti
    tieni = [False] * len(punti)
    tieni[0] = tieni[-1] = True
    pila = [(0, len(punti) - 1)]
    while pila:
        i, j = pila.pop()
        (x1, y1), (x2, y2) = punti[i], punti[j]
        dx, dy = x2 - x1, y2 - y1
        norma = math.hypot(dx, dy)
        massimo, indice = 0.0, None
        for k in range(i + 1, j):
            x0, y0 = punti[k]
            if norma:
                dist = abs(dy * x0 - dx * y0 + x2 * y1 - y2 * x1) / norma
            else:  # anello chiuso: estremi coincidenti, si misura dal punto
                dist = math.hypot(x0 - x1, y0 - y1)
            if dist > massimo:
                massimo, indice = dist, k
        if indice is not None and massimo > tolleranza:
            tieni[indice] = True
            pila += [(i, indice), (indice, j)]
    risultato = [p for p, t in zip(punti, tieni) if t]
    return risultato if len(risultato) >= 4 else punti


def anelli_in_poligoni(forma, tolleranza):
    """Converte una shape pyshp (anelli in sequenza) in coordinate GeoJSON MultiPolygon."""
    confini = list(forma.parts) + [len(forma.points)]
    poligoni = []
    for a, b in zip(confini[:-1], confini[1:]):
        anello = semplifica(forma.points[a:b], tolleranza)
        coords = [[round(v, 6) for v in utm32_a_wgs84(x, y)] for x, y in anello]
        # In uno shapefile gli anelli esterni sono in senso orario, i buchi antiorari.
        area = sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(anello, anello[1:]))
        if area <= 0 or not poligoni:
            poligoni.append([coords])
        else:
            poligoni[-1].append(coords)
    return poligoni


# --- Dati ISTAT ----------------------------------------------------------------

def scarica(url, cartella):
    destinazione = cartella / url.rsplit("/", 1)[-1]
    print(f"Scarico {url}", file=sys.stderr)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=600) as r, open(destinazione, "wb") as f:
        while blocco := r.read(1 << 20):
            f.write(blocco)
    return destinazione


def colonne_epoca(archivio):
    """Trova nel tracciato record le colonne delle epoche di costruzione."""
    for nome in archivio.namelist():
        if "tracciato" in nome.lower() and nome.lower().endswith((".csv", ".txt")):
            testo = archivio.read(nome).decode("latin-1")
            righe = [r for r in csv.reader(io.StringIO(testo), delimiter=";") if len(r) >= 2]
            trovate = []
            for _, _, modello in EPOCHE:
                riga = next((r for r in righe if re.search(modello, r[1], re.I)
                             and re.search(r"edific", r[1], re.I)), None)
                if not riga:
                    break
                trovate.append(riga[0].strip())
            if len(trovate) == len(EPOCHE):
                print(f"Colonne epoca dal tracciato {nome}: {trovate}", file=sys.stderr)
                return trovate
    print(f"Tracciato non trovato: uso {COLONNE_DEFAULT}", file=sys.stderr)
    return COLONNE_DEFAULT


def leggi_variabili(percorso_zip):
    with zipfile.ZipFile(percorso_zip) as z:
        colonne = colonne_epoca(z)
        nome = next(n for n in z.namelist() if re.search(r"R08_indicatori_2011_sezioni\.csv$", n, re.I))
        testo = z.read(nome).decode("latin-1")
    dati = {}
    for riga in csv.DictReader(io.StringIO(testo), delimiter=";"):
        if int(riga["PROCOM"]) != PROCOM_RAVENNA:
            continue
        dati[int(riga["SEZ2011"])] = [int(float(riga[c] or 0)) for c in colonne]
    return dati


def leggi_sezioni(percorso_zip, cartella):
    with zipfile.ZipFile(percorso_zip) as z:
        z.extractall(cartella)
    shp = next(cartella.rglob("R08_11_WGS84.shp"))
    lettore = shapefile.Reader(str(shp), encoding="latin-1")
    campi = [f[0] for f in lettore.fields[1:]]
    for rec in lettore.iterShapeRecords():
        attr = dict(zip(campi, rec.record))
        if int(attr["PRO_COM"]) == PROCOM_RAVENNA:
            yield int(attr["SEZ2011"]), rec.shape


def proprieta(conteggi):
    totale = sum(conteggi)
    if totale == 0:
        return None
    anno_medio = sum(n * anno for n, (_, anno, _) in zip(conteggi, EPOCHE)) / totale
    prevalente = EPOCHE[max(range(len(conteggi)), key=conteggi.__getitem__)][0]
    pre1961 = sum(conteggi[:3]) / totale
    tra61e90 = sum(conteggi[3:6]) / totale
    return {
        "edifici": totale,
        "anno_medio": round(anno_medio),
        "epoca_prevalente": prevalente,
        "quota_pre1961": round(pre1961, 3),
        "quota_1961_1990": round(tra61e90, 3),
        "epoche": dict(zip((e[0] for e in EPOCHE), conteggi)),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--basi", help="zip delle basi territoriali già scaricato")
    ap.add_argument("--dati", help="zip delle variabili censuarie già scaricato")
    ap.add_argument("--tolleranza", type=float, default=4.0, help="semplificazione in metri")
    ap.add_argument("--output", type=Path, default=USCITA)
    args = ap.parse_args()

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        basi = Path(args.basi) if args.basi else scarica(URL_BASI, tmp)
        dati = Path(args.dati) if args.dati else scarica(URL_DATI, tmp)
        variabili = leggi_variabili(dati)
        features = []
        for sez, forma in leggi_sezioni(basi, tmp / "basi"):
            props = proprieta(variabili.get(sez, []))
            if not props:
                continue  # sezioni senza edifici residenziali: campi, aree industriali, acque
            features.append({
                "type": "Feature",
                "geometry": {"type": "MultiPolygon", "coordinates": anelli_in_poligoni(forma, args.tolleranza)},
                "properties": {"sez2011": sez, **props},
            })

    if not features:
        raise SystemExit("Nessuna sezione di Ravenna trovata: controllare i file ISTAT")
    fc = {
        "type": "FeatureCollection",
        "metadata": {
            "fonte": "ISTAT, Censimento 2011: basi territoriali e variabili per sezione di censimento",
            "licenza": "CC BY 4.0",
            "metodo": "Anno medio di costruzione degli edifici residenziali come stima dell'età della rete di distribuzione",
        },
        "features": features,
    }
    args.output.write_text(json.dumps(fc, ensure_ascii=False, separators=(",", ":")))
    print(f"Salvate {len(features)} sezioni in {args.output} ({args.output.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
