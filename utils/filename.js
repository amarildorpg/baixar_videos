// utils/filename.js
// Resolução e sanitização de nomes de arquivo para download.

// Tamanho máximo do NOME DE ARQUIVO final (base + sufixo de qualidade +
// extensão), não só do título. Motivo de ser bem mais conservador que o
// limite de 255 caracteres que sistemas de arquivo costumam aceitar por
// componente: o que importa pra quem baixa é o CAMINHO completo (pasta de
// downloads do usuário + nome do arquivo), e no Windows isso estoura em
// ~260 caracteres (MAX_PATH clássico) — bug real encontrado: o título de
// um post do Instagram (og:title = a legenda inteira do post, que pode
// ter centenas de caracteres) gerava um nome de arquivo tão comprido que,
// somado a uma pasta de downloads normal, passava de 260 caracteres e o
// download falhava com `FILE_FAILED` sem nenhuma explicação visível pro
// usuário. 80 caracteres pro nome final deixa margem generosa (~180
// caracteres) pra pasta de downloads em praticamente qualquer máquina.
const MAX_FILENAME_LENGTH = 80;

/**
 * Remove caracteres inválidos em nomes de arquivo no Windows/macOS/Linux
 * e normaliza espaços para underscore, mantendo o nome legível.
 */
export function sanitizeFilename(name, fallback = 'video', maxLength = MAX_FILENAME_LENGTH) {
  let s = (name || '').toString().trim();
  if (!s) s = fallback;

  // Remove caracteres proibidos em sistemas de arquivo comuns
  s = s.replace(/[\\/:*?"<>|-]/g, ' ');
  // Colapsa espaços múltiplos
  s = s.replace(/\s+/g, ' ').trim();
  // Troca espaço por underscore (padrão pedido: Nome_do_Video_1080p.mp4)
  s = s.replace(/ /g, '_');
  // Remove pontos/underscores nas pontas
  s = s.replace(/^[._]+|[._]+$/g, '');

  if (!s) s = fallback;

  if (s.length > maxLength) {
    s = s.slice(0, maxLength).replace(/[._]+$/, '');
  }

  return s || fallback;
}

/**
 * Extrai um nome de arquivo a partir da URL quando não há título melhor.
 */
export function nameFromUrl(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    if (!last) return u.hostname;
    return decodeURIComponent(last.replace(/\.[a-zA-Z0-9]+$/, ''));
  } catch (_e) {
    return 'video';
  }
}

/**
 * Monta o nome final do arquivo seguindo a ordem de prioridade:
 * título do vídeo > atributo title > OpenGraph > <title> da página > metadata > URL.
 *
 * O título (candidate) é cortado o quanto for preciso para o nome final
 * caber em MAX_FILENAME_LENGTH — nunca o sufixo de qualidade/áudio nem a
 * extensão, que carregam informação que o usuário precisa pra diferenciar
 * os arquivos (ver comentário de MAX_FILENAME_LENGTH acima).
 */
export function buildFilename({ title, videoTitle, ogTitle, pageTitle, url, label, ext }) {
  const candidate = videoTitle || title || ogTitle || pageTitle || nameFromUrl(url);
  const labelPart = label ? sanitizeFilename(label, '', MAX_FILENAME_LENGTH) : '';
  const finalExt = ext ? ext.replace(/^\./, '') : 'mp4';

  const suffixLength = (labelPart ? labelPart.length + 1 : 0) + 1 + finalExt.length; // "_label.ext"
  const maxBaseLength = Math.max(20, MAX_FILENAME_LENGTH - suffixLength);
  const base = sanitizeFilename(candidate, 'video', maxBaseLength);

  const parts = [base];
  if (labelPart) parts.push(labelPart);
  return `${parts.filter(Boolean).join('_')}.${finalExt}`;
}
