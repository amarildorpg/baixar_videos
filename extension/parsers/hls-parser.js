// parsers/hls-parser.js
// Parser de playlists HLS (.m3u8) — master e media playlist.
// Sem dependências externas, apenas parsing de texto linha a linha.

import { hlsKeyInfo } from '../drm/drm-detector.js';

function resolveUrl(base, ref) {
  try {
    return new URL(ref, base).toString();
  } catch (_e) {
    return ref;
  }
}

function parseAttrList(str) {
  // Parseia uma lista de atributos estilo HLS: A=1,B="texto,com,virgula",C=x
  const attrs = {};
  const re = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    attrs[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return attrs;
}

/**
 * Detecta se o texto é uma master playlist (contém variantes) ou uma
 * media playlist (contém segmentos).
 */
export function isMasterPlaylist(text) {
  return /#EXT-X-STREAM-INF/.test(text);
}

/**
 * Parseia uma master playlist, retornando a lista de variantes (qualidades).
 */
export function parseMasterPlaylist(text, baseUrl) {
  const lines = text.split('\n').map((l) => l.trim());
  const variants = [];
  const audioRenditions = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('#EXT-X-MEDIA') && /TYPE=AUDIO/.test(line)) {
      const attrs = parseAttrList(line.slice(line.indexOf(':') + 1));
      if (attrs.URI) {
        audioRenditions.push({
          groupId: attrs['GROUP-ID'],
          name: attrs.NAME,
          url: resolveUrl(baseUrl, attrs.URI),
          default: attrs.DEFAULT === 'YES',
        });
      }
      continue;
    }

    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const attrs = parseAttrList(line.slice(line.indexOf(':') + 1));
      const uriLine = lines[i + 1];
      if (!uriLine || uriLine.startsWith('#')) continue;

      const [width, height] = (attrs.RESOLUTION || '').split('x').map(Number);
      variants.push({
        url: resolveUrl(baseUrl, uriLine),
        bandwidth: attrs.BANDWIDTH ? Number(attrs.BANDWIDTH) : null,
        averageBandwidth: attrs['AVERAGE-BANDWIDTH'] ? Number(attrs['AVERAGE-BANDWIDTH']) : null,
        width: width || null,
        height: height || null,
        codecs: attrs.CODECS || null,
        frameRate: attrs['FRAME-RATE'] ? Number(attrs['FRAME-RATE']) : null,
        audioGroupId: attrs.AUDIO || null,
      });
      i += 1;
    }
  }

  // Associa grupo de áudio às variantes
  for (const v of variants) {
    if (v.audioGroupId) {
      const match = audioRenditions.find((a) => a.groupId === v.audioGroupId && a.default) ||
        audioRenditions.find((a) => a.groupId === v.audioGroupId);
      v.audioUrl = match ? match.url : null;
    } else {
      v.audioUrl = null;
    }
  }

  return { variants, audioRenditions };
}

/**
 * Parseia uma media playlist (playlist de segmentos), retornando os
 * segmentos em ordem, o segmento de inicialização (se houver, fMP4) e
 * informações de criptografia.
 */
export function parseMediaPlaylist(text, baseUrl) {
  const lines = text.split('\n').map((l) => l.trim());
  const segments = [];
  let initSegmentUrl = null;
  let currentDuration = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    if (line.startsWith('#EXT-X-MAP')) {
      const attrs = parseAttrList(line.slice(line.indexOf(':') + 1));
      if (attrs.URI) initSegmentUrl = resolveUrl(baseUrl, attrs.URI);
      continue;
    }

    if (line.startsWith('#EXTINF')) {
      const dur = /#EXTINF:([\d.]+)/.exec(line);
      currentDuration = dur ? parseFloat(dur[1]) : null;
      continue;
    }

    if (!line.startsWith('#')) {
      segments.push({ url: resolveUrl(baseUrl, line), duration: currentDuration });
      currentDuration = null;
    }
  }

  const keyInfo = hlsKeyInfo(text);
  const isLive = !/#EXT-X-ENDLIST/.test(text);

  return { segments, initSegmentUrl, keyInfo, isLive };
}

/**
 * Ponto de entrada: dado o texto de um .m3u8, decide se é master ou media
 * playlist e retorna a estrutura apropriada com uma flag `type`.
 */
export function parseM3U8(text, baseUrl) {
  if (isMasterPlaylist(text)) {
    return { type: 'master', ...parseMasterPlaylist(text, baseUrl) };
  }
  return { type: 'media', ...parseMediaPlaylist(text, baseUrl) };
}
