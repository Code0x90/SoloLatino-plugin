/*
 * SoloLatino provider for Nuvio
 * Flow: TMDB ID -> IMDb ID -> Embed69 direct route -> Vidhide -> HLS
 * Runtime dependencies provided by Nuvio: fetch, require('crypto-js')
 */

const CryptoJS = require('crypto-js');

const PROVIDER_NAME = 'SoloLatino';
// Desactivación temporal para diagnosticar StreamWish sin alterar el extractor VidHide.
const ENABLE_VIDHIDE = false;
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
    if (!response.ok) throw new Error('HTTP ' + response.status + ' en ' + safeUrl(url));
    return response.text().then(function (text) {
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

// Caché en memoria acotada: evita duplicar las dos consultas TMDB en llamadas repetidas.
var TMDB_CACHE_TTL_MS = 10 * 60 * 1000;
var TMDB_CACHE_MAX_ENTRIES = 200;
var tmdbCache = Object.create(null);

function resolveTmdb(tmdbId, mediaType) {
  var type = mediaType === 'movie' ? 'movie' : 'tv';
  var cacheKey = type + ':' + String(tmdbId);
  var now = Date.now();
  var cached = tmdbCache[cacheKey];
  if (cached && cached.expiresAt > now) return cached.promise;
  if (cached) delete tmdbCache[cacheKey];

  var entry = { expiresAt: now + TMDB_CACHE_TTL_MS, promise: null };
  entry.promise = Promise.resolve().then(function () {
    var base = TMDB_BASE + '/' + type + '/' + encodeURIComponent(String(tmdbId));
    var key = '?api_key=' + encodeURIComponent(TMDB_API_KEY);
    return Promise.all([
      fetchJson(base + key),
      fetchJson(base + '/external_ids' + key)
    ]);
  }).then(function (results) {
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
  }).catch(function (error) {
    if (tmdbCache[cacheKey] === entry) delete tmdbCache[cacheKey];
    throw error;
  });

  tmdbCache[cacheKey] = entry;
  var keys = Object.keys(tmdbCache);
  if (keys.length > TMDB_CACHE_MAX_ENTRIES) {
    var oldestKey = null;
    var oldestExpiry = Infinity;
    keys.forEach(function (key) {
      if (key !== cacheKey && tmdbCache[key].expiresAt < oldestExpiry) {
        oldestExpiry = tmdbCache[key].expiresAt;
        oldestKey = key;
      }
    });
    if (oldestKey) delete tmdbCache[oldestKey];
  }
  return entry.promise;
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
  var numericDifficulty = Number(difficulty);
  if (!Number.isFinite(numericDifficulty) || numericDifficulty < 0 || numericDifficulty > 64) return null;
  var zeros = '0'.repeat(Math.floor(numericDifficulty));
  // Reutilizar el prefijo evita recalcular el hash de challenge en cada nonce.
  var hasher = CryptoJS.algo && CryptoJS.algo.SHA256 && typeof CryptoJS.algo.SHA256.create === 'function'
    ? CryptoJS.algo.SHA256.create().update(String(challenge))
    : null;
  // Keep a finite cap to avoid monopolizing Nuvio's JS runtime.
  for (var nonce = 0; nonce < 2000000; nonce++) {
    var candidate = challenge + nonce;
    var hash = hasher
      ? hasher.clone().update(String(nonce)).finalize().toString()
      : CryptoJS.SHA256(candidate).toString();
    if (hash.slice(0, zeros.length) === zeros) {
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

function extractPlaylists(html) {
  var htmlText = String(html || '');
  var source = htmlText + '\n' + unpackPacked(htmlText);
  var playlists = [];
  var seenPlaylists = new Set();
  function add(value) {
    if (typeof value !== 'string') return;
    var url = value.replace(/\\\//g, '/').trim();
    if (url.charAt(0) === '/' && url.slice(0, 2) !== '//') {
      url = 'https://morencius.com' + url;
    }
    if (/^https:\/\//i.test(url) && /\.m3u8(?:\?|$)/i.test(url) && !seenPlaylists.has(url)) {
      seenPlaylists.add(url);
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


// StreamWish/Vibuxer: la configuración de fuentes está dentro de un bloque JS empaquetado.
// No se ejecuta el código de la página: solo se desempaqueta texto y se extrae `links`.
function extractStreamwishPlaylist(html, pageUrl) {
  var htmlText = String(html || '');
  var source = htmlText + '\n' + unpackPacked(htmlText);
  var linksMatch = /links\s*=\s*(\{[^{}]*\})/.exec(source);
  if (!linksMatch) return null;

  var links;
  try { links = JSON.parse(linksMatch[1].replace(/\\\//g, '/')); }
  catch (_) { return null; }

  var pageOriginMatch = String(pageUrl || '').match(/^(https?:\/\/[^/]+)/i);
  var pageOrigin = pageOriginMatch ? pageOriginMatch[1] : 'https://vibuxer.com';
  function resolve(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    var url = value.trim().replace(/\\\//g, '/');
    if (/^https?:\/\//i.test(url)) return url;
    if (url.indexOf('//') === 0) return 'https:' + url;
    if (url.charAt(0) === '/') return pageOrigin + url;
    return pageOrigin + '/' + url;
  }

  // hls3 fue comprobado y entrega segmentos MPEG-TS reales. hls2 queda como respaldo.
  // hls4 se deja al final: en las pruebas devolvió segmentos de imágenes, pese a HTTP 200.
  var candidates = [resolve(links.hls3), resolve(links.hls2), resolve(links.hls4)];
  for (var i = 0; i < candidates.length; i++) {
    if (candidates[i] && /^https?:\/\//i.test(candidates[i]) && /(?:master\.(?:m3u8|txt)|\.m3u8)(?:\?|$)/i.test(candidates[i])) {
      // El CDN entrega el manifiesto, pero el origen HTTP del reproductor es Vibuxer.
      // No enviar Origin igual al host del CDN: puede provocar 403 en los segmentos.
      return { url: candidates[i], origin: pageOrigin, referer: pageUrl };
    }
  }
  return null;
}

function makeStreamwishStream(playlist, language, mediaType) {
  var headers = {
    'User-Agent': UA,
    'Referer': playlist.referer || 'https://vibuxer.com/',
    'Origin': playlist.origin || 'https://vibuxer.com'
  };
  return {
    name: PROVIDER_NAME,
    title: '',
    url: playlist.url,
    quality: '📺 StreamWish\nAuto | HLS | ' + (mediaType === 'tv' ? 'Serie' : 'Película') + '\n' + languageLabel(language),
    headers: headers,
    type: 'hls'
  };
}

function streamwishPageUrl(value) {
  var url = String(value || '');
  // Algunos listados usan hglink.to como alias de la página StreamWish.
  if (/^https?:\/\/hglink\.to\//i.test(url)) return url.replace(/^https?:\/\/hglink\.to/i, 'https://vibuxer.com');
  return url;
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
  if (type === 'tv') {
    var seasonNumber = Number(season);
    var episodeNumber = Number(episode);
    if (!Number.isInteger(seasonNumber) || seasonNumber < 0 ||
        !Number.isInteger(episodeNumber) || episodeNumber < 1) {
      log('Temporada o episodio inválido; se omiten las consultas de red.');
      return Promise.resolve([]);
    }
  }

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
      var vidhide = ENABLE_VIDHIDE ? sources.filter(function (source) {
        return /vidhide/i.test(source.server) || /morencius\.com/i.test(source.url);
      }) : [];
      if (!ENABLE_VIDHIDE) log('VidHide deshabilitado temporalmente para pruebas; se omite su resolución.');
      var streamwish = sources.filter(function (source) {
        return /streamwish|wish/i.test(source.server) || /(?:hglink\.to|vibuxer\.com)/i.test(source.url);
      });
      log('Embed69 devolvió ' + sources.length + ' servidores; VidHide: ' + vidhide.length + '; StreamWish: ' + streamwish.length);
      if (!vidhide.length && !streamwish.length) {
        log('No se encontró una fuente VidHide ni StreamWish compatible.');
        return [];
      }

      // Prefer LAT; fall back to ESP, then SUB. Keep only one language to avoid duplicates.
      var languagePriority = ['LAT', 'ESP', 'SUB'];
      var language = languagePriority.find(function (lang) {
        return vidhide.some(function (source) {
          return String(source.lang || '').toUpperCase() === lang;
        });
      });
      var selected = vidhide.filter(function (source) {
        return String(source.lang || '').toUpperCase() === language;
      });
      var uniquePages = [];
      var seenPages = new Set();
      selected.forEach(function (source) {
        if (!seenPages.has(source.url)) {
          seenPages.add(source.url);
          uniquePages.push(source.url);
        }
      });
      log('Idioma seleccionado: ' + language + '; páginas VidHide: ' + uniquePages.length);

      // Consultar las páginas en paralelo reduce la latencia cuando hay varios mirrors.
      return Promise.all(uniquePages.map(function (pageUrl) {
        return fetchText(pageUrl, {
          'Referer': EMBED69_REFERER,
          'Accept': 'text/html,application/xhtml+xml'
        }).then(function (page) {
          log('VidHide ' + safeUrl(pageUrl) + ' -> HTTP 200');
          return extractPlaylists(page.text);
        }).catch(function (error) {
          log('Fallo leyendo VidHide ' + safeUrl(pageUrl) + ': ' + error.message);
          return [];
        });
      })).then(function (playlistGroups) {
        var streams = [];
        var seenStreams = new Set();
        playlistGroups.forEach(function (playlists) {
          playlists.forEach(function (playlist) {
            if (seenStreams.has(playlist)) return;
            seenStreams.add(playlist);
            streams.push(makeStream(playlist, language, type));
          });
        });

        // StreamWish se procesa aparte para no alterar el extractor VidHide existente.
        var streamwishPages = [];
        var seenStreamwishPages = new Set();
        streamwish.forEach(function (source) {
          var pageUrl = streamwishPageUrl(source.url);
          if (!seenStreamwishPages.has(pageUrl)) {
            seenStreamwishPages.add(pageUrl);
            streamwishPages.push({ url: pageUrl, lang: source.lang || language || 'LAT' });
          }
        });
        return Promise.all(streamwishPages.map(function (item) {
          return fetchText(item.url, {
            'Referer': EMBED69_REFERER,
            'Accept': 'text/html,application/xhtml+xml'
          }).then(function (page) {
            var playlist = extractStreamwishPlaylist(page.text, item.url);
            if (!playlist) {
              log('StreamWish sin manifiesto extraíble: ' + safeUrl(item.url));
              return null;
            }
            log('StreamWish manifiesto extraído: ' + safeUrl(playlist.url));
            return { playlist: playlist, lang: item.lang };
          }).catch(function (error) {
            log('Fallo leyendo StreamWish ' + safeUrl(item.url) + ': ' + error.message);
            return null;
          });
        })).then(function (resolved) {
          resolved.forEach(function (item) {
            if (!item || seenStreams.has(item.playlist.url)) return;
            seenStreams.add(item.playlist.url);
            streams.push(makeStreamwishStream(item.playlist, item.lang, type));
          });
          return streams;
        });
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
