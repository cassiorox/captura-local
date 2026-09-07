// Utilitários compartilhados entre service worker, popup e página de resultado.
// Carregado via importScripts() no service worker e via <script> nas páginas.
const CL = (() => {
  const DEFAULT_SETTINGS = {
    lastMode: 'full',          // full | visible | selection
    scale: 'auto',             // auto | 1 | 2 | 3
    engine: 'cdp',             // cdp (DevTools, sem costura) | scroll (rolagem + costura)
    preScroll: true,           // rola a página antes para carregar imagens lazy
    preScrollDelay: 120,       // ms entre passos da pré-rolagem
    saveAs: false,             // perguntar onde salvar
    folder: 'Capturas',        // subpasta dentro de Downloads
    jpegQuality: 0.92,
    exportScale: 1,            // 1 | 0.5 (reduz a imagem na exportação)
    pdf: {
      mode: 'single',          // single (página única) | multi (paginado)
      paper: 'A4',             // A4 | Letter | Legal | A3
      landscape: false,
      marginMm: 10,
      background: true,        // imprimir fundos e cores
      headerFooter: false,     // título, URL, data e página
      outline: true,           // marcadores a partir dos títulos (H1-H6)
      tagged: false,           // PDF marcado (acessibilidade)
      screenMedia: true,       // usar CSS de tela em vez de CSS de impressão
      keepLayout: true,        // multipágina: reduzir escala para manter layout desktop
      unfix: true,             // multipágina: converter elementos fixos (evita repetição em cada página)
    },
  };

  function deepMerge(base, extra) {
    const out = Array.isArray(base) ? base.slice() : { ...base };
    if (!extra || typeof extra !== 'object') return out;
    for (const k of Object.keys(extra)) {
      const b = base ? base[k] : undefined;
      const e = extra[k];
      out[k] = (b && typeof b === 'object' && !Array.isArray(b) && e && typeof e === 'object' && !Array.isArray(e))
        ? deepMerge(b, e)
        : e;
    }
    return out;
  }

  async function getSettings() {
    const { settings } = await chrome.storage.local.get('settings');
    return deepMerge(DEFAULT_SETTINGS, settings || {});
  }

  async function saveSettings(patch) {
    const current = await getSettings();
    const next = deepMerge(current, patch);
    await chrome.storage.local.set({ settings: next });
    return next;
  }

  async function nextCounter() {
    const { counter = 0 } = await chrome.storage.local.get('counter');
    const n = counter + 1;
    await chrome.storage.local.set({ counter: n });
    return n;
  }

  function sanitizeName(s, max = 90) {
    return String(s || '')
      .replace(/[\x00-\x1f<>:"/\\|?*]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/g, '')
      .slice(0, max)
      .trim();
  }

  function sanitizeFolder(s) {
    return String(s || '')
      .split(/[\\/]+/)
      .map((p) => sanitizeName(p, 60))
      .filter((p) => p && p !== '.' && p !== '..')
      .join('/');
  }

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
  }

  function pad(n, w = 2) { return String(n).padStart(w, '0'); }

  function formatDate(ts, withTime = true) {
    const d = new Date(ts);
    const date = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
    if (!withTime) return date;
    return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // "Captura 012 - Título da página - dominio.com.png" dentro da pasta configurada.
  async function buildFilename(rec, ext, settings) {
    const n = await nextCounter();
    const title = sanitizeName(rec.title) || 'sem-titulo';
    const host = sanitizeName(hostOf(rec.url), 40);
    const base = `Captura ${pad(n, 3)} - ${title}${host ? ' - ' + host : ''}`;
    const folder = sanitizeFolder(settings && settings.folder);
    return (folder ? folder + '/' : '') + base + '.' + ext;
  }

  function isCapturableUrl(url) {
    return /^(https?|file|ftp):/i.test(url || '');
  }

  function base64ToBlob(b64, type) {
    const bin = atob(b64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
  }

  function humanBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  return {
    DEFAULT_SETTINGS, deepMerge, getSettings, saveSettings, nextCounter,
    sanitizeName, sanitizeFolder, hostOf, formatDate, buildFilename,
    isCapturableUrl, base64ToBlob, humanBytes,
  };
})();
