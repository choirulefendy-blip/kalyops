// Impor daftar menu dari teks tempelan: tabel spreadsheet (Kategori, Nama, Harga, Deskripsi),
// CSV, atau teks bebas hasil salin dari halaman menu (judul kategori, lalu "Nama ... Rp25.000").

const PRICE = /(?:rp\.?\s*)?(\d{1,3}(?:[.,]\d{3})+|\d{4,7}|\d{1,3}(?:[.,]\d)?\s*(?:k|rb|ribu))(?![\d])/i;
const DRINK = /\b(kopi|coffee|espresso|americano|latte|cappuc+ino|cappu|mocha|macchiato|v60|tubruk|manual brew|teh|tea|matcha|chocolate|coklat|cokelat|susu|milk|jus|juice|soda|mojito|mocktail|squash|lemonade|wedang|jahe|es |ice |iced|smoothie|frappe|air mineral|mineral|drink|minuman|beverage|kelapa muda|yakult|float)\b/i;
const PLAY = /\b(pakan|sewa|tiket|pancing|bermain|play|wahana)\b/i;
const CATWORD = /^(main ?dish(es)?|mains?|makanan( berat| utama)?|food|snacks?|camilan|cemilan|appetizers?|starters?|desserts?|pencuci mulut|sweets?|coffee|kopi|non[- ]?coffee|non kopi|minuman|beverages?|drinks?|tea|teh|jamu|juice|jus|paket|bundling|signature|kids( menu)?|menu anak|sides?|add[- ]?ons?|tambahan|play( corner)?)$/i;
const HEADER_HINT = /^(menu|daftar menu|harga|price|nama|kategori|category|item)$/i;
// Harga ribuan tanpa nol, seperti di papan menu: "Latte 30" = Rp30.000
const BARE = /^(?:rp\.?\s*)?(\d{1,3})$/i;
const TRAIL = /^(.*[^\d\s])\s+(?:rp\.?\s*)?(\d{1,3})$/i;
const SOLD = /(?:^|\s)(sold ?out|habis|stok habis)\s*$/i;
const bareK = (v) => { const m = String(v || '').trim().match(BARE); return m && Number(m[1]) > 0 ? Number(m[1]) * 1000 : 0; };

export function parsePrice(s) {
  const m = String(s || '').match(PRICE);
  if (!m) return 0;
  let v = m[1].toLowerCase().replace(/\s+/g, '');
  if (/(k|rb|ribu)$/.test(v)) return Math.round(parseFloat(v.replace(/(k|rb|ribu)$/, '').replace(',', '.')) * 1000);
  return Number(v.replace(/[.,]/g, '')) || 0;
}
export const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '_').slice(0, 24) || 'menu';
const tidy = (s) => String(s || '').replace(/\s+/g, ' ').replace(/^[\s•·*\-–—|:]+|[\s•·*\-–—|:]+$/g, '').trim();
const titleCase = (s) => (s === s.toUpperCase() && /[A-Z]/.test(s) ? s.toLowerCase().replace(/(^|\s|\/|&)(\p{L})/gu, (a, p, c) => p + c.toUpperCase()) : s);

const DRINK_CAT = /(coffee|kopi|minum|beverage|drink|\btea\b|\bteh\b|juice|\bjus\b|jamu|dessert|es )/i;
const FOOD_CAT = /(main|makan|snack|camilan|cemilan|food|appetizer|starter|kids|anak|side)/i;
const FOOD = /\b(pisang|tape|goreng|bakar|nasi|mie|ayam|tahu|kentang|fries|sandwich|pizza|spaghetti|roti|churros|wings|kroket|ubi|platter|kerupuk|sate|bakso)\b/i;
export function guessStation(name, cat) {
  const t = `${cat || ''} ${name || ''} `;
  if (PLAY.test(t)) return 'none';
  if (/^air mineral|kerupuk/i.test(name || '')) return 'none';
  if (DRINK_CAT.test(cat || '')) return 'bar';
  if (FOOD_CAT.test(cat || '')) return 'dapur';
  if (/^(es|iced?)\b/i.test(name || '')) return 'bar';
  if (FOOD.test(name || '')) return 'dapur';
  return DRINK.test(t) ? 'bar' : 'dapur';
}

function splitRow(line) {
  if (line.includes('\t')) return line.split('\t');
  if ((line.match(/;/g) || []).length >= 2) return line.split(';');
  if ((line.match(/\|/g) || []).length >= 2) return line.split('|');
  // CSV sederhana dengan tanda kutip
  if ((line.match(/,/g) || []).length >= 2 && !/\d,\d{3}/.test(line)) {
    const out = []; let cur = '', q = false;
    for (const ch of line) { if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch; }
    out.push(cur); return out;
  }
  return null;
}

// Kolom tambahan dari file Excel unduhan Kaly Ops: Stasiun, Outlet, Status
const stationOf = (v) => { const t = String(v || '').toLowerCase(); return /bar|minum/.test(t) ? 'bar' : /dapur|kitchen|masak/.test(t) ? 'dapur' : /langsung|tanpa|none|-/.test(t) ? 'none' : null; };

// Hasil: [{ cat, name, price, desc, station, stationSet?, outletText?, soldOut?, inactive? }]
export function parseMenuText(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map((l) => l.replace(/ /g, ' ').trimEnd());
  const rows = lines.map(splitRow);
  const tabular = rows.filter((r) => r && r.length >= 2).length >= Math.max(2, lines.filter((l) => l.trim()).length * 0.6);
  return tabular ? parseTable(rows.filter(Boolean)) : parseFree(lines);
}

function parseTable(rows) {
  let cols = { cat: -1, name: -1, price: -1, desc: -1 };
  const head = rows[0].map((c) => tidy(c).toLowerCase());
  const has = (re) => head.findIndex((h) => re.test(h));
  if (has(/^(nama|name|menu|item)/) >= 0 && has(/^(harga|price)/) >= 0) {
    cols = { cat: has(/^(kategori|category|cat|grup|group)/), name: has(/^(nama|name|menu|item)/), price: has(/^(harga|price)/), desc: has(/^(deskripsi|desc|keterangan|description|isi)/),
      station: has(/^(stasiun|station)/), outlet: has(/^(outlet|lokasi|dijual di)/), status: has(/^(status)/) };
    rows = rows.slice(1);
  } else {
    // Tanpa judul kolom: cari kolom harga, sisanya urut kategori/nama/deskripsi
    const n = Math.max(...rows.map((r) => r.length));
    const priceCol = [...Array(n).keys()].find((i) => rows.filter((r) => (parsePrice(r[i]) > 0 || bareK(r[i]) > 0 || SOLD.test(r[i] || '')) && !/[a-z]{5,}/i.test((r[i] || '').replace(SOLD, ''))).length >= rows.length * 0.6);
    const others = [...Array(n).keys()].filter((i) => i !== priceCol);
    if (others.length >= 3) cols = { cat: others[0], name: others[1], desc: others[2], price: priceCol };
    else if (others.length === 2) cols = { cat: -1, name: others[0], desc: others[1], price: priceCol };
    else cols = { cat: -1, name: others[0], desc: -1, price: priceCol };
    if (others.length === 2 && rows.every((r) => tidy(r[others[1]]).length < 24)) cols = { cat: others[0], name: others[1], desc: -1, price: priceCol };
  }
  let lastCat = 'Menu';
  const out = [];
  for (const r of rows) {
    let name = tidy(r[cols.name]);
    const pc = r[cols.price] || '';
    const price = parsePrice(pc) || bareK(pc);
    const soldOut = SOLD.test(pc) || SOLD.test(name);
    name = tidy(name.replace(SOLD, ''));
    const cat = cols.cat >= 0 && tidy(r[cols.cat]) ? titleCase(tidy(r[cols.cat])) : lastCat;
    lastCat = cat;
    if (!name || HEADER_HINT.test(name)) continue;
    const desc = cols.desc >= 0 ? tidy(r[cols.desc]) : '';
    const stx = cols.station >= 0 ? stationOf(r[cols.station]) : null;
    const status = cols.status >= 0 ? String(r[cols.status] || '').toLowerCase() : '';
    const row = { cat, name: titleCase(name), price, desc, soldOut: soldOut || /habis|sold/.test(status), station: stx || guessStation(name, cat) };
    if (stx) row.stationSet = true;
    if (/nonaktif|non aktif|tidak (dijual|aktif)|off/.test(status)) row.inactive = true;
    if (cols.outlet >= 0 && tidy(r[cols.outlet])) row.outletText = tidy(r[cols.outlet]);
    out.push(row);
  }
  return out;
}

const UI_WORD = /^(\+|-|\+?\s*tambah|tambahkan|add|add to cart|pesan|pesan sekarang|order|beli|lihat|detail)$/i;
const TAG = [[/^(terlaris|best ?seller|favorit|favorite|recommended|rekomendasi|signature|must try)$/i, 'best'], [/^(baru|new|menu baru)$/i, 'new']];

function parseFree(lines) {
  const kilo = lines.filter((x) => { const t = tidy(x); return !PRICE.test(t) && (BARE.test(t) || TRAIL.test(t)); }).length >= 3;
  const info = lines.map((raw) => {
    let l = tidy(raw);
    if (!l || UI_WORD.test(l)) return { blank: !l, skip: !!l };
    if (SOLD.test(l)) { const rest = tidy(l.replace(SOLD, '')); if (!rest) return { soldTag: true, l }; l = rest; var sold = true; }
    const pm = l.match(PRICE);
    const price = pm ? parsePrice(l) : 0;
    if (price >= 500) {
      const before = tidy(l.slice(0, pm.index).replace(/\.{2,}/g, ' '));
      return { l, price, before, after: tidy(l.slice(pm.index + pm[0].length)), priceOnly: !before, sold };
    }
    if (kilo && BARE.test(l)) return { l, price: bareK(l), before: '', after: '', priceOnly: true };
    if (kilo && TRAIL.test(l)) { const m = l.match(TRAIL); return { l, price: Number(m[2]) * 1000, before: tidy(m[1].replace(/\.{2,}/g, ' ')), after: '', priceOnly: false, sold }; }
    if (sold) return { l, price: 0, before: l, after: '', priceOnly: false, sold, soldName: true };
    return { l, price: 0, short: l.length <= 34 && l.split(' ').length <= 6 && !/[.!?,;]$/.test(l), caps: l === l.toUpperCase() && /\p{Lu}/u.test(l) };
  });
  const isTag = (x) => x && (x.soldTag || (!x.price && TAG.some(([re]) => re.test(x.l || ''))));
  const nextNB = (i) => { for (let j = i + 1; j < info.length; j++) if (!info[j].blank && !info[j].skip && !isTag(info[j])) return j; return -1; };
  const words = (l) => l.split(/\s+/).filter((w) => /\p{L}/u.test(w));
  const lowerShare = (l) => { const w = words(l); return w.length ? w.filter((x) => /^\p{Ll}/u.test(x)).length / w.length : 0; };
  const looksName = (x) => x && !x.price && x.short && !/,/.test(x.l) && lowerShare(x.l) <= 0.34;
  const looksDesc = (x) => x && !x.price && (/,/.test(x.l) || !x.short || lowerShare(x.l) > 0.5);
  const out = [];
  let cat = 'Menu', cur = null;
  const item = (name) => { cur = { cat, name: titleCase(name), price: 0, desc: '', tags: [], station: guessStation(name, cat) }; out.push(cur); return cur; };
  for (let i = 0; i < info.length; i++) {
    const x = info[i];
    if (x.blank || x.skip) continue;
    const prevBlank = i === 0 || info[i - 1].blank || info[i - 1].skip;
    if (x.soldTag) { if (cur) cur.soldOut = true; continue; }
    if (x.soldName) { item(x.before).soldOut = true; continue; }
    if (x.price) {
      if (!x.priceOnly) { item(x.before).price = x.price; cur.desc = x.after; if (x.sold) cur.soldOut = true; }
      else if (cur && !cur.price && !cur.soldOut) { cur.price = x.price; if (x.after) cur.desc = tidy(`${cur.desc} ${x.after}`); }
      continue;
    }
    const tg = TAG.find(([re]) => re.test(x.l));
    if (tg && cur) { if (!cur.tags.includes(tg[1])) cur.tags.push(tg[1]); continue; }
    let ja = i + 1; while (ja < info.length && (info[ja].blank || info[ja].skip)) ja++;
    if (x.short && info[ja]?.soldTag) { item(x.l); continue; }                        // Nama / SOLD OUT
    if (x.short && CATWORD.test(x.l)) { cat = titleCase(x.l); cur = null; continue; }  // judul kategori umum
    const j = nextNB(i), nx = j >= 0 ? info[j] : null;
    const k = j >= 0 ? nextNB(j) : -1, nn = k >= 0 ? info[k] : null;
    if (cur && !cur.price && !cur.soldOut) { cur.desc = tidy(`${cur.desc} ${x.l}`); continue; }      // di antara nama dan harga = deskripsi
    if (x.short && nx?.priceOnly) { item(x.l); continue; }                           // Nama / Harga
    if (x.short && x.caps) { cat = titleCase(x.l); cur = null; continue; }            // JUDUL KATEGORI
    if (looksName(x) && looksDesc(nx) && nn?.priceOnly) { item(x.l); continue; }     // Nama / Deskripsi / Harga
    if (x.short && (prevBlank || !cur)) { cat = titleCase(x.l); cur = null; continue; } // Judul kategori
    if (cur) cur.desc = tidy(`${cur.desc} ${x.l}`);                                   // deskripsi setelah harga
  }
  return out.filter((r) => r.name && (r.price > 0 || r.soldOut));
}

const CCK = ['orange', 'kunyit', 'plum', 'kopi', 'kolam', 'olive', 'cabai', 'slate'];
const nextColor = (db) => CCK.find((k) => !db.cats.some((c) => c.color === k)) || CCK.at(db.cats.length % CCK.length);

// Terapkan ke database. mode: 'add' (tambah/perbarui) atau 'replace' (nonaktifkan menu lain di outlet itu)
export function applyMenuImport(db, items, { mode = 'add', outlet = 'L1', uid }) {
  const res = { added: 0, updated: 0, off: 0, cats: 0 };
  const touched = new Set();
  for (const it of items) {
    if (!it.name) continue;
    const m0 = db.menus.find((x) => x.name.toLowerCase() === it.name.toLowerCase() && !x.pkg);
    // Status Nonaktif: menu yang ada dinonaktifkan, baris baru dilewati
    if (it.inactive) { if (m0 && m0.active) { m0.active = false; touched.add(m0.id); res.off++; } continue; }
    if (!(it.price > 0 || it.soldOut)) continue;
    const outs = it.outlets?.length ? it.outlets : [outlet];
    let c = db.cats.find((x) => x.name.toLowerCase() === it.cat.toLowerCase());
    if (!c) {
      let id = slug(it.cat), n = 2;
      while (db.cats.some((x) => x.id === id)) id = slug(it.cat) + n++;
      c = { id, name: it.cat, color: nextColor(db), station: it.station || 'dapur' }; db.cats.push(c); res.cats++;
    }
    const m = m0;
    if (m) {
      Object.assign(m, { cat: c.id, active: true, soldOut: !!it.soldOut });
      if (it.price > 0) m.price = it.price;
      if (it.desc) m.desc = it.desc;
      if (it.stationSet) m.station = it.station;
      if (it.tags?.length) m.tags = [...new Set([...(m.tags || []), ...it.tags])];
      if (it.outlets?.length) m.outlets = [...it.outlets]; else if (!m.outlets.includes(outlet)) m.outlets.push(outlet);
      touched.add(m.id); res.updated++;
    } else {
      const id = uid('m_');
      db.menus.push({ id, name: it.name, cat: c.id, price: it.price, station: it.station || 'dapur', prep: it.station === 'bar' ? 4 : it.station === 'none' ? 0 : 10, bom: [], active: true, outlets: [...outs], desc: it.desc || '', tags: it.tags || [], ...(it.soldOut ? { soldOut: true } : {}) });
      touched.add(id); res.added++;
    }
  }
  if (mode === 'replace') {
    for (const m of db.menus) if (m.active && m.outlets.includes(outlet) && !touched.has(m.id)) {
      if (m.outlets.length > 1) m.outlets = m.outlets.filter((l) => l !== outlet); else m.active = false;
      res.off++;
    }
    // urutan kategori mengikuti daftar yang diimpor
    const order = [...new Set(items.map((i) => i.cat.toLowerCase()))];
    db.cats.sort((a, b) => { const ia = order.indexOf(a.name.toLowerCase()), ib = order.indexOf(b.name.toLowerCase()); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); });
  }
  return res;
}
