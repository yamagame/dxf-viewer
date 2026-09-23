#!/usr/bin/env python3
"""Convert DynaCAD drawings (.dcz) to ASCII DXF (R12).

The DCZ format is undocumented. This converter is based on reverse
engineering and recovers geometry only (lines, polylines, circles, arcs);
text, dimensions, hatches, colors and line types are not converted.

Format notes (as far as they are understood):

* The file starts with a 0x18-byte signature ("DynaCAD16 Ver.0.00").
* The rest is a zero-suppressed stream of 64-bit words: a group of four
  mask bytes is followed by the non-zero bytes of four words (bit i of a
  mask set = byte i of that word is stored).
* The unpacked stream is a sequence of 32-byte rows. Each row is stored
  XOR-ed with the previous row (per section). The reference value at the
  start of a section is not recorded explicitly, so it is estimated by
  choosing, for each block of rows, the base that makes the rows look most
  like entity records.
* An entity is a header row (byte 3 has bit 7 set, byte 0 = type) followed
  by an id row and optional body rows (byte 0 = type, byte 3 = 0).
  Each row holds two doubles (x, y) at offsets 16 and 24.
"""

import argparse
import collections
import math
import os
import struct
import sys

import numpy as np

ROW = 32
HDR3 = (0xc0, 0x88, 0xe4)
TYPES = (0x81, 0x82, 0x83, 0x88, 0x8a, 0x8b, 0x8e, 0x90, 0x94)
LINE, POLY_A, POLY_B, POLY_C, CIRCLE, ARC = 0x81, 0x82, 0x83, 0x88, 0x8a, 0x8b
GROUP_FLAG = 0x20
LAYERS = {
    0xc0: ("DCZ-MAIN", 7),   # ordinary entities
    0xe4: ("DCZ-GROUP", 3),  # members of groups (windows etc.)
    0x88: ("DCZ-OTHER", 8),  # meaning unknown; looks like hidden/old geometry
}
MAX_COORD = 1e5


def unpack(data):
    if not data.startswith(b"DynaCAD"):
        raise ValueError("not a DynaCAD file")
    out = bytearray()
    pos, n = 0x18, len(data)
    while pos < n:
        masks = data[pos:pos + 4]
        pos += 4
        for m in masks:
            word = bytearray(8)
            for i in range(8):
                if m & (1 << i):
                    if pos < n:
                        word[i] = data[pos]
                    pos += 1
            out += word
    return bytes(out)


def row_score(P):
    """Per-row plausibility of candidate plain rows (higher = more entity-like)."""
    w0 = P[:, 0:8]
    ok = (np.isin(w0[:, 3], HDR3 + (0,)) & (w0[:, 5:8] == 0).all(axis=1)
          & (w0[:, 2] <= 1) & (w0[:, 4] < 0x40))
    w1 = P[:, 8:16]
    ok &= (w1[:, 0:4] == 0).all(axis=1) | (w1[:, 4:8] == 0).all(axis=1)
    v = P[:, 16:32].copy().view("<f8")
    with np.errstate(invalid="ignore", over="ignore"):
        a = np.abs(v)
        fine = (np.isfinite(v) & ((a == 0) | ((a > 1e-3) & (a < MAX_COORD)))).all(axis=1)
    hdr = np.isin(w0[:, 3], HDR3) & np.isin(w0[:, 0] & ~GROUP_FLAG & 0xff, TYPES)
    zero = ~P.any(axis=1)
    return (ok & fine).astype(np.int32) + (ok & fine & hdr) + zero


def viterbi(S, switch):
    """Pick one state per block; switching state costs `switch` points."""
    nstate, nb = S.shape
    score = S[:, 0].astype(np.int64)
    back = np.zeros((nb, nstate), np.int32)
    for b in range(1, nb):
        best = int(np.argmax(score))
        switched = score[best] - switch > score
        back[b] = np.where(switched, best, np.arange(nstate))
        score = np.where(switched, score[best] - switch, score) + S[:, b]
    path = np.empty(nb, np.int32)
    path[-1] = int(np.argmax(score))
    for b in range(nb - 1, 0, -1):
        path[b - 1] = back[b, path[b]]
    return path


def blocks(values, block):
    nb = (len(values) + block - 1) // block
    pad = nb * block - len(values)
    return np.pad(values, [(0, pad)] + [(0, 0)] * (values.ndim - 1)).reshape(nb, block, *values.shape[1:])


def undelta(raw, block=16, ncand=300):
    rows = np.frombuffer(raw, np.uint8)[:len(raw) // ROW * ROW].reshape(-1, ROW)
    X = np.bitwise_xor.accumulate(rows, axis=0)

    # Rows whose plain value is all zero reveal the section base, so the most
    # frequent cumulative rows are the base candidates.
    uniq, counts = np.unique(X.view("V32").ravel(), return_counts=True)
    order = np.argsort(-counts)[:ncand]
    cands = [np.frombuffer(uniq[i].tobytes(), np.uint8) for i in order if counts[i] >= 2]
    cands.append(np.zeros(ROW, np.uint8))
    S = np.stack([blocks(row_score(X ^ c), block).sum(axis=1) for c in cands])
    path = viterbi(S, switch=6)
    P = X.copy()
    for b, ci in enumerate(path):
        P[b * block:(b + 1) * block] ^= cands[ci]
    return fix_type_byte(P, block)


def fix_type_byte(P, block):
    """Re-estimate the base of byte 0 (entity type), which the zero-row
    heuristic cannot recover reliably."""
    hdr = np.isin(P[:, 3], HDR3) & (P[:, 5:8] == 0).all(axis=1)
    col = blocks(P[:, 0], block)
    h = blocks(hdr, block)
    known = np.zeros(256, bool)
    known[list(TYPES) + [t | GROUP_FLAG for t in TYPES]] = True
    S = np.stack([(known[col ^ k] & h).sum(axis=1) for k in range(256)])
    path = viterbi(S, switch=4)
    for b, k in enumerate(path):
        P[b * block:(b + 1) * block, 0] ^= k
    return P


def dbl(row, offset):
    return struct.unpack_from("<d", row, offset)[0]


def point(row):
    return (dbl(row, 16), dbl(row, 24))


def entities(P):
    R = [bytes(r) for r in P]
    n = len(R)
    i = 0
    while i < n - 1:
        r = R[i]
        t = r[0] & ~GROUP_FLAG & 0xff
        if r[3] in HDR3 and r[5:8] == b"\0\0\0" and t in TYPES:
            j = i + 2
            body = []
            while j < n and R[j][0] == r[0] and R[j][3] == 0 and R[j][1] in (0, 0x80) and R[j][2] == 0:
                body.append(R[j])
                j += 1
            if r[2] == 1 and body:  # entities with this flag end with a terminator row
                body = body[:-1]
            yield t, r[3], r, R[i + 1], body
            i = j
        else:
            i += 1


def to_geometry(P):
    out = []
    stats = collections.Counter()
    for t, cls, head, second, body in entities(P):
        layer = LAYERS[cls][0]
        if t == LINE:
            geom = ("LINE", point(head), point(second))
        elif t in (POLY_A, POLY_B, POLY_C) and len(body) >= 2:
            closed = bool((body[0][4] ^ body[1][4]) & 4)
            geom = ("POLYLINE", [point(b) for b in body], closed)
        elif t == CIRCLE and len(body) >= 2 and cls != 0x88:
            geom = ("CIRCLE", point(body[0]), dbl(body[1], 16))
        elif t == ARC and len(body) >= 3 and cls != 0x88:
            start, sweep = point(body[2])
            geom = ("ARC", point(body[0]), dbl(body[1], 16), start, sweep)
        else:
            stats["skipped"] += 1
            continue
        if valid(geom):
            out.append((layer, geom))
            stats[geom[0]] += 1
        else:
            stats["invalid"] += 1
    return out, stats


def valid(geom):
    def ok(p):
        return all(math.isfinite(v) and abs(v) < MAX_COORD for v in p)

    kind = geom[0]
    if kind == "LINE":
        return ok(geom[1]) and ok(geom[2])
    if kind == "POLYLINE":
        return all(ok(p) for p in geom[1])
    if not (ok(geom[1]) and math.isfinite(geom[2]) and 0 < geom[2] < MAX_COORD):
        return False
    return kind == "CIRCLE" or all(math.isfinite(v) and abs(v) <= 720 for v in geom[3:])


def dxf(geoms):
    lines = []

    def emit(*pairs):
        for code, value in pairs:
            if isinstance(value, float):
                value = f"{value:.10g}"
            lines.append(f"{code}\n{value}")

    emit((0, "SECTION"), (2, "HEADER"), (9, "$ACADVER"), (1, "AC1009"), (0, "ENDSEC"))
    emit((0, "SECTION"), (2, "TABLES"), (0, "TABLE"), (2, "LAYER"), (70, len(LAYERS)))
    for name, color in LAYERS.values():
        emit((0, "LAYER"), (2, name), (70, 0), (62, color), (6, "CONTINUOUS"))
    emit((0, "ENDTAB"), (0, "ENDSEC"), (0, "SECTION"), (2, "ENTITIES"))
    for layer, g in geoms:
        kind = g[0]
        if kind == "LINE":
            (x1, y1), (x2, y2) = g[1], g[2]
            emit((0, "LINE"), (8, layer), (10, x1), (20, y1), (30, 0.0), (11, x2), (21, y2), (31, 0.0))
        elif kind == "POLYLINE":
            emit((0, "POLYLINE"), (8, layer), (66, 1), (10, 0.0), (20, 0.0), (30, 0.0), (70, 1 if g[2] else 0))
            for x, y in g[1]:
                emit((0, "VERTEX"), (8, layer), (10, x), (20, y), (30, 0.0))
            emit((0, "SEQEND"), (8, layer))
        elif kind == "CIRCLE":
            (cx, cy), r = g[1], g[2]
            emit((0, "CIRCLE"), (8, layer), (10, cx), (20, cy), (30, 0.0), (40, r))
        elif kind == "ARC":
            (cx, cy), r, start, sweep = g[1:]
            a0, a1 = (start, start + sweep) if sweep >= 0 else (start + sweep, start)
            emit((0, "ARC"), (8, layer), (10, cx), (20, cy), (30, 0.0), (40, r),
                 (50, a0 % 360), (51, a1 % 360))
    emit((0, "ENDSEC"), (0, "EOF"))
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser(description="Convert a DynaCAD .dcz drawing to DXF (geometry only).")
    ap.add_argument("input")
    ap.add_argument("output", nargs="?", help="output .dxf (default: beside the input)")
    ap.add_argument("--dump-dir", help="also write the unpacked (.unpacked.bin) and de-XORed (.plain.bin) streams here")
    args = ap.parse_args()

    output = args.output or os.path.splitext(args.input)[0] + ".dxf"
    if os.path.exists(output):
        sys.exit(f"Error: output already exists: {output}")

    raw = unpack(open(args.input, "rb").read())
    plain = undelta(raw)
    if args.dump_dir:
        os.makedirs(args.dump_dir, exist_ok=True)
        stem = os.path.join(args.dump_dir, os.path.splitext(os.path.basename(args.input))[0])
        open(stem + ".unpacked.bin", "wb").write(raw)
        open(stem + ".plain.bin", "wb").write(plain.tobytes())

    geoms, stats = to_geometry(plain)
    with open(output, "w", encoding="ascii") as f:
        f.write(dxf(geoms))
    per_layer = collections.Counter(layer for layer, _ in geoms)
    print(f"{output}: " + ", ".join(f"{k}={v}" for k, v in sorted(stats.items())))
    print("  layers: " + ", ".join(f"{k}={v}" for k, v in sorted(per_layer.items())))


if __name__ == "__main__":
    main()
