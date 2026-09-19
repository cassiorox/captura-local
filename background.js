// Service worker da extensão Captura Local.
// Orquestra as capturas (DevTools Protocol ou rolagem + captureVisibleTab),
// gera PDFs vetoriais via Page.printToPDF e guarda os resultados em chrome.storage.local
// para a página result.html montar, exportar e baixar. Nada sai do computador.
importScripts('lib/common.js');

const PROTO = '1.3';
const MAX_CHUNK_DEVICE_PX = 6000;      // altura máxima (px físicos) de cada fatia capturada via CDP
const VISIBLE_CAPTURE_GAP_MS = 600;    // o Chrome limita captureVisibleTab a ~2 chamadas/s
const MAX_SINGLE_PAGE_IN = 200;        // limite prático de altura de página PDF (200 polegadas)
const HISTORY_SIZE = 8;

let busy = false;
let lastError = null;
let lastVisibleCaptureAt = 0;

const ACTIONS = {
  'cl-full':      { mode: 'full',      output: 'preview' },
  'cl-visible':   { mode: 'visible',   output: 'preview' },
  'cl-selection': { mode: 'selection', output: 'preview' },
  'cl-full-png':  { mode: 'full',      output: 'png' },
  'cl-full-pdf':  { mode: 'full',      output: 'pdf' },
};
const COMMANDS = {
  'capture-full': ACTIONS['cl-full'],
  'capture-visible': ACTIONS['cl-visible'],
  'capture-selection': ACTIONS['cl-selection'],
  'capture-pdf': ACTIONS['cl-full-pdf'],
};

// ---------------------------------------------------------------------------
// Pontos de entrada
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    const items = [
      ['cl-full', 'Capturar página inteira'],
      ['cl-visible', 'Capturar área visível'],
      ['cl-selection', 'Capturar seleção'],
      ['cl-full-png', 'Página inteira direto em PNG'],
      ['cl-full-pdf', 'Página inteira direto em PDF'],
    ];
    for (const [id, title] of items) {
      chrome.contextMenus.create({ id, title, contexts: ['page', 'frame', 'selection', 'image', 'link', 'video'] });
    }
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const action = ACTIONS[info.menuItemId];
  if (action && tab) startCapture(action, tab);
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  const action = COMMANDS[command];
  if (!action) return;
  const t = tab || (await activeTab());
  if (t) startCapture(action, t);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case 'capture': {
        const tab = msg.tabId ? await chrome.tabs.get(msg.tabId) : await activeTab();
        if (!tab) return { error: 'Nenhuma aba ativa encontrada.' };
        startCapture({ mode: msg.mode, output: msg.output }, tab);
        return { ok: true };
      }
      case 'generatePdf':
        return await generatePdfForRecord(msg.id, msg.options);
      case 'status':
        return { busy, lastError };
      default:
        return { error: 'Mensagem desconhecida.' };
    }
  })().then(sendResponse, (e) => sendResponse({ error: errMsg(e) }));
  return true;
});

// ---------------------------------------------------------------------------
// Fluxo principal
// ---------------------------------------------------------------------------
async function startCapture(action, tab) {
  if (busy) {
    notify('Captura em andamento', 'Aguarde a captura atual terminar.');
    return;
  }
  if (!tab || !CL.isCapturableUrl(tab.url)) {
    notify('Página não suportada', 'Só é possível capturar páginas http, https ou file. Páginas internas do Chrome e a Chrome Web Store não permitem captura.');
    return;
  }
  busy = true;
  lastError = null;
  setBadge('...', '#003ec7');
  try {
    const settings = await CL.getSettings();
    const mode = action.mode || 'full';
    const output = action.output || 'preview';
    const rec = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      tabId: tab.id,
      windowId: tab.windowId,
      url: tab.url,
      title: tab.title || CL.hostOf(tab.url) || 'Página',
      createdAt: Date.now(),
      mode,
    };

    if (output === 'pdf' && mode === 'full') {
      // PDF vetorial direto, sem passar pela imagem.
      rec.kind = 'pdf';
      const pdf = await capturePdf(tab, settings.pdf, settings);
      Object.assign(rec, pdf);
    } else {
      rec.kind = 'image';
      let cap;
      if (mode === 'visible') cap = await captureVisible(tab);
      else if (mode === 'selection') cap = await captureSelection(tab);
      else if (settings.engine === 'scroll') cap = await captureFullScroll(tab, settings);
      else cap = await captureFullCdp(tab, settings);
      if (!cap) { busy = false; setBadge(''); return; } // seleção cancelada
      Object.assign(rec, cap);
    }

    await saveRecord(rec);
    const auto = output !== 'preview' ? `&auto=${encodeURIComponent(output)}` : '';
    await chrome.tabs.create({
      url: chrome.runtime.getURL(`result.html?id=${rec.id}${auto}`),
      index: tab.index + 1,
      openerTabId: tab.id,
      active: true,
    });
  } catch (e) {
    lastError = errMsg(e);
    console.error('[Captura Local]', e);
    notify('Falha na captura', lastError);
  } finally {
    busy = false;
    setBadge('');
  }
}

// PDF gerado sob demanda pela página de resultado (com as opções escolhidas lá).
async function generatePdfForRecord(id, options) {
  const rec = (await chrome.storage.local.get('cap:' + id))['cap:' + id];
  if (!rec) throw new Error('Captura não encontrada. Capture a página novamente.');
  let tab;
  try { tab = await chrome.tabs.get(rec.tabId); } catch { tab = null; }
  if (!tab) throw new Error('A aba original foi fechada. Abra a página de novo e capture novamente.');
  if (stripHash(tab.url) !== stripHash(rec.url)) throw new Error('A aba original navegou para outra página. Capture novamente.');
  if (busy) throw new Error('Já existe uma captura em andamento. Tente de novo em instantes.');
  busy = true;
  setBadge('PDF', '#003ec7');
  try {
    const settings = await CL.getSettings();
    const pdfOptions = CL.deepMerge(settings.pdf, options || {});
    // Usa a largura da captura de imagem para o PDF sair com o mesmo layout.
    const widthHint = rec.kind === 'image' && rec.mode === 'full' ? rec.width : null;
    const pdf = await capturePdf(tab, pdfOptions, settings, widthHint);
    return { ok: true, base64: pdf.pdfBase64, options: pdfOptions, width: pdf.width, height: pdf.height };
  } finally {
    busy = false;
    setBadge('');
  }
}

// ---------------------------------------------------------------------------
// Motores de captura de imagem
// ---------------------------------------------------------------------------

// Motor padrão: DevTools Protocol com captureBeyondViewport. Não rola a página
// durante a captura, então cabeçalhos fixos não se repetem e não há costura visível.
async function captureFullCdp(tab, settings) {
  const target = { tabId: tab.id };
  await attach(target);
  let revealed = false;
  try {
    const info = await exec(tab.id, fnPageInfo);
    if (settings.preScroll) {
      setBadge('lazy', '#003ec7');
      await exec(tab.id, fnPreScroll, [settings.preScrollDelay || 120, 20000]);
    }
    if (settings.revealAnim !== false) {
      await exec(tab.id, fnRevealAnim);
      revealed = true;
      await sleep(120);
    }
    const m = await cdp(target, 'Page.getLayoutMetrics');
    const width = Math.ceil((m.cssLayoutViewport && m.cssLayoutViewport.clientWidth) || info.clientWidth);
    const height = Math.ceil(Math.max((m.cssContentSize && m.cssContentSize.height) || 0, info.scrollHeight, info.clientHeight));
    const pr = resolveScale(settings.scale, info.dpr);
    if (Math.abs(pr - info.dpr) > 0.01) {
      await cdp(target, 'Emulation.setDeviceMetricsOverride', { width: 0, height: 0, deviceScaleFactor: pr, mobile: false });
      await sleep(150);
    }
    const chunkCss = Math.max(256, Math.floor(MAX_CHUNK_DEVICE_PX / pr));
    const chunks = [];
    const total = Math.ceil(height / chunkCss);
    for (let y = 0, i = 0; y < height; y += chunkCss, i++) {
      const h = Math.min(chunkCss, height - y);
      setBadge(`${i + 1}/${total}`, '#003ec7');
      const r = await cdp(target, 'Page.captureScreenshot', {
        format: 'png',
        clip: { x: 0, y, width, height: h, scale: 1 },
        captureBeyondViewport: true,
        fromSurface: true,
      });
      chunks.push({ y, height: h, dataUrl: 'data:image/png;base64,' + r.data });
    }
    return { width, height, pixelRatio: pr, chunks, engine: 'cdp' };
  } finally {
    if (revealed) { try { await exec(tab.id, fnUnrevealAnim); } catch {} }
    await restoreViewport(target, tab.id);
    await detach(target);
  }
}

// Depois de vários captureBeyondViewport o Chrome deixa a barra de rolagem escondida
// (clientWidth cresce). Só volta ao normal com um override explícito seguido de clear.
async function restoreViewport(target, tabId) {
  try {
    const info = await exec(tabId, fnPageInfo);
    await cdp(target, 'Emulation.setDeviceMetricsOverride', {
      width: info.innerWidth, height: info.innerHeight, deviceScaleFactor: info.dpr, mobile: false,
    });
    await sleep(60);
    await cdp(target, 'Emulation.clearDeviceMetricsOverride');
    await sleep(120);
  } catch {}
}

// Motor alternativo: rola a página e captura a área visível a cada passo.
// Respeita unidades vh e páginas que se comportam mal com o motor CDP.
async function captureFullScroll(tab, settings) {
  const info = await exec(tab.id, fnScrollPrepare);
  const width = info.clientWidth;
  const height = Math.max(info.scrollHeight, info.clientHeight);
  const vh = info.clientHeight;
  const chunks = [];
  let y = 0;
  let lastY = -1;
  let first = true;
  let revealed = false;
  try {
    for (let guard = 0; guard < 400; guard++) {
      const pos = await exec(tab.id, fnScrollStep, [y, !first, 180]);
      if (settings.revealAnim !== false) {
        // Reaplica a cada passo: blocos que voltam a se esconder ao sair da viewport
        // (animações "whileInView" sem once) precisam ser destravados de novo.
        await exec(tab.id, fnRevealAnim);
        revealed = true;
        await sleep(120);
      }
      await throttleVisibleCapture();
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      chunks.push({ y: pos.scrollY, height: vh, dataUrl });
      setBadge(`${Math.min(100, Math.round(((pos.scrollY + vh) / height) * 100))}%`, '#003ec7');
      if (pos.scrollY + vh >= height - 1 || pos.scrollY === lastY) break;
      lastY = pos.scrollY;
      y += vh;
      first = false;
    }
  } finally {
    if (revealed) { try { await exec(tab.id, fnUnrevealAnim); } catch {} }
    try { await exec(tab.id, fnScrollRestore, [info.scrollY]); } catch {}
  }
  let pr = info.dpr;
  const want = resolveScale(settings.scale, info.dpr);
  return { width, height, pixelRatio: pr, chunks, engine: 'scroll', downscaleTo: want < pr ? want : null };
}

async function captureVisible(tab) {
  const info = await exec(tab.id, fnPageInfo);
  await throttleVisibleCapture();
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  return { width: info.clientWidth, height: info.clientHeight, pixelRatio: info.dpr, chunks: [{ y: 0, height: info.clientHeight, dataUrl }], engine: 'visible' };
}

async function captureSelection(tab) {
  const sel = await exec(tab.id, fnSelect);
  if (!sel) return null; // cancelado com Esc
  await sleep(150); // garante que o overlay já sumiu antes de fotografar
  await throttleVisibleCapture();
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  return {
    width: sel.vw, height: sel.vh, pixelRatio: sel.dpr,
    chunks: [{ y: 0, height: sel.vh, dataUrl }],
    crop: { x: sel.x, y: sel.y, w: sel.w, h: sel.h },
    engine: 'selection',
  };
}

// ---------------------------------------------------------------------------
// PDF vetorial (texto selecionável, links clicáveis) via Page.printToPDF
// ---------------------------------------------------------------------------
const PAPER_IN = { A4: [8.27, 11.69], Letter: [8.5, 11], Legal: [8.5, 14], A3: [11.69, 16.54] };
const HEADER_TPL = '<div style="font-family:Helvetica,Arial,sans-serif;font-size:8px;color:#6b7280;width:100%;padding:0 10mm;display:flex;justify-content:space-between;align-items:center;">'
  + '<span class="title" style="max-width:58%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;"></span>'
  + '<span class="url" style="max-width:40%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;"></span></div>';
const FOOTER_TPL = '<div style="font-family:Helvetica,Arial,sans-serif;font-size:8px;color:#6b7280;width:100%;padding:0 10mm;display:flex;justify-content:space-between;">'
  + '<span class="date"></span><span>Página <span class="pageNumber"></span> de <span class="totalPages"></span></span></div>';

async function capturePdf(tab, o, settings, widthHint) {
  const target = { tabId: tab.id };
  await attach(target);
  let media = false;
  let unfixed = false;
  let frozen = false;
  let revealed = false;
  try {
    const info = await exec(tab.id, fnPageInfo);
    if (settings.preScroll) {
      setBadge('lazy', '#003ec7');
      await exec(tab.id, fnPreScroll, [settings.preScrollDelay || 120, 20000]);
    }
    if (settings.revealAnim !== false) {
      await exec(tab.id, fnRevealAnim);
      revealed = true;
      await sleep(120);
    }
    if (o.screenMedia !== false) {
      await cdp(target, 'Emulation.setEmulatedMedia', { media: 'screen' });
      media = true;
    }
    if (o.mode === 'multi' && o.unfix !== false) {
      await exec(tab.id, fnUnfix);
      unfixed = true;
    }
    // Na impressão, 100vh vira a altura do papel (numa página única, a página inteira).
    // Congela vh/vmin/vmax em px da tela para o layout ficar igual ao que se vê.
    await exec(tab.id, fnFreezeVh);
    frozen = true;
    await sleep(80);
    const m = await cdp(target, 'Page.getLayoutMetrics');
    const info2 = await exec(tab.id, fnPageInfo);
    const cssW = widthHint || Math.ceil((m.cssLayoutViewport && m.cssLayoutViewport.clientWidth) || info2.clientWidth);
    const cssH = Math.ceil(Math.max((m.cssContentSize && m.cssContentSize.height) || 0, info2.scrollHeight, info2.clientHeight));
    const params = buildPrintParams(o, cssW, cssH);
    setBadge('PDF', '#003ec7');
    const print = async () => {
      const { expectedPages, ...cdpParams } = params;
      let r;
      try {
        r = await cdp(target, 'Page.printToPDF', cdpParams);
      } catch (e) {
        // Chrome antigo pode rejeitar parâmetros novos (outline / tagged): tenta sem eles.
        delete params.generateDocumentOutline;
        delete params.generateTaggedPDF;
        delete cdpParams.generateDocumentOutline;
        delete cdpParams.generateTaggedPDF;
        r = await cdp(target, 'Page.printToPDF', cdpParams);
      }
      return r.stream ? await readStream(target, r.stream) : r.data;
    };
    let base64 = await print();
    if (o.mode !== 'multi' && params.expectedPages) {
      // O layout de impressão pode sair alguns px mais alto que o de tela e vazar
      // para uma página extra. Se vazou, reimprime um pouco mais alto (até 2 vezes).
      const baseH = params.paperHeight;
      for (const bump of [1.03, 1.12]) {
        if (countPdfPages(base64) <= params.expectedPages) break;
        params.paperHeight = Math.min(MAX_SINGLE_PAGE_IN * 1.5, baseH * bump);
        base64 = await print();
      }
    }
    return { pdfBase64: base64, pdfOptions: o, width: cssW, height: cssH };
  } finally {
    if (frozen) { try { await exec(tab.id, fnUnfreezeVh); } catch {} }
    if (revealed) { try { await exec(tab.id, fnUnrevealAnim); } catch {} }
    if (unfixed) { try { await exec(tab.id, fnRefix); } catch {} }
    if (media) { try { await cdp(target, 'Emulation.setEmulatedMedia', { media: '' }); } catch {} }
    await detach(target);
  }
}

function buildPrintParams(o, cssW, cssH) {
  const hf = !!o.headerFooter;
  const p = {
    printBackground: o.background !== false,
    preferCSSPageSize: false,
    displayHeaderFooter: hf,
    transferMode: 'ReturnAsStream',
  };
  if (hf) { p.headerTemplate = HEADER_TPL; p.footerTemplate = FOOTER_TPL; }
  if (o.mode !== 'multi') {
    // Página única: largura = viewport, altura = conteúdo. Acima do limite, o Chrome pagina sozinho.
    const mv = hf ? 0.45 : 0;
    const contentIn = cssH / 96 + 0.03;
    // Acima do limite, divide em N páginas iguais (em vez de deixar a última quase vazia).
    const n = Math.max(1, Math.ceil(contentIn / MAX_SINGLE_PAGE_IN));
    p.paperWidth = cssW / 96;
    p.paperHeight = contentIn / n + 2 * mv;
    p.marginTop = mv; p.marginBottom = mv; p.marginLeft = 0; p.marginRight = 0;
    p.scale = 1;
    p.expectedPages = n;
  } else {
    let [w, h] = PAPER_IN[o.paper] || PAPER_IN.A4;
    if (o.landscape) [w, h] = [h, w];
    const m = Math.max(0, (Number(o.marginMm) || 0) / 25.4);
    const mv = hf ? Math.max(m, 0.45) : m;
    p.paperWidth = w; p.paperHeight = h;
    p.marginLeft = m; p.marginRight = m; p.marginTop = mv; p.marginBottom = mv;
    const availPx = (w - 2 * m) * 96;
    p.scale = o.keepLayout !== false ? Math.min(1, Math.max(0.1, availPx / cssW)) : 1;
  }
  if (o.outline) p.generateDocumentOutline = true;
  if (o.tagged) p.generateTaggedPDF = true;
  return p;
}

// Conta páginas pelo /Count do objeto /Pages (o Chrome sempre escreve). Decodifica só o necessário.
function countPdfPages(base64) {
  try {
    const s = atob(base64);
    let max = 0;
    const re = /\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages/g;
    let m;
    while ((m = re.exec(s))) max = Math.max(max, Number(m[1] || m[2]));
    if (!max) max = (s.match(/\/Type\s*\/Page[^s]/g) || []).length;
    return max || 1;
  } catch { return 1; }
}

async function readStream(target, handle) {
  // Cada pedaço vem em base64 próprio (o Chrome nem sempre devolve o tamanho pedido),
  // então decodifica pedaço a pedaço e recodifica uma vez no fim.
  const parts = [];
  for (;;) {
    const r = await cdp(target, 'IO.read', { handle, size: 4 * 1024 * 1024 });
    if (r.data) parts.push(r.base64Encoded ? atob(r.data) : r.data);
    if (r.eof) break;
  }
  try { await cdp(target, 'IO.close', { handle }); } catch {}
  return btoa(parts.join(''));
}

// ---------------------------------------------------------------------------
// Funções injetadas na página (precisam ser autocontidas)
// ---------------------------------------------------------------------------
function fnPageInfo() {
  const de = document.documentElement;
  const b = document.body;
  return {
    dpr: window.devicePixelRatio || 1,
    scrollHeight: Math.max(de.scrollHeight, b ? b.scrollHeight : 0, de.offsetHeight, b ? b.offsetHeight : 0),
    scrollWidth: Math.max(de.scrollWidth, b ? b.scrollWidth : 0),
    clientWidth: de.clientWidth || window.innerWidth,
    clientHeight: de.clientHeight || window.innerHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  };
}

async function fnPreScroll(stepDelay, maxMs) {
  const de = document.documentElement;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const prev = de.style.scrollBehavior;
  de.style.scrollBehavior = 'auto';
  const y0 = window.scrollY;
  const t0 = Date.now();
  const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
  let y = 0;
  while (y < de.scrollHeight && Date.now() - t0 < maxMs) {
    window.scrollTo(0, y);
    await wait(stepDelay);
    y += step;
  }
  window.scrollTo(0, de.scrollHeight);
  await wait(stepDelay);
  window.scrollTo(0, y0);
  await wait(250);
  de.style.scrollBehavior = prev;
  return true;
}

function fnScrollPrepare() {
  const de = document.documentElement;
  const b = document.body;
  de.dataset.clPrevScrollBehavior = de.style.scrollBehavior || '';
  de.style.scrollBehavior = 'auto';
  return {
    dpr: window.devicePixelRatio || 1,
    scrollHeight: Math.max(de.scrollHeight, b ? b.scrollHeight : 0),
    clientWidth: de.clientWidth || window.innerWidth,
    clientHeight: de.clientHeight || window.innerHeight,
    scrollY: window.scrollY,
  };
}

async function fnScrollStep(y, hideFixed, settle) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  if (hideFixed && !document.documentElement.dataset.clFixedHidden) {
    document.documentElement.dataset.clFixedHidden = '1';
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed') {
        el.dataset.clPrevVis = el.style.visibility || '';
        el.style.setProperty('visibility', 'hidden', 'important');
        el.dataset.clFixed = '1';
      } else if (cs.position === 'sticky') {
        el.dataset.clPrevPos = el.style.position || '';
        el.style.setProperty('position', 'relative', 'important');
        el.dataset.clSticky = '1';
      }
    }
  }
  window.scrollTo(0, y);
  await wait(settle);
  return { scrollY: window.scrollY };
}

function fnScrollRestore(y0) {
  for (const el of document.querySelectorAll('[data-cl-fixed]')) {
    el.style.visibility = el.dataset.clPrevVis || '';
    delete el.dataset.clFixed; delete el.dataset.clPrevVis;
  }
  for (const el of document.querySelectorAll('[data-cl-sticky]')) {
    el.style.position = el.dataset.clPrevPos || '';
    delete el.dataset.clSticky; delete el.dataset.clPrevPos;
  }
  const de = document.documentElement;
  delete de.dataset.clFixedHidden;
  window.scrollTo(0, y0);
  de.style.scrollBehavior = de.dataset.clPrevScrollBehavior || '';
  delete de.dataset.clPrevScrollBehavior;
  return true;
}

// Multipágina: elementos position:fixed se repetem em toda página impressa pelo Chrome.
// Converte para absolute na posição atual e sticky para relative; fnRefix desfaz.
function fnUnfix() {
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed') {
      const r = el.getBoundingClientRect();
      el.dataset.clUnfix = JSON.stringify({ position: el.style.position || '', top: el.style.top || '', left: el.style.left || '', bottom: el.style.bottom || '', right: el.style.right || '' });
      el.style.setProperty('position', 'absolute', 'important');
      el.style.setProperty('top', (r.top + window.scrollY) + 'px', 'important');
      el.style.setProperty('left', (r.left + window.scrollX) + 'px', 'important');
      el.style.setProperty('bottom', 'auto', 'important');
      el.style.setProperty('right', 'auto', 'important');
    } else if (cs.position === 'sticky') {
      el.dataset.clUnsticky = el.style.position || '';
      el.style.setProperty('position', 'relative', 'important');
    }
  }
  return true;
}

function fnRefix() {
  for (const el of document.querySelectorAll('[data-cl-unfix]')) {
    try {
      const s = JSON.parse(el.dataset.clUnfix);
      for (const k of ['position', 'top', 'left', 'bottom', 'right']) el.style[k] = s[k];
    } catch {}
    delete el.dataset.clUnfix;
  }
  for (const el of document.querySelectorAll('[data-cl-unsticky]')) {
    el.style.position = el.dataset.clUnsticky || '';
    delete el.dataset.clUnsticky;
  }
  return true;
}

// Substitui vh/vmin/vmax (e dvh/svh/lvh) por px calculados com a viewport de tela,
// em todas as regras CSS acessíveis e estilos inline. fnUnfreezeVh desfaz.
function fnFreezeVh() {
  const vh = window.innerHeight / 100;
  const vw = (document.documentElement.clientWidth || window.innerWidth) / 100;
  const backup = [];
  const has = /\d(?:d|s|l)?v(?:h|min|max)\b/;
  const re = /(-?\d*\.?\d+)(?:d|s|l)?v(h|min|max)\b/g;
  const conv = (val) => val.replace(re, (m, n, unit) => {
    const x = parseFloat(n);
    const px = unit === 'h' ? x * vh : unit === 'min' ? x * Math.min(vh, vw) : x * Math.max(vh, vw);
    return px.toFixed(2) + 'px';
  });
  const fixStyle = (st) => {
    const props = [];
    for (let i = 0; i < st.length; i++) props.push(st[i]);
    for (const prop of props) {
      const v = st.getPropertyValue(prop);
      if (!has.test(v)) continue;
      const pr = st.getPropertyPriority(prop);
      backup.push({ st, prop, v, pr });
      try { st.setProperty(prop, conv(v), pr); } catch {}
    }
  };
  const walk = (rules) => {
    for (const rule of rules) {
      if (rule.style) fixStyle(rule.style);
      if (rule.cssRules && rule.cssRules.length) walk(rule.cssRules);
    }
  };
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; } // folha de outra origem: inacessível
    if (rules) walk(rules);
  }
  for (const el of document.querySelectorAll('[style*="vh"],[style*="vmin"],[style*="vmax"]')) fixStyle(el.style);
  window.__clVhBackup = backup;
  return backup.length;
}

function fnUnfreezeVh() {
  const backup = window.__clVhBackup || [];
  for (const { st, prop, v, pr } of backup) { try { st.setProperty(prop, v, pr); } catch {} }
  window.__clVhBackup = null;
  return backup.length;
}

// Muita página moderna (Framer, Webflow, AOS, GSAP, Elementor) deixa blocos com
// opacity 0 até rolarem para dentro da tela, e alguns voltam a se esconder ao sair.
// Como o motor CDP e o printToPDF não rolam a página, esses blocos saem em branco —
// no PDF nem o texto vai junto. Aqui concluímos as animações em curso e destravamos
// o que ficou escondido; fnUnrevealAnim devolve a página ao estado original.
function fnRevealAnim() {
  let finished = 0;
  try {
    for (const a of document.getAnimations()) { try { a.finish(); finished++; } catch {} }
  } catch {}

  // Bibliotecas que escondem por classe/atributo: um CSS resolve sem tocar no DOM.
  if (!document.getElementById('__cl_reveal_css')) {
    const st = document.createElement('style');
    st.id = '__cl_reveal_css';
    st.textContent = '[data-aos]{opacity:1!important;transform:none!important;transition:none!important}'
      + '.wow,.animated{visibility:visible!important;animation-name:none!important}'
      + '.elementor-invisible{opacity:1!important;visibility:visible!important;animation:none!important}'
      + '.gs-reveal,.reveal,.scroll-reveal,.js-reveal{opacity:1!important;transform:none!important}';
    (document.head || document.documentElement).appendChild(st);
  }

  // Animação por JS deixa a pista no estilo inline (style="opacity:0"). Conteúdo
  // escondido de propósito usa display:none ou classe CSS, que não tocamos aqui.
  const backup = window.__clRevealBackup || (window.__clRevealBackup = []);
  let revealed = 0;
  for (const el of document.querySelectorAll('[style*="opacity"]')) {
    if (el.dataset.clRevealed) continue;
    const op = el.style.opacity;
    if (op === '' || !(Number(op) < 1)) continue;
    if (getComputedStyle(el).display === 'none') continue;
    backup.push({
      el,
      opacity: op, opacityPriority: el.style.getPropertyPriority('opacity'),
      transform: el.style.transform, transformPriority: el.style.getPropertyPriority('transform'),
      visibility: el.style.visibility, visibilityPriority: el.style.getPropertyPriority('visibility'),
      filter: el.style.filter, filterPriority: el.style.getPropertyPriority('filter'),
    });
    el.dataset.clRevealed = '1';
    el.style.setProperty('opacity', '1', 'important');
    if (el.style.transform && el.style.transform !== 'none') el.style.setProperty('transform', 'none', 'important');
    if (el.style.visibility === 'hidden') el.style.setProperty('visibility', 'visible', 'important');
    if (el.style.filter && /blur/.test(el.style.filter)) el.style.setProperty('filter', 'none', 'important');
    revealed++;
  }
  return { finished, revealed };
}

function fnUnrevealAnim() {
  const backup = window.__clRevealBackup || [];
  for (const b of backup) {
    for (const prop of ['opacity', 'transform', 'visibility', 'filter']) {
      const v = b[prop];
      const pr = b[prop + 'Priority'];
      try {
        b.el.style.removeProperty(prop);
        if (v) b.el.style.setProperty(prop, v, pr);
      } catch {}
    }
    delete b.el.dataset.clRevealed;
  }
  window.__clRevealBackup = null;
  const st = document.getElementById('__cl_reveal_css');
  if (st) st.remove();
  return backup.length;
}

// Seleção por arrasto: devolve o retângulo em px CSS relativo à viewport (ou null se cancelado).
function fnSelect() {
  return new Promise((resolve) => {
    const old = document.getElementById('__cl_sel_overlay');
    if (old) old.remove();
    const ov = document.createElement('div');
    ov.id = '__cl_sel_overlay';
    Object.assign(ov.style, {
      position: 'fixed', inset: '0', zIndex: '2147483647', cursor: 'crosshair',
      background: 'rgba(15,23,42,0.28)', userSelect: 'none', margin: '0', padding: '0',
    });
    const box = document.createElement('div');
    Object.assign(box.style, {
      position: 'fixed', display: 'none', pointerEvents: 'none', boxSizing: 'border-box',
      border: '2px solid #003ec7', background: 'transparent',
      boxShadow: '0 0 0 100000px rgba(15,23,42,0.28)',
    });
    const hint = document.createElement('div');
    hint.textContent = 'Arraste para selecionar a área. Esc cancela.';
    Object.assign(hint.style, {
      position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)',
      background: '#0f172a', color: '#fff', font: '13px/1.4 -apple-system, Inter, Segoe UI, sans-serif',
      padding: '8px 14px', borderRadius: '999px', pointerEvents: 'none', boxShadow: '0 4px 16px rgba(0,0,0,.25)',
    });
    let sx = 0, sy = 0, dragging = false, cur = null;
    const rect = (e) => {
      const x1 = Math.min(sx, e.clientX), y1 = Math.min(sy, e.clientY);
      const x2 = Math.max(sx, e.clientX), y2 = Math.max(sy, e.clientY);
      return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    };
    const draw = (e) => {
      cur = rect(e);
      Object.assign(box.style, { left: cur.x + 'px', top: cur.y + 'px', width: cur.w + 'px', height: cur.h + 'px' });
    };
    const cleanup = () => {
      ov.remove();
      window.removeEventListener('keydown', onKey, true);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cleanup(); resolve(null); }
    };
    ov.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      sx = e.clientX; sy = e.clientY; dragging = true;
      ov.style.background = 'transparent';
      box.style.display = 'block';
      hint.style.display = 'none';
      draw(e);
    });
    ov.addEventListener('mousemove', (e) => { if (dragging) draw(e); });
    ov.addEventListener('mouseup', (e) => {
      if (!dragging) return;
      draw(e);
      cleanup();
      if (!cur || cur.w < 4 || cur.h < 4) { resolve(null); return; }
      resolve({
        x: cur.x, y: cur.y, w: cur.w, h: cur.h,
        dpr: window.devicePixelRatio || 1,
        vw: document.documentElement.clientWidth || window.innerWidth,
        vh: document.documentElement.clientHeight || window.innerHeight,
      });
    });
    window.addEventListener('keydown', onKey, true);
    ov.append(box, hint);
    document.documentElement.append(ov);
  });
}

// ---------------------------------------------------------------------------
// Infra: DevTools Protocol, injeção de script, storage, badge, notificações
// ---------------------------------------------------------------------------
function cdp(target, method, params) {
  return chrome.debugger.sendCommand(target, method, params || {});
}

async function attach(target) {
  try {
    await chrome.debugger.attach(target, PROTO);
  } catch (e) {
    throw new Error('Não foi possível conectar o depurador à aba. Feche o DevTools desta aba (F12) e tente de novo. Detalhe: ' + errMsg(e));
  }
}

async function detach(target) {
  try { await chrome.debugger.detach(target); } catch {}
}

async function exec(tabId, func, args) {
  const results = await chrome.scripting.executeScript({ target: { tabId }, func, args: args || [] });
  const r = results && results[0];
  if (!r) throw new Error('Não foi possível executar script na página.');
  if (r.error) throw new Error(r.error.message || String(r.error));
  return r.result;
}

function resolveScale(setting, dpr) {
  if (setting === 'auto' || setting === undefined || setting === null || setting === '') return dpr || 1;
  const n = Number(setting);
  return n > 0 ? n : (dpr || 1);
}

async function throttleVisibleCapture() {
  const wait = lastVisibleCaptureAt + VISIBLE_CAPTURE_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastVisibleCaptureAt = Date.now();
}

async function saveRecord(rec) {
  const { capIndex = [] } = await chrome.storage.local.get('capIndex');
  const entry = {
    id: rec.id, title: rec.title, url: rec.url, createdAt: rec.createdAt,
    kind: rec.kind, mode: rec.mode, width: rec.width, height: rec.height,
  };
  const index = [entry, ...capIndex.filter((e) => e.id !== rec.id)];
  const keep = index.slice(0, HISTORY_SIZE);
  const drop = index.slice(HISTORY_SIZE);
  await chrome.storage.local.set({ ['cap:' + rec.id]: rec, capIndex: keep });
  if (drop.length) await chrome.storage.local.remove(drop.map((e) => 'cap:' + e.id));
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

function setBadge(text, color) {
  try {
    chrome.action.setBadgeText({ text: text || '' });
    if (color) chrome.action.setBadgeBackgroundColor({ color });
  } catch {}
}

function notify(title, message) {
  try {
    chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title, message: String(message || '').slice(0, 300) });
  } catch {}
}

function stripHash(u) { return String(u || '').split('#')[0]; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function errMsg(e) { return (e && e.message) ? e.message : String(e); }
