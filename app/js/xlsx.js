// Baca & tulis file Excel (.xlsx) dan CSV langsung di browser, tanpa pustaka luar.
// .xlsx = arsip zip berisi XML. Baca: buka zip (DecompressionStream), ambil sheet pertama. Tulis: zip tanpa kompresi.

const td = new TextDecoder();
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

async function inflate(data) {
  const ds = new DecompressionStream('deflate-raw');
  const buf = await new Response(new Blob([data]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(buf);
}
// Isi arsip zip: { 'xl/workbook.xml': async () => Uint8Array, ... }
function unzip(b) {
  let e = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (u32(b, i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('Bukan file Excel .xlsx yang valid');
  const n = u16(b, e + 10);
  let p = u32(b, e + 16);
  const files = {};
  for (let k = 0; k < n; k++) {
    if (u32(b, p) !== 0x02014b50) break;
    const method = u16(b, p + 10), csize = u32(b, p + 20), nlen = u16(b, p + 28), xlen = u16(b, p + 30), clen = u16(b, p + 32), off = u32(b, p + 42);
    const name = td.decode(b.subarray(p + 46, p + 46 + nlen));
    files[name] = async () => {
      const start = off + 30 + u16(b, off + 26) + u16(b, off + 28);
      const raw = b.subarray(start, start + csize);
      if (method === 0) return raw;
      if (method === 8) return inflate(raw);
      throw new Error('Format kompresi file Excel tidak didukung');
    };
    p += 46 + nlen + xlen + clen;
  }
  return files;
}
const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
const kids = (el, tag) => [...el.getElementsByTagName('*')].filter((x) => x.localName === tag);
const colIdx = (ref) => { let n = 0; for (const ch of String(ref).replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

async function readXlsx(buf) {
  const z = unzip(new Uint8Array(buf));
  const txt = async (name) => (z[name] ? td.decode(await z[name]()) : null);
  // Sheet pertama sesuai urutan di workbook
  let path = 'xl/worksheets/sheet1.xml';
  const wb = await txt('xl/workbook.xml'), rels = await txt('xl/_rels/workbook.xml.rels');
  if (wb && rels) {
    const s0 = kids(xml(wb), 'sheet')[0];
    const rid = s0 && [...s0.attributes].find((a) => a.localName === 'id')?.value;
    const rel = rid && kids(xml(rels), 'Relationship').find((r) => r.getAttribute('Id') === rid);
    if (rel) { const t = rel.getAttribute('Target'); path = t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, ''); }
  }
  const sheet = await txt(path);
  if (!sheet) throw new Error('Sheet pertama tidak ditemukan di file Excel');
  const ssx = await txt('xl/sharedStrings.xml');
  const shared = ssx ? kids(xml(ssx), 'si').map((si) => kids(si, 't').map((t) => t.textContent).join('')) : [];
  const rows = [];
  for (const r of kids(xml(sheet), 'row')) {
    const ri = Number(r.getAttribute('r') || rows.length + 1) - 1;
    const row = [];
    for (const c of kids(r, 'c')) {
      const t = c.getAttribute('t'), v = kids(c, 'v')[0]?.textContent ?? '';
      const val = t === 's' ? shared[Number(v)] ?? '' : t === 'inlineStr' ? kids(c, 't').map((x) => x.textContent).join('') : t === 'b' ? (v === '1' ? 'TRUE' : 'FALSE') : v;
      row[c.getAttribute('r') ? colIdx(c.getAttribute('r')) : row.length] = val;
    }
    rows[ri] = Array.from(row, (x) => x ?? '');
  }
  return Array.from(rows, (x) => x || []).filter((r) => r.some((x) => String(x).trim() !== ''));
}

// CSV dari Excel Indonesia biasanya memakai titik koma
export function parseCsv(text) {
  const t = String(text).replace(/^﻿/, '');
  const first = t.split(/\r?\n/)[0] || '';
  const sep = [';', '\t', ','].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"' && t[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === sep) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

// Baca file pilihan pengguna → baris tabel (array of array teks)
export async function readTable(file) {
  const name = (file.name || '').toLowerCase();
  if (/\.xls$/.test(name)) throw new Error('File .xls versi lama belum didukung. Di Excel pilih File › Simpan Sebagai › Excel Workbook (.xlsx), lalu pilih file itu lagi.');
  if (/\.(csv|txt|tsv)$/.test(name)) return parseCsv(await file.text());
  return readXlsx(await file.arrayBuffer());
}
// Baris tabel → teks ber-tab, supaya bisa dipakai pengenal daftar menu yang sama dengan tempelan dari spreadsheet
export const rowsToTsv = (rows) => rows.map((r) => r.map((x) => String(x ?? '').replace(/[\t\r\n]+/g, ' ').trim()).join('\t')).join('\n');

// ---------- Tulis .xlsx ----------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function zip(files) {
  const te = new TextEncoder(), parts = [], central = [];
  let off = 0;
  const w16 = (a, o, v) => { a[o] = v & 255; a[o + 1] = (v >>> 8) & 255; };
  const w32 = (a, o, v) => { a[o] = v & 255; a[o + 1] = (v >>> 8) & 255; a[o + 2] = (v >>> 16) & 255; a[o + 3] = (v >>> 24) & 255; };
  for (const [name, content] of files) {
    const nb = te.encode(name), data = typeof content === 'string' ? te.encode(content) : content, crc = crc32(data);
    const h = new Uint8Array(30 + nb.length);
    w32(h, 0, 0x04034b50); w16(h, 4, 20); w16(h, 6, 0x0800); w16(h, 8, 0); w16(h, 10, 0); w16(h, 12, 0x21);
    w32(h, 14, crc); w32(h, 18, data.length); w32(h, 22, data.length); w16(h, 26, nb.length); w16(h, 28, 0); h.set(nb, 30);
    const c = new Uint8Array(46 + nb.length);
    w32(c, 0, 0x02014b50); w16(c, 4, 20); w16(c, 6, 20); w16(c, 8, 0x0800); w16(c, 10, 0); w16(c, 12, 0); w16(c, 14, 0x21);
    w32(c, 16, crc); w32(c, 20, data.length); w32(c, 24, data.length); w16(c, 28, nb.length); w32(c, 42, off); c.set(nb, 46);
    parts.push(h, data); central.push(c); off += h.length + data.length;
  }
  const csize = central.reduce((s, c) => s + c.length, 0), end = new Uint8Array(22);
  w32(end, 0, 0x06054b50); w16(end, 8, files.length); w16(end, 10, files.length); w32(end, 12, csize); w32(end, 16, off);
  return new Blob([...parts, ...central, end], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (i) => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
// rows: array of array (angka ditulis sebagai angka). Baris pertama = judul kolom (tebal). widths: lebar kolom (karakter).
export function writeXlsx(rows, { sheet = 'Menu', widths = [] } = {}) {
  const sd = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
    const ref = colName(ci) + (ri + 1), st = ri === 0 ? ' s="1"' : '';
    if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${st}><v>${v}</v></c>`;
    return `<c r="${ref}" t="inlineStr"${st}><is><t xml:space="preserve">${esc(v ?? '')}</t></is></c>`;
  }).join('')}</row>`).join('');
  const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(sheet)}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'],
    ['xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols}<sheetData>${sd}</sheetData></worksheet>`],
  ]);
}
