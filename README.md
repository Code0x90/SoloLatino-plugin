# SoloLatino Vidhide para Nuvio

Plugin de prueba que solo devuelve fuentes Vidhide. No usa `kino.browser.capture` ni devuelve Principal, StreamWish o Voe.

## Flujo

`TMDB ID → IMDb ID → https://embed69.org/f/{slug} → Vidhide → playlist HLS`

Para series, el slug probado por el script es `{imdbId}-{temporada}x{episodio con dos dígitos}`. La ruta directa para películas fue comprobada con TMDB `299536` (Avengers: Infinity War). La ruta directa de series aún debe validarse dentro de Nuvio.

## Archivos

- `manifest.json`: repositorio de plugins de Nuvio.
- `providers/sololatino-vidhide.js`: proveedor que exporta `getStreams(tmdbId, mediaType, season, episode)`.
- `tests/test-provider.js`: prueba local opcional con Node.js.

## Dependencia del runtime

Nuvio debe proporcionar `crypto-js` y `fetch`, según el entorno habitual de plugins. El proveedor no usa `Buffer`, módulos nativos de Node ni `kino.browser.capture`.

## Prueba local

En Node.js, instala la dependencia de prueba:

```sh
npm install
node tests/test-provider.js movie 299536
node tests/test-provider.js tv TMDB_ID 1 1
```

La prueba solicita directamente el flujo de red y puede fallar si Embed69 cambia su HTML, si el identificador directo no existe o si la URL temporal deja de estar disponible.

## Instalación

Publica `manifest.json` y la carpeta `providers/` en un repositorio público. En Nuvio, agrega la URL RAW del `manifest.json` desde la sección de repositorios/plugins.

## Nota sobre TMDB

La clave TMDB proporcionada está incrustada para esta prueba solicitada. Al ser parte del JavaScript descargable, cualquiera que tenga acceso al código podrá verla; si se publica el repositorio, considera rotarla y moverla a ajustes del plugin cuando la prueba inicial termine.
