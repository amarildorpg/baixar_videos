// parsers/dash-parser.js
// Parser de manifestos MPEG-DASH (.mpd) baseado em regex, sem dependência
// de DOMParser (indisponível no service worker do Manifest V3).
//
// Suporta: AdaptationSet/Representation, SegmentTemplate (com
// SegmentTimeline ou @duration), SegmentList e SegmentBase (arquivo único).
// Limitação conhecida: manifests com estruturas muito atípicas (múltiplos
// BaseURL condicionais, xlink, MPDs multi-período complexos) podem não ser
// totalmente cobertos — ver README de limitações.

import { extractDashDrmSystems } from '../drm/drm-detector.js';

function resolveUrl(base, ref) {
  if (!ref) return ref;
  try {
    return new URL(ref, base).toString();
  } catch (_e) {
    return ref;
  }
}

function extractBlocks(xml, tag) {
  const blocks = [];
  const re = new RegExp(`<${tag}(\\s[^>]*)?(?:\\/>|>([\\s\\S]*?)<\\/${tag}>)`, 'g');
  let m;
  while ((m = re.exec(xml)) !== null) {
    blocks.push({ attrsStr: m[1] || '', inner: m[2] || '' });
  }
  return blocks;
}

function getAttr(attrsStr, name) {
  // Exige que o nome do atributo comece no início da string ou logo após
  // um espaço — sem isso, `width="..."` também batia dentro de
  // `bandwidth="..."` (mesmo problema para qualquer par tipo
  // nome/sobrenome de atributo), pegando o valor errado sempre que
  // `bandwidth` viesse antes de `width` no mesmo elemento — a ordem mais
  // comum em manifests DASH reais (confirmado com um manifesto gerado
  // pelo ffmpeg). Regressão coberta em tests/dash-parser.test.mjs.
  const re = new RegExp(`(?:^|\\s)${name}="([^"]*)"`);
  const m = re.exec(attrsStr || '');
  return m ? m[1] : null;
}

function numOrNull(v) {
  return v === null || v === undefined || v === '' ? null : Number(v);
}

function extractBaseUrl(xml, fallback) {
  const m = /<BaseURL[^>]*>([^<]*)<\/BaseURL>/.exec(xml);
  if (!m) return fallback;
  return resolveUrl(fallback, m[1].trim()) || fallback;
}

export function parseISODuration(iso) {
  if (!iso) return null;
  const m = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(iso);
  if (!m) return null;
  const h = parseFloat(m[1] || 0);
  const min = parseFloat(m[2] || 0);
  const s = parseFloat(m[3] || 0);
  return h * 3600 + min * 60 + s;
}

function extractSegmentTimeline(xml) {
  const tlBlocks = extractBlocks(xml, 'SegmentTimeline');
  if (!tlBlocks.length) return null;
  const sMatches = [...tlBlocks[0].inner.matchAll(/<S\s+([^>]*?)\/?>/g)];
  return sMatches.map((m) => ({
    t: numOrNull(getAttr(m[1], 't')),
    d: numOrNull(getAttr(m[1], 'd')),
    r: numOrNull(getAttr(m[1], 'r')) || 0,
  }));
}

function extractSegmentTemplate(xml) {
  const blocks = extractBlocks(xml, 'SegmentTemplate');
  if (!blocks.length) return null;
  const b = blocks[0];
  return {
    media: getAttr(b.attrsStr, 'media'),
    initialization: getAttr(b.attrsStr, 'initialization'),
    startNumber: numOrNull(getAttr(b.attrsStr, 'startNumber')) ?? 1,
    timescale: numOrNull(getAttr(b.attrsStr, 'timescale')) ?? 1,
    duration: numOrNull(getAttr(b.attrsStr, 'duration')),
    timeline: extractSegmentTimeline(b.inner),
  };
}

function extractSegmentList(xml) {
  const blocks = extractBlocks(xml, 'SegmentList');
  if (!blocks.length) return null;
  const b = blocks[0];
  const initBlocks = extractBlocks(b.inner, 'Initialization');
  const initUrl = initBlocks.length ? getAttr(initBlocks[0].attrsStr, 'sourceURL') : null;
  const urlMatches = [...b.inner.matchAll(/<SegmentURL\s+([^>]*?)\/?>/g)];
  const segments = urlMatches.map((m) => getAttr(m[1], 'media')).filter(Boolean);
  return { initUrl, segments };
}

function hasSegmentBase(xml) {
  return extractBlocks(xml, 'SegmentBase').length > 0;
}

function guessContentType(mimeType, codecs, width) {
  if (mimeType) {
    if (mimeType.startsWith('video')) return 'video';
    if (mimeType.startsWith('audio')) return 'audio';
  }
  if (width) return 'video';
  if (codecs) {
    const c = codecs.toLowerCase();
    if (/mp4a|opus|vorbis|ac-3|ec-3/.test(c)) return 'audio';
    if (/avc1|hev1|hvc1|vp9|vp09|av01/.test(c)) return 'video';
  }
  return 'unknown';
}

/**
 * Parseia um manifesto MPD completo.
 * @returns {{ adaptationSets: object[], isDRM: boolean, drmSystems: string[], durationSeconds: number|null }}
 */
export function parseMPD(xmlText, baseUrl) {
  const mpdBaseUrl = extractBaseUrl(xmlText, baseUrl);
  const globalDrmSystems = extractDashDrmSystems(xmlText);

  const mpdDurationAttr = /<MPD[^>]*mediaPresentationDuration="([^"]*)"/.exec(xmlText)?.[1];
  const durationSeconds = parseISODuration(mpdDurationAttr);

  const periods = extractBlocks(xmlText, 'Period');
  const adaptationSets = [];

  const periodList = periods.length ? periods : [{ attrsStr: '', inner: xmlText }];

  for (const period of periodList) {
    const periodDurAttr = getAttr(period.attrsStr, 'duration');
    const periodDuration = parseISODuration(periodDurAttr) || durationSeconds;
    const periodBaseUrl = extractBaseUrl(period.inner, mpdBaseUrl);

    const asBlocks = extractBlocks(period.inner, 'AdaptationSet');
    for (const asBlock of asBlocks) {
      const asBaseUrl = extractBaseUrl(asBlock.inner, periodBaseUrl);
      const mimeType = getAttr(asBlock.attrsStr, 'mimeType');
      const contentTypeAttr = getAttr(asBlock.attrsStr, 'contentType');
      const asDrm = extractDashDrmSystems(asBlock.inner);
      const asSegTemplate = extractSegmentTemplate(asBlock.inner);

      const repBlocks = extractBlocks(asBlock.inner, 'Representation');
      for (const repBlock of repBlocks) {
        const repDrm = extractDashDrmSystems(repBlock.inner);
        const width = numOrNull(getAttr(repBlock.attrsStr, 'width'));
        const height = numOrNull(getAttr(repBlock.attrsStr, 'height'));
        const bandwidth = numOrNull(getAttr(repBlock.attrsStr, 'bandwidth'));
        const codecs = getAttr(repBlock.attrsStr, 'codecs');
        const representationId = getAttr(repBlock.attrsStr, 'id');
        const repMime = getAttr(repBlock.attrsStr, 'mimeType') || mimeType;
        const contentType = contentTypeAttr || guessContentType(repMime, codecs, width);

        const repSegTemplate = extractSegmentTemplate(repBlock.inner) || asSegTemplate;
        const segmentList = extractSegmentList(repBlock.inner);
        const segmentBase = hasSegmentBase(repBlock.inner);
        const repBaseUrl = extractBaseUrl(repBlock.inner, asBaseUrl);

        const drmSystems = [...new Set([...globalDrmSystems, ...asDrm, ...repDrm])];

        adaptationSets.push({
          adaptationSetId: getAttr(asBlock.attrsStr, 'id'),
          representationId,
          contentType,
          mimeType: repMime,
          width,
          height,
          bandwidth,
          codecs,
          isDRM: drmSystems.length > 0,
          drmSystems,
          segmentTemplate: repSegTemplate,
          segmentList,
          segmentBase,
          baseUrl: repBaseUrl,
          periodDuration,
        });
      }
    }
  }

  return {
    adaptationSets,
    isDRM: globalDrmSystems.length > 0 || adaptationSets.some((r) => r.isDRM),
    drmSystems: globalDrmSystems,
    durationSeconds,
  };
}

function fillTemplate(template, { representationId, bandwidth, number, time }) {
  if (!template) return null;
  return template
    .replace(/\$RepresentationID\$/g, representationId ?? '')
    .replace(/\$Bandwidth\$/g, bandwidth ?? '')
    .replace(/\$Number(%0(\d+)d)?\$/g, (_all, _fmt, width) => {
      const n = String(number ?? 0);
      return width ? n.padStart(Number(width), '0') : n;
    })
    .replace(/\$Time(%0(\d+)d)?\$/g, (_all, _fmt, width) => {
      const t = String(time ?? 0);
      return width ? t.padStart(Number(width), '0') : t;
    })
    .replace(/\$\$/g, '$');
}

/**
 * Expande uma Representation em URLs de segmento concretas, prontas para
 * download em ordem. Retorna `needsDurationExpansion: true` quando não é
 * possível calcular o número total de segmentos (SegmentTemplate por
 * @duration sem SegmentTimeline nem duração de período conhecida).
 */
export function buildSegmentUrls(representation) {
  const { segmentTemplate, segmentList, representationId, bandwidth, baseUrl, periodDuration } = representation;

  if (segmentList) {
    const initUrl = segmentList.initUrl ? resolveUrl(baseUrl, segmentList.initUrl) : null;
    const segments = segmentList.segments.map((s) => resolveUrl(baseUrl, s));
    return { initUrl, segments };
  }

  if (segmentTemplate) {
    const initUrl = segmentTemplate.initialization
      ? resolveUrl(baseUrl, fillTemplate(segmentTemplate.initialization, { representationId, bandwidth }))
      : null;

    const segments = [];

    if (segmentTemplate.timeline && segmentTemplate.timeline.length) {
      let time = segmentTemplate.timeline[0].t ?? 0;
      let number = segmentTemplate.startNumber;
      for (const entry of segmentTemplate.timeline) {
        if (entry.t != null) time = entry.t;
        const repeat = entry.r || 0;
        for (let i = 0; i <= repeat; i++) {
          const url = fillTemplate(segmentTemplate.media, { representationId, bandwidth, number, time });
          segments.push(resolveUrl(baseUrl, url));
          time += entry.d || 0;
          number += 1;
        }
      }
      return { initUrl, segments };
    }

    if (segmentTemplate.duration) {
      const timescale = segmentTemplate.timescale || 1;
      const segDurSec = segmentTemplate.duration / timescale;
      const count = periodDuration ? Math.ceil(periodDuration / segDurSec) : null;
      if (count) {
        for (let i = 0; i < count; i++) {
          const number = segmentTemplate.startNumber + i;
          const url = fillTemplate(segmentTemplate.media, { representationId, bandwidth, number });
          segments.push(resolveUrl(baseUrl, url));
        }
        return { initUrl, segments };
      }
      return { initUrl, segments: [], needsDurationExpansion: true };
    }

    return { initUrl, segments: [], needsDurationExpansion: true };
  }

  // SegmentBase ou representação de arquivo único: a própria BaseURL é o arquivo completo.
  if (baseUrl) {
    return { initUrl: null, segments: [baseUrl] };
  }

  return { initUrl: null, segments: [] };
}

/**
 * Agrupa as Representations em vídeo/áudio e identifica as melhores de cada.
 */
export function summarizeAdaptationSets(adaptationSets) {
  const videos = adaptationSets.filter((r) => r.contentType === 'video');
  const audios = adaptationSets.filter((r) => r.contentType === 'audio');
  const byBandwidthDesc = (a, b) => (b.bandwidth || 0) - (a.bandwidth || 0);
  const bestVideo = videos.slice().sort(byBandwidthDesc)[0] || null;
  const bestAudio = audios.slice().sort(byBandwidthDesc)[0] || null;
  return { videos, audios, bestVideo, bestAudio };
}
