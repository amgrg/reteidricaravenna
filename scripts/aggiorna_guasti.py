#!/usr/bin/env python3
"""Cerca nelle notizie online i guasti alla rete idrica di Ravenna, li
geolocalizza con Nominatim (OpenStreetMap) e li aggiunge a data/guasti.geojson.

Fonti: Google News RSS (query in config/fonti_notizie.json) e feed RSS extra.
I guasti trovati in automatico hanno origine "auto" e stato "da verificare":
la posizione è quella della via o località citata, non il punto della rottura.

Solo libreria standard. Esempi:
    python3 scripts/aggiorna_guasti.py --dry-run
    python3 scripts/aggiorna_guasti.py --giorni 30
"""
import argparse
import html
import json
import math
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

RADICE = Path(__file__).resolve().parent.parent
GUASTI = RADICE / "data" / "guasti.geojson"
CACHE_GEO = RADICE / "data" / "geocache.json"
CONFIG = RADICE / "config" / "fonti_notizie.json"
USER_AGENT = "reteidricaravenna/1.0 (+https://github.com/amgrg/reteidricaravenna)"
# Riquadro del Comune di Ravenna (lon_min, lat_max, lon_max, lat_min) per Nominatim.
VIEWBOX = "11.95,44.62,12.40,44.25"

RE_ACQUA = re.compile(r"\b(acqua|idric[ao]|idrich[ei]|acquedott\w*|tubatur\w*|tubazion\w*|condott[ae])\b", re.I)
RE_GUASTO = re.compile(
    r"\b(guast\w*|rottur\w*|rott[ao]|perdit\w*|senz['’ ]acqua|a secco|interruzion\w*|"
    r"allagat\w*|falla|cali di pressione|autobott\w*)\b", re.I)
RE_PROGRAMMATO = re.compile(r"\b(lavori programmati|interruzione programmata|manutenzione programmata)\b", re.I)
PREFISSI = r"via|viale|piazza|piazzetta|piazzale|largo|vicolo|corso|circonvallazione|strada|borgo"
CONNETTORI = {"di", "del", "della", "dello", "dei", "degli", "delle", "da", "san", "santa", "sant'", "e"}
RE_UTENZE = re.compile(r"(\d{1,3}(?:[.\s]\d{3})*|\d+)\s+(?:utenze|famiglie|abitazioni|utenti)", re.I)
RE_CITTA = re.compile(r"\b(tutta la città|intera città|tutta l['’]area urbana|gran parte della città|"
                      r"centro storico senz|mezza città)\b", re.I)


# --- Testo -------------------------------------------------------------------

def pulisci(testo):
    testo = re.sub(r"<[^>]+>", " ", testo or "")
    return re.sub(r"\s+", " ", html.unescape(testo)).strip()


def slug(testo):
    testo = unicodedata.normalize("NFKD", testo).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", testo.lower()).strip("-")[:60]


def parla_di_guasto(testo):
    return bool(RE_ACQUA.search(testo) and RE_GUASTO.search(testo))


def estrai_vie(testo):
    """Restituisce le vie/piazze citate, es. 'via Baccarini', 'viale dei Navigatori'."""
    risultati = []
    for m in re.finditer(rf"\b({PREFISSI})\s+", testo, re.I):
        parole = []
        for tok in re.findall(r"[\wÀ-ÿ'’]+", testo[m.end():m.end() + 80]):
            t = tok.replace("’", "'")
            if t[:1].isupper() or t[:1].isdigit():
                parole.append(t)
            elif t.lower() in CONNETTORI or re.fullmatch(r"(dell|d|sant|all)'\w*", t.lower()):
                parole.append(t)
            else:
                break
            if len(parole) >= 5:
                break
        while parole and parole[-1].lower() in CONNETTORI:
            parole.pop()
        if parole and any(p[:1].isupper() or p[:1].isdigit() for p in parole):
            via = f"{m.group(1).lower()} {' '.join(parole)}"
            if via not in risultati:
                risultati.append(via)
    return risultati


def estrai_localita(testo, localita):
    trovate = [l for l in localita if re.search(rf"\b{re.escape(l)}\b", testo, re.I)]
    # Tiene la più specifica: "Lido di Classe" assorbe "Classe".
    return [l for l in trovate if not any(l != a and l in a for a in trovate)]


def stima_impatto(testo):
    if RE_CITTA.search(testo):
        return "alto", None
    m = RE_UTENZE.search(testo)
    utenze = int(re.sub(r"\D", "", m.group(1))) if m else None
    if utenze is None:
        return "medio", None
    if utenze >= 2000:
        return "alto", utenze
    return ("medio" if utenze >= 200 else "basso"), utenze


# --- Rete --------------------------------------------------------------------

def scarica(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Language": "it"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def leggi_feed(url):
    radice = ET.fromstring(scarica(url))
    for item in radice.iter("item"):
        data = item.findtext("pubDate")
        try:
            quando = parsedate_to_datetime(data) if data else None
        except (TypeError, ValueError):
            quando = None
        fonte = item.find("source")
        yield {
            "titolo": pulisci(item.findtext("title")),
            "url": (item.findtext("link") or "").strip(),
            "testo": pulisci(item.findtext("description")),
            "data": quando,
            "testata": fonte.text if fonte is not None else None,
        }


def url_google_news(query):
    q = urllib.parse.quote(f"{query} when:30d")
    return f"https://news.google.com/rss/search?q={q}&hl=it&gl=IT&ceid=IT:it"


class Geocoder:
    """Nominatim con cache su file e al massimo una richiesta al secondo."""

    def __init__(self, percorso):
        self.percorso = percorso
        self.cache = json.loads(percorso.read_text()) if percorso.exists() else {}
        self.ultima = 0.0

    def cerca(self, testo):
        chiave = testo.lower()
        if chiave in self.cache:
            return self.cache[chiave]
        attesa = 1.1 - (time.monotonic() - self.ultima)
        if attesa > 0:
            time.sleep(attesa)
        params = urllib.parse.urlencode({
            "q": f"{testo}, Ravenna", "format": "jsonv2", "limit": 1,
            "countrycodes": "it", "viewbox": VIEWBOX, "bounded": 1,
        })
        try:
            risultati = json.loads(scarica(f"https://nominatim.openstreetmap.org/search?{params}"))
        except Exception as e:
            print(f"  geocodifica fallita per {testo!r}: {e}", file=sys.stderr)
            return None
        finally:
            self.ultima = time.monotonic()
        hit = risultati[0] if risultati else None
        valore = None
        if hit:
            valore = {"lat": float(hit["lat"]), "lon": float(hit["lon"]),
                      "nome": hit.get("name") or testo, "indirizzo": hit.get("display_name"),
                      "tipo": hit.get("addresstype")}
        self.cache[chiave] = valore
        return valore

    def salva(self):
        self.percorso.write_text(json.dumps(self.cache, ensure_ascii=False, indent=1, sort_keys=True))


# --- Logica ------------------------------------------------------------------

def distanza_m(a, b):
    (lon1, lat1), (lon2, lat2) = a, b
    x = math.radians(lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2))
    y = math.radians(lat2 - lat1)
    return 6371000 * math.hypot(x, y)


def localizza(notizia, geo, localita):
    """Prova prima le vie citate, poi le località; restituisce (punto, precisione, luogo)."""
    testo = f"{notizia['titolo']}. {notizia['testo']}"
    vie = estrai_vie(testo)
    loc = estrai_localita(testo, localita)
    for via in vie:
        contesto = f"{via}, {loc[0]}" if loc else via
        hit = geo.cerca(contesto) or (geo.cerca(via) if loc else None)
        if hit:
            return hit, "via", via
    for l in loc:
        hit = geo.cerca(l)
        if hit:
            return hit, "localita", l
    return None, None, None


def trova_simile(features, punto, data, url):
    for f in features:
        p = f["properties"]
        if any(fo.get("url") == url for fo in p.get("fonti", [])):
            return f, True
    for f in features:
        p = f["properties"]
        try:
            giorni = abs((datetime.fromisoformat(p["data"]).date() - data).days)
        except ValueError:
            continue
        if giorni <= 2 and distanza_m(f["geometry"]["coordinates"], punto) < 400:
            return f, False
    return None, False


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--giorni", type=int, default=30, help="considera solo notizie degli ultimi N giorni")
    ap.add_argument("--dry-run", action="store_true", help="mostra i guasti trovati senza salvare")
    args = ap.parse_args()

    config = json.loads(CONFIG.read_text())
    fc = json.loads(GUASTI.read_text())
    geo = Geocoder(CACHE_GEO)
    limite = datetime.now(timezone.utc) - timedelta(days=args.giorni)

    feed = [url_google_news(q) for q in config["google_news_query"]] + config.get("feed_rss", [])
    notizie, visti = [], set()
    for url in feed:
        try:
            for n in leggi_feed(url):
                if n["url"] in visti or (n["data"] and n["data"] < limite):
                    continue
                visti.add(n["url"])
                notizie.append(n)
        except Exception as e:
            print(f"Feed non leggibile {url}: {e}", file=sys.stderr)

    nuovi = aggiornati = 0
    for n in sorted(notizie, key=lambda n: n["data"] or limite):
        testo = f"{n['titolo']}. {n['testo']}"
        if not parla_di_guasto(testo) or RE_PROGRAMMATO.search(testo):
            continue
        if "ravenna" not in testo.lower() and not estrai_localita(testo, config["localita"]):
            continue
        hit, precisione, luogo = localizza(n, geo, config["localita"])
        if not hit:
            print(f"- non localizzata: {n['titolo']}")
            continue
        punto = [round(hit["lon"], 7), round(hit["lat"], 7)]
        data = (n["data"] or datetime.now(timezone.utc)).date()
        fonte = {"titolo": n["titolo"] + (f" ({n['testata']})" if n["testata"] else ""), "url": n["url"]}
        esistente, stessa_url = trova_simile(fc["features"], punto, data, n["url"])
        if stessa_url:
            continue
        if esistente:
            esistente["properties"].setdefault("fonti", []).append(fonte)
            aggiornati += 1
            print(f"+ fonte aggiunta a {esistente['properties']['id']}: {n['titolo']}")
            continue
        impatto, utenze = stima_impatto(testo)
        fc["features"].append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": punto},
            "properties": {
                "id": f"{data.isoformat()}-{slug(luogo)}",
                "titolo": n["titolo"],
                "data": data.isoformat(),
                "localita": ", ".join((hit.get("indirizzo") or "").split(", ")[1:3]),
                "indirizzo": hit["nome"],
                "precisione": precisione,
                "causa": None,
                "materiale": None,
                "utenze": utenze,
                "impatto": impatto,
                "stato": "da verificare",
                "descrizione": n["testo"][:400],
                "origine": "auto",
                "fonti": [fonte],
            },
        })
        nuovi += 1
        print(f"* nuovo guasto {data} @ {luogo} ({precisione}): {n['titolo']}")

    print(f"Notizie lette: {len(notizie)} · nuovi guasti: {nuovi} · fonti aggiunte: {aggiornati}")
    if args.dry_run:
        return
    geo.salva()
    if nuovi or aggiornati:
        fc["features"].sort(key=lambda f: f["properties"]["data"], reverse=True)
        fc.setdefault("metadata", {})["aggiornato"] = datetime.now(timezone.utc).date().isoformat()
        GUASTI.write_text(json.dumps(fc, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
