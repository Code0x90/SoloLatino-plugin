# SoloLatino 1.2.0 — consolidación de fuentes

## Prioridad de resolución y listado

1. **StreamWish**: se lista primero. Prueba HLS4 como principal y pasa a HLS3 y HLS2 si el manifiesto no se puede usar. Expone las variantes detectadas ordenadas por calidad.
2. **VidHide**: se lista después de las variantes StreamWish, usando el extractor conservado y habilitado.

Los dos proveedores de un mismo resultado se mantienen en un solo idioma: **español latino primero**. Si no hay fuentes latinoamericanas o no se consigue resolver ninguna, se intenta **inglés**. Las fuentes en español de España, subtitulado genérico y otros idiomas se ignoran.

## Flujo

`TMDB ID → IMDb ID → Embed69 → selección LAT/ENG → StreamWish HLS4/HLS3/HLS2 + VidHide → deduplicación y orden`

## Verificaciones

La suite `npm test` valida la normalización de idioma, el orden HLS, el análisis de variantes y la combinación StreamWish/VidHide. La reproducción real debe seguir comprobándose en Nuvio/Kino, porque el estado del CDN cambia por enlace y mirror.


## Interruptor de VidHide (v1.2.4)

En `providers/sololatino.js`, cambia `const ENABLE_VIDHIDE = false;` a `true` para habilitar VidHide. En `false`, solo se resuelve StreamWish. HLS4 se mantiene como principal, con HLS3/HLS2 de respaldo.


En la versión 1.2.4 StreamWish solo publica variantes 1080p y 720p. Si un mirror no ofrece ninguna de esas resoluciones, el resolver continúa con el siguiente HLS. VidHide sigue deshabilitado mediante `ENABLE_VIDHIDE = false`.
