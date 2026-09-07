// Gerador mínimo de PDF a partir de imagens JPEG (uma por página), sem dependências.
// pages: [{ bytes: Uint8Array (JPEG), wPx, hPx, pageW, pageH, x, y, drawW, drawH }]
// Unidades de página em pontos (1 pt = 1/72 in). Origem no canto inferior esquerdo.
const PdfImage = (() => {
  const enc = new TextEncoder();

  function pdfTextString(s) {
    // UTF-16BE com BOM em hex: aceita qualquer caractere.
    let hex = 'FEFF';
    for (const ch of String(s || '')) {
      const cp = ch.codePointAt(0);
      if (cp > 0xffff) {
        const v = cp - 0x10000;
        hex += (0xd800 + (v >> 10)).toString(16).padStart(4, '0') + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0');
      } else {
        hex += cp.toString(16).padStart(4, '0');
      }
    }
    return '<' + hex.toUpperCase() + '>';
  }

  function pdfDate(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  function fmt(n) { return Number(n).toFixed(3).replace(/\.?0+$/, ''); }

  function build(pages, meta) {
    const parts = [];
    const offsets = [];
    let pos = 0;
    const push = (bytes) => { parts.push(bytes); pos += bytes.length; };
    const pushStr = (s) => push(enc.encode(s));
    const addObj = (num, bodyStr, streamBytes) => {
      offsets[num] = pos;
      pushStr(`${num} 0 obj\n${bodyStr}\n`);
      if (streamBytes) {
        pushStr('stream\n');
        push(streamBytes);
        pushStr('\nendstream\n');
      }
      pushStr('endobj\n');
    };

    pushStr('%PDF-1.4\n');
    push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // comentário binário

    const n = pages.length;
    const pageObj = (i) => 4 + 3 * i;
    const contentObj = (i) => 5 + 3 * i;
    const imageObj = (i) => 6 + 3 * i;
    const kids = pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ');

    addObj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    addObj(2, `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
    addObj(3, `<< /Title ${pdfTextString(meta.title)} /Producer (Captura Local) /Creator (Captura Local) /CreationDate (${pdfDate(new Date())}) >>`);

    pages.forEach((p, i) => {
      const content = enc.encode(`q ${fmt(p.drawW)} 0 0 ${fmt(p.drawH)} ${fmt(p.x)} ${fmt(p.y)} cm /Im0 Do Q`);
      addObj(pageObj(i), `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(p.pageW)} ${fmt(p.pageH)}] /Resources << /XObject << /Im0 ${imageObj(i)} 0 R >> >> /Contents ${contentObj(i)} 0 R >>`);
      addObj(contentObj(i), `<< /Length ${content.length} >>`, content);
      addObj(imageObj(i), `<< /Type /XObject /Subtype /Image /Width ${p.wPx} /Height ${p.hPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.bytes.length} >>`, p.bytes);
    });

    const total = 3 + 3 * n;
    const xrefPos = pos;
    let xref = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= total; i++) xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    pushStr(xref);
    pushStr(`trailer\n<< /Size ${total + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);

    const out = new Uint8Array(pos);
    let o = 0;
    for (const part of parts) { out.set(part, o); o += part.length; }
    return out;
  }

  return { build };
})();
