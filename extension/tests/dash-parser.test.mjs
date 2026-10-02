import { test, assertEqual, assertTrue } from './_assert.mjs';
import { parseMPD, buildSegmentUrls, summarizeAdaptationSets, parseISODuration } from '../parsers/dash-parser.js';

const MPD_SEGMENT_LIST = `<?xml version="1.0"?>
<MPD mediaPresentationDuration="PT1M40S">
  <Period>
    <AdaptationSet mimeType="video/mp4" contentType="video">
      <Representation id="v1" width="1920" height="1080" bandwidth="5000000" codecs="avc1.640028">
        <SegmentList>
          <Initialization sourceURL="video/init-1080p.mp4"/>
          <SegmentURL media="video/seg-1080p-1.m4s"/>
          <SegmentURL media="video/seg-1080p-2.m4s"/>
        </SegmentList>
      </Representation>
      <Representation id="v2" width="1280" height="720" bandwidth="2500000" codecs="avc1.4d401f">
        <SegmentList>
          <Initialization sourceURL="video/init-720p.mp4"/>
          <SegmentURL media="video/seg-720p-1.m4s"/>
        </SegmentList>
      </Representation>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" contentType="audio">
      <Representation id="a1" bandwidth="128000" codecs="mp4a.40.2">
        <SegmentList>
          <Initialization sourceURL="audio/init.mp4"/>
          <SegmentURL media="audio/seg-1.m4s"/>
        </SegmentList>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

const MPD_SEGMENT_TEMPLATE_TIMELINE = `<?xml version="1.0"?>
<MPD>
  <Period duration="PT8S">
    <AdaptationSet mimeType="video/mp4" contentType="video">
      <SegmentTemplate media="video/$RepresentationID$/seg-$Number$.m4s" initialization="video/$RepresentationID$/init.mp4" startNumber="1" timescale="1000">
        <SegmentTimeline>
          <S t="0" d="4000" r="1"/>
        </SegmentTimeline>
      </SegmentTemplate>
      <Representation id="v1" width="3840" height="2160" bandwidth="15000000" codecs="hev1.1.6.L150"/>
    </AdaptationSet>
  </Period>
</MPD>`;

// Ordem de atributos como o ffmpeg (e muitos encoders reais) gera:
// `bandwidth` ANTES de `width`/`height` no mesmo elemento. Regressão: o
// regex de getAttr() não tinha checagem de limite antes do nome do
// atributo, então `width="..."` batia dentro do sufixo de
// `bandWIDTH="..."` e pegava o valor de bandwidth por engano sempre que
// bandwidth vinha primeiro (bug real encontrado testando contra um
// manifesto gerado pelo ffmpeg — ver histórico do projeto).
const MPD_BANDWIDTH_BEFORE_WIDTH = `<?xml version="1.0"?>
<MPD mediaPresentationDuration="PT6S">
  <Period>
    <AdaptationSet mimeType="video/mp4" contentType="video">
      <Representation id="v1" mimeType="video/mp4" codecs="avc1.64000c" bandwidth="42956" width="320" height="240" sar="1:1">
        <SegmentList>
          <SegmentURL media="video/seg-1.m4s"/>
        </SegmentList>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

const MPD_WITH_DRM = `<?xml version="1.0"?>
<MPD>
  <Period>
    <AdaptationSet mimeType="video/mp4" contentType="video">
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
      <Representation id="v1" width="1920" height="1080" bandwidth="5000000" codecs="avc1.640028">
        <SegmentList>
          <SegmentURL media="video/seg-1.m4s"/>
        </SegmentList>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

test('parseISODuration converte PT1M40S corretamente', () => {
  assertEqual(parseISODuration('PT1M40S'), 100);
  assertEqual(parseISODuration('PT8S'), 8);
  assertEqual(parseISODuration('PT1H'), 3600);
});

test('parseia MPD com SegmentList (video + audio separados)', () => {
  const result = parseMPD(MPD_SEGMENT_LIST, 'https://cdn.example.com/manifest.mpd');
  assertEqual(result.isDRM, false);
  const { videos, audios, bestVideo, bestAudio } = summarizeAdaptationSets(result.adaptationSets);
  assertEqual(videos.length, 2);
  assertEqual(audios.length, 1);
  assertEqual(bestVideo.height, 1080);
  assertEqual(bestVideo.bandwidth, 5000000);
  assertTrue(bestAudio.codecs.includes('mp4a'));
});

test('buildSegmentUrls resolve SegmentList relativo à BaseURL do manifesto', () => {
  const result = parseMPD(MPD_SEGMENT_LIST, 'https://cdn.example.com/path/manifest.mpd');
  const { bestVideo } = summarizeAdaptationSets(result.adaptationSets);
  const segs = buildSegmentUrls(bestVideo);
  assertEqual(segs.initUrl, 'https://cdn.example.com/path/video/init-1080p.mp4');
  assertEqual(segs.segments, [
    'https://cdn.example.com/path/video/seg-1080p-1.m4s',
    'https://cdn.example.com/path/video/seg-1080p-2.m4s',
  ]);
});

test('buildSegmentUrls expande SegmentTemplate com SegmentTimeline ($Number$/$RepresentationID$)', () => {
  const result = parseMPD(MPD_SEGMENT_TEMPLATE_TIMELINE, 'https://cdn.example.com/manifest.mpd');
  const rep = result.adaptationSets[0];
  const segs = buildSegmentUrls(rep);
  assertEqual(segs.initUrl, 'https://cdn.example.com/video/v1/init.mp4');
  // r="1" => repete mais 1 vez => 2 segmentos no total
  assertEqual(segs.segments, [
    'https://cdn.example.com/video/v1/seg-1.m4s',
    'https://cdn.example.com/video/v1/seg-2.m4s',
  ]);
});

test('getAttr não confunde width com o sufixo de bandwidth quando bandwidth vem antes (ordem do ffmpeg)', () => {
  const result = parseMPD(MPD_BANDWIDTH_BEFORE_WIDTH, 'https://cdn.example.com/manifest.mpd');
  const rep = result.adaptationSets[0];
  assertEqual(rep.bandwidth, 42956);
  assertEqual(rep.width, 320);
  assertEqual(rep.height, 240);
});

test('detecta DRM via ContentProtection (Widevine) e bloqueia a representation', () => {
  const result = parseMPD(MPD_WITH_DRM, 'https://cdn.example.com/manifest.mpd');
  assertEqual(result.isDRM, true);
  assertTrue(result.drmSystems.includes('Widevine'));
  assertEqual(result.adaptationSets[0].isDRM, true);
});
