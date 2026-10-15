/*
 * SoloLatino provider for Nuvio
 * Flow: TMDB ID -> IMDb ID -> Embed69 direct route -> Vidhide -> HLS
 * Runtime dependencies provided by Nuvio: fetch, require('crypto-js')
 */

const CryptoJS = require('crypto-js');

const PROVIDER_NAME = 'SoloLatino';
const TMDB_API_KEY = '56db0ec297530920213e1503706b81ff';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const EMBED69_BASE = 'https://embed69.org';
const EMBED69_REFERER = 'https://embed69.org/';
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';

function log(message) {
  console.log('[SoloLatino] ' + message);
}

function safeUrl(value) {
  try {
    const match = String(value || '').match(/^(https?:\/\/[^/]+)(\/[^?#]*)?/i);
    return match ? match[1] + (match[2] || '') : String(value || '');
  } catch (_) {
    return String(value || '');
  }
}

function fetchText(url, headers) {
  return fetch(url, {
    method: 'GET',
    headers: Object.assign({
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8'
    }, headers || {})
  }).then(function (response) {
    return response.text().then(function (text) {
      if (!response.ok) throw new Error('HTTP ' + response.status + ' en ' + safeUrl(url));
      return { response: response, text: text };
    });
  });
}

function fetchJson(url) {
  return fetch(url, {
    method: 'GET',
    headers: { 'User-Agent': UA, 'Accept': 'application/json' }
  }).then(function (response) {
    return response.text().then(function (text) {
      var data;
      try { data = JSON.parse(text); } catch (_) { data = {}; }
      if (!response.ok) {
        throw new Error('TMDB HTTP ' + response.status + (data.status_message ? ': ' + data.status_message : ''));
      }
      return data;
    });
  });
}

function resolveTmdb(tmdbId, mediaType) {
  var type = mediaType === 'movie' ? 'movie' : 'tv';
  var base = TMDB_BASE + '/' + type + '/' + encodeURIComponent(String(tmdbId));
  var key = '?api_key=' + encodeURIComponent(TMDB_API_KEY);
  return Promise.all([
    fetchJson(base + key),
    fetchJson(base + '/external_ids' + key)
  ]).then(function (results) {
    var details = results[0] || {};
    var external = results[1] || {};
    var imdbId = external.imdb_id;
    if (!imdbId || !/^tt\d+$/.test(imdbId)) {
      throw new Error('TMDB no devolvió un IMDb ID válido para ' + type + ' ' + tmdbId);
    }
    return {
      imdbId: imdbId,
      title: details.title || details.name || 'Título desconocido',
      year: String(details.release_date || details.first_air_date || '').slice(0, 4)
    };
  });
}

function buildSlug(imdbId, mediaType, season, episode) {
  if (mediaType === 'movie') return imdbId;
  var s = Number(season);
  var e = Number(episode);
  if (!Number.isInteger(s) || s < 0 || !Number.isInteger(e) || e < 1) {
    throw new Error('Temporada y episodio son obligatorios para series.');
  }
  return imdbId + '-' + s + 'x' + String(e).padStart(2, '0');
}

function utf8ToHex(value) {
  return CryptoJS.enc.Utf8.parse(value).toString(CryptoJS.enc.Hex);
}

function normalizedKeyHex(keyHex) {
  var byteLength = keyHex.length / 2;
  if (byteLength === 16 || byteLength === 24 || byteLength === 32) return keyHex;
  return (keyHex + '0'.repeat(64)).slice(0, 64);
}

function decryptLink(encoded, keyHex) {
  try {
    var clean = String(encoded || '').replace(/[^A-Za-z0-9+/=]/g, '');
    var allHex = CryptoJS.enc.Base64.parse(clean).toString(CryptoJS.enc.Hex);
    if (allHex.length < 64 || allHex.length % 32 !== 0) return null;
    var iv = CryptoJS.enc.Hex.parse(allHex.slice(0, 32));
    var ciphertext = CryptoJS.enc.Hex.parse(allHex.slice(32));
    var key = CryptoJS.enc.Hex.parse(normalizedKeyHex(keyHex));
    var decrypted = CryptoJS.AES.decrypt(
      { ciphertext: ciphertext },
      key,
      { iv: iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }
    ).toString(CryptoJS.enc.Utf8).trim();
    return /^https?:\/\//i.test(decrypted) ? decrypted : null;
  } catch (_) {
    return null;
  }
}

function solvePow(challenge, difficulty, salt) {
  var zeros = '0'.repeat(Math.min(Number(difficulty) || 0, 64));
  // Keep a finite cap to avoid monopolizing Nuvio's JS runtime.
  for (var nonce = 0; nonce < 2000000; nonce++) {
    var candidate = challenge + nonce;
    if (CryptoJS.SHA256(candidate).toString().indexOf(zeros) === 0) {
      return salt ? CryptoJS.SHA256(candidate + salt).toString() : null;
    }
  }
  return null;
}

function extractEmbed69Sources(html) {
  var keyHex = null;
  var inlineKey = /decryptLink\(server\.link,\s*'(.+?)'\),/.exec(html);
  if (inlineKey) keyHex = utf8ToHex(inlineKey[1]);

  if (!keyHex) {
    var pow = /POW_CHALLENGE\s*=\s*'([^']+)';[\s\S]*?POW_DIFFICULTY\s*=\s*(\d+);[\s\S]*?POW_SALT\s*=\s*'([^']+)';/.exec(html);
    if (pow) keyHex = solvePow(pow[1], Number(pow[2]), pow[3]);
  }

  var dataMatch = /dataLink\s*=\s*(\[[\s\S]*?\])\s*;/.exec(html) || /dataLink\s*=\s*([^;]+)/.exec(html);
  if (!dataMatch) throw new Error('Embed69 no contiene dataLink.');
  if (!keyHex) throw new Error('No se encontró la clave de Embed69.');

  var data;
  try { data = JSON.parse(dataMatch[1].replace(/\\\//g, '/')); }
  catch (_) { throw new Error('No se pudo interpretar dataLink de Embed69.'); }

  var sources = [];
  (Array.isArray(data) ? data : []).forEach(function (section) {
    var lang = section && section.video_language ? String(section.video_language) : 'LAT';
    (section && Array.isArray(section.sortedEmbeds) ? section.sortedEmbeds : []).forEach(function (item) {
      if (!item || item.servername === 'download') return;
      var url = decryptLink(item.link, keyHex);
      if (url) {
        var server = String(item.servername || url.replace(/^https?:\/\//, '').split('/')[0]).toLowerCase();
        sources.push({ lang: lang, server: server, url: url });
      }
    });
  });
  return sources;
}

function unpackPacked(html) {
  var output = [];
  var regex = /\}\('((?:[^'\\]|\\.)*)',\s*(\d+),\s*(\d+),\s*'((?:[^'\\]|\\.)*)'\.split\('\|'\)/g;
  var match;
  while ((match = regex.exec(String(html || '')))) {
    var radix = parseInt(match[2], 10);
    var count = parseInt(match[3], 10);
    var words = match[4].split('|');
    var payload = match[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    if (!(radix >= 2 && radix <= 62) || count > 50000) continue;
    function encode(number) {
      var quotient = Math.floor(number / radix);
      var remainder = number % radix;
      var prefix = number < radix ? '' : encode(quotient);
      return prefix + (remainder > 35 ? String.fromCharCode(remainder + 29) : remainder.toString(36));
    }
    var dict = Object.create(null);
    while (count--) dict[encode(count)] = words[count] || encode(count);
    output.push(payload.replace(/\b\w+\b/g, function (word) {
      return Object.prototype.hasOwnProperty.call(dict, word) ? dict[word] : word;
    }));
  }
  return output.join('\n');
}

function extractPlaylists(html, pageUrl) {
  var source = String(html || '') + '\n' + unpackPacked(html);
  var playlists = [];
  function add(value) {
    if (typeof value !== 'string') return;
    var url = value.replace(/\\\//g, '/').trim();
    if (url.charAt(0) === '/' && url.slice(0, 2) !== '//') {
      url = 'https://morencius.com' + url;
    }
    if (/^https:\/\//i.test(url) && /\.m3u8(?:\?|$)/i.test(url) && playlists.indexOf(url) < 0) {
      playlists.push(url);
    }
  }
  var links = /links\s*=\s*(\{[^{}]*\})/.exec(source);
  if (links) {
    try {
      var config = JSON.parse(links[1]);
      ['hls4', 'hls2', 'hls3'].forEach(function (key) { add(config[key]); });
    } catch (_) {}
  }
  var fileRegex = /(?:file|src)\s*:\s*["']([^"']+)\s*["']/g;
  var match;
  while ((match = fileRegex.exec(source))) add(match[1]);
  return playlists;
}


// Extractor Voe adaptado del método funcional de AnimeAV1 1.2.5.
var VOE_MARKERS = ['@$', '^^', '~@', '%?', '*~', '!!', '#&'];

function voeRot13(value) {
  return String(value || '').replace(/[a-zA-Z]/g, function (char) {
    var code = char.charCodeAt(0);
    var base = code <= 90 ? 65 : 97;
    return String.fromCharCode((code - base + 13) % 26 + base);
  });
}

function voeReplaceMarkers(value) {
  var output = String(value || '');
  VOE_MARKERS.forEach(function (marker) {
    output = output.split(marker).join('_');
  });
  return output;
}

function decodeVoePayload(rawValue) {
  var value = voeRot13(rawValue);
  value = voeReplaceMarkers(value).split('_').join('');
  value = atob(value);
  value = Array.from(value).map(function (char) {
    return String.fromCharCode((char.charCodeAt(0) - 3 + 256) % 256);
  }).join('');
  value = value.split('').reverse().join('');
  value = atob(value);
  return JSON.parse(value);
}

function extractVoe(embedUrl) {
  // Replica el flujo HTTP de AnimeAV1 1.2.5 exclusivamente para Voe:
  // mismo User-Agent, sin añadir Accept ni Referer a la petición de la redirección.
  var voeUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  function requestVoe(url) {
    return fetch(url, { headers: { 'User-Agent': voeUA } }).then(function (response) {
      return response.text().then(function (text) {
        if (!response.ok) throw new Error('HTTP error! Status: ' + response.status + ' en ' + safeUrl(url));
        return text;
      });
    });
  }

  return requestVoe(embedUrl)
    .then(function (html) {
      // fetch no ejecuta JavaScript: seguir window.location.href manualmente,
      // igual que el extractor de AnimeAV1.
      var redirect = html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/);
      if (!redirect) return { html: html, pageUrl: embedUrl };
      var redirectUrl = redirect[1];
      log('Voe: redirección JS detectada -> ' + safeUrl(redirectUrl));
      return requestVoe(redirectUrl).then(function (redirectHtml) {
        return { html: redirectHtml, pageUrl: embedUrl };
      });
    })
    .then(function (page) {
      // Mantener el mismo selector y decodificación del resolver funcional.
      var script = page.html.match(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
      if (!script) throw new Error('No se encontró el <script type="application/json"> en el embed de Voe');
      var jsonText = script[1].trim()
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
        .replace(/&#34;/g, '"').replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      var payload;
      try { payload = JSON.parse(jsonText); }
      catch (error) { throw new Error('No se pudo parsear el array JSON del embed de Voe: ' + error.message); }
      if (!Array.isArray(payload) || !payload[0]) throw new Error('El embed de Voe no trajo el payload esperado');
      var decoded;
      try { decoded = decodeVoePayload(payload[0]); }
      catch (error) { throw new Error('No se pudo decodificar el payload de Voe: ' + error.message); }
      var streamUrl = decoded && typeof decoded.source === 'string' ? decoded.source.trim() : '';
      if (!/^https?:\/\//i.test(streamUrl)) throw new Error('El payload de Voe no trajo una URL HLS válida');
      var origin = new URL(embedUrl).origin;
      var result = {
        url: streamUrl,
        headers: {
          'Referer': origin + '/',
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Dest': 'empty',
          'User-Agent': voeUA
        }
      };
      log('Voe HLS extraído: ' + safeUrl(streamUrl));
      return result;
    });
}

function makeVoeStream(stream, language, mediaType) {
  return {
    name: PROVIDER_NAME,
    title: '',
    url: stream.url,
    quality: '📺 Voe 720p\n720p | WEB-DL | ' + (mediaType === 'tv' ? 'Serie' : 'Película') + '\n' + languageLabel(language),
    headers: stream.headers,
    type: 'hls'
  };
}

function languageLabel(language) {
  var lang = String(language || '').toUpperCase();
  if (lang === 'ESP') return '🇪🇸 Español';
  if (lang === 'SUB') return '🌐 Subtitulado';
  return '🇲🇽 Latino';
}

function makeStream(url, language, mediaType) {
  var isMorencius = /^https:\/\/morencius\.com\//i.test(url);
  var headers = {
    'User-Agent': UA,
    'Referer': 'https://morencius.com/'
  };
  if (!isMorencius) headers.Origin = 'https://morencius.com';
  return {
    name: PROVIDER_NAME,
    title: '',
    url: url,
    quality: '📺 VidHide\nAuto | WEB-DL | ' + (mediaType === 'tv' ? 'Serie' : 'Película') + '\n' + languageLabel(language),
    headers: headers,
    type: 'hls'
  };
}

function getStreams(tmdbId, mediaType, season, episode) {
  var type = String(mediaType || '').toLowerCase();
  if (!tmdbId || (type !== 'movie' && type !== 'tv')) return Promise.resolve([]);

  log('TMDB ' + type + ' ' + tmdbId + (type === 'tv' ? ' S' + season + 'E' + episode : ''));
  var slug;
  return resolveTmdb(tmdbId, type)
    .then(function (meta) {
      slug = buildSlug(meta.imdbId, type, season, episode);
      log(meta.title + (meta.year ? ' (' + meta.year + ')' : '') + ' -> ' + slug);
      var embedUrl = EMBED69_BASE + '/f/' + slug;
      log('GET ' + safeUrl(embedUrl));
      return fetchText(embedUrl, {
        'Referer': 'https://sololatino.net/',
        'Accept': 'text/html,application/xhtml+xml'
      });
    })
    .then(function (result) {
      if (/No folders found|"error"\s*:/i.test(result.text.slice(0, 1800))) {
        throw new Error('Embed69 no tiene una entrada directa para ' + slug + '. La búsqueda alternativa en SoloLatino aún no está implementada.');
      }
      var sources = extractEmbed69Sources(result.text);
      var vidhide = sources.filter(function (source) {
        return /vidhide/i.test(source.server) || /morencius\.com/i.test(source.url);
      });
      log('Embed69 devolvió ' + sources.length + ' servidores; Vidhide: ' + vidhide.length);
      if (!vidhide.length) log('No se encontró Vidhide; se continuará intentando resolver los demás servidores.');

      // Prefer LAT; fall back to ESP, then SUB. Keep only one language to avoid duplicates.
      var language = ['LAT', 'ESP', 'SUB'].find(function (lang) {
        return vidhide.some(function (source) { return source.lang.toUpperCase() === lang; });
      });
      var selected = vidhide.filter(function (source) { return source.lang.toUpperCase() === language; });
      var uniquePages = [];
      selected.forEach(function (source) {
        if (uniquePages.indexOf(source.url) < 0) uniquePages.push(source.url);
      });
      log('Idioma seleccionado: ' + language + '; páginas Vidhide: ' + uniquePages.length);

      return uniquePages.reduce(function (promise, pageUrl) {
        return promise.then(function (streams) {
          return fetchText(pageUrl, {
            'Referer': EMBED69_REFERER,
            'Accept': 'text/html,application/xhtml+xml'
          }).then(function (page) {
            log('Vidhide ' + safeUrl(pageUrl) + ' -> HTTP 200');
            var playlists = extractPlaylists(page.text, pageUrl);
            if (!playlists.length) log('No se encontró playlist HLS en ' + safeUrl(pageUrl));
            playlists.forEach(function (playlist) {
              if (!streams.some(function (stream) { return stream.url === playlist; })) {
                streams.push(makeStream(playlist, language, type));
              }
            });
            return streams;
          }).catch(function (error) {
            log('Fallo leyendo Vidhide ' + safeUrl(pageUrl) + ': ' + error.message);
            return streams;
          });
        });
      }, Promise.resolve([])).then(function (streams) {
        // Voe se resuelve de forma independiente: un fallo de Voe nunca elimina Vidhide.
        var voeSources = sources.filter(function (source) {
          return /\bvoe\b/i.test(source.server) || /voe\.sx/i.test(source.url);
        });
        var seenVoe = [];
        voeSources = voeSources.filter(function (source) {
          if (seenVoe.indexOf(source.url) !== -1) return false;
          seenVoe.push(source.url);
          return true;
        });
        log('Embed69: fuentes Voe detectadas: ' + voeSources.length);
        return voeSources.reduce(function (promise, source) {
          return promise.then(function (currentStreams) {
            return extractVoe(source.url).then(function (resolved) {
              if (!currentStreams.some(function (stream) { return stream.url === resolved.url; })) {
                currentStreams.push(makeVoeStream(resolved, source.lang || language, type));
              }
              log('Voe resuelto correctamente a HLS.');
              return currentStreams;
            }).catch(function (error) {
              log('Fallo resolviendo Voe ' + safeUrl(source.url) + ': ' + error.message);
              return currentStreams;
            });
          });
        }, Promise.resolve(streams));
      });
    })
    .then(function (streams) {
      log('Resultado: ' + streams.length + ' playlist(s) HLS');
      return streams;
    })
    .catch(function (error) {
      console.error('[SoloLatino] ' + (error && error.message ? error.message : String(error)));
      return [];
    });
}

module.exports = { getStreams: getStreams };
