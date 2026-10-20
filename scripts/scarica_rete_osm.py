#!/usr/bin/env python3
"""Scarica la rete idrica del Comune di Ravenna da OpenStreetMap (Overpass API)
e la salva come GeoJSON in data/rete_osm.geojson.

Usa la stessa query del visualizzatore (config/rete_osm.overpassql).
Solo libreria standard.
"""
import argparse
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

RADICE = Path(__file__).resolve().parent.parent
QUERY = RADICE / "config" / "rete_osm.overpassql"
USCITA = RADICE / "data" / "rete_osm.geojson"
USER_AGENT = "reteidricaravenna/1.0 (+https://github.com/amgrg/reteidricaravenna)"
ENDPOINT = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]


def categoria(tags):
    if tags.get("man_made") == "pipeline":
        return "condotta"
    if tags.get("amenity") in ("drinking_water", "water_point"):
        return "fontanella"
    if tags.get("emergency") == "fire_hydrant":
        return "idrante"
    return "impianto"


def overpass_to_geojson(dati):
    features = []
    for el in dati.get("elements", []):
        tags = el.get("tags", {})
        if el["type"] == "node":
            geom = {"type": "Point", "coordinates": [el["lon"], el["lat"]]}
        elif "geometry" in el and tags.get("man_made") == "pipeline":
            geom = {"type": "LineString", "coordinates": [[p["lon"], p["lat"]] for p in el["geometry"]]}
        elif "center" in el:
            geom = {"type": "Point", "coordinates": [el["center"]["lon"], el["center"]["lat"]]}
        else:
            continue
        props = {"osm_id": f"{el['type']}/{el['id']}", "categoria": categoria(tags), **tags}
        features.append({"type": "Feature", "geometry": geom, "properties": props})
    return {
        "type": "FeatureCollection",
        "metadata": {"fonte": "OpenStreetMap via Overpass API", "licenza": "ODbL 1.0",
                     "osm_base": dati.get("osm3s", {}).get("timestamp_osm_base")},
        "features": features,
    }


def interroga(query):
    corpo = urllib.parse.urlencode({"data": query}).encode()
    ultimo = None
    for url in ENDPOINT:
        try:
            req = urllib.request.Request(url, data=corpo, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.load(r)
        except Exception as e:  # prova l'endpoint successivo
            ultimo = e
            print(f"Overpass {url} non disponibile: {e}", file=sys.stderr)
    raise SystemExit(f"Nessun endpoint Overpass raggiungibile: {ultimo}")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--output", type=Path, default=USCITA)
    args = ap.parse_args()

    fc = overpass_to_geojson(interroga(QUERY.read_text()))
    conta = {}
    for f in fc["features"]:
        conta[f["properties"]["categoria"]] = conta.get(f["properties"]["categoria"], 0) + 1
    args.output.write_text(json.dumps(fc, ensure_ascii=False, separators=(",", ":")))
    print(f"Salvato {args.output}: {conta}")


if __name__ == "__main__":
    main()
