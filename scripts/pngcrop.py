# -*- coding: utf-8 -*-
"""纯 Python 的 PNG 裁剪（无 PIL 依赖）：python pngcrop.py <in> <out> <cx> <cy> <w> <h>"""
import io, zlib, struct, sys

def read_png(path):
    b = io.open(path, "rb").read()
    pos = 8; w = h = None; idat = b""
    while pos < len(b):
        ln = struct.unpack(">I", b[pos:pos+4])[0]; typ = b[pos+4:pos+8]
        data = b[pos+8:pos+8+ln]
        if typ == b"IHDR":
            w, h, bd, ct = struct.unpack(">IIBB", data[:10])
            assert bd == 8, bd
        elif typ == b"IDAT":
            idat += data
        elif typ == b"IEND":
            break
        pos += 12 + ln
    raw = zlib.decompress(idat)
    ch = {0:1, 2:3, 4:2, 6:4}[ct]
    stride = w * ch
    out = bytearray(w * h * ch)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        f = raw[p]; p += 1
        line = bytearray(raw[p:p+stride]); p += stride
        if f == 1:
            for i in range(ch, stride): line[i] = (line[i] + line[i-ch]) & 0xff
        elif f == 2:
            for i in range(stride): line[i] = (line[i] + prev[i]) & 0xff
        elif f == 3:
            for i in range(stride):
                a = line[i-ch] if i >= ch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xff
        elif f == 4:
            for i in range(stride):
                a = line[i-ch] if i >= ch else 0
                c = prev[i-ch] if i >= ch else 0
                bb = prev[i]
                pp = a + bb - c
                pa, pb, pc = abs(pp-a), abs(pp-bb), abs(pp-c)
                pr = a if (pa <= pb and pa <= pc) else (bb if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xff
        out[y*stride:(y+1)*stride] = line
        prev = line
    return w, h, ch, bytes(out)

def write_png(path, w, h, ch, px):
    ct = {1:0, 2:4, 3:2, 4:6}[ch]
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    raw = b"".join(b"\x00" + px[y*w*ch:(y+1)*w*ch] for y in range(h))
    io.open(path, "wb").write(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, ct, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b""))

def crop(path, out, cx, cy, cw, chh):
    w, h, ch, px = read_png(path)
    x0 = max(0, min(w - cw, cx - cw // 2))
    y0 = max(0, min(h - chh, cy - chh // 2))
    buf = bytearray(cw * chh * ch)
    for r in range(chh):
        s = ((y0 + r) * w + x0) * ch
        buf[r*cw*ch:(r+1)*cw*ch] = px[s:s+cw*ch]
    write_png(out, cw, chh, ch, bytes(buf))
    print(f"{out}: {cw}x{chh} @ ({x0},{y0}) from {w}x{h}")

if __name__ == "__main__":
    crop(sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]),
         int(sys.argv[5]), int(sys.argv[6]))
