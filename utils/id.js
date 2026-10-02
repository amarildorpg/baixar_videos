// utils/id.js
// Geração de chaves de deduplicação/agrupamento de mídia.

/**
 * Chave única de uma mídia individual (uma qualidade específica).
 * Combina URL + resolução + bitrate + codec + tipo, conforme especificado.
 */
export function mediaKey({ url, width, height, bitrate, codecs, kind }) {
  const res = width && height ? `${width}x${height}` : 'na';
  const br = bitrate ? Math.round(bitrate / 1000) : 'na';
  const cd = codecs || 'na';
  return `${kind || 'na'}|${res}|${br}|${cd}|${normalizeUrl(url)}`;
}

/**
 * Chave de agrupamento: mídias que pertencem ao "mesmo vídeo" (diferentes
 * qualidades da mesma fonte). Para conteúdo direto usa a URL sem querystring
 * de qualidade; para HLS/DASH usa a URL do manifesto mestre.
 */
export function groupKey(url) {
  return normalizeUrl(url);
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    // Descarta TODA a querystring para fins de agrupamento/dedupe. CDNs (ex.:
    // fbcdn.net do Instagram) assinam cada requisição com parâmetros que
    // mudam a cada chunk/range (tokens, "oe", "oh", "bytestart"/"byteend",
    // "_nc_*" etc.) — uma lista de nomes conhecidos não dá conta disso, e
    // sem esse corte cada range-request de um mesmo vídeo virava uma
    // entrada nova (era o que gerava dezenas de "vídeos" duplicados de
    // poucos bytes). O caminho (pathname) já é um identificador estável do
    // recurso na esmagadora maioria dos CDNs.
    return u.origin + u.pathname;
  } catch (_e) {
    return url;
  }
}
