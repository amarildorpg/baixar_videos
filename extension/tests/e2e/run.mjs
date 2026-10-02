// tests/e2e/run.mjs
// Suite de testes end-to-end: carrega a extensão de verdade (não
// mockada) num Chromium real via Playwright e baixa vídeo de cada um dos
// formatos suportados (MP4 direto, HLS, DASH, blob/MediaSource), além de
// checar a deduplicação por range-request (caso Instagram/fbcdn) e o
// clique no botão sobreposto na página.
//
// Por quê isso existe além de tests/run-all.mjs: a lógica pura (parsers,
// classificador, filename, dedupe) já é coberta lá, sem precisar de
// navegador. Mas boa parte dos bugs reais deste projeto (ver README,
// seção "Bugs corrigidos") estavam especificamente na parte que SÓ existe
// dentro de um navegador de verdade: o service worker não ter
// URL.createObjectURL, chrome.downloads.download ignorar `filename`,
// chrome.runtime.sendMessage não entregar ArrayBuffer corretamente,
// content script vs. webRequest chegando em ordens diferentes. Nenhum
// desses aparece rodando só a lógica pura em Node — só apareceram
// baixando um vídeo de verdade numa aba de verdade. Este arquivo existe
// para não perder essa cobertura de novo.
//
// Pré-requisitos (não vem instalado por padrão — ver README):
//   npm install
//   npx playwright install chromium
// Rodar:
//   node tests/e2e/run.mjs

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(__dirname, '..', '..');
const WORK_DIR = path.join(__dirname, '.run');

function freshDir(name) {
  const dir = path.join(WORK_DIR, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function launchExtension(profileName, downloadDir) {
  const userDataDir = freshDir(`profile-${profileName}`);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, '--no-first-run'],
  });
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = sw.url().split('/')[2];

  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });

  return { context, sw, extId, page };
}

async function activeTabId(sw, page) {
  await page.bringToFront();
  return sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id;
  });
}

async function openPopup(context, extId) {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  await popup.waitForTimeout(300);
  return popup;
}

async function getTabMedia(popup, tabId) {
  return popup.evaluate((tid) => chrome.runtime.sendMessage({ type: 'GET_TAB_MEDIA', tabId: tid }), tabId);
}

async function downloadBest(popup, tabId, groupId) {
  return popup.evaluate(
    ({ tid, gid }) => chrome.runtime.sendMessage({ type: 'DOWNLOAD_BEST', tabId: tid, groupId: gid }),
    { tid: tabId, gid: groupId },
  );
}

async function waitForDownloadComplete(sw, { timeoutMs = 20000, matchUrl } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const items = await sw.evaluate(async () => chrome.downloads.search({}));
    const item = matchUrl ? items.find((i) => i.url.includes(matchUrl)) : items[0];
    if (item && (item.state === 'complete' || item.state === 'interrupted')) return item;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('timeout esperando download terminar');
}

// ---------------------------------------------------------------------
// Cenários
// ---------------------------------------------------------------------

async function scenarioDirectMp4(baseUrl) {
  const downloadDir = freshDir('downloads-direct');
  const { context, sw, extId, page } = await launchExtension('direct', downloadDir);
  try {
    await page.goto(`${baseUrl}/page.html`);
    const tabId = await activeTabId(sw, page);
    await page.waitForTimeout(1500);

    const popup = await openPopup(context, extId);
    const media = await getTabMedia(popup, tabId);
    if (!media.ok || !media.groups.length) throw new Error('nenhum vídeo detectado');
    const group = media.groups[0];

    const res = await downloadBest(popup, tabId, group.groupId);
    if (!res.ok) throw new Error(`DOWNLOAD_BEST falhou: ${res.error}`);

    const item = await waitForDownloadComplete(sw);
    if (item.state !== 'complete') throw new Error(`download não completou: ${item.error}`);
    if (item.totalBytes !== 30389) throw new Error(`tamanho inesperado: ${item.totalBytes} (esperado 30389)`);
    // Deve usar o <title> da página, não um nome genérico tipo "download".
    if (!item.filename.includes('Teste_Video_Downloader')) {
      throw new Error(`nome de arquivo não usou o título da página: ${item.filename}`);
    }
  } finally {
    await context.close();
  }
}

async function scenarioFeedDedupeAndOverlayButton(baseUrl) {
  const downloadDir = freshDir('downloads-feed');
  const { context, sw, extId, page } = await launchExtension('feed', downloadDir);
  try {
    await page.goto(`${baseUrl}/feed.html`);
    await page.waitForTimeout(3000); // deixa os 3 vídeos autoplay/loop gerarem tráfego de range request

    const tabId = await activeTabId(sw, page);
    const popup = await openPopup(context, extId);
    const media = await getTabMedia(popup, tabId);
    await popup.close();

    if (!media.ok || media.groups.length !== 3) {
      throw new Error(`esperava 3 vídeos distintos (dedupe por range-request/token), achou ${media.groups?.length ?? 0}`);
    }

    // Clica no botão flutuante sobre o 2º vídeo (fluxo real de uso, não o popup).
    const secondCard = page.locator('.card').nth(1);
    await secondCard.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    const btn = page.locator('html > div').nth(1).locator('button.vd-btn');
    await btn.waitFor({ state: 'visible', timeout: 10000 });
    await btn.click();

    let state;
    for (let i = 0; i < 30; i++) {
      state = await btn.getAttribute('data-state');
      if (state === 'done' || state === 'error') break;
      await page.waitForTimeout(300);
    }
    if (state !== 'done') throw new Error(`botão sobreposto não concluiu (estado final: ${state})`);

    const item = await waitForDownloadComplete(sw);
    if (item.state !== 'complete') throw new Error(`download não completou: ${item.error}`);
    if (item.totalBytes !== 45584) throw new Error(`tamanho inesperado: ${item.totalBytes} (esperado 45584, feed2.mp4)`);
    // Deve usar o og:title da página (não "feed2.mp4" genérico da URL).
    if (!item.filename.includes('Feed_de_demonstra')) {
      throw new Error(`nome de arquivo não usou og:title: ${item.filename}`);
    }
  } finally {
    await context.close();
  }
}

async function scenarioHls(baseUrl) {
  const downloadDir = freshDir('downloads-hls');
  const { context, sw, extId, page } = await launchExtension('hls', downloadDir);
  try {
    await page.goto(`${baseUrl}/hls.html`);
    const tabId = await activeTabId(sw, page);
    await page.waitForTimeout(1500);

    const popup = await openPopup(context, extId);
    const media = await getTabMedia(popup, tabId);
    if (!media.ok || !media.groups.length) throw new Error('manifesto HLS não detectado');
    const res = await downloadBest(popup, tabId, media.groups[0].groupId);
    if (!res.ok) throw new Error(`DOWNLOAD_BEST falhou: ${res.error}`);

    const item = await waitForDownloadComplete(sw, { timeoutMs: 30000 });
    if (item.state !== 'complete') throw new Error(`download não completou: ${item.error}`);
    // 3 segmentos .ts concatenados (33088 + 32900 + 34028 bytes)
    if (item.totalBytes !== 100016) throw new Error(`tamanho inesperado: ${item.totalBytes} (esperado 100016)`);
    if (!item.filename.endsWith('.ts')) throw new Error(`extensão errada: ${item.filename}`);
  } finally {
    await context.close();
  }
}

async function scenarioDash(baseUrl) {
  const downloadDir = freshDir('downloads-dash');
  const { context, sw, extId, page } = await launchExtension('dash', downloadDir);
  try {
    await page.goto(`${baseUrl}/dash.html`);
    const tabId = await activeTabId(sw, page);
    await page.waitForTimeout(1500);

    const popup = await openPopup(context, extId);
    const media = await getTabMedia(popup, tabId);
    if (!media.ok || !media.groups.length) throw new Error('manifesto DASH não detectado');
    const quality = media.groups[0].qualities[0];
    // Regressão: bug real no parser fazia `width` vir igual a `bandwidth`
    // sempre que bandwidth aparecia antes de width no manifesto (ordem
    // que o ffmpeg usa) — ver parsers/dash-parser.js e o teste unitário
    // correspondente em tests/dash-parser.test.mjs.
    if (quality.width !== 320 || quality.height !== 240) {
      throw new Error(`resolução errada detectada: ${quality.width}x${quality.height} (esperado 320x240)`);
    }

    const res = await downloadBest(popup, tabId, media.groups[0].groupId);
    if (!res.ok) throw new Error(`DOWNLOAD_BEST falhou: ${res.error}`);

    // DASH baixa vídeo e áudio como dois arquivos separados — espera o
    // primeiro completar e dá uma folga para o segundo também terminar.
    await waitForDownloadComplete(sw);
    await new Promise((r) => setTimeout(r, 1500));
    const items = await sw.evaluate(async () => chrome.downloads.search({}));
    if (items.length !== 2) throw new Error(`esperava 2 arquivos (vídeo + áudio), achou ${items.length}`);
    if (items.some((i) => i.state !== 'complete')) throw new Error('nem todos os downloads completaram');
    const totalBytes = items.reduce((s, i) => s + i.totalBytes, 0);
    if (totalBytes !== 32217 + 54848) throw new Error(`tamanho total inesperado: ${totalBytes}`);
  } finally {
    await context.close();
  }
}

async function scenarioBlobMediaSource(baseUrl) {
  const downloadDir = freshDir('downloads-blob');
  const { context, sw, extId, page } = await launchExtension('blob', downloadDir);
  try {
    await page.goto(`${baseUrl}/blob.html`);
    await page.bringToFront();
    await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('pronto'), { timeout: 15000 });
    await page.waitForTimeout(1000);

    const btn = page.locator('html > div').first().locator('button.vd-btn');
    await btn.waitFor({ state: 'visible', timeout: 10000 });
    await btn.click();

    let state;
    for (let i = 0; i < 30; i++) {
      state = await btn.getAttribute('data-state');
      if (state === 'done' || state === 'error') break;
      await page.waitForTimeout(300);
    }
    if (state !== 'done') throw new Error(`botão não concluiu (estado final: ${state})`);

    const item = await waitForDownloadComplete(sw);
    if (item.state !== 'complete') throw new Error(`download não completou: ${item.error}`);
    // Regressão: o Blob reconstruído a partir do ArrayBuffer capturado via
    // MediaSource/SourceBuffer virava só 15 bytes ("[object Object]") por
    // causa de como o buffer viajava entre contextos — ver
    // downloader/segment-downloader.js e offscreen/offscreen.js.
    if (item.totalBytes !== 61651) throw new Error(`tamanho inesperado: ${item.totalBytes} (esperado 61651) — conteúdo do blob corrompido?`);
  } finally {
    await context.close();
  }
}

async function scenarioBlobDualSourceBuffer(baseUrl) {
  // Regressão: players que usam um SourceBuffer para vídeo e outro para
  // áudio (em vez de um único stream muxado) — caso real do YouTube,
  // reportado por um usuário como "baixei um vídeo, veio sem o áudio".
  // Antes, resolveBlobContent() mantinha só o SourceBuffer com mais bytes
  // acumulados (quase sempre o de vídeo) e descartava o resto em
  // silêncio — o download "funcionava" (sem erro nenhum) mas o arquivo
  // saía mudo. Ver content/page-hook.js e downloadBlobGroup em
  // background/service-worker.js.
  const downloadDir = freshDir('downloads-blob-dual');
  const { context, sw, extId, page } = await launchExtension('blob-dual', downloadDir);
  try {
    await page.goto(`${baseUrl}/blob-dual.html`);
    await page.bringToFront();
    await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('pronto'), { timeout: 15000 });
    await page.waitForTimeout(1000);

    const btn = page.locator('html > div').first().locator('button.vd-btn');
    await btn.waitFor({ state: 'visible', timeout: 10000 });
    await btn.click();

    let state;
    for (let i = 0; i < 30; i++) {
      state = await btn.getAttribute('data-state');
      if (state === 'done' || state === 'error') break;
      await page.waitForTimeout(300);
    }
    if (state !== 'done') throw new Error(`botão não concluiu (estado final: ${state})`);

    await waitForDownloadComplete(sw);
    await new Promise((r) => setTimeout(r, 1000));
    const items = await sw.evaluate(async () => chrome.downloads.search({}));
    if (items.length !== 2) throw new Error(`esperava 2 arquivos (vídeo + áudio separados), achou ${items.length} — áudio descartado?`);
    if (items.some((i) => i.state !== 'complete')) throw new Error('nem todos os downloads completaram');

    const totalBytes = items.reduce((s, i) => s + i.totalBytes, 0);
    if (totalBytes !== 33807 + 28252) throw new Error(`tamanho total inesperado: ${totalBytes} (esperado 33807 vídeo + 28252 áudio)`);
    if (!items.some((i) => i.filename.includes('_audio'))) {
      throw new Error('nenhum arquivo com sufixo "_audio" — faixa de áudio não foi salva separadamente');
    }
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------

const SCENARIOS = [
  ['MP4 direto (download + nome de arquivo do <title>)', scenarioDirectMp4],
  ['Feed estilo Instagram: dedupe por range-request + botão sobreposto + og:title', scenarioFeedDedupeAndOverlayButton],
  ['HLS: parse + download de segmentos + concatenação', scenarioHls],
  ['DASH: parse (regressão width/bandwidth) + download vídeo+áudio separados', scenarioDash],
  ['Blob/MediaSource (estilo Instagram real): captura via SourceBuffer + download', scenarioBlobMediaSource],
  ['Blob/MediaSource com vídeo e áudio em SourceBuffers separados (estilo YouTube)', scenarioBlobDualSourceBuffer],
];

async function main() {
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });

  const { server, port } = await startFixtureServer();
  const baseUrl = `http://localhost:${port}`;
  console.log(`Fixture server em ${baseUrl}`);
  console.log(`Extensão: ${EXT_DIR}\n`);

  const results = [];
  for (const [name, fn] of SCENARIOS) {
    process.stdout.write(`- ${name} ... `);
    try {
      await fn(baseUrl);
      console.log('OK');
      results.push({ name, ok: true });
    } catch (err) {
      console.log(`FALHOU — ${err.message}`);
      results.push({ name, ok: false, error: err.message });
    }
  }

  server.close();

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} cenários passaram.`);
  if (passed !== results.length) {
    console.log('\nFalhas:');
    for (const r of results.filter((r) => !r.ok)) console.log(`  - ${r.name}: ${r.error}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Erro fatal no runner de testes E2E:', err);
  process.exitCode = 1;
});
