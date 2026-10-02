// downloader/segment-downloader.js
// Baixa segmentos (HLS .ts/.m4s ou DASH SegmentTemplate/SegmentList) em
// ordem, concatena em um único arquivo e dispara o download via
// chrome.downloads. Concatenação de segmentos MPEG-TS ou fMP4 (mesmo
// init) produz um arquivo final reproduzível sem necessidade de
// recodificação (remux por concatenação).

import { createLogger } from '../utils/logger.js';

const log = createLogger('segment-downloader');

const CONCURRENCY = 5;
const MAX_RETRIES = 2;

async function fetchArrayBuffer(url, retries = MAX_RETRIES) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.arrayBuffer();
  } catch (err) {
    if (retries > 0) {
      await new Promise((r) => setTimeout(r, 300));
      return fetchArrayBuffer(url, retries - 1);
    }
    throw err;
  }
}

/**
 * Baixa uma lista de segmentos preservando a ordem final, com concorrência
 * limitada, e reporta progresso incremental.
 */
async function fetchSegmentsInOrder(segmentUrls, onProgress) {
  const buffers = new Array(segmentUrls.length);
  let completed = 0;
  let index = 0;

  async function worker() {
    while (index < segmentUrls.length) {
      const i = index;
      index += 1;
      buffers[i] = await fetchArrayBuffer(segmentUrls[i]);
      completed += 1;
      onProgress?.(completed, segmentUrls.length);
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, segmentUrls.length) }, () => worker());
  await Promise.all(workers);
  return buffers;
}

/**
 * Baixa init (opcional) + segmentos, concatena e retorna um Blob pronto
 * para download.
 */
export async function downloadAndConcatSegments({ initUrl, segments, mimeType }, onProgress) {
  if (!segments || segments.length === 0) {
    throw new Error('Nenhum segmento para baixar');
  }

  log.info(`Baixando ${segments.length} segmentos${initUrl ? ' + init' : ''}`);

  const parts = [];
  if (initUrl) {
    parts.push(await fetchArrayBuffer(initUrl));
  }

  const segBuffers = await fetchSegmentsInOrder(segments, (done, total) => {
    onProgress?.({ done: done + (initUrl ? 1 : 0), total: total + (initUrl ? 1 : 0) });
  });

  parts.push(...segBuffers);

  return new Blob(parts, { type: mimeType || 'video/mp2t' });
}

// O service worker do Manifest V3 não implementa URL.createObjectURL (a API
// existe em páginas normais, mas não nesse contexto — confirmado em
// runtime: `typeof URL.createObjectURL` é `undefined` no service worker).
// Sem um object URL não há como entregar um Blob montado em memória (vídeo
// HLS/DASH concatenado, ou blob capturado da página) para chrome.downloads,
// que só aceita uma URL.
//
// Duas alternativas foram testadas e descartadas antes desta:
// 1. Criar o object URL num documento offscreen e chamar
//    chrome.downloads.download() a partir do service worker com essa URL:
//    falha com erro FILE_FAILED — um blob: URL só é resolvível pelo mesmo
//    contexto de execução que o criou, mesmo sendo a mesma extensão.
// 2. Converter o Blob para um data: URL (base64) e baixar isso
//    diretamente do service worker: funciona (o arquivo baixa completo e
//    correto), mas o Chrome ignora a opção `filename` para URLs data: e
//    usa sempre um nome genérico ("download"/"download.mp4") — confirmado
//    em teste manual, com e sem chrome.downloads.onDeterminingFilename.
//
// 3. Chamar chrome.downloads.download() diretamente do documento
//    offscreen: falha porque documentos offscreen não têm acesso a
//    chrome.downloads (API ausente nesse contexto — confirmado em
//    runtime).
//
// Solução: o documento offscreen cria o object URL e dispara o download
// através do mecanismo nativo do HTML — um <a href="blob:..." download>
// clicado programaticamente (não depende de chrome.downloads, então
// funciona lá; e por ser o mesmo contexto que criou o blob, não esbarra
// no problema #1). O clique ainda gera uma entrada normal em
// chrome.downloads, que o service worker localiza depois por URL para
// acompanhar o progresso (ver findDownloadIdByUrl). Os bytes viajam do
// service worker para o documento offscreen como base64 (chrome.runtime.
// sendMessage não entrega um ArrayBuffer bruto de forma confiável nesse
// sentido — testado e confirmado: o payload chegava corrompido).
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

const OFFSCREEN_URL = 'offscreen/offscreen.html';
let offscreenReady = null;

async function ensureOffscreenDocument() {
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    const has = await chrome.offscreen.hasDocument();
    if (has) return;
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['BLOBS'],
      justification: 'Criar object URL de um Blob e disparar o download — API ausente no service worker.',
    });
  })();
  try {
    await offscreenReady;
  } catch (err) {
    offscreenReady = null; // permite tentar de novo na próxima chamada
    throw err;
  }
  return offscreenReady;
}

// O clique no <a download> (ver offscreen/offscreen.js) não passa pela API
// chrome.downloads, então não temos o downloadId de volta diretamente —
// mas ele ainda cria uma entrada normal em chrome.downloads (é o mesmo
// mecanismo nativo do navegador). Localiza essa entrada pela URL exata do
// blob usada no clique, para poder acompanhar o progresso como nos outros
// caminhos de download.
async function findDownloadIdByUrl(url, { retries = 20, delayMs = 150 } = {}) {
  for (let i = 0; i < retries; i++) {
    const items = await chrome.downloads.search({ url, limit: 1 });
    if (items && items.length) return items[0].id;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error('Falha ao iniciar download');
}

/**
 * Dispara o download de um Blob já montado. Delegado ao documento
 * offscreen (ver comentário acima), que cria o object URL e o baixa via
 * um <a download> clicado programaticamente.
 */
export async function downloadBlob(blob, filename) {
  const buffer = await blob.arrayBuffer();
  const mimeType = blob.type || 'application/octet-stream';
  const base64 = arrayBufferToBase64(buffer);
  await ensureOffscreenDocument();
  const res = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_DOWNLOAD_BLOB', base64, mimeType, filename });
  if (!res || !res.ok) throw new Error(res?.error || 'Falha ao iniciar download');
  return findDownloadIdByUrl(res.url);
}
