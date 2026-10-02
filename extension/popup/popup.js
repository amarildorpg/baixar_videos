// popup/popup.js
// UI do popup. Não importa módulos ES — recebe dados já processados do
// service worker via mensagens. Constrói o DOM programaticamente (sem
// innerHTML com dados da página) para evitar XSS a partir de títulos
// vindos de páginas arbitrárias.

let currentTabId = null;

const contentEl = document.getElementById('content');
const countEl = document.getElementById('count');
const debugToggle = document.getElementById('debugToggle');

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'disabled') node.disabled = !!v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child) node.appendChild(child);
  }
  return node;
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    renderEmpty('Nenhum vídeo encontrado');
    return;
  }
  currentTabId = tab.id;
  await loadAndRender();

  const debugState = await chrome.storage.local.get('vd_debug');
  debugToggle.checked = !!debugState.vd_debug;
}

debugToggle.addEventListener('change', () => {
  chrome.storage.local.set({ vd_debug: debugToggle.checked });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.tabId !== currentTabId) return;
  if (message.type === 'TAB_MEDIA_UPDATED') {
    loadAndRender();
  } else if (message.type === 'DOWNLOAD_STATE') {
    updateDownloadUI(message.downloadKey, message.status);
  }
});

async function loadAndRender() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_TAB_MEDIA', tabId: currentTabId });
  if (!res || !res.ok) {
    renderEmpty('Nenhum vídeo encontrado');
    return;
  }
  render(res.groups, res.pageDrm);
}

function renderEmpty(message) {
  countEl.textContent = 'Vídeos encontrados: 0';
  contentEl.innerHTML = '';
  contentEl.appendChild(
    el('div', { class: 'empty' }, [
      el('div', { class: 'empty-title', text: message }),
      el('div', { text: 'Abra ou reproduza um vídeo na página e aguarde alguns segundos.' }),
    ]),
  );
}

function render(groups, pageDrm) {
  countEl.textContent = `Vídeos encontrados: ${groups.length}`;
  contentEl.innerHTML = '';

  if (!groups.length) {
    renderEmpty('Nenhum vídeo encontrado');
    return;
  }

  for (const group of groups) {
    contentEl.appendChild(renderGroupCard(group));
  }
}

function labelForGroup(group) {
  return group.videoTitle || group.ogTitle || group.pageTitle || group.domain || 'Vídeo';
}

function kindLabel(kind) {
  return { direct: 'Arquivo direto', hls: 'HLS (streaming)', dash: 'DASH (streaming)', blob: 'Fonte via blob/MSE' }[kind] || kind;
}

function renderGroupCard(group) {
  const isProtected = group.isDRM;
  const best = group.qualities[0];
  const others = group.qualities.slice(1);

  const card = el('div', { class: 'card' });

  card.appendChild(
    el('div', { class: 'card-title' }, [
      el('span', { text: labelForGroup(group) }),
      el('span', { class: `badge ${isProtected ? 'badge-drm' : ''}`, text: isProtected ? 'DRM' : kindLabel(group.kind) }),
    ]),
  );

  if (isProtected) {
    card.appendChild(
      el('div', { class: 'drm-notice' }, [
        el('div', { text: `Conteúdo protegido por DRM${group.drmSystem ? ` (${group.drmSystem})` : ''}.` }),
        el('div', { text: 'Este vídeo não pode ser processado pelo downloader.' }),
      ]),
    );
  }

  if (best) {
    card.appendChild(renderMetaGrid(best, group));
  }

  if (group.kind === 'blob' && !isProtected) {
    const hint = group.possibleSourceGroupId
      ? 'Fonte real possivelmente detectada em outro item da lista abaixo.'
      : 'Fonte de rede não identificada — o download lê os dados direto do blob na página (funciona bem para gravações locais; para streaming adaptativo pode trazer só o trecho já carregado).';
    card.appendChild(el('div', { class: 'hint', text: hint }));
  }

  const downloadKeyBest = `${group.groupId}::0`;
  const bestBtn = el('button', {
    class: 'btn btn-primary',
    text: 'BAIXAR MELHOR QUALIDADE',
    disabled: isProtected || !best,
    onclick: () => triggerDownload(group.groupId, 'DOWNLOAD_BEST', 0, downloadKeyBest),
  });
  card.appendChild(bestBtn);

  card.appendChild(renderProgress(downloadKeyBest));

  if (others.length) {
    const list = el('div', { class: 'other-qualities' }, [
      el('div', { class: 'other-qualities-title', text: 'Outras qualidades' }),
    ]);
    others.forEach((q) => {
      const dKey = `${group.groupId}::${q.index}`;
      const row = el('div', { class: 'quality-row' }, [
        el('span', { text: `${q.label || '—'}${q.width && q.height ? ` (${q.width}x${q.height})` : ''}` }),
        el('button', {
          class: 'btn-small',
          text: 'Baixar',
          onclick: () => triggerDownload(group.groupId, 'DOWNLOAD_QUALITY', q.index, dKey),
        }),
      ]);
      list.appendChild(row);
      list.appendChild(renderProgress(dKey));
    });
    card.appendChild(list);
  }

  return card;
}

function renderMetaGrid(quality, group) {
  const rows = [];
  if (quality.width && quality.height) rows.push(['Resolução', `${quality.width}x${quality.height}`]);
  if (quality.label) rows.push(['Qualidade', quality.label]);
  if (quality.codecs) rows.push(['Codec', quality.codecs]);
  if (quality.bitrateLabel) rows.push(['Bitrate', quality.bitrateLabel]);
  if (quality.estimatedSizeLabel) rows.push(['Tamanho estimado', quality.estimatedSizeLabel]);
  rows.push(['Áudio', quality.hasAudio ? 'Disponível' : 'Separado / indisponível']);
  if (group.domain) rows.push(['Origem', group.domain]);

  const grid = el('div', { class: 'meta-grid' });
  for (const [k, v] of rows) {
    grid.appendChild(el('div', { text: k }));
    grid.appendChild(el('div', {}, [el('b', { text: String(v) })]));
  }
  return grid;
}

function renderProgress(downloadKey) {
  const wrap = el('div', { class: 'progress-wrap', id: `progress-${downloadKey}` });
  wrap.hidden = true;
  wrap.appendChild(el('div', { class: 'progress-bar' }, [el('div', { class: 'progress-fill', style: 'width:0%' })]));
  wrap.appendChild(el('div', { class: 'progress-label' }, [el('span', { class: 'state-text' }), el('span', { class: 'percent-text' })]));
  return wrap;
}

function updateDownloadUI(downloadKey, status) {
  const wrap = document.getElementById(`progress-${downloadKey}`);
  if (!wrap) return;
  wrap.hidden = false;
  const fill = wrap.querySelector('.progress-fill');
  const stateText = wrap.querySelector('.state-text');
  const percentText = wrap.querySelector('.percent-text');
  const label = wrap.querySelector('.progress-label');

  fill.style.width = `${status.percent || 0}%`;
  stateText.textContent = status.error ? status.error : status.state;
  percentText.textContent = status.state === 'Erro' ? '' : `${status.percent || 0}%`;
  label.className = `progress-label state-${status.state}`;
}

async function triggerDownload(groupId, type, qualityIndex, downloadKey) {
  updateDownloadUI(downloadKey, { state: 'Detectado', percent: 0 });
  const res = await chrome.runtime.sendMessage({ type, tabId: currentTabId, groupId, qualityIndex });
  if (!res.ok) {
    updateDownloadUI(downloadKey, { state: 'Erro', error: res.error, percent: 0 });
  }
}

init();
