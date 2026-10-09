# Future ideas

## Contour line overlay

swisstopo has no standalone contour layer in its WMTS or WMS. Contours only exist baked into the
Landeskarten (pixelkarte) or in the vector base map, which is Web Mercator and doesn't fit the LV95
Leaflet setup.

Generate them ourselves from the DEM instead, as an overlay usable on any base map (works especially
well on the relief map):

- e.g. 50 m interval, thicker index line every 250 m
- Crisp at overview zooms; at high zoom the 100 m grid makes them blocky. For smooth lines use
  marching squares (e.g. d3-contour from CDN) on the visible viewport only, recomputed on pan/zoom.
