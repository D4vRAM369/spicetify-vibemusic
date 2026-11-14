# Contribuir a Vibemusic

¡Gracias por querer ayudar! Vibemusic es un único archivo JavaScript (`vibemusic.js`) sin paso de compilación ni dependencias.

## Cómo trabajar

1. Haz un fork y clona tu copia.
2. Enlaza el archivo a tu carpeta de extensiones para ver los cambios al momento:

   ```bash
   ln -s "$PWD/vibemusic.js" "$(spicetify path userdata)/Extensions/vibemusic.js"   # Linux/macOS
   spicetify config extensions vibemusic.js
   spicetify apply
   ```

   Tras cada cambio: `spicetify refresh -e` y recarga Spotify con Ctrl+R (consola de desarrollo: Ctrl+Shift+I).
3. Ejecuta las pruebas, que no necesitan Spotify:

   ```bash
   node --test
   ```

## Normas

- **Lógica nueva = función pura con prueba.** Las funciones de `Match` y similares se exportan en Node (ver el final del bloque de funciones puras) y se prueban en `test/`.
- **Nunca insertes texto externo como HTML.** Lo que viene de la IA o de Spotify se pinta con `textContent`/`createElement`, nunca con `innerHTML`.
- **APIs internas de Spotify:** protégelas con `?.` y `try/catch`, y anota en un comentario en qué versión de Spotify/Spicetify las verificaste.
- **Privacidad:** las playlists se crean privadas. No añadas nada que publique datos del usuario sin que lo elija.
- Cambios pequeños y enfocados, con una descripción clara de qué problema resuelven.

## Reportar errores

Usa la [plantilla de error](https://github.com/D4vRAM369/spicetify-vibemusic/issues/new/choose) e incluye tu versión de Spotify y Spicetify, el sistema operativo y lo que muestra la consola (`Ctrl+Shift+I`, filtra por `Vibemusic`). **No pegues nunca tus claves de API.**
