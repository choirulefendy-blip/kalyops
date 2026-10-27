# Printer thermal tiruan untuk uji: terima koneksi TCP, simpan byte tiap koneksi, lalu urai jadi gambar.
import socket, sys, threading, time
sys.path.insert(0, __import__('os').path.dirname(__file__))
from escpos_decode import decode
PORT = int(sys.argv[1]); OUT = sys.argv[2]
srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); srv.bind(('127.0.0.1', PORT)); srv.listen(5)
n = 0
def serve(c, k):
    t0 = time.time(); buf = b''
    c.settimeout(5)
    try:
        while True:
            d = c.recv(65536)
            if not d: break
            buf += d
    except socket.timeout: pass
    c.close()
    pages, unk = decode(buf)
    for i, im in enumerate(pages): im.save(f'{OUT}_{k}_{i}.png')
    print(f'koneksi {k}: {len(buf)} byte, {len(pages)} lembar {[im.size for im in pages]}, tak dikenal {unk[:3]}, {time.time()-t0:.2f}s', flush=True)
while True:
    c, _ = srv.accept(); n += 1
    threading.Thread(target=serve, args=(c, n), daemon=True).start()
