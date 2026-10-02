// background/service-worker.js
// Orquestrador central: monitora requisições de rede, recebe sinais dos
// content scripts, mantém o estado de mídia por aba e executa downloads.

import { createLogger } from '../utils/logger.js';
import { classifyMedia, resolutionLabel, formatBitrate, formatBytes } from '../utils/media-classifier.js';
import { mediaKey, groupKey } from '../utils/id.js';
import { buildFilename } from '../utils/filename.js';
import { parseM3U8 } from '../parsers/hls-parser.js';
import { parseMPD, buildSegmentUrls, summarizeAdaptationSets } from '../parsers/dash-parser.js';
import { drmNameFromKeySystem, combineDrmSignals } from '../drm/drm-detector.js';
import { fetchDirectVideo, trackDownload } from '../downloader/direct-download.js';
import { downloadAndConcatSegments, downloadBlob } from '../downloader/segment-downloader.js';

const log = createLogger('background');

/** @type {Map<number, TabState>} */
const tabStates = new Map();

/**
 * Pedidos pendentes de leitura de bytes de um blob: (ver
 * requestBlobBytesFromTab / handler de BLOB_BYTES_RESULT mais abaixo).
 * @type {Map<string, (result: {ok:boolean, streams?:Array<{base64:string, mimeType:string, kind:string}>, error?:string}) => void>}
 */
const pendingBlobRequests = new Map();
const BLOB_FETCH_TIMEOUT_MS = 45_000;

/**
 * @typedef {Object} TabState
 * @property {string|null} pageUrl
 * @property {string|null} pageTitle
 * @property {string|null} ogTitle
 * @property {Map<string, MediaGroup>} groups
 * @property {{isDRM:boolean, drmSystem:string|null}} pageDrm
 * @property {Map<string, DownloadState>} downloads
 * @property {Array<{url:string, groupId:string, ts:number}>} recentDetections
 */

function newTabState() {
  return {
    pageUrl: null,
    pageTitle: null,
    ogTitle: null,
    groups: new Map(),
    pageDrm: { isDRM: false, drmSystem: null },
    downloads: new Map(),
    recentDetections: [],
  };
}

function getTabState(tabId) {
  if (!tabStates.has(tabId)) tabStates.set(tabId, newTabState());
  return tabStates.get(tabId);
}

function domainOf(url) {
  try {
    return new URL(url).hostname;
  } catch (_e) {
    return null;
  }
}

const MAX_RECENT_DETECTIONS = 20;

// Mantém apenas as últimas detecções (usadas só como dica de correlação
// para blobs) — evita crescimento ilimitado de memória em abas de longa duração.
function pushRecentDetection(tabState, entry) {
  tabState.recentDetections.push(entry);
  if (tabState.recentDetections.length > MAX_RECENT_DETECTIONS) {
    tabState.recentDetections.splice(0, tabState.recentDetections.length - MAX_RECENT_DETECTIONS);
  }
}

// ---------------------------------------------------------------------
// Deduplicação / agrupamento
// ---------------------------------------------------------------------

function ensureGroup(tabState, key, base) {
  let group = tabState.groups.get(key);
  if (!group) {
    group = {
      groupId: key,
      kind: base.kind,
      sourceUrl: base.sourceUrl,
      pageUrl: base.pageUrl || tabState.pageUrl,
      pageTitle: base.pageTitle || tabState.pageTitle,
      ogTitle: base.ogTitle || tabState.ogTitle,
      domain: domainOf(base.sourceUrl),
      isDRM: false,
      drmSystem: null,
      qualities: [],
      firstSeen: Date.now(),
    };
    tabState.groups.set(key, group);
  } else {
    // O grupo pode ter sido criado por uma detecção de rede (webRequest)
    // ANTES do content script mandar o título/og:title da página — nesse
    // caso ele nascia sem esses campos e ficava assim para sempre (bug
    // real: filename caía direto para o nome extraído da URL mesmo com
    // og:title presente na página, porque nada reatualizava o grupo já
    // existente depois). Reaproveita aqui os valores mais recentes que a
    // aba já conhece, sem nunca apagar um valor bom com um nulo.
    group.pageUrl = base.pageUrl || tabState.pageUrl || group.pageUrl;
    group.pageTitle = base.pageTitle || tabState.pageTitle || group.pageTitle;
    group.ogTitle = base.ogTitle || tabState.ogTitle || group.ogTitle;
  }
  return group;
}

function upsertQuality(group, quality) {
  const key = mediaKey({
    url: quality.url,
    width: quality.width,
    height: quality.height,
    bitrate: quality.bitrate,
    codecs: quality.codecs,
    kind: quality.kind,
  });
  const existing = group.qualities.find((q) => q._key === key);
  if (existing) {
    Object.assign(existing, quality, { _key: key });
    return existing;
  }
  const q = { ...quality, _key: key };
  group.qualities.push(q);
  return q;
}

function sortQualitiesDesc(group) {
  group.qualities.sort((a, b) => {
    const ah = a.height || 0;
    const bh = b.height || 0;
    if (bh !== ah) return bh - ah;
    return (b.bitrate || 0) - (a.bitrate || 0);
  });
}

function notifyTabUpdated(tabId) {
  chrome.runtime.sendMessage({ type: 'TAB_MEDIA_UPDATED', tabId }).catch(() => {});
  updateBadge(tabId);
}

async function updateBadge(tabId) {
  const state = tabStates.get(tabId);
  const count = state ? state.groups.size : 0;
  try {
    await chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : '' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#2563eb' });
  } catch (_e) {
    /* aba pode ter fechado */
  }
}

// ---------------------------------------------------------------------
// Monitoramento de rede
// ---------------------------------------------------------------------

function getHeader(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

// "Content-Range: bytes 0-999/5000000" -> 5000000 (tamanho TOTAL do
// recurso). CDNs que servem vídeo por range request (ex.: fbcdn.net do
// Instagram) respondem 206 Partial Content a cada chunk — o Content-Length
// desses chunks é só o tamanho do pedaço, não do vídeo inteiro.
// Content-Range, quando presente, é a fonte confiável do tamanho real.
function parseContentRangeTotal(value) {
  const m = /bytes\s+\d+-\d+\/(\d+)/i.exec(value || '');
  return m ? Number(m[1]) : null;
}

// Abaixo disso, sem um Content-Range confirmando o tamanho total, um
// corpo "video/mp4" quase certamente não é um vídeo de verdade — é um
// probe do player, um chunk isolado ou algum outro artefato de rede.
// Evita poluir a lista com dezenas de entradas de poucas centenas de bytes.
const MIN_PLAUSIBLE_DIRECT_VIDEO_BYTES = 20_000;

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return; // não associado a uma aba visível
    handleNetworkResponse(details).catch((err) => log.warn('Erro processando resposta de rede:', err));
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders'],
);

async function handleNetworkResponse(details) {
  const contentType = getHeader(details.responseHeaders, 'content-type');
  const contentLength = getHeader(details.responseHeaders, 'content-length');
  const contentRange = getHeader(details.responseHeaders, 'content-range');
  const classification = classifyMedia(details.url, contentType);
  if (!classification) return;

  const tabState = getTabState(details.tabId);

  if (classification.media === 'manifest' && classification.kind === 'hls') {
    await handleHlsManifest(details.tabId, tabState, details.url);
    return;
  }

  if (classification.media === 'manifest' && classification.kind === 'dash') {
    await handleDashManifest(details.tabId, tabState, details.url);
    return;
  }

  if (classification.kind === 'direct' && classification.media === 'video') {
    const rangeTotal = parseContentRangeTotal(contentRange);
    const partialLength = contentLength ? Number(contentLength) : null;

    // Chunk de range request sem indicação do tamanho total e minúsculo:
    // descarta (ver MIN_PLAUSIBLE_DIRECT_VIDEO_BYTES acima).
    if (!rangeTotal && partialLength != null && partialLength < MIN_PLAUSIBLE_DIRECT_VIDEO_BYTES) {
      return;
    }

    const key = groupKey(details.url);
    const group = ensureGroup(tabState, key, { kind: 'direct', sourceUrl: details.url, pageUrl: tabState.pageUrl });
    upsertQuality(group, {
      url: details.url,
      container: classification.container,
      kind: 'direct',
      width: null,
      height: null,
      bitrate: null,
      codecs: null,
      hasAudio: true,
      estimatedSize: rangeTotal || partialLength,
      isDRM: false,
    });
    sortQualitiesDesc(group);
    pushRecentDetection(tabState, { url: details.url, groupId: key, ts: Date.now() });
    notifyTabUpdated(details.tabId);
  }
}

async function handleHlsManifest(tabId, tabState, url) {
  try {
    const text = await fetch(url).then((r) => r.text());
    const parsed = parseM3U8(text, url);
    const key = groupKey(url);
    const group = ensureGroup(tabState, key, { kind: 'hls', sourceUrl: url, pageUrl: tabState.pageUrl });

    if (parsed.type === 'master') {
      for (const variant of parsed.variants) {
        upsertQuality(group, {
          url: variant.url,
          container: 'm3u8',
          kind: 'hls',
          width: variant.width,
          height: variant.height,
          bitrate: variant.bandwidth,
          codecs: variant.codecs,
          hasAudio: !variant.audioUrl, // se não há grupo de áudio separado, presume-se áudio embutido
          audioUrl: variant.audioUrl || null,
          estimatedSize: null,
          isDRM: false,
        });
      }
    } else {
      // Media playlist direta (sem master) — uma única qualidade
      upsertQuality(group, {
        url,
        container: 'm3u8',
        kind: 'hls',
        width: null,
        height: null,
        bitrate: null,
        codecs: null,
        hasAudio: true,
        estimatedSize: null,
        isDRM: parsed.keyInfo.isDrm,
        drmSystem: parsed.keyInfo.drmName,
      });
      if (parsed.keyInfo.isDrm) {
        group.isDRM = true;
        group.drmSystem = parsed.keyInfo.drmName;
      }
    }

    sortQualitiesDesc(group);
    pushRecentDetection(tabState, { url, groupId: key, ts: Date.now() });
    notifyTabUpdated(tabId);
  } catch (err) {
    log.warn('Falha ao processar playlist HLS:', url, err);
  }
}

async function handleDashManifest(tabId, tabState, url) {
  try {
    const text = await fetch(url).then((r) => r.text());
    const parsed = parseMPD(text, url);
    const key = groupKey(url);
    const group = ensureGroup(tabState, key, { kind: 'dash', sourceUrl: url, pageUrl: tabState.pageUrl });

    if (parsed.isDRM) {
      group.isDRM = true;
      group.drmSystem = parsed.drmSystems.join(', ') || 'DRM desconhecido';
    }

    const { videos, bestAudio } = summarizeAdaptationSets(parsed.adaptationSets);
    for (const rep of videos) {
      upsertQuality(group, {
        url: rep.baseUrl,
        container: 'mp4',
        kind: 'dash',
        width: rep.width,
        height: rep.height,
        bitrate: rep.bandwidth,
        codecs: rep.codecs,
        hasAudio: false, // DASH normalmente separa áudio/vídeo
        audioRepresentationId: bestAudio ? bestAudio.representationId : null,
        estimatedSize: null,
        isDRM: rep.isDRM,
        drmSystem: rep.drmSystems.join(', ') || null,
        _dashRepresentation: rep,
        _dashBestAudio: bestAudio,
      });
    }

    sortQualitiesDesc(group);
    pushRecentDetection(tabState, { url, groupId: key, ts: Date.now() });
    notifyTabUpdated(tabId);
  } catch (err) {
    log.warn('Falha ao processar manifesto DASH:', url, err);
  }
}

// ---------------------------------------------------------------------
// Mensagens dos content scripts
// ---------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  if (message.type === 'VIDEO_ELEMENT_FOUND' && tabId != null) {
    handleVideoElementFound(tabId, message.payload);
    return false;
  }

  if (message.type === 'DRM_SIGNAL' && tabId != null) {
    handleDrmSignal(tabId, message.payload);
    return false;
  }

  if (message.type === 'MSE_SIGNAL' && tabId != null) {
    handleMseSignal(tabId, message.payload);
    return false;
  }

  if (message.type === 'MEDIA_URL_SEEN' && tabId != null) {
    // Sinal de correlação (URL usada pelo player via fetch/XHR). O
    // webRequest já classifica/detecta a URL de qualquer forma; aqui só
    // guardamos o hint para associar a fonte real de um <video blob:...>.
    const state = getTabState(tabId);
    pushRecentDetection(state, { url: message.payload.url, groupId: null, ts: Date.now() });
    return false;
  }

  // Resposta do content script a um pedido de leitura de blob (ver
  // requestBlobBytesFromTab). Não depende de tabId porque é casado por
  // requestId, que já identifica o pedido de forma única.
  if (message.type === 'BLOB_BYTES_RESULT') {
    const resolve = pendingBlobRequests.get(message.requestId);
    if (resolve) {
      pendingBlobRequests.delete(message.requestId);
      resolve(
        message.ok
          ? { ok: true, streams: message.streams }
          : { ok: false, error: message.error },
      );
    }
    return false;
  }

  // Mensagens do popup (respondem de forma assíncrona)
  if (message.type === 'GET_TAB_MEDIA') {
    handleGetTabMedia(message.tabId).then(sendResponse);
    return true;
  }

  if (message.type === 'DOWNLOAD_BEST' || message.type === 'DOWNLOAD_QUALITY') {
    handleDownloadRequest(message).then(sendResponse).catch((err) => {
      log.error('Erro no download:', err);
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  // Clique no botão sobreposto a um <video> específico na página (in-page).
  if (message.type === 'DOWNLOAD_FOR_ELEMENT') {
    if (tabId == null) {
      sendResponse({ ok: false, error: 'Aba não encontrada' });
      return false;
    }
    handleDownloadRequest({ ...message, tabId }).then(sendResponse).catch((err) => {
      log.error('Erro no download:', err);
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  return false;
});

function handleVideoElementFound(tabId, payload) {
  const tabState = getTabState(tabId);
  if (payload.pageTitle) tabState.pageTitle = payload.pageTitle;
  if (payload.ogTitle) tabState.ogTitle = payload.ogTitle;
  if (payload.pageUrl) tabState.pageUrl = payload.pageUrl;

  if (payload.isBlob) {
    const key = `blob:${payload.pageUrl}`;
    const group = ensureGroup(tabState, key, {
      kind: 'blob',
      sourceUrl: payload.src,
      pageUrl: payload.pageUrl,
      pageTitle: payload.pageTitle,
      ogTitle: payload.ogTitle,
    });
    group.sourceUrl = payload.src;
    group.isDRM = tabState.pageDrm.isDRM || group.isDRM;
    group.drmSystem = tabState.pageDrm.drmSystem || group.drmSystem;
    // melhor palpite de fonte real: detecção de rede mais recente da aba
    const hint = [...tabState.recentDetections].reverse()[0];
    group.possibleSourceGroupId = hint && hint.groupId && hint.groupId !== key ? hint.groupId : null;

    // Diferente de HLS/DASH, um grupo "blob" não tem múltiplas qualidades
    // selecionáveis de verdade — é sempre a mesma sessão de reprodução. E
    // URLs blob: são efêmeras: o navegador gera uma nova a cada
    // URL.createObjectURL(), então o player costuma recriar uma (ex.: ao
    // sair/voltar ao viewport num feed, ou trocar de faixa). Por isso a
    // entrada é SEMPRE substituída pela mais recente, nunca acumulada —
    // acumular gerava dezenas de linhas "1080p" duplicadas com URLs já
    // revogadas por trás.
    group.qualities = [
      {
        url: payload.src,
        container: 'blob',
        kind: 'blob',
        width: payload.width,
        height: payload.height,
        bitrate: null,
        codecs: null,
        hasAudio: true,
        estimatedSize: null,
        isDRM: group.isDRM,
        drmSystem: group.drmSystem,
        title: payload.title,
        _key: 'blob-current',
      },
    ];
    notifyTabUpdated(tabId);
    return;
  }

  if (payload.src && !payload.src.startsWith('blob:')) {
    // <video src="https://.../arquivo.mp4"> direto — complementa o que o
    // webRequest também deve detectar, garantindo o título do vídeo.
    const key = groupKey(payload.src);
    const group = ensureGroup(tabState, key, {
      kind: 'direct',
      sourceUrl: payload.src,
      pageUrl: payload.pageUrl,
      pageTitle: payload.pageTitle,
      ogTitle: payload.ogTitle,
    });
    if (payload.title) group.videoTitle = payload.title;
    notifyTabUpdated(tabId);
  }
}

function handleDrmSignal(tabId, payload) {
  const tabState = getTabState(tabId);
  const drmName = payload.keySystem ? drmNameFromKeySystem(payload.keySystem) : 'DRM (EME)';
  const combined = combineDrmSignals({ pageEmeDrmName: drmName, manifestDrmNames: [] });
  tabState.pageDrm = combined;

  // Propaga para grupos do tipo blob dessa aba (fonte mais provável do EME)
  for (const group of tabState.groups.values()) {
    if (group.kind === 'blob') {
      group.isDRM = true;
      group.drmSystem = combined.drmSystem;
      for (const q of group.qualities) {
        q.isDRM = true;
        q.drmSystem = combined.drmSystem;
      }
    }
  }
  notifyTabUpdated(tabId);
}

function handleMseSignal(tabId, payload) {
  const tabState = getTabState(tabId);
  tabState.lastMseMimeType = payload.mimeType || tabState.lastMseMimeType;
}

// ---------------------------------------------------------------------
// Ciclo de vida da aba
// ---------------------------------------------------------------------

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStates.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const state = getTabState(tabId);
  if (state.pageUrl && state.pageUrl !== changeInfo.url) {
    // Nova navegação: reinicia a detecção para esta aba
    tabStates.set(tabId, newTabState());
    getTabState(tabId).pageUrl = changeInfo.url;
    updateBadge(tabId);
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => updateBadge(tabId));

// ---------------------------------------------------------------------
// API para o popup: leitura de estado
// ---------------------------------------------------------------------

async function handleGetTabMedia(tabId) {
  const state = getTabState(tabId);
  const groups = [...state.groups.values()].map(serializeGroup);
  return {
    ok: true,
    pageDrm: state.pageDrm,
    groups,
  };
}

function serializeGroup(group) {
  return {
    groupId: group.groupId,
    kind: group.kind,
    sourceUrl: group.sourceUrl,
    domain: group.domain,
    pageTitle: group.pageTitle,
    ogTitle: group.ogTitle,
    videoTitle: group.videoTitle || null,
    isDRM: group.isDRM,
    drmSystem: group.drmSystem,
    possibleSourceGroupId: group.possibleSourceGroupId || null,
    qualities: group.qualities.map((q, i) => ({
      index: i,
      label: q.width && q.height ? resolutionLabel(q.width, q.height) : (q.kind === 'blob' ? 'Detectado (blob)' : 'Qualidade única'),
      width: q.width,
      height: q.height,
      bitrateLabel: formatBitrate(q.bitrate),
      estimatedSizeLabel: formatBytes(q.estimatedSize),
      codecs: q.codecs,
      container: q.container,
      hasAudio: q.hasAudio,
      isDRM: !!q.isDRM,
      drmSystem: q.drmSystem || null,
    })),
  };
}

// ---------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------

function setDownloadState(tabId, downloadKey, patch) {
  const state = getTabState(tabId);
  const current = state.downloads.get(downloadKey) || { state: 'Detectado', percent: 0 };
  // requestId, uma vez definido no primeiro push, persiste nos seguintes
  // (o merge abaixo não some com ele mesmo que `patch` não o repita).
  const next = { ...current, ...patch };
  state.downloads.set(downloadKey, next);
  const msg = { type: 'DOWNLOAD_STATE', tabId, downloadKey, requestId: next.requestId || null, status: next };
  // Popup (se aberto) escuta via runtime.sendMessage...
  chrome.runtime.sendMessage(msg).catch(() => {});
  // ...e o botão sobreposto no content script da aba escuta via tabs.sendMessage.
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
  return next;
}

/**
 * Encontra o grupo de mídia correspondente a um elemento <video> da página,
 * a partir do descritor enviado pelo content script (botão sobreposto).
 * Tenta a URL direta do elemento, depois cada <source>, depois — se for
 * blob: — o grupo "blob" da página.
 */
function findGroupForElement(state, payload) {
  if (payload.isBlob) {
    return state.groups.get(`blob:${payload.pageUrl}`) || null;
  }
  const candidates = [payload.src, ...((payload.sources || []).map((s) => s.src))].filter(Boolean);
  for (const url of candidates) {
    const g = state.groups.get(groupKey(url));
    if (g) return g;
  }
  return null;
}

/**
 * Resolve {group, quality, downloadKey} a partir da mensagem recebida,
 * cobrindo os três formatos: DOWNLOAD_BEST/DOWNLOAD_QUALITY (popup, por
 * groupId) e DOWNLOAD_FOR_ELEMENT (botão sobreposto, por descritor do
 * elemento <video>).
 */
function resolveDownloadTarget(message) {
  const state = getTabState(message.tabId);

  if (message.type === 'DOWNLOAD_FOR_ELEMENT') {
    const payload = message.payload || {};

    if (payload.isBlob) {
      // Nunca usa a qualidade guardada aqui: blob: é efêmera (o navegador
      // gera uma URL nova a cada URL.createObjectURL(), e o player pode
      // ter revogado a antiga entre a detecção e o clique). Usa sempre a
      // URL lida agora, na página, no momento do clique — que é o que
      // getMeta() do content script manda em payload.src.
      if (!payload.src) return { error: 'Nenhum vídeo encontrado nesta aba.' };
      const key = `blob:${payload.pageUrl}`;
      const group =
        state.groups.get(key) ||
        ensureGroup(state, key, {
          kind: 'blob',
          sourceUrl: payload.src,
          pageUrl: payload.pageUrl,
          pageTitle: payload.pageTitle,
          ogTitle: payload.ogTitle,
        });
      const quality = {
        url: payload.src,
        container: 'blob',
        kind: 'blob',
        width: payload.width || null,
        height: payload.height || null,
        isDRM: group.isDRM,
        drmSystem: group.drmSystem,
      };
      return { group, quality, downloadKey: `${group.groupId}::0`, requestId: payload.requestId || null };
    }

    const group = findGroupForElement(state, payload);
    if (!group) return { error: 'Nenhum vídeo encontrado nesta aba.' };
    const quality = group.qualities[0];
    if (!quality) return { error: 'Qualidade não encontrada.' };
    return { group, quality, downloadKey: `${group.groupId}::0`, requestId: payload.requestId || null };
  }

  const group = state.groups.get(message.groupId);
  if (!group) return { error: 'Vídeo não encontrado nesta aba.' };
  const qualityIndex = message.type === 'DOWNLOAD_BEST' ? 0 : message.qualityIndex;
  const quality = group.qualities[qualityIndex];
  if (!quality) return { error: 'Qualidade não encontrada.' };
  return { group, quality, downloadKey: `${group.groupId}::${qualityIndex}`, requestId: null };
}

async function handleDownloadRequest(message) {
  const { tabId } = message;
  const resolved = resolveDownloadTarget(message);
  if (resolved.error) return { ok: false, error: resolved.error };

  const { group, quality, downloadKey, requestId } = resolved;

  if (group.isDRM || quality.isDRM) {
    setDownloadState(tabId, downloadKey, { state: 'Erro', error: 'Conteúdo protegido por DRM', percent: 0, requestId });
    return { ok: false, error: 'Conteúdo protegido por DRM' };
  }

  // Responde imediatamente com o downloadKey — o progresso real chega por
  // eventos DOWNLOAD_STATE (o botão/popup já ficam escutando por ele).
  // Isso é o que permite ao botão sobreposto no vídeo acompanhar o próprio
  // download sem precisar esperar o download inteiro terminar para saber
  // que ele começou. `requestId` (quando vem do botão sobreposto) viaja
  // junto em todo push de estado, porque o content script sabe o
  // requestId ANTES de receber esta resposta — evita perder o primeiro
  // push em downloads que falham/terminam rápido demais (efetivamente
  // síncronos, antes do round-trip da resposta chegar).
  runDownload(tabId, group, quality, downloadKey, requestId).catch((err) => {
    log.error('Falha no download:', err);
    setDownloadState(tabId, downloadKey, { state: 'Erro', error: humanizeError(err), percent: 0 });
  });

  return { ok: true, downloadKey };
}

async function runDownload(tabId, group, quality, downloadKey, requestId) {
  setDownloadState(tabId, downloadKey, { state: 'Analisando', percent: 0, requestId });

  if (group.kind === 'direct') {
    await downloadDirect(tabId, group, quality, downloadKey);
  } else if (group.kind === 'hls') {
    await downloadHls(tabId, group, quality, downloadKey);
  } else if (group.kind === 'dash') {
    await downloadDash(tabId, group, quality, downloadKey);
  } else if (group.kind === 'blob') {
    await downloadBlobGroup(tabId, group, quality, downloadKey);
  } else {
    throw new Error('Formato não suportado');
  }
}

// Mensagens já em português, aprovadas pelo escopo do projeto — devem
// chegar ao usuário como estão, sem virar o fallback genérico abaixo.
const PASSTHROUGH_ERROR_MESSAGES = new Set([
  'Formato não suportado',
  'Stream ainda não carregada',
  'Nenhum vídeo encontrado nesta aba.',
  'Qualidade não encontrada.',
  'Não foi possível acessar a mídia',
]);

function humanizeError(err) {
  const msg = err?.message || String(err);
  if (/DRM/i.test(msg)) return 'Conteúdo protegido por DRM';
  if (PASSTHROUGH_ERROR_MESSAGES.has(msg)) return msg;
  if (/HTTP 4|HTTP 5/.test(msg)) return 'Não foi possível acessar a mídia';
  if (/Nenhum segmento/.test(msg)) return 'Stream ainda não carregada';
  return 'Erro ao processar o download';
}

function filenameFor(tabId, group, quality, ext, labelSuffix = '') {
  const state = getTabState(tabId);
  const baseLabel = quality.height ? resolutionLabel(quality.width, quality.height) : null;
  const label = [baseLabel, labelSuffix].filter(Boolean).join('_') || null;
  return buildFilename({
    videoTitle: group.videoTitle,
    ogTitle: group.ogTitle || state.ogTitle,
    pageTitle: group.pageTitle || state.pageTitle,
    url: quality.url,
    label,
    ext,
  });
}

async function downloadDirect(tabId, group, quality, downloadKey) {
  setDownloadState(tabId, downloadKey, { state: 'Preparando', percent: 0 });
  const filename = filenameFor(tabId, group, quality, quality.container);
  setDownloadState(tabId, downloadKey, { state: 'Baixando vídeo', percent: 0 });
  const blob = await fetchDirectVideo(quality.url, (p) => {
    const percent = p.totalBytes > 0 ? Math.round((p.bytesReceived / p.totalBytes) * 100) : 0;
    setDownloadState(tabId, downloadKey, {
      state: 'Baixando vídeo',
      percent,
      bytesReceived: p.bytesReceived,
      totalBytes: p.totalBytes,
    });
  });
  const id = await downloadBlob(blob, filename);
  await trackDownload(id, () => {});
  setDownloadState(tabId, downloadKey, { state: 'Concluído', percent: 100 });
}

async function downloadHls(tabId, group, quality, downloadKey) {
  setDownloadState(tabId, downloadKey, { state: 'Preparando', percent: 0 });
  const mediaText = await fetch(quality.url).then((r) => r.text());
  const media = parseM3U8(mediaText, quality.url);

  if (media.type !== 'media') throw new Error('Formato não suportado');
  if (media.keyInfo.encrypted) {
    if (media.keyInfo.isDrm) throw new Error('Conteúdo protegido por DRM');
    throw new Error('Formato não suportado'); // AES-128 simples: fora do MVP
  }
  if (!media.segments.length) throw new Error('Nenhum segmento para baixar');

  setDownloadState(tabId, downloadKey, { state: 'Baixando vídeo', percent: 0 });
  const blob = await downloadAndConcatSegments(
    { initUrl: media.initSegmentUrl, segments: media.segments.map((s) => s.url), mimeType: media.initSegmentUrl ? 'video/mp4' : 'video/mp2t' },
    ({ done, total }) => {
      setDownloadState(tabId, downloadKey, { state: 'Baixando vídeo', percent: Math.round((done / total) * 90) });
    },
  );

  setDownloadState(tabId, downloadKey, { state: 'Finalizando', percent: 95 });
  const ext = media.initSegmentUrl ? 'mp4' : 'ts';
  const filename = filenameFor(tabId, group, quality, ext);
  const id = await downloadBlob(blob, filename);
  await trackDownload(id, () => {});
  setDownloadState(tabId, downloadKey, { state: 'Concluído', percent: 100 });

  if (quality.audioUrl) {
    log.info('Áudio em rendition separada detectado — mux automático ainda não implementado (fase 2).');
  }
}

async function downloadDash(tabId, group, quality, downloadKey) {
  setDownloadState(tabId, downloadKey, { state: 'Preparando', percent: 0 });
  const rep = quality._dashRepresentation;
  if (!rep) throw new Error('Formato não suportado');

  const videoSegs = buildSegmentUrls(rep);
  if (videoSegs.needsDurationExpansion || !videoSegs.segments.length) {
    throw new Error('Stream ainda não carregada');
  }

  setDownloadState(tabId, downloadKey, { state: 'Baixando vídeo', percent: 0 });
  const videoBlob = await downloadAndConcatSegments(
    { initUrl: videoSegs.initUrl, segments: videoSegs.segments, mimeType: 'video/mp4' },
    ({ done, total }) => {
      setDownloadState(tabId, downloadKey, { state: 'Baixando vídeo', percent: Math.round((done / total) * 45) });
    },
  );
  const videoFilename = filenameFor(tabId, group, quality, 'mp4');
  const videoId = await downloadBlob(videoBlob, videoFilename);
  await trackDownload(videoId, () => {});

  const bestAudio = quality._dashBestAudio;
  if (bestAudio && !bestAudio.isDRM) {
    setDownloadState(tabId, downloadKey, { state: 'Baixando áudio', percent: 50 });
    const audioSegs = buildSegmentUrls(bestAudio);
    if (audioSegs.segments.length) {
      const audioBlob = await downloadAndConcatSegments(
        { initUrl: audioSegs.initUrl, segments: audioSegs.segments, mimeType: 'audio/mp4' },
        ({ done, total }) => {
          setDownloadState(tabId, downloadKey, { state: 'Baixando áudio', percent: 50 + Math.round((done / total) * 45) });
        },
      );
      const audioFilename = filenameFor(tabId, group, quality, 'mp4', 'audio');
      const audioId = await downloadBlob(audioBlob, audioFilename);
      await trackDownload(audioId, () => {});
      log.info('Vídeo e áudio DASH baixados como arquivos separados — mux automático ainda não implementado (fase 2).');
    }
  } else if (bestAudio && bestAudio.isDRM) {
    log.warn('Áudio correspondente está protegido por DRM — apenas o vídeo foi baixado.');
  }

  setDownloadState(tabId, downloadKey, { state: 'Concluído', percent: 100 });
}

/**
 * Pede ao content script da aba para ler os bytes de uma URL blob: (fetch
 * feito na própria página, onde o blob é resolvível) e devolver em base64.
 * Cobre principalmente gravações locais (MediaRecorder — screen/webcam
 * recording) cujo conteúdo nunca passa pela rede, então não há nenhuma
 * requisição para correlacionar. Para blobs alimentados por MediaSource
 * (streaming adaptativo), o resultado é o que a página tiver bufferizado
 * no momento — pode não ser o vídeo completo (limitação conhecida).
 */
function requestBlobBytesFromTab(tabId, url) {
  return new Promise((resolve) => {
    const requestId = `blob_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const timeout = setTimeout(() => {
      pendingBlobRequests.delete(requestId);
      resolve({ ok: false, error: 'Não foi possível acessar a mídia' });
    }, BLOB_FETCH_TIMEOUT_MS);

    pendingBlobRequests.set(requestId, (result) => {
      clearTimeout(timeout);
      resolve(result);
    });

    chrome.tabs.sendMessage(tabId, { type: 'FETCH_BLOB_BYTES', requestId, url }).catch(() => {
      clearTimeout(timeout);
      pendingBlobRequests.delete(requestId);
      resolve({ ok: false, error: 'Não foi possível acessar a mídia' });
    });
  });
}

async function downloadBlobGroup(tabId, group, quality, downloadKey) {
  setDownloadState(tabId, downloadKey, { state: 'Preparando', percent: 10 });
  const result = await requestBlobBytesFromTab(tabId, quality.url);
  if (!result.ok) throw new Error(result.error || 'Não foi possível acessar a mídia');

  // Normalmente um único stream (blob simples, ou um MediaSource com um
  // SourceBuffer só, vídeo+áudio já muxados). Mas alguns players (ex.:
  // YouTube) usam um SourceBuffer para vídeo e outro para áudio — nesse
  // caso `streams` tem mais de um item (ver content/page-hook.js), e cada
  // um vira um arquivo separado, do mesmo jeito que HLS/DASH já fazem
  // quando o áudio vem separado (bug real corrigido: antes o áudio de
  // players com SourceBuffers separados era descartado silenciosamente,
  // baixando o vídeo mudo).
  const streams = (result.streams || []).filter((s) => s.base64);
  if (!streams.length) throw new Error('Não foi possível acessar a mídia');

  const videoStream = streams.find((s) => s.kind === 'video') || streams[0];
  const otherStreams = streams.filter((s) => s !== videoStream);

  setDownloadState(tabId, downloadKey, { state: 'Finalizando', percent: otherStreams.length ? 45 : 90 });
  const videoFile = await fetch(`data:${videoStream.mimeType};base64,${videoStream.base64}`).then((r) => r.blob());
  if (!videoFile.size) throw new Error('Não foi possível acessar a mídia');
  const videoExt = videoStream.mimeType.includes('webm') ? 'webm' : 'mp4';
  const videoFilename = filenameFor(tabId, group, quality, videoExt, otherStreams.length ? 'video' : '');
  const videoId = await downloadBlob(videoFile, videoFilename);
  await trackDownload(videoId, () => {});

  for (const [i, stream] of otherStreams.entries()) {
    setDownloadState(tabId, downloadKey, { state: 'Baixando áudio', percent: 50 + Math.round((i / otherStreams.length) * 40) });
    const file = await fetch(`data:${stream.mimeType};base64,${stream.base64}`).then((r) => r.blob());
    if (!file.size) continue;
    const ext = stream.mimeType.includes('webm') ? 'webm' : 'mp4';
    const label = stream.kind === 'audio' || otherStreams.length === 1 ? 'audio' : `audio${i + 1}`;
    const filename = filenameFor(tabId, group, quality, ext, label);
    const id = await downloadBlob(file, filename);
    await trackDownload(id, () => {});
  }
  if (otherStreams.length) {
    log.info('Vídeo e áudio capturados via MediaSource (SourceBuffers separados) baixados como arquivos separados — mux automático ainda não implementado (fase 2).');
  }

  setDownloadState(tabId, downloadKey, { state: 'Concluído', percent: 100 });
}
