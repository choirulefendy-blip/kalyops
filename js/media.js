// Foto menu — disimpan di Supabase Storage (bucket menu-images). menu.img berisi path file di bucket.
import { ic } from './lib.js';
import { imageUrl } from './cloud.js';
import * as API from './api.js';

// URL publik foto menu, atau null
export function imgUrl(m) {
  if (!m?.img) return null;
  if (/^(https?:|data:|assets\/)/.test(m.img)) return m.img;
  return imageUrl(m.img);
}

// Gambar menu atau placeholder. size: 'sm' (POS), 'md' (halaman pesan), 'lg' (editor/promo)
const STATION_IC = { bar: 'coffee', dapur: 'utensils', none: 'sprout' };
export function menuPic(m, size = 'sm', cls = '') {
  const url = imgUrl(m);
  if (url) return `<span class="mpic mpic-${size} ${cls}"><img src="${url}" alt="" loading="lazy" decoding="async"></span>`;
  return `<span class="mpic mpic-${size} mpic-ph ${cls}" aria-hidden="true">${ic(m?.pkg ? 'gift' : STATION_IC[m?.station] || 'utensils', ({ xs: 17, sm: 20, md: 26 })[size] || 34)}</span>`;
}

// Pilih file dari perangkat (kamera di HP/tablet)
export function pickImage() {
  return new Promise((res) => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    inp.style.display = 'none';
    inp.onchange = () => { res(inp.files?.[0] || null); inp.remove(); };
    document.body.appendChild(inp);
    inp.click();
  });
}

// Kecilkan & kompres: sisi terpanjang maks 900 px, JPEG kualitas 0,82 (biasanya 60–150 KB)
async function shrink(file, max = 900, type = 'image/jpeg', quality = 0.82) {
  if (!file.type.startsWith('image/')) throw new Error('File harus berupa gambar (JPG, PNG, atau WebP)');
  if (file.size > 20 * 1024 * 1024) throw new Error('Ukuran gambar maksimal 20 MB');
  let src, w, h;
  try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); w = src.width; h = src.height; }
  catch {
    src = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('Gambar tidak bisa dibaca. Coba simpan ulang sebagai JPG.')); im.src = URL.createObjectURL(file); });
    w = src.naturalWidth; h = src.naturalHeight;
  }
  const k = Math.min(1, max / Math.max(w, h));
  const cw = Math.round(w * k), ch = Math.round(h * k);
  const cv = document.createElement('canvas');
  cv.width = cw; cv.height = ch;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, cw, ch);
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, cw, ch);
  src.close?.();
  return new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('Gagal memproses gambar'))), type, quality));
}
// Unggah foto untuk menu. Hasil: { path, kb } — simpan path ke menu (menus.image_path)
export async function saveMenuImage(menuId, file) {
  const blob = await shrink(file);
  const path = await API.uploadMenuImage(menuId, blob);
  return { path, kb: Math.round(blob.size / 1024) };
}
export const removeMenuImage = (path) => API.removeStorageImage(path);
// QRIS statis dari bank/e-wallet (gambar standee). Disimpan lebih besar & tajam supaya tetap bisa di-scan.
export async function saveQrisImage(file) {
  const blob = await shrink(file, 1400, file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.95);
  return API.uploadMenuImage('qris', blob);
}
export const qrisUrl = (s) => (s?.qrisImage ? imageUrl(s.qrisImage) : null);
