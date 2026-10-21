import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import aggiorna_guasti as ag  # noqa: E402
import scarica_rete_osm as osm  # noqa: E402

LOCALITA = json.loads((Path(__file__).resolve().parent.parent / "config" / "fonti_notizie.json").read_text())["localita"]


class TestEstrazione(unittest.TestCase):
    def test_parla_di_guasto(self):
        self.assertTrue(ag.parla_di_guasto("Rottura sulla rete idrica in via Baccarini"))
        self.assertTrue(ag.parla_di_guasto("Tubatura rotta, in tanti senz'acqua"))
        self.assertFalse(ag.parla_di_guasto("Nuovo parcheggio in via Baccarini"))

    def test_estrai_vie(self):
        t = "Dopo il guasto di viale Farini, rottura in piazzetta Anna Magnani e in via dell'Antico Squero a Ravenna"
        self.assertEqual(ag.estrai_vie(t), ["viale Farini", "piazzetta Anna Magnani", "via dell'Antico Squero"])
        self.assertEqual(ag.estrai_vie("Rottura in viale dei Navigatori a Punta Marina"), ["viale dei Navigatori"])
        self.assertEqual(ag.estrai_vie("i tecnici sono in via di ultimazione"), [])
        # Titoli reali del 19-20/10/2026: il nome non prosegue oltre la punteggiatura.
        self.assertEqual(ag.estrai_vie("Ravenna, tubatura rotta: allagato un tratto di via Baccarini. Residenti e attività senz'acqua"),
                         ["via Baccarini"])

    def test_varianti_via(self):
        self.assertEqual(ag.varianti_via("via Baccarini Dove"), ["via Baccarini Dove", "via Baccarini"])
        # Il nome completo viene sempre provato per primo; non si chiude mai su un connettore.
        self.assertEqual(ag.varianti_via("via dell'Antico Squero")[0], "via dell'Antico Squero")
        self.assertEqual(ag.varianti_via("viale dei Navigatori"), ["viale dei Navigatori"])

    def test_localizza_accorcia_la_via(self):
        class GeoFinto:
            def cerca(self, testo):
                return {"lat": 44.41, "lon": 12.2, "nome": "Via Alfredo Baccarini"} if testo == "via Baccarini" else None
        notizia = {"titolo": "Condotta rotta in via Baccarini Dove sono le autobotti", "testo": ""}
        hit, precisione, luogo = ag.localizza(notizia, GeoFinto(), [])
        self.assertEqual((precisione, luogo), ("via", "via Baccarini"))

    def test_estrai_localita(self):
        self.assertEqual(ag.estrai_localita("Guasto a Lido di Classe", LOCALITA), ["Lido di Classe"])
        self.assertEqual(sorted(ag.estrai_localita("Marina Romea e Casalborsetti a secco", LOCALITA)),
                         ["Casalborsetti", "Marina Romea"])

    def test_stima_impatto(self):
        self.assertEqual(ag.stima_impatto("stop all'acqua in tutta l'area urbana"), ("alto", None))
        self.assertEqual(ag.stima_impatto("circa 300 utenze senz'acqua"), ("medio", 300))
        self.assertEqual(ag.stima_impatto("cento famiglie"), ("medio", None))
        self.assertEqual(ag.stima_impatto("1.000 utenze"), ("medio", 1000))
        self.assertEqual(ag.stima_impatto("80 utenze"), ("basso", 80))

    def test_trova_simile(self):
        from datetime import date
        f = {"geometry": {"coordinates": [12.2006782, 44.4122109]},
             "properties": {"data": "2026-10-19", "fonti": [{"url": "https://x/1"}]}}
        self.assertEqual(ag.trova_simile([f], [12.201, 44.4123], date(2026, 10, 20), "https://x/2"), (f, False))
        self.assertEqual(ag.trova_simile([f], [12.30, 44.41], date(2026, 10, 20), "https://x/1"), (f, True))
        self.assertEqual(ag.trova_simile([f], [12.30, 44.41], date(2026, 10, 20), "https://x/3"), (None, False))


class TestOverpass(unittest.TestCase):
    def test_conversione(self):
        dati = {"elements": [
            {"type": "node", "id": 1, "lat": 44.4, "lon": 12.2, "tags": {"emergency": "fire_hydrant"}},
            {"type": "way", "id": 2, "center": {"lat": 44.5, "lon": 12.1}, "tags": {"man_made": "water_tower"}},
            {"type": "way", "id": 3, "geometry": [{"lat": 44.4, "lon": 12.2}, {"lat": 44.41, "lon": 12.21}],
             "tags": {"man_made": "pipeline", "substance": "water"}},
        ]}
        fc = osm.overpass_to_geojson(dati)
        cat = [f["properties"]["categoria"] for f in fc["features"]]
        self.assertEqual(cat, ["idrante", "impianto", "condotta"])
        self.assertEqual(fc["features"][2]["geometry"]["type"], "LineString")


class TestDati(unittest.TestCase):
    def test_guasti_validi(self):
        fc = json.loads((Path(__file__).resolve().parent.parent / "data" / "guasti.geojson").read_text())
        ids = set()
        for f in fc["features"]:
            p = f["properties"]
            lon, lat = f["geometry"]["coordinates"]
            self.assertTrue(11.95 < lon < 12.40 and 44.25 < lat < 44.62, p["id"])
            self.assertIn(p["impatto"], {"alto", "medio", "basso"})
            self.assertIn(p["precisione"], {"indirizzo", "incrocio", "via", "localita", "area"})
            self.assertTrue(p["fonti"], p["id"])
            self.assertNotIn(p["id"], ids)
            ids.add(p["id"])


if __name__ == "__main__":
    unittest.main()
