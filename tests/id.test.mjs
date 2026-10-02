import { test, assertEqual } from './_assert.mjs';
import { mediaKey, groupKey } from '../utils/id.js';

test('mediaKey gera chaves diferentes para qualidades diferentes da mesma URL base', () => {
  const k1 = mediaKey({ url: 'https://cdn.example.com/v.m3u8', width: 1920, height: 1080, bitrate: 5000000, codecs: 'avc1', kind: 'hls' });
  const k2 = mediaKey({ url: 'https://cdn.example.com/v.m3u8', width: 1280, height: 720, bitrate: 2500000, codecs: 'avc1', kind: 'hls' });
  if (k1 === k2) throw new Error('chaves não deveriam ser iguais');
});

test('mediaKey gera a mesma chave para a mesma qualidade (deduplicação)', () => {
  const a = { url: 'https://cdn.example.com/v.mp4', width: null, height: null, bitrate: null, codecs: null, kind: 'direct' };
  assertEqual(mediaKey(a), mediaKey({ ...a }));
});

test('groupKey ignora parâmetros voláteis (token/expires) para agrupar a mesma fonte', () => {
  const a = groupKey('https://cdn.example.com/video.mp4?token=abc123&quality=1080');
  const b = groupKey('https://cdn.example.com/video.mp4?token=xyz789&quality=1080');
  assertEqual(a, b);
});

test('groupKey agrupa chunks de range-request de CDN com parâmetros assinados totalmente diferentes (caso Instagram/fbcdn)', () => {
  // Cada chunk de range costuma vir com uma querystring inteiramente
  // diferente (não é só token/expires) — isso gerava dezenas de "vídeos"
  // duplicados de poucos bytes para o mesmo arquivo real.
  const a = groupKey('https://instagram.fops2-1.fna.fbcdn.net/v/t42.mp4?_nc_ht=x&oe=AAA&oh=111&bytestart=0&byteend=999');
  const b = groupKey('https://instagram.fops2-1.fna.fbcdn.net/v/t42.mp4?_nc_ht=y&oe=BBB&oh=222&bytestart=1000&byteend=1999');
  assertEqual(a, b);
});

test('groupKey distingue URLs de origem diferente', () => {
  const a = groupKey('https://cdn1.example.com/video.mp4');
  const b = groupKey('https://cdn2.example.com/video.mp4');
  if (a === b) throw new Error('domínios diferentes não deveriam gerar a mesma chave');
});
