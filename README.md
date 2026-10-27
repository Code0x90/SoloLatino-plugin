# SoloLatino 1.0.9

Versión de diagnóstico para probar exclusivamente StreamWish en Nuvio/Kino. VidHide está deshabilitado temporalmente desde `ENABLE_VIDHIDE = false`; su extractor y lógica se conservan en el código, sin modificarlos.

## Flujo

`TMDB ID → IMDb ID → Embed69 → páginas StreamWish → manifiesto HLS`

## Nota de prueba

Esta versión omite las fuentes VidHide para que el reproductor no las seleccione durante las pruebas. Cuando se termine el diagnóstico, se puede reactivar cambiando `ENABLE_VIDHIDE` a `true`. La reproducción de StreamWish debe verificarse en Nuvio/Kino con enlaces reales.
