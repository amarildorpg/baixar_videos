// offscreen/offscreen.js
// Documento offscreen (chrome.offscreen) cuja única razão de existir é ter
// acesso a APIs de DOM ausentes no service worker do Manifest V3 — o
// service worker não implementa URL.createObjectURL (confirmado em
// runtime).
//
// Duas abordagens foram tentadas e descartadas antes desta (ver histórico
// em downloader/segment-downloader.js):
// 1. Criar o object URL aqui e deixar o service worker chamar
//    chrome.downloads.download() com ele: falha com FILE_FAILED — um
//    blob: URL só é resolvível pelo mesmo contexto que o criou.
// 2. Chamar chrome.downloads.download() diretamente daqui: falha porque
//    documentos offscreen não têm acesso a chrome.downloads (API
//    ausente/undefined nesse contexto — confirmado em runtime).
//
// Solução: usar o mecanismo padrão do HTML para download — um elemento
// <a href="blob:..." download="nome"> clicado programaticamente. Isso não
// passa pela API chrome.downloads (não precisa dela aqui), é suportado em
// qualquer documento (incluindo offscreen) e respeita o nome de arquivo
// de forma confiável, ao contrário de um data: URL passado para
// chrome.downloads.download(). O clique ainda assim gera uma entrada
// normal em chrome://downloads, que o service worker localiza depois por
// URL (ver findDownloadIdByUrl em segment-downloader.js) para acompanhar
// o progresso.

// chrome.runtime.sendMessage não entrega um ArrayBuffer bruto de forma
// confiável até aqui (testado e confirmado: o Blob resultante virava o
// texto "[object Object]", 15 bytes, em vez do conteúdo real) — os bytes
// chegam como base64 (ver downloader/segment-downloader.js) e são
// decodificados de volta para binário aqui.
function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'OFFSCREEN_DOWNLOAD_BLOB') return false;

  try {
    const blob = new Blob([base64ToBytes(message.base64)], { type: message.mimeType || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = message.filename || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    sendResponse({ ok: true, url });
  } catch (err) {
    sendResponse({ ok: false, error: err?.message || String(err) });
  }

  return false;
});
