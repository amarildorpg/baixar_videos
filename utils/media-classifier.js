// utils/media-classifier.js
// Classifica uma requisição/URL como um tipo de mídia relevante,
// combinando extensão da URL e Content-Type da resposta.

const CONTENT_TYPE_MAP = [
  { match: 'video/mp4', kind: 'direct', container: 'mp4', media: 'video' },
  { match: 'video/webm', kind: 'direct', container: 'webm', media: 'video' },
  { match: 'video/mp2t', kind: 'ts-segment', container: 'ts', media: 'video' },
  { match: 'application/vnd.apple.mpegurl', kind: 'hls', container: 'm3u8', media: 'manifest' },
  { match: 'application/x-mpegurl', kind: 'hls', container: 'm3u8', media: 'manifest' },
  { match: 'application/dash+xml', kind: 'dash', container: 'mpd', media: 'manifest' },
  { match: 'audio/mp4', kind: 'direct', container: 'mp4', media: 'audio' },
  { match: 'audio/webm', kind: 'direct', container: 'webm', media: 'audio' },
];

const EXTENSION_MAP = [
  { match: /\.mp4($|\?)/i, kind: 'direct', container: 'mp4', media: 'video' },
  { match: /\.webm($|\?)/i, kind: 'direct', container: 'webm', media: 'video' },
  { match: /\.m3u8($|\?)/i, kind: 'hls', container: 'm3u8', media: 'manifest' },
  { match: /\.mpd($|\?)/i, kind: 'dash', container: 'mpd', media: 'manifest' },
  { match: /\.ts($|\?)/i, kind: 'ts-segment', container: 'ts', media: 'video' },
  { match: /\.m4s($|\?)/i, kind: 'fmp4-segment', container: 'm4s', media: 'video' },
];

/**
 * @param {string} url
 * @param {string|null} contentType
 * @returns {{kind:string, container:string, media:string}|null}
 */
export function classifyMedia(url, contentType) {
  if (contentType) {
    const ct = contentType.split(';')[0].trim().toLowerCase();
    const byType = CONTENT_TYPE_MAP.find((e) => e.match === ct);
    if (byType) return { ...byType };
  }
  const byExt = EXTENSION_MAP.find((e) => e.match.test(url));
  if (byExt) return { ...byExt };
  return null;
}

export const RELEVANT_CONTENT_TYPES = CONTENT_TYPE_MAP.map((e) => e.match);

/**
 * Converte largura/altura numa label padrão (360p, 720p, 1080p, 4K...).
 */
export function resolutionLabel(width, height) {
  if (!width || !height) return null;
  const h = Math.min(width, height) === height ? height : width;
  if (h >= 2160) return '4K';
  if (h >= 1440) return '1440p';
  if (h >= 1080) return '1080p';
  if (h >= 720) return '720p';
  if (h >= 480) return '480p';
  if (h >= 360) return '360p';
  if (h >= 240) return '240p';
  return `${h}p`;
}

export function formatBitrate(bps) {
  if (!bps || bps <= 0) return null;
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  return `${Math.round(bps / 1000)} kbps`;
}

export function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return null;
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
