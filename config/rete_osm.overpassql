/*
  Rete idrica del Comune di Ravenna da OpenStreetMap.
  Usata sia dal visualizzatore (query live) sia da scripts/scarica_rete_osm.py.
*/
[out:json][timeout:120];
area["boundary"="administrative"]["admin_level"="8"]["name"="Ravenna"]->.a;
(
  nwr["man_made"~"^(water_tower|water_works|reservoir_covered|water_well)$"](area.a);
  nwr["man_made"="storage_tank"]["content"="water"](area.a);
  nwr["man_made"="pumping_station"](area.a);
  nwr["man_made"="wastewater_plant"](area.a);
  nwr["landuse"="reservoir"]["reservoir_type"="water_storage"](area.a);
);
out center tags;
way["man_made"="pipeline"]["substance"~"water"](area.a);
out geom tags;
node["amenity"~"^(drinking_water|water_point)$"](area.a);
out body;
node["emergency"="fire_hydrant"](area.a);
out body;
