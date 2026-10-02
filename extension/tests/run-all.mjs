import { summary } from './_assert.mjs';

console.log('MP4 direto / classificador de mídia');
await import('./media-classifier.test.mjs');

console.log('\nHLS (.m3u8)');
await import('./hls-parser.test.mjs');

console.log('\nDASH (.mpd)');
await import('./dash-parser.test.mjs');

console.log('\nNome de arquivo');
await import('./filename.test.mjs');

console.log('\nDeduplicação / agrupamento');
await import('./id.test.mjs');

summary();
