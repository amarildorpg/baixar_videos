// content/page-hook.js
// Executado no MAIN world da página (mesmo contexto do JS da própria página),
// necessário para observar chamadas que o player faz diretamente na página
// (EME, MediaSource, fetch/XHR) — um content script isolado não consegue
// interceptar isso.
//
// Este script é somente observacional: ele NUNCA modifica, bloqueia ou
// atrasa nenhuma chamada. Todo wrap chama a função original normalmente
// e apenas relata o que foi observado via postMessage para o content
// script isolado (video-detector.js), que repassa ao background.
//
// Nada aqui tenta contornar DRM — a detecção de EME serve apenas para
// avisar o usuário de que a mídia está protegida.
//
// --- Captura de blob/MediaSource ---
// Uma URL blob: costuma ser revogada (URL.revokeObjectURL) pelo próprio
// player pouco depois de criada — às vezes tão rápido que tentar
// fetch(blobUrl) mais tarde (ex.: quando o usuário clica em "baixar")
// falha com net::ERR_FILE_NOT_FOUND, mesmo a URL tendo sido válida
// segundos antes. Por isso, em vez de tentar buscar a URL depois, este
// script guarda uma REFERÊNCIA aos dados no momento em que são criados:
//   - Blob simples (ex.: gravação local via MediaRecorder): guarda o
//     próprio objeto Blob quando URL.createObjectURL(blob) é chamado.
//     Revogar a URL depois não afeta o objeto Blob em si.
//   - MediaSource (streaming adaptativo): guarda cada pedaço de dados
//     conforme SourceBuffer.appendBuffer(chunk) é chamado pelo player.
//     Na hora do download, esses pedaços são concatenados na ordem em
//     que foram anexados — reflete o que já foi bufferizado até aquele
//     momento, não necessariamente o vídeo inteiro.

(() => {
  const CHANNEL = '__vd_page_hook__';
  const BRIDGE_CHANNEL = '__vd_blob_bridge__';
  const seenUrls = new Set();

  function post(type, payload) {
    try {
      window.postMessage({ channel: CHANNEL, type, payload }, '*');
    } catch (_e) {
      // ignora — nunca deve quebrar a página
    }
  }

  function looksLikeMedia(url) {
    return /\.(m3u8|mpd|mp4|webm|m4s|ts)(\?|$)/i.test(url);
  }

  function reportUrlOnce(url, source) {
    if (!url || seenUrls.has(url)) return;
    seenUrls.add(url);
    if (looksLikeMedia(url)) {
      post('MEDIA_URL_SEEN', { url, source });
    }
  }

  // --- EME: detecção de DRM (somente leitura/observação) ---
  try {
    if (navigator.requestMediaKeySystemAccess) {
      const original = navigator.requestMediaKeySystemAccess.bind(navigator);
      navigator.requestMediaKeySystemAccess = function (keySystem, configs) {
        post('EME_REQUEST', { keySystem });
        return original(keySystem, configs);
      };
    }
  } catch (_e) {
    /* alguns sites bloqueiam redefinição — não é crítico */
  }

  document.addEventListener(
    'encrypted',
    (ev) => {
      try {
        post('EME_ENCRYPTED_EVENT', { initDataType: ev.initDataType });
      } catch (_e) {
        /* noop */
      }
    },
    true,
  );

  // --- Captura de blob:/MediaSource, ver comentário no topo do arquivo ---
  const MAX_TRACKED_URLS = 30;
  const blobUrlToBlob = new Map(); // url -> Blob
  const blobUrlToMediaSource = new Map(); // url -> MediaSource
  const sourceBuffersByMediaSource = new WeakMap(); // MediaSource -> SourceBuffer[]
  const chunksBySourceBuffer = new WeakMap(); // SourceBuffer -> ArrayBuffer[]
  const mimeTypeBySourceBuffer = new WeakMap(); // SourceBuffer -> mimeType

  function trackUrl(map, url, value) {
    if (map.size >= MAX_TRACKED_URLS && !map.has(url)) {
      const oldest = map.keys().next().value;
      map.delete(oldest);
    }
    map.set(url, value);
  }

  try {
    if (window.URL && URL.createObjectURL) {
      const originalCreateObjectURL = URL.createObjectURL.bind(URL);
      URL.createObjectURL = function (obj) {
        const url = originalCreateObjectURL(obj);
        try {
          if (typeof Blob !== 'undefined' && obj instanceof Blob) {
            trackUrl(blobUrlToBlob, url, obj);
          } else if (typeof MediaSource !== 'undefined' && obj instanceof MediaSource) {
            trackUrl(blobUrlToMediaSource, url, obj);
          }
        } catch (_e) {
          /* noop */
        }
        return url;
      };
    }
  } catch (_e) {
    /* noop */
  }

  // --- MediaSource: identificar mimeType usado em vídeos blob: e manter
  // referência dos SourceBuffers de cada MediaSource ---
  try {
    if (window.MediaSource && MediaSource.prototype.addSourceBuffer) {
      const originalAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
      MediaSource.prototype.addSourceBuffer = function (mimeType) {
        post('MSE_SOURCE_BUFFER', { mimeType, pageUrl: location.href });
        const sb = originalAddSourceBuffer.call(this, mimeType);
        try {
          if (!sourceBuffersByMediaSource.has(this)) sourceBuffersByMediaSource.set(this, []);
          sourceBuffersByMediaSource.get(this).push(sb);
          mimeTypeBySourceBuffer.set(sb, mimeType || '');
        } catch (_e) {
          /* noop */
        }
        return sb;
      };
    }
  } catch (_e) {
    /* noop */
  }

  // --- SourceBuffer: capturar cada pedaço de dados conforme é anexado ---
  try {
    if (window.SourceBuffer && SourceBuffer.prototype.appendBuffer) {
      const originalAppendBuffer = SourceBuffer.prototype.appendBuffer;
      SourceBuffer.prototype.appendBuffer = function (data) {
        try {
          let buf = null;
          if (data instanceof ArrayBuffer) buf = data.slice(0);
          else if (ArrayBuffer.isView(data)) buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
          if (buf) {
            if (!chunksBySourceBuffer.has(this)) chunksBySourceBuffer.set(this, []);
            chunksBySourceBuffer.get(this).push(buf);
          }
        } catch (_e) {
          /* noop */
        }
        return originalAppendBuffer.call(this, data);
      };
    }
  } catch (_e) {
    /* noop */
  }

  function guessKind(mimeType) {
    const m = (mimeType || '').toLowerCase();
    if (m.startsWith('audio')) return 'audio';
    if (m.startsWith('video')) return 'video';
    return 'unknown';
  }

  // O mimeType que SourceBuffer.addSourceBuffer() recebe costuma incluir
  // parâmetros de codec entre aspas com vírgula dentro (ex.:
  // `video/mp4; codecs="avc1.42E01E, mp4a.40.2"`) — útil para
  // classificar vídeo/áudio (guessKind), mas quebra a construção de um
  // data: URI mais tarde (background/service-worker.js), já que a
  // vírgula dentro das aspas do parâmetro `codecs` é confundida com o
  // separador entre o cabeçalho e os dados do data: URI (bug real:
  // arquivo baixado vinha maior que o esperado e corrompido). Só o tipo
  // base (`video/mp4`) é necessário a partir daqui — os codecs em si não
  // fazem diferença para o Blob final.
  function baseMimeType(mimeType) {
    return (mimeType || '').split(';')[0].trim() || 'video/mp4';
  }

  async function resolveBlobContent(url) {
    if (blobUrlToBlob.has(url)) {
      const blob = blobUrlToBlob.get(url);
      const buffer = await blob.arrayBuffer();
      const mimeType = blob.type || 'video/mp4';
      return { ok: true, streams: [{ buffer, mimeType: baseMimeType(mimeType), kind: guessKind(mimeType) || 'video' }], source: 'blob' };
    }

    if (blobUrlToMediaSource.has(url)) {
      const mediaSource = blobUrlToMediaSource.get(url);
      const buffers = sourceBuffersByMediaSource.get(mediaSource) || [];
      // Um MediaSource pode ter vários SourceBuffers — muitos players
      // (ex.: YouTube) usam um para vídeo e outro para áudio, em vez de
      // um único stream muxado. Antes só o que tinha mais bytes
      // acumulados era mantido (assumindo que fosse sempre o vídeo) e o
      // resto era descartado — na prática isso descartava o áudio inteiro
      // sempre que o player usava SourceBuffers separados (bug real:
      // vídeo baixava mudo). Agora todos os SourceBuffers com dados são
      // devolvidos como streams separados, do mesmo jeito que HLS/DASH já
      // fazem quando o áudio vem em rendition/Representation separada —
      // ver downloadBlobGroup em background/service-worker.js.
      const streams = [];
      for (const sb of buffers) {
        const chunks = chunksBySourceBuffer.get(sb) || [];
        const total = chunks.reduce((s, c) => s + c.byteLength, 0);
        if (!total) continue;
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) {
          merged.set(new Uint8Array(c), offset);
          offset += c.byteLength;
        }
        const mimeType = mimeTypeBySourceBuffer.get(sb) || 'video/mp4';
        streams.push({ buffer: merged.buffer, mimeType: baseMimeType(mimeType), kind: guessKind(mimeType), size: total });
      }
      if (!streams.length) return { ok: false, error: 'mse-empty' };
      // Vídeo primeiro (ou, se o mimeType não permitir saber, o maior —
      // mesma heurística de antes, só que agora como desempate, não como
      // critério para descartar os outros).
      streams.sort((a, b) => {
        if (a.kind === 'video' && b.kind !== 'video') return -1;
        if (b.kind === 'video' && a.kind !== 'video') return 1;
        return b.size - a.size;
      });
      return { ok: true, streams, source: 'mse' };
    }

    // Não capturado por nenhum dos dois wraps acima — último recurso,
    // funciona só se a página ainda não tiver revogado a URL.
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('fetch-failed');
      const blob = await res.blob();
      const buffer = await blob.arrayBuffer();
      const mimeType = blob.type || 'video/mp4';
      return { ok: true, streams: [{ buffer, mimeType: baseMimeType(mimeType), kind: guessKind(mimeType) || 'video' }], source: 'fetch' };
    } catch (_e) {
      return { ok: false, error: 'not-found' };
    }
  }

  // Ponte de pedido/resposta com o content script isolado (video-detector.js)
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.channel !== BRIDGE_CHANNEL) return;
    if (ev.data.type !== 'GET_BLOB_CONTENT') return;
    const { requestId, url } = ev.data;
    resolveBlobContent(url)
      .then((result) => {
        const transfer = result.streams ? result.streams.map((s) => s.buffer) : [];
        window.postMessage({ channel: BRIDGE_CHANNEL, type: 'BLOB_CONTENT_RESULT', requestId, ...result }, '*', transfer);
      })
      .catch(() => {
        window.postMessage({ channel: BRIDGE_CHANNEL, type: 'BLOB_CONTENT_RESULT', requestId, ok: false, error: 'internal' }, '*');
      });
  });

  // --- fetch: observar URLs de mídia requisitadas pela própria página ---
  try {
    if (window.fetch) {
      const originalFetch = window.fetch;
      window.fetch = function (input, init) {
        try {
          const url = typeof input === 'string' ? input : input?.url;
          reportUrlOnce(url, 'fetch');
        } catch (_e) {
          /* noop */
        }
        return originalFetch.call(this, input, init);
      };
    }
  } catch (_e) {
    /* noop */
  }

  // --- XMLHttpRequest: mesma ideia, para players que usam XHR ---
  try {
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      try {
        reportUrlOnce(url, 'xhr');
      } catch (_e) {
        /* noop */
      }
      return originalOpen.call(this, method, url, ...rest);
    };
  } catch (_e) {
    /* noop */
  }
})();
