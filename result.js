// Página de resultado: monta a captura (costura das fatias), exporta PNG/JPEG,
// gera PDF vetorial (via service worker) ou PDF de imagem, copia, imprime.
(async () => {
  const $ = (s) => document.querySelector(s);
  const q = new URLSearchParams(location.search);
  const id = q.get('id');
  const auto = q.get('auto');
  const PAPER_IN = { A4: [8.27, 11.69], Letter: [8.5, 11], Legal: [8.5, 14], A3: [11.69, 16.54] };
  const PT_PER_PX = 0.75; // 96 px CSS = 72 pt
  const MAX_PAGE_PT = 14400; // 200 in, limite do formato PDF

  const state = {
    rec: null, settings: null,
    canvas: null, pixelRatio: 1, reduced: false,
    imageUrl: null,
    pdf: null, // { blob, url, label, ext }
    view: 'image',
  };

  // ------------------------------------------------------------------ util
  let toastTimer = null;
  function toast(msg, isError) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('error', !!isError);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), isError ? 6000 : 3000);
  }
  function showError(msg) {
    const e = $('#error');
    e.hidden = false;
    e.textContent = msg;
    toast(msg, true);
  }
  function setLoading(text) {
    const l = $('#loading');
    if (text) { l.hidden = false; $('#loadingText').textContent = text; } else { l.hidden = true; }
  }
  function loadImage(src) {
    return new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('Falha ao decodificar uma fatia da captura.'));
      i.src = src;
    });
  }
  function toBlob(canvas, type, quality) {
    return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Falha ao codificar a imagem.'))), type, quality));
  }
  function withBusy(btn, fn) {
    return async () => {
      const prev = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Aguarde...';
      try { await fn(); } catch (e) { showError(e.message || String(e)); } finally { btn.disabled = false; btn.textContent = prev; }
    };
  }

  // ------------------------------------------------------------------ costura
  async function stitch(rec) {
    let pr = rec.pixelRatio || 1;
    // Motor de rolagem captura sempre no DPR da tela; reduz aqui se o usuário pediu 1x.
    let f = 1;
    if (rec.downscaleTo && rec.downscaleTo < pr) f = rec.downscaleTo / pr;
    let W = Math.round(rec.width * pr * f);
    let H = Math.round(rec.height * pr * f);
    const MAX_SIDE = 32000, MAX_AREA = 240e6;
    let reduced = false;
    if (H > MAX_SIDE || W > MAX_SIDE || W * H > MAX_AREA) {
      const g = Math.min(MAX_SIDE / H, MAX_SIDE / W, Math.sqrt(MAX_AREA / (W * H)));
      f *= g; W = Math.floor(rec.width * pr * f); H = Math.floor(rec.height * pr * f);
      reduced = true;
    }
    const effPr = pr * f;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < rec.chunks.length; i++) {
      const ch = rec.chunks[i];
      setLoading(`Montando a captura (${i + 1}/${rec.chunks.length})...`);
      const img = await loadImage(ch.dataUrl);
      ctx.drawImage(img, 0, Math.round(ch.y * effPr), Math.round(img.naturalWidth * f), Math.round(img.naturalHeight * f));
    }
    let out = c;
    if (rec.crop) {
      const cw = Math.max(1, Math.round(rec.crop.w * effPr));
      const chh = Math.max(1, Math.round(rec.crop.h * effPr));
      const cc = document.createElement('canvas');
      cc.width = cw; cc.height = chh;
      cc.getContext('2d').drawImage(c, Math.round(rec.crop.x * effPr), Math.round(rec.crop.y * effPr), cw, chh, 0, 0, cw, chh);
      out = cc;
    }
    return { canvas: out, pixelRatio: effPr, reduced };
  }

  function scaledCanvas(scale) {
    const c = state.canvas;
    if (!c || scale >= 1) return c;
    const s = document.createElement('canvas');
    s.width = Math.max(1, Math.round(c.width * scale));
    s.height = Math.max(1, Math.round(c.height * scale));
    const ctx = s.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(c, 0, 0, s.width, s.height);
    return s;
  }

  // ------------------------------------------------------------------ download
  async function download(blob, ext) {
    const name = await CL.buildFilename(state.rec, ext, state.settings);
    const url = URL.createObjectURL(blob);
    await chrome.downloads.download({ url, filename: name, saveAs: !!state.settings.saveAs, conflictAction: 'uniquify' });
    toast(`Salvo em Downloads/${name} (${CL.humanBytes(blob.size)})`);
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }

  async function exportImage(type) {
    const scale = Number($('#exportScale').value) || 1;
    const quality = Math.min(1, Math.max(0.5, (Number($('#jpegQuality').value) || 92) / 100));
    const c = scaledCanvas(scale);
    const blob = await toBlob(c, type === 'jpeg' ? 'image/jpeg' : 'image/png', quality);
    await download(blob, type === 'jpeg' ? 'jpg' : 'png');
  }

  async function copyImage() {
    const c = scaledCanvas(Number($('#exportScale').value) || 1);
    const blob = await toBlob(c, 'image/png');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('Imagem copiada para a área de transferência.');
  }

  // ------------------------------------------------------------------ PDF
  function readPdfOptions() {
    return {
      mode: $('#pdfMode button.on') ? $('#pdfMode button.on').dataset.mode : 'single',
      paper: $('#paper').value,
      landscape: $('#landscape').value === 'true',
      marginMm: Number($('#marginMm').value) || 0,
      keepLayout: $('#keepLayout').checked,
      unfix: $('#unfix').checked,
      background: $('#background').checked,
      headerFooter: $('#headerFooter').checked,
      outline: $('#outline').checked,
      screenMedia: $('#screenMedia').checked,
      tagged: $('#tagged').checked,
    };
  }
  function paintPdfOptions(o) {
    document.querySelectorAll('#pdfMode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === o.mode));
    $('#multiOnly').classList.toggle('show', o.mode === 'multi');
    $('#paper').value = o.paper;
    $('#landscape').value = String(!!o.landscape);
    $('#marginMm').value = o.marginMm;
    $('#keepLayout').checked = !!o.keepLayout;
    $('#unfix').checked = !!o.unfix;
    $('#background').checked = !!o.background;
    $('#headerFooter').checked = !!o.headerFooter;
    $('#outline').checked = !!o.outline;
    $('#screenMedia').checked = !!o.screenMedia;
    $('#tagged').checked = !!o.tagged;
  }
  async function persistPdfOptions() {
    state.settings = await CL.saveSettings({ pdf: readPdfOptions() });
  }

  function setPdf(blob, label) {
    if (state.pdf && state.pdf.url) URL.revokeObjectURL(state.pdf.url);
    state.pdf = { blob, url: URL.createObjectURL(blob), label };
    $('#pdfReady').classList.add('show');
    $('#pdfReadyLabel').textContent = `${label} (${CL.humanBytes(blob.size)})`;
    $('#viewPdfBtn').disabled = false;
    $('#pdfIframe').src = state.pdf.url;
    setView('pdf');
  }

  async function generateVectorPdf() {
    await persistPdfOptions();
    const options = readPdfOptions();
    const r = await chrome.runtime.sendMessage({ type: 'generatePdf', id, options });
    if (!r || r.error) throw new Error((r && r.error) || 'Falha ao gerar o PDF.');
    setPdf(CL.base64ToBlob(r.base64, 'application/pdf'), 'PDF com texto selecionável');
  }

  async function generateImagePdf() {
    await persistPdfOptions();
    const o = readPdfOptions();
    const c = state.canvas;
    if (!c) throw new Error('Não há imagem para converter.');
    const pr = state.pixelRatio;
    const cssW = c.width / pr, cssH = c.height / pr;
    const quality = Math.min(1, Math.max(0.5, (Number($('#jpegQuality').value) || 92) / 100));
    const slices = [];
    if (o.mode !== 'multi') {
      const pageW = cssW * PT_PER_PX;
      const maxSliceCss = MAX_PAGE_PT / PT_PER_PX;
      for (let y = 0; y < cssH; y += maxSliceCss) {
        const h = Math.min(maxSliceCss, cssH - y);
        slices.push({ srcY: y * pr, srcH: h * pr, pageW, pageH: h * PT_PER_PX, x: 0, y: 0, drawW: pageW, drawH: h * PT_PER_PX });
      }
    } else {
      let [wIn, hIn] = PAPER_IN[o.paper] || PAPER_IN.A4;
      if (o.landscape) [wIn, hIn] = [hIn, wIn];
      const pageW = wIn * 72, pageH = hIn * 72;
      const m = (o.marginMm / 25.4) * 72;
      const availW = pageW - 2 * m, availH = pageH - 2 * m;
      const s = availW / cssW;
      const sliceCss = availH / s;
      for (let y = 0; y < cssH; y += sliceCss) {
        const h = Math.min(sliceCss, cssH - y);
        slices.push({ srcY: y * pr, srcH: h * pr, pageW, pageH, x: m, y: pageH - m - h * s, drawW: cssW * s, drawH: h * s });
      }
    }
    const pages = [];
    for (let i = 0; i < slices.length; i++) {
      const p = slices[i];
      toast(`Gerando página ${i + 1} de ${slices.length}...`);
      const t = document.createElement('canvas');
      t.width = c.width;
      t.height = Math.max(1, Math.round(p.srcH));
      const ctx = t.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, t.width, t.height);
      ctx.drawImage(c, 0, Math.round(p.srcY), c.width, t.height, 0, 0, c.width, t.height);
      const blob = await toBlob(t, 'image/jpeg', quality);
      pages.push({ ...p, bytes: new Uint8Array(await blob.arrayBuffer()), wPx: t.width, hPx: t.height });
    }
    const bytes = PdfImage.build(pages, { title: state.rec.title });
    setPdf(new Blob([bytes], { type: 'application/pdf' }), 'PDF de imagem');
  }

  // ------------------------------------------------------------------ views
  function setView(v) {
    state.view = v;
    document.querySelectorAll('#viewSeg button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
    $('#imageFrame').hidden = v !== 'image';
    $('#pdfFrame').hidden = v !== 'pdf';
    $('#preview').classList.toggle('pdf', v === 'pdf');
    $('#zoomSeg').style.visibility = v === 'image' ? 'visible' : 'hidden';
  }
  function setZoom(z) {
    document.querySelectorAll('#zoomSeg button').forEach((b) => b.classList.toggle('on', b.dataset.zoom === z));
    $('#preview').classList.toggle('fit', z === 'fit');
  }

  // ------------------------------------------------------------------ main
  try {
    state.settings = await CL.getSettings();
    const rec = (await chrome.storage.local.get('cap:' + id))['cap:' + id];
    if (!rec) throw new Error('Captura não encontrada. Ela pode ter sido removida do histórico; capture a página novamente.');
    state.rec = rec;

    document.title = `Captura: ${rec.title}`;
    $('#title').textContent = rec.title;
    $('#url').textContent = rec.url;
    $('#infoUrl').textContent = rec.url;
    $('#infoUrl').href = rec.url;
    $('#infoDate').textContent = CL.formatDate(rec.createdAt);
    $('#infoMode').textContent = rec.kind === 'pdf' ? 'PDF direto (página inteira)'
      : rec.mode === 'full' ? `Página inteira (${rec.engine === 'scroll' ? 'rolagem e costura' : 'DevTools'})`
      : rec.mode === 'visible' ? 'Área visível' : 'Seleção';

    paintPdfOptions(state.settings.pdf);
    $('#exportScale').value = String(state.settings.exportScale || 1);
    $('#jpegQuality').value = Math.round((state.settings.jpegQuality || 0.92) * 100);

    if (rec.kind === 'image') {
      const r = await stitch(rec);
      state.canvas = r.canvas;
      state.pixelRatio = r.pixelRatio;
      state.reduced = r.reduced;
      const blob = await toBlob(r.canvas, 'image/png');
      state.imageUrl = URL.createObjectURL(blob);
      $('#img').src = state.imageUrl;
      $('#imageFrame').hidden = false;
      setLoading(null);
      const cssW = Math.round(r.canvas.width / r.pixelRatio), cssH = Math.round(r.canvas.height / r.pixelRatio);
      $('#infoSize').textContent = `${r.canvas.width} × ${r.canvas.height} px (${cssW} × ${cssH} CSS px)`;
      $('#infoScale').textContent = `${r.pixelRatio.toFixed(2)}x`;
      $('#imgDims').textContent = `PNG atual: ${r.canvas.width} × ${r.canvas.height} px, ${CL.humanBytes(blob.size)}`;
      if (r.reduced) toast('Página muito grande: a imagem foi reduzida para caber no limite do navegador.', true);
      // PDF vetorial só faz sentido para página inteira; nos outros modos oferece o PDF de imagem.
      if (rec.mode !== 'full') {
        $('#btnPdfVector').disabled = true;
        $('#pdfHint').textContent = 'Nos modos área visível e seleção o PDF é gerado a partir da imagem. Para PDF com texto selecionável, capture a página inteira.';
      }
    } else {
      // Registro de PDF direto: sem imagem, mostra o PDF.
      $('#secImage').hidden = true;
      $('#viewSeg button[data-view="image"]').disabled = true;
      setLoading(null);
      $('#infoSize').textContent = `${rec.width} × ${rec.height} CSS px`;
      $('#infoScale').textContent = 'vetorial';
      $('#btnPdfImage').disabled = true;
      setPdf(CL.base64ToBlob(rec.pdfBase64, 'application/pdf'), 'PDF com texto selecionável');
      paintPdfOptions(CL.deepMerge(state.settings.pdf, rec.pdfOptions || {}));
    }

    // Botões
    $('#btnPng').addEventListener('click', withBusy($('#btnPng'), () => exportImage('png')));
    $('#btnJpeg').addEventListener('click', withBusy($('#btnJpeg'), () => exportImage('jpeg')));
    $('#btnCopy').addEventListener('click', withBusy($('#btnCopy'), copyImage));
    $('#btnPrint').addEventListener('click', () => { setView('image'); setZoom('fit'); setTimeout(() => window.print(), 50); });
    $('#btnPdfVector').addEventListener('click', withBusy($('#btnPdfVector'), generateVectorPdf));
    $('#btnPdfImage').addEventListener('click', withBusy($('#btnPdfImage'), generateImagePdf));
    $('#btnPdfDownload').addEventListener('click', withBusy($('#btnPdfDownload'), () => download(state.pdf.blob, 'pdf')));
    $('#btnPdfOpen').addEventListener('click', () => chrome.tabs.create({ url: state.pdf.url }));
    document.querySelectorAll('#pdfMode button').forEach((b) => b.addEventListener('click', async () => {
      document.querySelectorAll('#pdfMode button').forEach((x) => x.classList.toggle('on', x === b));
      $('#multiOnly').classList.toggle('show', b.dataset.mode === 'multi');
      await persistPdfOptions();
    }));
    ['#paper', '#landscape', '#marginMm', '#keepLayout', '#unfix', '#background', '#headerFooter', '#outline', '#screenMedia', '#tagged']
      .forEach((s) => $(s).addEventListener('change', persistPdfOptions));
    $('#exportScale').addEventListener('change', async () => { state.settings = await CL.saveSettings({ exportScale: Number($('#exportScale').value) }); });
    $('#jpegQuality').addEventListener('change', async () => { state.settings = await CL.saveSettings({ jpegQuality: (Number($('#jpegQuality').value) || 92) / 100 }); });
    document.querySelectorAll('#viewSeg button').forEach((b) => b.addEventListener('click', () => { if (!b.disabled) setView(b.dataset.view); }));
    document.querySelectorAll('#zoomSeg button').forEach((b) => b.addEventListener('click', () => setZoom(b.dataset.zoom)));

    // Ações automáticas (botões "direto" do popup, atalhos e menu de contexto)
    if (auto === 'png' && rec.kind === 'image') {
      await exportImage('png');
    } else if (auto === 'pdf') {
      if (rec.kind === 'pdf') await download(state.pdf.blob, 'pdf');
      else { await generateImagePdf(); await download(state.pdf.blob, 'pdf'); }
    }
  } catch (e) {
    setLoading(null);
    showError(e.message || String(e));
  }
})();
