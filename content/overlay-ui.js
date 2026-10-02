// content/overlay-ui.js
// Botão de download sobreposto diretamente em cada <video> detectado na
// página (em vez de depender só da lista no popup). Roda no isolated
// world, no mesmo frame/contexto de video-detector.js — os dois scripts
// compartilham o mesmo escopo global do content script nesse frame, então
// este arquivo expõe sua API em window.__VD_OVERLAY__ para o outro usar.
//
// Cuidados de performance/intrusão na página:
// - O botão fica num host com Shadow DOM + `all: initial`, isolado do CSS
//   da página (não herda nem vaza estilo).
// - Reposicionamento é feito via requestAnimationFrame, nunca por polling
//   com setInterval.
// - Nunca insere nada DENTRO da árvore do player (evita quebrar scripts
//   da página) — o botão é um elemento `position: fixed` independente,
//   apenas alinhado visualmente ao vídeo.

(() => {
  if (window.__VD_OVERLAY__) return; // evita reinicializar em re-injeções

  const overlays = new Map(); // HTMLVideoElement -> { host, btn, ro, downloadKey, state }
  let rafPending = false;

  function scheduleRepositionAll() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      for (const video of overlays.keys()) reposition(video);
    });
  }

  window.addEventListener('scroll', scheduleRepositionAll, { passive: true, capture: true });
  window.addEventListener('resize', scheduleRepositionAll, { passive: true });

  function reposition(video) {
    const entry = overlays.get(video);
    if (!entry) return;
    if (!document.documentElement.contains(video)) {
      detach(video);
      return;
    }
    const rect = video.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const visible = rect.width >= 60 && rect.height >= 40 && rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;
    entry.host.style.display = visible ? 'block' : 'none';
    if (!visible) return;
    entry.host.style.top = `${Math.max(0, Math.round(rect.top + 8))}px`;
    entry.host.style.left = `${Math.round(rect.right - 8)}px`;
  }

  function buildHost() {
    const host = document.createElement('div');
    host.style.cssText =
      'all:initial;position:fixed;top:0;left:0;z-index:2147483647;transform:translateX(-100%);pointer-events:none;display:none;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      .vd-btn {
        all: initial;
        display: flex;
        align-items: center;
        gap: 5px;
        pointer-events: auto;
        cursor: pointer;
        background: rgba(17,24,39,0.85);
        color: #fff;
        font: 600 11px -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
        padding: 6px 10px;
        border-radius: 7px;
        box-shadow: 0 1px 4px rgba(0,0,0,0.35);
        user-select: none;
      }
      .vd-label {
        max-width: 220px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .vd-btn:hover { background: rgba(37,99,235,0.95); }
      .vd-btn[data-state="loading"] { background: rgba(37,99,235,0.95); cursor: default; }
      .vd-btn[data-state="done"] { background: rgba(22,163,74,0.92); }
      .vd-btn[data-state="error"] { background: rgba(220,38,38,0.92); }
      .vd-icon { font-size: 12px; line-height: 1; }
      .vd-spinner {
        width: 9px; height: 9px;
        border: 2px solid rgba(255,255,255,0.4);
        border-top-color: #fff;
        border-radius: 50%;
        animation: vd-spin 0.7s linear infinite;
        flex: none;
      }
      @keyframes vd-spin { to { transform: rotate(360deg); } }
    `;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'vd-btn';
    btn.dataset.state = 'idle';
    btn.innerHTML = '<span class="vd-icon">⬇</span><span class="vd-label">Baixar</span>';
    shadow.appendChild(style);
    shadow.appendChild(btn);
    document.documentElement.appendChild(host);
    return { host, btn };
  }

  function setState(video, state, label) {
    const entry = overlays.get(video);
    if (!entry) return;
    entry.state = state;
    entry.btn.dataset.state = state;
    const iconEl = entry.btn.querySelector('.vd-icon, .vd-spinner');
    const labelEl = entry.btn.querySelector('.vd-label');
    if (!iconEl || !labelEl) return;

    if (state === 'loading') {
      iconEl.outerHTML = '<span class="vd-spinner"></span>';
      labelEl.textContent = label || 'Baixando…';
    } else if (state === 'done') {
      iconEl.outerHTML = '<span class="vd-icon">✓</span>';
      labelEl.textContent = 'Concluído';
      setTimeout(() => {
        if (overlays.get(video)?.state === 'done') setState(video, 'idle');
      }, 4000);
    } else if (state === 'error') {
      iconEl.outerHTML = '<span class="vd-icon">⚠</span>';
      const full = label || 'Erro';
      labelEl.textContent = full;
      entry.btn.title = full; // texto completo ao passar o mouse, mesmo se cortado visualmente
      // eslint-disable-next-line no-console
      console.warn('[VideoDownloader] Download falhou:', full);
    } else {
      iconEl.outerHTML = '<span class="vd-icon">⬇</span>';
      labelEl.textContent = 'Baixar';
    }
  }

  async function handleClick(video, getMeta) {
    const entry = overlays.get(video);
    if (!entry || entry.state === 'loading') return;

    // Gerado ANTES de enviar a mensagem e guardado já aqui, de forma
    // síncrona: o background pode terminar (com sucesso OU erro) antes do
    // round-trip de resposta a esta chamada voltar — casos como "Formato
    // não suportado" ou DRM falham/completam de forma efetivamente
    // instantânea. Sem um id conhecido de antemão, o primeiro (ou único)
    // push de progresso chegaria com downloadKey ainda desconhecido pelo
    // botão e seria descartado, deixando-o preso em "Analisando…" para
    // sempre — era exatamente o bug relatado.
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    entry.requestId = requestId;
    entry.downloadKey = null;
    setState(video, 'loading', 'Analisando…');
    try {
      const meta = { ...getMeta(), requestId };
      const res = await chrome.runtime.sendMessage({ type: 'DOWNLOAD_FOR_ELEMENT', payload: meta });
      if (!res || !res.ok) {
        setState(video, 'error', errorLabel(res?.error));
        return;
      }
      entry.downloadKey = res.downloadKey;
    } catch (_e) {
      setState(video, 'error', 'Erro ao iniciar');
    }
  }

  function errorLabel(error) {
    // Não colapsa mais mensagens longas em "Erro" genérico — isso escondia
    // a causa real (ex.: "Conteúdo protegido por DRM"). O CSS (.vd-label)
    // corta visualmente com reticências se não couber, mas o texto
    // completo fica no atributo title (tooltip) e no console (ver setState).
    return error || 'Erro';
  }

  function attach(video, getMeta) {
    if (overlays.has(video)) {
      reposition(video);
      return;
    }
    const { host, btn } = buildHost();
    const entry = { host, btn, ro: null, downloadKey: null, requestId: null, state: 'idle' };
    overlays.set(video, entry);

    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      handleClick(video, getMeta);
    });

    if (window.ResizeObserver) {
      entry.ro = new ResizeObserver(() => scheduleRepositionAll());
      entry.ro.observe(video);
    }

    reposition(video);
  }

  function detach(video) {
    const entry = overlays.get(video);
    if (!entry) return;
    entry.ro?.disconnect();
    entry.host.remove();
    overlays.delete(video);
  }

  function sweep() {
    for (const video of [...overlays.keys()]) {
      if (!document.documentElement.contains(video)) detach(video);
    }
  }

  function applyDownloadState(downloadKey, requestId, status) {
    for (const [video, entry] of overlays.entries()) {
      // Casa por requestId (conhecido desde antes de enviar a mensagem —
      // ver handleClick) OU por downloadKey (já resolvido, aprendido pela
      // resposta). Cobre tanto o push que chega antes da resposta quanto
      // os que chegam depois.
      const matches = (requestId && entry.requestId === requestId) || (downloadKey && entry.downloadKey === downloadKey);
      if (!matches) continue;
      if (downloadKey) entry.downloadKey = downloadKey;
      if (status.state === 'Concluído') setState(video, 'done');
      else if (status.state === 'Erro') setState(video, 'error', errorLabel(status.error));
      else setState(video, 'loading', `${status.state}${status.percent ? ` ${status.percent}%` : ''}`);
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'DOWNLOAD_STATE') {
      applyDownloadState(message.downloadKey, message.requestId, message.status);
    }
  });

  window.__VD_OVERLAY__ = { attach, detach, sweep };
})();
