// utils/logger.js
// Sistema de logs em níveis. DEBUG fica desativado por padrão (produção).
// Para ativar em desenvolvimento: chrome.storage.local.set({ vd_debug: true })

const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

let currentLevel = LEVELS.INFO;
let initialized = false;

function applyStoredFlag(value) {
  currentLevel = value ? LEVELS.DEBUG : LEVELS.INFO;
}

// Em contextos sem chrome.storage (ex.: injeção no MAIN world da página),
// isso simplesmente não roda e o logger mantém o nível padrão (INFO).
function ensureInit() {
  if (initialized) return;
  initialized = true;
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get('vd_debug').then((res) => applyStoredFlag(res.vd_debug)).catch(() => {});
      if (chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area === 'local' && changes.vd_debug) {
            applyStoredFlag(changes.vd_debug.newValue);
          }
        });
      }
    }
  } catch (_e) {
    // ambiente sem storage (ex: MAIN world) — mantém nível padrão
  }
}

function log(level, prefix, ...args) {
  ensureInit();
  if (LEVELS[level] < currentLevel) return;
  const tag = `[VideoDownloader:${prefix}]`;
  const fn = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
  fn(tag, ...args);
}

export function createLogger(prefix) {
  return {
    debug: (...args) => log('DEBUG', prefix, ...args),
    info: (...args) => log('INFO', prefix, ...args),
    warn: (...args) => log('WARN', prefix, ...args),
    error: (...args) => log('ERROR', prefix, ...args),
  };
}
