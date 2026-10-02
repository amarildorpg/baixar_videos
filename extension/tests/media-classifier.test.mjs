import { test, assertEqual } from './_assert.mjs';
import { classifyMedia, resolutionLabel, formatBitrate, formatBytes } from '../utils/media-classifier.js';

test('classifica MP4 por Content-Type', () => {
  const r = classifyMedia('https://cdn.example.com/x', 'video/mp4; charset=binary');
  assertEqual(r.kind, 'direct');
  assertEqual(r.container, 'mp4');
});

test('classifica MP4 por extensão quando não há Content-Type', () => {
  const r = classifyMedia('https://cdn.example.com/video.mp4?token=abc', null);
  assertEqual(r.kind, 'direct');
  assertEqual(r.container, 'mp4');
});

test('classifica HLS por Content-Type application/vnd.apple.mpegurl', () => {
  const r = classifyMedia('https://cdn.example.com/master', 'application/vnd.apple.mpegurl');
  assertEqual(r.kind, 'hls');
});

test('classifica HLS por extensão .m3u8', () => {
  const r = classifyMedia('https://cdn.example.com/master.m3u8', null);
  assertEqual(r.kind, 'hls');
});

test('classifica DASH por Content-Type application/dash+xml', () => {
  const r = classifyMedia('https://cdn.example.com/manifest', 'application/dash+xml');
  assertEqual(r.kind, 'dash');
});

test('retorna null para URL irrelevante', () => {
  const r = classifyMedia('https://cdn.example.com/style.css', 'text/css');
  assertEqual(r, null);
});

test('resolutionLabel mapeia alturas para labels padrão', () => {
  assertEqual(resolutionLabel(3840, 2160), '4K');
  assertEqual(resolutionLabel(1920, 1080), '1080p');
  assertEqual(resolutionLabel(1280, 720), '720p');
  assertEqual(resolutionLabel(854, 480), '480p');
  assertEqual(resolutionLabel(640, 360), '360p');
});

test('formatBitrate formata Mbps e kbps', () => {
  assertEqual(formatBitrate(15_000_000), '15.0 Mbps');
  assertEqual(formatBitrate(850_000), '850 kbps');
  assertEqual(formatBitrate(0), null);
});

test('formatBytes formata unidades', () => {
  assertEqual(formatBytes(500), '500 B');
  assertEqual(formatBytes(1024 * 1024 * 5), '5.0 MB');
});
