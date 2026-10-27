# Pengurai ESC/POS sederhana untuk pengujian: ubah byte yang dikirim ke printer menjadi gambar per potongan kertas.
# Mendukung ESC @, GS v 0 (raster), ESC * 33 (24 titik), ESC d, ESC 3, ESC 2, LF, GS V (potong).
import sys
from PIL import Image

def decode(data):
    pages, rows, width = [], [], 0
    i, n = 0, len(data)
    def flush():
        nonlocal rows, width
        if rows:
            w = max(len(r) for r in rows)
            im = Image.new('1', (w, len(rows)), 1)
            px = im.load()
            for y, r in enumerate(rows):
                for x, b in enumerate(r):
                    if b: px[x, y] = 0
            pages.append(im)
        rows = []
    unknown = []
    while i < n:
        b = data[i]
        if b == 0x1b and i + 1 < n:
            c = data[i + 1]
            if c == 0x40: i += 2; continue
            if c == 0x64: rows.extend([[0] * (width or 8)] * (data[i + 2] * 24)); i += 3; continue
            if c == 0x33: i += 3; continue
            if c == 0x32: i += 2; continue
            if c == 0x2a:
                m, nl, nh = data[i + 2], data[i + 3], data[i + 4]
                cols = nl + nh * 256
                assert m == 33, m
                band = [[0] * cols for _ in range(24)]
                p = i + 5
                for x in range(cols):
                    for k in range(3):
                        v = data[p + x * 3 + k]
                        for j in range(8):
                            band[k * 8 + j][x] = (v >> (7 - j)) & 1
                rows.extend(band); width = cols
                i = p + cols * 3
                if i < n and data[i] == 0x0a: i += 1
                continue
            unknown.append(('ESC', c)); i += 2; continue
        if b == 0x1d and i + 1 < n:
            c = data[i + 1]
            if c == 0x76:
                xl, xh, yl, yh = data[i + 4], data[i + 5], data[i + 6], data[i + 7]
                bpr, h = xl + xh * 256, yl + yh * 256
                p = i + 8
                for y in range(h):
                    r = []
                    for xb in range(bpr):
                        v = data[p + y * bpr + xb]
                        r.extend((v >> (7 - k)) & 1 for k in range(8))
                    rows.append(r)
                width = bpr * 8
                i = p + bpr * h; continue
            if c == 0x56:
                flush(); i += 4 if data[i + 2] in (65, 66) else 3; continue
            unknown.append(('GS', c)); i += 2; continue
        if b == 0x0a: i += 1; continue
        unknown.append(('byte', b)); i += 1
    flush()
    return pages, unknown

if __name__ == '__main__':
    pages, unk = decode(open(sys.argv[1], 'rb').read())
    for k, im in enumerate(pages): im.save(f'{sys.argv[2]}_{k}.png')
    print(len(pages), 'lembar', [im.size for im in pages], 'tak dikenal', unk[:5])
