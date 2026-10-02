// downloader/direct-download.js
// Download de um arquivo único (MP4/WebM) servido direto por URL.
//
// Não usa chrome.downloads.download({ url, filename }) diretamente contra
// a URL remota: testado e confirmado que a opção `filename` dessa API é
// ignorada neste ambiente — o Chrome sempre usa o nome derivado da própria
// URL (ex.: pedir "Meu_Video.mp4" para baixar ".../abc123.mp4" resulta em
// "abc123.mp4" salvo, mesmo com download concluído com sucesso). Em vez
// disso, busca os bytes aqui (o service worker tem host_permissions
// amplo o bastante para isso não esbarrar em CORS) e entrega o resultado
// como Blob para downloadBlob() (ver segment-downloader.js), que já
// resolve o nome de arquivo corretamente através do documento offscreen.

/**
 * Baixa uma URL de vídeo direto como Blob, reportando progresso
 * incremental (bytesReceived/totalBytes, quando o servidor informa
 * Content-Length).
 */
export async function fetchDirectVideo(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const totalBytes = Number(res.headers.get('content-length')) || 0;
  const contentType = res.headers.get('content-type') || 'video/mp4';

  if (!res.body) {
    // Alguns ambientes não expõem stream de leitura incremental — cai
    // para leitura de corpo inteiro de uma vez (sem progresso parcial).
    const blob = await res.blob();
    onProgress?.({ bytesReceived: blob.size, totalBytes: blob.size || totalBytes });
    return blob;
  }

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress?.({ bytesReceived: received, totalBytes });
  }
  return new Blob(chunks, { type: contentType });
}

/**
 * Acompanha o progresso de um download nativo do Chrome via chrome.downloads.
 * @param {number} downloadId
 * @param {(state: {bytesReceived:number, totalBytes:number, state:string}) => void} onProgress
 * @returns {Promise<void>} resolve quando concluído, reject em erro/cancelamento
 */
export function trackDownload(downloadId, onProgress) {
  return new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      chrome.downloads.search({ id: downloadId }, (results) => {
        const item = results && results[0];
        if (!item) return;
        onProgress?.({
          bytesReceived: item.bytesReceived,
          totalBytes: item.totalBytes,
          state: item.state,
        });
        if (item.state === 'complete') {
          clearInterval(poll);
          resolve();
        } else if (item.state === 'interrupted') {
          clearInterval(poll);
          reject(new Error(item.error || 'Download interrompido'));
        }
      });
    }, 400);
  });
}
