import { test, assertEqual, assertTrue } from './_assert.mjs';
import { parseM3U8, isMasterPlaylist } from '../parsers/hls-parser.js';

const MASTER = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
1080p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
720p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=854x480
480p/playlist.m3u8
`;

const MASTER_WITH_SEPARATE_AUDIO = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud1",NAME="Portuguese",DEFAULT=YES,URI="audio/pt.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="hev1.1.6.L93",AUDIO="aud1"
video/1080p.m3u8
`;

const MEDIA_SIMPLE = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
seg0.ts
#EXTINF:6.0,
seg1.ts
#EXTINF:4.0,
seg2.ts
#EXT-X-ENDLIST
`;

const MEDIA_FMP4_WITH_MAP = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4.0,
seg0.m4s
#EXTINF:4.0,
seg1.m4s
#EXT-X-ENDLIST
`;

const MEDIA_ENCRYPTED_DRM = `#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.apple.streamingkeydelivery",URI="skd://key"
#EXTINF:6.0,
seg0.ts
#EXT-X-ENDLIST
`;

test('detecta master playlist', () => {
  assertTrue(isMasterPlaylist(MASTER));
});

test('parseia master playlist e ordena variantes com resolução/bandwidth/codecs', () => {
  const result = parseM3U8(MASTER, 'https://cdn.example.com/video/master.m3u8');
  assertEqual(result.type, 'master');
  assertEqual(result.variants.length, 3);
  const first = result.variants[0];
  assertEqual(first.width, 1920);
  assertEqual(first.height, 1080);
  assertEqual(first.bandwidth, 5000000);
  assertEqual(first.codecs, 'avc1.640028,mp4a.40.2');
  assertEqual(first.url, 'https://cdn.example.com/video/1080p/playlist.m3u8');
});

test('associa grupo de áudio separado à variante (HLS fMP4)', () => {
  const result = parseM3U8(MASTER_WITH_SEPARATE_AUDIO, 'https://cdn.example.com/master.m3u8');
  assertEqual(result.variants.length, 1);
  assertEqual(result.variants[0].audioUrl, 'https://cdn.example.com/audio/pt.m3u8');
});

test('parseia media playlist simples (TS) em ordem', () => {
  const result = parseM3U8(MEDIA_SIMPLE, 'https://cdn.example.com/480p/playlist.m3u8');
  assertEqual(result.type, 'media');
  assertEqual(result.segments.length, 3);
  assertEqual(result.segments.map((s) => s.url), [
    'https://cdn.example.com/480p/seg0.ts',
    'https://cdn.example.com/480p/seg1.ts',
    'https://cdn.example.com/480p/seg2.ts',
  ]);
  assertEqual(result.isLive, false);
  assertEqual(result.initSegmentUrl, null);
});

test('parseia media playlist fMP4 com EXT-X-MAP (init segment)', () => {
  const result = parseM3U8(MEDIA_FMP4_WITH_MAP, 'https://cdn.example.com/1080p/playlist.m3u8');
  assertEqual(result.initSegmentUrl, 'https://cdn.example.com/1080p/init.mp4');
  assertEqual(result.segments.length, 2);
});

test('identifica criptografia DRM (SAMPLE-AES com KEYFORMAT proprietário)', () => {
  const result = parseM3U8(MEDIA_ENCRYPTED_DRM, 'https://cdn.example.com/playlist.m3u8');
  assertEqual(result.keyInfo.encrypted, true);
  assertEqual(result.keyInfo.isDrm, true);
  assertEqual(result.keyInfo.drmName, 'FairPlay');
});

test('playlist ao vivo (sem ENDLIST) é marcada como live', () => {
  const live = MEDIA_SIMPLE.replace('#EXT-X-ENDLIST\n', '');
  const result = parseM3U8(live, 'https://cdn.example.com/playlist.m3u8');
  assertEqual(result.isLive, true);
});
