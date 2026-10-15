# SoloLatino para Nuvio — v1.0.5

Plugin de prueba llamado SoloLatino. Extrae las playlists HLS mediante la ruta directa de Embed69 y devuelve únicamente esa fuente; no usa `kino.browser.capture`. La presentación sigue el formato de AnimeAV1: etiqueta de tres líneas en `quality`, `title` vacío y `type: "hls"`.

## Flujo

`TMDB ID → IMDb ID → https://embed69.org/f/{slug} → SoloLatino → playlist HLS`

Para series, el slug probado por el script es `{imdbId}-{temporada}x{episodio con dos dígitos}`. La ruta directa para películas fue comprobada con TMDB `299536` (Avengers: Infinity War). La ruta directa de series aún debe validarse dentro de Nuvio.

## Archivos

- `manifest.json`: repositorio de plugins de Nuvio.
- `providers/sololatino.js`: proveedor que exporta `getStreams(tmdbId, mediaType, season, episode)`.
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


## Presentación de las fuentes (v1.0.5)

Cada stream devuelve `title: ""` y este formato en `quality`, siguiendo el patrón de AnimeAV1:

```text
📺 VidHide
Auto | WEB-DL | Película o Serie
🇲🇽 Latino
```

La segunda línea muestra `Película` o `Serie` según el contenido. La tercera línea incluye la bandera correspondiente al idioma: `🇲🇽 Latino`, `🇪🇸 Español` o `🌐 Subtitulado`. La calidad se mantiene como `Auto`; no se anuncia 1080p sin haber comprobado la variante de reproducción. Los streams declaran `type: "hls"`.


## Voe (v1.0.5)

Integra el extractor Voe adaptado del método funcional de AnimeAV1: sigue la redirección JavaScript, decodifica el payload JSON y devuelve la URL HLS con sus cabeceras. Los errores de Voe no impiden devolver los streams de Vidhide.
