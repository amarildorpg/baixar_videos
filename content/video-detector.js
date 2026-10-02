// content/video-detector.js
// Executa no isolated world (padrão) da página. Observa o DOM em busca de
// elementos <video>/<source>, recebe sinais do page-hook.js (MAIN world)
// via postMessage e repassa tudo para o service worker.
//
// Cuidados de performance: MutationObserver com debounce, sem polling por
// intervalo, e deduplicação local para não reenviar a mesma informação.

(() => {
  const CHANNEL = '__vd_page_hook__';
  const reported = new Set();
  let scanTimer = null;

  function safeSendMessage(message) {
    try {
      chrome.runtime.sendMessage(message).catch(() => {
        // contexto invalidado (extensão recarregada) — ignora silenciosamente
      });
    } catch (_e) {
      /* extensão pode ter sido recarregada; ignora */
    }
  }

  // --- Leitura de blob: sob pedido do background (ver FETCH_BLOB_BYTES) ---
  //
  // NÃO tenta mais dar fetch() na URL blob: diretamente daqui — muitos
  // players (Instagram incluso) revogam a URL quase instantaneamente
  // depois de criada, e fetch numa URL já revogada falha com
  // net::ERR_FILE_NOT_FOUND mesmo que a extensão a tenha visto "fresca"
  // há poucos instantes. Em vez disso, pede ao page-hook.js (MAIN world)
  // os dados que ele já capturou no momento da criação — de
  // Blob/SourceBuffer, não da URL — o que não é afetado por revogação
  // posterior. Ver comentário no topo de page-hook.js.
  const MAX_BLOB_BYTES = 300 * 1024 * 1024; // 300 MB — limite de segurança
  const BRIDGE_CHANNEL = '__vd_blob_bridge__';
  const pendingBridgeRequests = new Map(); // requestId -> resolve fn

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.channel !== BRIDGE_CHANNEL) return;
    if (ev.data.type !== 'BLOB_CONTENT_RESULT') return;
    const resolve = pendingBridgeRequests.get(ev.data.requestId);
    if (resolve) {
      pendingBridgeRequests.delete(ev.data.requestId);
      resolve(ev.data);
    }
  });

  function requestBlobContentFromPage(url, timeoutMs = 20000) {
    return new Promise((resolve) => {
      const bridgeRequestId = `bridge_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const timer = setTimeout(() => {
        pendingBridgeRequests.delete(bridgeRequestId);
        resolve({ ok: false, error: 'timeout' });
      }, timeoutMs);
      pendingBridgeRequests.set(bridgeRequestId, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      window.postMessage({ channel: BRIDGE_CHANNEL, type: 'GET_BLOB_CONTENT', requestId: bridgeRequestId, url }, '*');
    });
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  async function fetchBlobAndReply(requestId, url) {
    try {
      const result = await requestBlobContentFromPage(url);
      if (!result.ok || !result.streams || !result.streams.length) throw new Error(result.error || 'no-data');

      let totalBytes = 0;
      const streams = [];
      for (const s of result.streams) {
        if (!s.buffer || s.buffer.byteLength === 0) continue;
        totalBytes += s.buffer.byteLength;
        if (totalBytes > MAX_BLOB_BYTES) throw new Error('too-large');
        streams.push({ base64: arrayBufferToBase64(s.buffer), mimeType: s.mimeType || 'video/mp4', kind: s.kind || 'video' });
      }
      if (!streams.length) throw new Error('empty-blob');
      safeSendMessage({ type: 'BLOB_BYTES_RESULT', requestId, ok: true, streams });
    } catch (err) {
      // Log sempre visível (não só em modo debug) — é a única forma de o
      // usuário descobrir a causa real (URL revogada, blob vazio, erro de
      // rede etc.) já que a mensagem mostrada na UI é propositalmente
      // genérica. Aparece no console da PÁGINA (F12), não no do popup.
      console.warn('[VideoDownloader] Falha ao ler blob:', url, err);
      safeSendMessage({ type: 'BLOB_BYTES_RESULT', requestId, ok: false, error: 'Não foi possível acessar a mídia' });
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'FETCH_BLOB_BYTES') {
      fetchBlobAndReply(message.requestId, message.url);
      // Resposta chega separadamente via BLOB_BYTES_RESULT (pode demorar
      // e/ou ser grande) — não usamos sendResponse aqui.
    }
  });

  function getMeta(name, attr = 'name') {
    const el = document.querySelector(`meta[${attr}="${name}"]`);
    return el ? el.getAttribute('content') : null;
  }

  function pageMeta() {
    return {
      pageUrl: location.href,
      pageTitle: document.title || null,
      ogTitle: getMeta('og:title', 'property') || null,
      ogVideo: getMeta('og:video', 'property') || getMeta('og:video:url', 'property') || null,
    };
  }

  function describeVideoEl(video) {
    const src = video.currentSrc || video.src || null;
    let sources = [];
    video.querySelectorAll('source').forEach((s) => {
      if (s.src) sources.push({ src: s.src, type: s.type || null });
    });
    return {
      src,
      sources,
      title: video.getAttribute('title') || null,
      width: video.videoWidth || null,
      height: video.videoHeight || null,
      duration: Number.isFinite(video.duration) ? video.duration : null,
      poster: video.poster || null,
      isBlob: !!(src && src.startsWith('blob:')),
    };
  }

  function reportVideoElement(video) {
    const info = describeVideoEl(video);
    if (!info.src && info.sources.length === 0) return;

    const key = `video:${info.src || info.sources.map((s) => s.src).join(',')}`;
    // Reenvia se ainda não tiver dimensões (metadata pode chegar depois)
    const dimsKnown = !!(info.width && info.height);
    const cacheKey = `${key}:${dimsKnown ? `${info.width}x${info.height}` : 'pending'}`;
    if (reported.has(cacheKey)) return;
    reported.add(cacheKey);

    safeSendMessage({ type: 'VIDEO_ELEMENT_FOUND', payload: { ...info, ...pageMeta() } });

    if (!dimsKnown) {
      video.addEventListener(
        'loadedmetadata',
        () => reportVideoElement(video),
        { once: true },
      );
    }
  }

  // Garante o botão de download sobreposto sobre o elemento <video> (ver
  // content/overlay-ui.js, carregado antes deste script no manifest).
  // attach() é idempotente — chamar de novo num vídeo já conhecido só
  // reposiciona o botão, não duplica nada.
  function ensureOverlay(video) {
    if (!window.__VD_OVERLAY__) return;
    window.__VD_OVERLAY__.attach(video, () => ({ ...describeVideoEl(video), ...pageMeta() }));
  }

  function scanVideos() {
    document.querySelectorAll('video').forEach((video) => {
      reportVideoElement(video);
      ensureOverlay(video);
    });
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanVideos();
    }, 400);
  }

  // Varredura inicial
  scanVideos();

  // Observa mudanças no DOM (players que injetam <video> dinamicamente, ou
  // removem o vídeo ao trocar de mídia numa SPA)
  const observer = new MutationObserver((mutations) => {
    let added = false;
    let removed = false;
    for (const m of mutations) {
      if (m.addedNodes && m.addedNodes.length) added = true;
      if (m.removedNodes && m.removedNodes.length) removed = true;
    }
    if (added) scheduleScan();
    if (removed) window.__VD_OVERLAY__?.sweep();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Também reagimos a interação do usuário (play), pois alguns players só
  // carregam a fonte real após o primeiro clique.
  document.addEventListener('play', (ev) => {
    if (ev.target && ev.target.tagName === 'VIDEO') {
      ensureOverlay(ev.target);
      setTimeout(() => reportVideoElement(ev.target), 500);
    }
  }, true);

  // --- Sinais vindos do page-hook.js (MAIN world) ---
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.channel !== CHANNEL) return;
    const { type, payload } = ev.data;
    const key = `hook:${type}:${JSON.stringify(payload)}`;
    if (reported.has(key)) return;
    reported.add(key);

    switch (type) {
      case 'EME_REQUEST':
        safeSendMessage({ type: 'DRM_SIGNAL', payload: { source: 'eme-request', keySystem: payload.keySystem, pageUrl: location.href } });
        break;
      case 'EME_ENCRYPTED_EVENT':
        safeSendMessage({ type: 'DRM_SIGNAL', payload: { source: 'encrypted-event', pageUrl: location.href } });
        break;
      case 'MSE_SOURCE_BUFFER':
        safeSendMessage({ type: 'MSE_SIGNAL', payload: { ...payload } });
        break;
      case 'MEDIA_URL_SEEN':
        safeSendMessage({ type: 'MEDIA_URL_SEEN', payload: { ...payload, pageUrl: location.href } });
        break;
      default:
        break;
    }
  });

  // Página fica com <video src="blob:...">: avisa o background para
  // correlacionar com URLs de mídia vistas via fetch/XHR/MSE.
})();
