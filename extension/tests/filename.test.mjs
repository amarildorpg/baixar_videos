import { test, assertEqual, assertTrue } from './_assert.mjs';
import { sanitizeFilename, buildFilename, nameFromUrl } from '../utils/filename.js';

test('sanitizeFilename remove caracteres inválidos e usa underscore', () => {
  assertEqual(sanitizeFilename('Nome: do / Video? *teste*'), 'Nome_do_Video_teste');
});

test('sanitizeFilename usa fallback quando vazio', () => {
  assertEqual(sanitizeFilename('   ', 'video'), 'video');
});

test('buildFilename prioriza título do vídeo sobre outros candidatos', () => {
  const name = buildFilename({
    videoTitle: 'Aula 01',
    ogTitle: 'Outro título',
    pageTitle: 'Página',
    url: 'https://cdn.example.com/x.mp4',
    label: '1080p',
    ext: 'mp4',
  });
  assertEqual(name, 'Aula_01_1080p.mp4');
});

test('buildFilename cai para nome extraído da URL quando não há título', () => {
  const name = buildFilename({
    url: 'https://cdn.example.com/videos/Nome_do_Video.mp4',
    ext: 'mp4',
  });
  assertEqual(name, 'Nome_do_Video.mp4');
});

test('nameFromUrl extrai o último segmento sem extensão', () => {
  assertEqual(nameFromUrl('https://cdn.example.com/a/b/clipe-final.mp4'), 'clipe-final');
});

test('buildFilename corta títulos muito longos (ex.: legenda inteira de post do Instagram usada como og:title)', () => {
  // Regressão: um og:title bem comprido (legenda de post real, ~280
  // caracteres) gerava um nome de arquivo tão grande que, somado a uma
  // pasta de downloads comum, passava dos ~260 caracteres que o Windows
  // aceita no caminho completo — download falhava com FILE_FAILED sem
  // explicação nenhuma. Ver comentário de MAX_FILENAME_LENGTH em
  // utils/filename.js.
  const longCaption =
    'FOFOCAS no Instagram: "Uma cena chamou atenção após uma confus4o no Conjunto Penal Feminino, em Salvador. Quatro mulheres foram conduzidas à Central de Flagrantes depois de uma brig4 envolvendo internas."';
  const name = buildFilename({
    ogTitle: longCaption,
    url: 'https://instagram.fxyz.fna.fbcdn.net/video.mp4',
    label: '720p_video',
    ext: 'mp4',
  });
  assertTrue(name.length <= 80, `nome de arquivo tem ${name.length} caracteres, esperado <= 80: ${name}`);
  assertTrue(name.endsWith('_720p_video.mp4'), `sufixo de qualidade deve ser preservado intacto: ${name}`);
});
