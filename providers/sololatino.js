/*
 * SoloLatino provider for Nuvio
 * Flow: TMDB ID -> IMDb ID -> Embed69 -> StreamWish HLS -> VidHide HLS
 * Runtime dependencies provided by Nuvio: fetch, require('crypto-js')
 */

const CryptoJS = require('crypto-js');

const PROVIDER_NAME = 'SoloLatino';
// Interruptor de proveedores: true = habilitar VidHide; false = solo StreamWish.
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

function normalizeLanguage(value) {
  var raw = String(value == null ? '' : value).trim().toUpperCase();
  if (!raw) return 'LAT';
  raw = raw.replace(/Á/g, 'A').replace(/É/g, 'E').replace(/Í/g, 'I')
    .replace(/Ó/g, 'O').replace(/Ú/g, 'U').replace(/Ü/g, 'U').replace(/Ñ/g, 'N');
  var code = raw.replace(/[^A-Z0-9]/g, '');

  // Solo se admiten español latino e inglés; el castellano de España y el subtitulado
  // genérico se ignoran para no mezclarlos con las pistas de audio solicitadas.
  if ([
    'LAT', 'LATINO', 'LATAM', 'LATIN', 'LATINAMERICA', 'LATINOAMERICA',
    'LATINOAMERICANO', 'LATINOAMERICANA', 'LATINSPANISH', 'SPANISHLATIN',
    'ESPANOLLATINO', 'ESPANOL LATINO', 'ES419', 'ESLA', 'ESMX', 'ESAR', 'ESCL', 'ESCO', 'ESPE'
  ].indexOf(code) !== -1 || code.indexOf('ESPANOLLATINO') !== -1 || code.indexOf('LATINSPANISH') !== -1) {
    return 'LAT';
  }
  if ([ 'EN', 'ENG', 'ENGLISH', 'ENUS', 'ENGB', 'INGLES', 'INGLESUS', 'INGLESUK' ].indexOf(code) !== -1 ||
      code.indexOf('ENGLISH') === 0 || code.indexOf('INGLES') === 0) {
    return 'ENG';
  }
  return null;
}

function isStreamwishSource(source) {
  return /streamwish|wish/i.test(String(source && source.server || '')) ||
    /(?:hglink\.to|vibuxer\.com)/i.test(String(source && source.url || ''));
}

function isVidHideSource(source) {
  return /vidhide/i.test(String(source && source.server || '')) ||
    /morencius\.com/i.test(String(source && source.url || ''));
}

function selectPreferredLanguage(sources) {
  if ((sources || []).some(function (source) { return source.lang === 'LAT'; })) return 'LAT';
  if ((sources || []).some(function (source) { return source.lang === 'ENG'; })) return 'ENG';
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
    var rawLanguage = section && section.video_language ? String(section.video_language) : 'LAT';
    var lang = normalizeLanguage(rawLanguage);
    if (!lang) return;
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
      ['hls4', 'hls3', 'hls2'].forEach(function (key) { add(config[key]); });
    } catch (_) {}
  }
  var fileRegex = /(?:file|src)\s*:\s*["']([^"']+)\s*["']/g;
  var match;
  while ((match = fileRegex.exec(source))) add(match[1]);
  return playlists;
}


// Parser activo de StreamWish: consulta HLS4 primero y conserva los fallbacks HLS.
function makeStreamwishStream(playlist, language, mediaType) {
  var headers = {
    'User-Agent': UA,
    'Referer': playlist.referer || 'https://vibuxer.com/',
    'Origin': playlist.origin || 'https://vibuxer.com'
  };
  var quality = playlist.quality || 'Auto';
  return {
    name: PROVIDER_NAME,
    title: '',
    url: playlist.url,
    quality: '📺 StreamWish\n' + quality + ' | HLS | ' + (mediaType === 'tv' ? 'Serie' : 'Película') + '\n' + languageLabel(language),
    headers: headers,
    type: 'hls'
  };
}

// Lee el manifiesto maestro y reproduce el comportamiento esencial de M3u8Helper:
// expone las variantes de calidad como streams separados, sin cambiar las extensiones
// .txt que usa el CDN ni construir URLs de manifiesto que no existen.
function parseStreamwishMaster(text, masterUrl) {
  var lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).map(function (line) { return line.trim(); });
  if (!lines.some(function (line) { return line === '#EXTM3U'; })) return [];
  var variants = [];
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('#EXT-X-STREAM-INF:') !== 0) continue;
    var info = lines[i];
    var path = '';
    for (var j = i + 1; j < lines.length; j++) {
      if (!lines[j] || lines[j].charAt(0) === '#') continue;
      path = lines[j];
      break;
    }
    if (!path) continue;
    var absolute;
    try { absolute = new URL(path, masterUrl).toString(); }
    catch (_) { continue; }
    var resolution = /RESOLUTION=\d+x(\d+)/i.exec(info);
    var height = resolution ? Number(resolution[1]) : 0;
    if (!height) {
      var bandwidth = /(?:AVERAGE-BANDWIDTH|BANDWIDTH)=(\d+)/i.exec(info);
      if (bandwidth) {
        var bps = Number(bandwidth[1]);
        height = bps >= 4500000 ? 1080 : bps >= 1800000 ? 720 : bps >= 700000 ? 480 : 0;
      }
    }
    var quality = height >= 1000 ? '1080p' : height >= 700 ? '720p' : height >= 450 ? '480p' : 'Auto';
    variants.push({ url: absolute, quality: quality, height: height });
  }
  variants.sort(function (a, b) { return b.height - a.height; });
  var seen = new Set();
  return variants.filter(function (variant) {
    if (seen.has(variant.url)) return false;
    seen.add(variant.url);
    return true;
  });
}

function streamwishCandidates(links, pageUrl) {
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
  // HLS4 es la fuente principal ya validada en reproducción; luego HLS3 y HLS2.
  // Los tres pasan por el mismo parser de variantes, respetando la extensión original.
  return [
    { url: resolve(links.hls4), key: 'hls4' },
    { url: resolve(links.hls3), key: 'hls3' },
    { url: resolve(links.hls2), key: 'hls2' }
  ].filter(function (item) {
    return item.url && /^https?:\/\//i.test(item.url) && /(?:master\.(?:m3u8|txt)|\.m3u8)(?:\?|$)/i.test(item.url);
  }).map(function (item) {
    return { url: item.url, key: item.key, origin: pageOrigin, referer: pageUrl };
  });
}

function resolveStreamwishStreams(html, pageUrl) {
  var htmlText = String(html || '');
  var source = htmlText + '\n' + unpackPacked(htmlText);
  var linksMatch = /links\s*=\s*(\{[^{}]*\})/.exec(source);
  if (!linksMatch) return Promise.resolve([]);
  var links;
  try { links = JSON.parse(linksMatch[1].replace(/\\\//g, '/')); }
  catch (_) { return Promise.resolve([]); }

  var candidates = streamwishCandidates(links, pageUrl);
  function tryCandidate(index) {
    if (index >= candidates.length) return Promise.resolve([]);
    var candidate = candidates[index];
    return fetchText(candidate.url, {
      'Referer': candidate.referer,
      'Origin': candidate.origin,
      'Accept': 'application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,*/*'
    }).then(function (result) {
      var body = result.text || '';
      if (!/^\s*#EXTM3U\b/m.test(body)) throw new Error('Respuesta sin #EXTM3U');
      log('StreamWish ' + candidate.key + ': manifiesto recibido; analizando variantes.');
      var variants = parseStreamwishMaster(body, candidate.url);
      if (!variants.length) {
        // Una lista multimedia directa no declara resoluciones seleccionables; se omite
        // para cumplir el modo de calidad limitada a 1080p y 720p.
        if (/^\s*#EXTINF:/m.test(body)) throw new Error('Lista directa sin variantes 1080p/720p');
        throw new Error('Manifiesto maestro sin variantes');
      }
      // Solo publicar 1080p y 720p. Si el mirror no ofrece ninguna de ellas,
      // se prueba el siguiente HLS en vez de mostrar 480p o Auto.
      variants = variants.filter(function (variant) {
        return variant.quality === '1080p' || variant.quality === '720p';
      });
      if (!variants.length) throw new Error('No ofrece variantes 1080p/720p');
      log('StreamWish ' + candidate.key + ' HTTP 200; variantes HLS 1080p/720p: ' + variants.length);
      return variants.map(function (variant) {
        return {
          url: variant.url,
          quality: variant.quality,
          origin: candidate.origin,
          referer: candidate.referer
        };
      });
    }).catch(function (error) {
      log('StreamWish ' + candidate.key + ' no disponible: ' + error.message);
      return tryCandidate(index + 1);
    });
  }
  return tryCandidate(0);
}

function streamwishPageUrl(value) {
  var url = String(value || '');
  // Algunos listados usan hglink.to como alias de la página StreamWish.
  if (/^https?:\/\/hglink\.to\//i.test(url)) return url.replace(/^https?:\/\/hglink\.to/i, 'https://vibuxer.com');
  return url;
}


function languageLabel(language) {
  return String(language || '').toUpperCase() === 'ENG' ? '🇺🇸 Inglés' : '🇲🇽 Latino';
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

function resolveStreamwishSources(languageSources, language, mediaType) {
  var pages = [];
  var seenPages = new Set();
  (languageSources || []).forEach(function (source) {
    var pageUrl = streamwishPageUrl(source.url);
    if (!seenPages.has(pageUrl)) {
      seenPages.add(pageUrl);
      pages.push({ url: pageUrl });
    }
  });

  // Los mirrors StreamWish se prueban en serie y se detiene al encontrar uno funcional.
  // Así se evita esperar a mirrors que agotan el tiempo de espera.
  function tryPage(index) {
    if (index >= pages.length) return Promise.resolve([]);
    var item = pages[index];
    return fetchText(item.url, {
      'Referer': EMBED69_REFERER,
      'Accept': 'text/html,application/xhtml+xml'
    }).then(function (page) {
      return resolveStreamwishStreams(page.text, item.url);
    }).then(function (playlists) {
      if (!playlists.length) {
        log('StreamWish sin variantes; se prueba el siguiente mirror: ' + safeUrl(item.url));
        return tryPage(index + 1);
      }
      var streams = [];
      var seenUrls = new Set();
      playlists.forEach(function (playlist) {
        if (!playlist || !playlist.url || seenUrls.has(playlist.url)) return;
        seenUrls.add(playlist.url);
        streams.push(makeStreamwishStream(playlist, language, mediaType));
      });
      if (!streams.length) return tryPage(index + 1);
      log('StreamWish: se selecciona el primer mirror válido (' + streams.length + ' variante(s)); se omiten los restantes.');
      return streams;
    }).catch(function (error) {
      log('Fallo leyendo StreamWish ' + safeUrl(item.url) + ': ' + error.message);
      return tryPage(index + 1);
    });
  }
  return tryPage(0);
}

function resolveVidHideSources(languageSources, language, mediaType) {
  var pages = [];
  var seenPages = new Set();
  (languageSources || []).forEach(function (source) {
    if (!seenPages.has(source.url)) {
      seenPages.add(source.url);
      pages.push(source.url);
    }
  });

  // Mantiene el extractor VidHide existente y consulta sus páginas en paralelo.
  return Promise.all(pages.map(function (pageUrl) {
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
    var seenUrls = new Set();
    playlistGroups.forEach(function (playlists) {
      playlists.forEach(function (playlist) {
        if (seenUrls.has(playlist)) return;
        seenUrls.add(playlist);
        streams.push(makeStream(playlist, language, mediaType));
      });
    });
    return streams;
  });
}

function streamQualityRank(stream) {
  var label = String(stream && (stream.quality || stream.title) || '');
  var match = /(?:^|\b)(2160|1440|1080|720|576|540|480|360|240)p\b/i.exec(label);
  if (match) return Number(match[1]);
  return 0;
}

function combineProviderStreams(streamwishStreams, vidhideStreams) {
  var combined = [];
  var seen = new Set();
  // Orden explícito de catálogo: StreamWish primero, VidHide después.
  // Dentro de cada proveedor, mostrar primero la resolución más alta.
  (streamwishStreams || []).concat(vidhideStreams || []).forEach(function (stream) {
    if (!stream || !stream.url || seen.has(stream.url)) return;
    seen.add(stream.url);
    combined.push(stream);
  });
  var providerRank = function (stream) {
    var label = String(stream && stream.quality || '');
    return /StreamWish/i.test(label) ? 0 : /VidHide/i.test(label) ? 1 : 2;
  };
  return combined.map(function (stream, index) {
    return { stream: stream, index: index, provider: providerRank(stream), quality: streamQualityRank(stream) };
  }).sort(function (a, b) {
    return a.provider - b.provider || b.quality - a.quality || a.index - b.index;
  }).map(function (item) { return item.stream; });
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
      var streamwish = sources.filter(isStreamwishSource);
      var vidhide = sources.filter(isVidHideSource);
      log('Embed69 devolvió ' + sources.length + ' servidores; StreamWish: ' + streamwish.length + '; VidHide: ' + (ENABLE_VIDHIDE ? vidhide.length : 'deshabilitado por switch')); 

      var supportedSources = ENABLE_VIDHIDE ? streamwish.concat(vidhide) : streamwish;
      var preferredLanguage = selectPreferredLanguage(supportedSources);
      if (!preferredLanguage) {
        log('No hay fuentes compatibles en español latino ni inglés; se ignoran español de España y otros idiomas.');
        return { streams: [], language: null, streamwishCount: 0, vidhideCount: 0 };
      }

      function resolveLanguage(language) {
        var streamwishForLanguage = streamwish.filter(function (source) { return source.lang === language; });
        var vidhideForLanguage = ENABLE_VIDHIDE ? vidhide.filter(function (source) { return source.lang === language; }) : [];
        log('Resolviendo idioma ' + languageLabel(language) + '; StreamWish: ' + streamwishForLanguage.length + '; VidHide: ' + vidhideForLanguage.length);

        // Se ejecutan ambos proveedores en paralelo para reducir la latencia, pero los
        // resultados se concatenan en el orden pedido: primero StreamWish y luego VidHide.
        return Promise.all([
          resolveStreamwishSources(streamwishForLanguage, language, type),
          ENABLE_VIDHIDE ? resolveVidHideSources(vidhideForLanguage, language, type) : Promise.resolve([])
        ]).then(function (providerResults) {
          var streamwishStreams = providerResults[0] || [];
          var vidhideStreams = providerResults[1] || [];
          return {
            streams: combineProviderStreams(streamwishStreams, vidhideStreams),
            language: language,
            streamwishCount: streamwishStreams.length,
            vidhideCount: vidhideStreams.length
          };
        });
      }

      // Prioridad de catálogo/idioma: latino antes que inglés. Si las fuentes LAT no
      // se encuentran o no se pueden resolver, se intenta inglés; ESP nunca se resuelve.
      var languageOrder = preferredLanguage === 'LAT' ? ['LAT', 'ENG'] : ['ENG'];
      function tryLanguage(index) {
        if (index >= languageOrder.length) {
          return Promise.resolve({ streams: [], language: null, streamwishCount: 0, vidhideCount: 0 });
        }
        var language = languageOrder[index];
        return resolveLanguage(language).then(function (resolved) {
          if (resolved.streams.length || index + 1 >= languageOrder.length) return resolved;
          log('No se resolvieron fuentes en español latino; se intenta inglés.');
          return tryLanguage(index + 1);
        });
      }
      return tryLanguage(0);
    })
    .then(function (result) {
      var streams = Array.isArray(result) ? result : result.streams;
      var language = Array.isArray(result) ? null : result.language;
      var swCount = Array.isArray(result) ? 0 : result.streamwishCount;
      var vhCount = Array.isArray(result) ? 0 : result.vidhideCount;
      log('Idioma seleccionado: ' + (language || 'ninguno') + '; StreamWish: ' + swCount + '; VidHide: ' + (ENABLE_VIDHIDE ? vhCount : 'deshabilitado'));
      log('Resultado: ' + streams.length + ' playlist(s) HLS; ' + (ENABLE_VIDHIDE ? 'StreamWish primero, VidHide después.' : 'solo StreamWish (switch ENABLE_VIDHIDE=false).'));
      return streams;
    })
    .catch(function (error) {
      console.error('[SoloLatino] ' + (error && error.message ? error.message : String(error)));
      return [];
    });
}

module.exports = { getStreams: getStreams };
