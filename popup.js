(async () => {
  const $ = (s) => document.querySelector(s);
  let settings = await CL.getSettings();
  let mode = settings.lastMode || 'full';

  // Aba atual: bloqueia páginas que o Chrome não deixa capturar.
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const capturable = tab && CL.isCapturableUrl(tab.url);
  if (!capturable) {
    const w = $('#warn');
    w.style.display = 'block';
    w.textContent = 'Esta página não pode ser capturada (páginas internas do Chrome, Web Store ou aba vazia). Abra um site http/https.';
    document.querySelectorAll('[data-output]').forEach((b) => (b.disabled = true));
  }

  const status = await chrome.runtime.sendMessage({ type: 'status' }).catch(() => null);
  if (status && status.busy) {
    const w = $('#warn');
    w.style.display = 'block';
    w.textContent = 'Há uma captura em andamento. Aguarde ela terminar.';
  } else if (status && status.lastError) {
    const w = $('#warn');
    w.style.display = 'block';
    w.textContent = 'Última captura falhou: ' + status.lastError;
  }

  // Modo
  const modeButtons = document.querySelectorAll('#modes button');
  const paintMode = () => {
    modeButtons.forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    $('#pdfNote').textContent = mode === 'full'
      ? 'PDF direto gera um PDF vetorial: texto selecionável, links clicáveis, editável no visualizador do Chrome.'
      : 'Nesse modo o PDF direto é gerado a partir da imagem capturada.';
  };
  modeButtons.forEach((b) => b.addEventListener('click', async () => {
    mode = b.dataset.mode;
    paintMode();
    settings = await CL.saveSettings({ lastMode: mode });
  }));
  paintMode();

  // Configurações
  $('#scale').value = String(settings.scale);
  $('#engine').value = settings.engine;
  $('#preScroll').checked = !!settings.preScroll;
  $('#saveAs').checked = !!settings.saveAs;
  $('#folder').value = settings.folder || '';
  const persist = async () => {
    settings = await CL.saveSettings({
      scale: $('#scale').value,
      engine: $('#engine').value,
      preScroll: $('#preScroll').checked,
      saveAs: $('#saveAs').checked,
      folder: CL.sanitizeFolder($('#folder').value),
    });
  };
  ['#scale', '#engine', '#preScroll', '#saveAs', '#folder'].forEach((s) => $(s).addEventListener('change', persist));

  // Ações
  document.querySelectorAll('[data-output]').forEach((b) => b.addEventListener('click', async () => {
    await persist();
    await chrome.runtime.sendMessage({ type: 'capture', mode, output: b.dataset.output, tabId: tab.id });
    window.close();
  }));

  // Recentes
  const { capIndex = [] } = await chrome.storage.local.get('capIndex');
  const ul = $('#recent');
  if (capIndex.length) {
    ul.innerHTML = '';
    for (const e of capIndex.slice(0, 5)) {
      const li = document.createElement('li');
      const kind = e.kind === 'pdf' ? 'PDF' : (e.mode === 'full' ? 'Inteira' : e.mode === 'visible' ? 'Visível' : 'Seleção');
      li.innerHTML = `<span class="pill blue"></span><div class="t"><b></b><span></span></div>`;
      li.querySelector('.pill').textContent = kind;
      li.querySelector('b').textContent = e.title || e.url;
      li.querySelector('span:last-child').textContent = `${CL.formatDate(e.createdAt)} · ${CL.hostOf(e.url)}`;
      li.addEventListener('click', () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('result.html?id=' + e.id) });
        window.close();
      });
      ul.appendChild(li);
    }
  }
})();
