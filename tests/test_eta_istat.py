import csv
import io
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
try:
    import shapefile  # noqa: F401
    import scarica_eta_istat as eta
except ImportError:  # pyshp non installato
    eta = None


@unittest.skipIf(eta is None, "pyshp non installato")
class TestEtaIstat(unittest.TestCase):
    def test_proiezione(self):
        # Valori di riferimento calcolati con pyproj (EPSG:32632 -> EPSG:4326).
        for (x, y), (lon, lat) in {
            (757300.0, 4922300.0): (12.2314693, 44.4082678),
            (500000.0, 5000000.0): (9.0, 45.1534772),
        }.items():
            lo, la = eta.utm32_a_wgs84(x, y)
            self.assertAlmostEqual(lo, lon, places=6)
            self.assertAlmostEqual(la, lat, places=6)

    def test_proprieta(self):
        p = eta.proprieta([10, 0, 0, 0, 0, 0, 0, 0, 10])
        self.assertEqual(p["edifici"], 20)
        self.assertEqual(p["anno_medio"], round((1905 + 2008) / 2))
        self.assertEqual(p["quota_pre1961"], 0.5)
        self.assertIsNone(eta.proprieta([0] * 9))

    def test_semplifica(self):
        linea = [(0, 0), (1, 0.01), (2, 0), (2, 2), (0, 2), (0, 0)]
        self.assertEqual(eta.semplifica(linea, 0.5), [(0, 0), (2, 0), (2, 2), (0, 2), (0, 0)])

    def test_pipeline(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            w = shapefile.Writer(str(tmp / "R08_11_WGS84"), shapeType=shapefile.POLYGON)
            w.field("PRO_COM", "N", 6)
            w.field("SEZ2011", "N", 15)
            quadrato = [[(757000, 4922000), (757000, 4922200), (757200, 4922200), (757200, 4922000), (757000, 4922000)]]
            for procom, sez in [(39014, 390140000001), (39014, 390140000002), (39001, 390010000001)]:
                w.poly(quadrato)
                w.record(procom, sez)
            w.close()
            basi = tmp / "basi.zip"
            with zipfile.ZipFile(basi, "w") as z:
                for ext in ("shp", "shx", "dbf"):
                    z.write(tmp / f"R08_11_WGS84.{ext}", f"R08_11_WGS84/R08_11_WGS84.{ext}")

            descrizioni = ["Edifici ad uso residenziale costruiti prima del 1919",
                           "Edifici ad uso residenziale costruiti dal 1919 al 1945",
                           "Edifici ad uso residenziale costruiti dal 1946 al 1960",
                           "Edifici ad uso residenziale costruiti dal 1961 al 1970",
                           "Edifici ad uso residenziale costruiti dal 1971 al 1980",
                           "Edifici ad uso residenziale costruiti dal 1981 al 1990",
                           "Edifici ad uso residenziale costruiti dal 1991 al 2000",
                           "Edifici ad uso residenziale costruiti dal 2001 al 2005",
                           "Edifici ad uso residenziale costruiti dopo il 2005"]
            trac = "CODICE;DEFINIZIONE\nP1;Popolazione residente - totale\n" + \
                "".join(f"X{i};{d}\n" for i, d in enumerate(descrizioni))
            buf = io.StringIO()
            cw = csv.writer(buf, delimiter=";")
            cw.writerow(["PROCOM", "SEZ2011"] + [f"X{i}" for i in range(9)])
            cw.writerow([39014, 390140000001, 5, 5, 0, 0, 0, 0, 0, 0, 0])
            cw.writerow([39014, 390140000002, 0, 0, 0, 0, 0, 0, 0, 0, 0])
            cw.writerow([39001, 390010000001, 1, 0, 0, 0, 0, 0, 0, 0, 0])
            dati = tmp / "dati.zip"
            with zipfile.ZipFile(dati, "w") as z:
                z.writestr("tracciato_2011_sezioni.csv", trac.encode("latin-1"))
                z.writestr("Sezioni di Censimento/R08_indicatori_2011_sezioni.csv", buf.getvalue().encode("latin-1"))

            out = tmp / "eta.geojson"
            sys.argv = ["x", "--basi", str(basi), "--dati", str(dati), "--output", str(out)]
            eta.main()
            fc = json.loads(out.read_text())
            self.assertEqual(len(fc["features"]), 1)
            f = fc["features"][0]
            self.assertEqual(f["properties"]["sez2011"], 390140000001)
            self.assertEqual(f["properties"]["anno_medio"], round((1905 + 1932) / 2))
            lon, lat = f["geometry"]["coordinates"][0][0][0]
            self.assertTrue(12.1 < lon < 12.3 and 44.3 < lat < 44.5)


if __name__ == "__main__":
    unittest.main()
