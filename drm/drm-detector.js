// drm/drm-detector.js
//
// Detecção INFORMATIVA de DRM. Este módulo NÃO tenta contornar, decifrar
// ou extrair chaves de nenhum sistema de proteção — ele apenas reconhece
// sinais públicos de que uma mídia está protegida, para avisar o usuário
// e impedir que o downloader tente processá-la.

const KEY_SYSTEMS = {
  'com.widevine.alpha': 'Widevine',
  'com.microsoft.playready': 'PlayReady',
  'com.apple.fps': 'FairPlay',
  'com.apple.fps.1_0': 'FairPlay',
  'org.w3.clearkey': 'ClearKey',
};

// GUID do SystemID usado em ContentProtection de manifests DASH.
const DASH_SYSTEM_IDS = {
  'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed': 'Widevine',
  '9a04f079-9840-4286-ab92-e65be0885f95': 'PlayReady',
  '94ce86fb-07ff-4f43-adb8-93d2fa968ca2': 'FairPlay',
};

export function drmNameFromKeySystem(keySystem) {
  return KEY_SYSTEMS[keySystem] || (keySystem ? 'DRM desconhecido' : null);
}

export function drmNameFromDashSystemId(systemId) {
  if (!systemId) return null;
  const clean = systemId.toLowerCase().replace(/[{}]/g, '');
  return DASH_SYSTEM_IDS[clean] || 'DRM desconhecido';
}

/**
 * Verifica se um manifesto DASH (texto bruto) contém elementos
 * ContentProtection, indicando mídia protegida por DRM.
 */
export function mpdHasContentProtection(mpdText) {
  return /<ContentProtection[\s>]/i.test(mpdText);
}

export function extractDashDrmSystems(mpdText) {
  const systems = new Set();
  const re = /<ContentProtection[^>]*schemeIdUri="urn:uuid:([0-9a-fA-F-]+)"[^>]*>/g;
  let m;
  while ((m = re.exec(mpdText)) !== null) {
    const name = drmNameFromDashSystemId(m[1]);
    if (name) systems.add(name);
  }
  if (systems.size === 0 && mpdHasContentProtection(mpdText)) {
    systems.add('DRM desconhecido');
  }
  return [...systems];
}

/**
 * Verifica se uma playlist HLS (texto bruto) indica chave de criptografia
 * do tipo DRM (SAMPLE-AES / SAMPLE-AES-CTR costumam ser FairPlay/Widevine
 * via EXT-X-KEY com KEYFORMAT proprietário). AES-128 "simples" (METHOD=AES-128
 * sem KEYFORMAT proprietário) não é necessariamente DRM — é apenas
 * criptografia de transporte com chave publicamente obtível pelo player,
 * então não é classificada aqui como DRM (mas não é suportada no MVP).
 */
export function hlsKeyInfo(m3u8Text) {
  const lines = m3u8Text.split('\n');
  for (const line of lines) {
    if (!line.startsWith('#EXT-X-KEY')) continue;
    const method = /METHOD=([^,\s]+)/i.exec(line)?.[1];
    const keyformat = /KEYFORMAT="([^"]+)"/i.exec(line)?.[1];
    if (method && method !== 'NONE') {
      const isDrm =
        keyformat &&
        (keyformat.includes('com.apple.streamingkeydelivery') ||
          keyformat.includes('com.microsoft.playready') ||
          keyformat.includes('urn:uuid:edef8ba9')); // widevine uuid via keyformat
      return {
        encrypted: true,
        isDrm: !!isDrm,
        method,
        drmName: isDrm
          ? keyformat.includes('playready')
            ? 'PlayReady'
            : keyformat.includes('edef8ba9')
              ? 'Widevine'
              : 'FairPlay'
          : null,
      };
    }
  }
  return { encrypted: false, isDrm: false, method: null, drmName: null };
}

/**
 * Combina sinais coletados no runtime da página (EME) com os do manifesto
 * para decidir o status final de DRM de uma entrada de mídia.
 */
export function combineDrmSignals({ pageEmeDrmName, manifestDrmNames }) {
  const names = new Set();
  if (pageEmeDrmName) names.add(pageEmeDrmName);
  (manifestDrmNames || []).forEach((n) => n && names.add(n));
  if (names.size === 0) return { isDRM: false, drmSystem: null };
  return { isDRM: true, drmSystem: [...names].join(', ') };
}
