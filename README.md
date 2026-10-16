# SoloLatino para Nuvio — v1.0.6

Proveedor para películas y series que resuelve el identificador de IMDb mediante TMDB y obtiene playlists HLS de VidHide desde la ruta directa de Embed69. **Solo procesa VidHide**; los demás servidores se ignoran. No usa `kino.browser.capture`.

## Flujo

`TMDB ID → IMDb ID → https://embed69.org/f/{slug} → VidHide → playlist HLS`

Para películas se usa el IMDb ID (`/f/tt...`). Para series se usa `{imdbId}-{temporada}x{episodio con dos dígitos}`, por ejemplo `tt1234567-2x03`.

## Mejoras en v1.0.6

- Eliminada toda la implementación auxiliar de servidores que no sean VidHide.
- Consultas de páginas VidHide en paralelo, conservando el orden de los resultados y eliminando URLs duplicadas.
- Resolución del challenge de Embed69 más eficiente al reutilizar el hash del prefijo cuando la implementación de CryptoJS admite clonación incremental.
- Caché de metadatos TMDB en memoria por 10 minutos, limitada a 200 entradas, para evitar peticiones repetidas en consultas cercanas.
- Validación de temporada y episodio antes de hacer peticiones de red.
- Añadidas pruebas offline para películas, series, selección de idioma, deduplicación, errores, caché y concurrencia.

## Archivos

- `manifest.json`: manifiesto del plugin de Nuvio.
- `providers/sololatino.js`: exporta `getStreams(tmdbId, mediaType, season, episode)`.
- `tests/test-provider.js`: suite local offline con respuestas de red simuladas y cifrado AES de prueba.

## Dependencias

Nuvio debe proporcionar `fetch`; el plugin usa `crypto-js`. Para ejecutar la suite local se necesita Node.js 18 o posterior. Los tests interceptan las peticiones y **no necesitan acceso a TMDB ni Embed69**.

## Pruebas

```sh
npm install
npm test
npm run test:functionality
npm run test:perf
```

La suite offline valida el flujo del proveedor, incluyendo la decodificación de los enlaces de prueba, pero no puede confirmar que los HTML reales de TMDB/Embed69 sigan iguales. Para esa comprobación se requiere una prueba en vivo desde un entorno con conexión, sin incluir claves privadas en los logs.

## Streams devueltos

Cada resultado usa `title: ""`, `type: "hls"` y la siguiente estructura en `quality`:

```text
📺 VidHide
Auto | WEB-DL | Película o Serie
🇲🇽 Latino
```

El idioma prioriza `LAT`, luego `ESP` y finalmente `SUB`. La calidad se etiqueta `Auto` porque no se inspeccionan todas las variantes de la playlist.

## Nota sobre la clave TMDB

La clave TMDB actual está incrustada en el JavaScript del plugin. Cualquier persona con acceso al código publicado puede leerla; si se publica el repositorio, usa una clave restringida y considera rotarla.
