"""Deterministic handwritten-looking signature strokes (pure Python)."""
from __future__ import annotations

import random


def _catmull_rom(pts, per_seg=14):
    p = [pts[0]] + list(pts) + [pts[-1]]
    out = []
    for i in range(1, len(p) - 2):
        p0, p1, p2, p3 = p[i - 1], p[i], p[i + 1], p[i + 2]
        for k in range(per_seg):
            t = k / per_seg
            t2, t3 = t * t, t * t * t
            out.append(tuple(
                0.5 * ((2 * p1[j]) + (-p0[j] + p2[j]) * t
                       + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2
                       + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3)
                for j in (0, 1)))
    out.append(pts[-1])
    return out


def signature_strokes(seed: int):
    """Strokes in the unit square, normalised so their extent is exactly [0,1]^2.

    A tall "capital" stroke followed by an irregular run of humps and an underline,
    so different seeds give visibly different signatures.
    """
    rng = random.Random(seed)
    n_tail = rng.randint(5, 8)
    steps = [rng.uniform(0.05, 0.22) for _ in range(n_tail)]
    total = sum(steps) + 0.20
    x, main = 0.0, [(0.0, 0.92), (0.07 / total, 0.0), (0.16 / total, 0.88)]
    x = 0.20
    for st in steps:
        x += st
        main.append((x / total, rng.uniform(0.15, 0.85)))
    under = [(rng.uniform(0.0, 0.1), 0.94), (0.5, 0.90 + rng.uniform(-0.04, 0.02)),
             (rng.uniform(0.9, 1.0), 0.84 + rng.uniform(0.0, 0.08))]
    strokes = [_catmull_rom(main), _catmull_rom(under)]
    xs = [p[0] for s in strokes for p in s]
    ys = [p[1] for s in strokes for p in s]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    return [[((px - x0) / (x1 - x0), (py - y0) / (y1 - y0)) for px, py in s] for s in strokes]


def place(strokes, rect):
    """Map unit strokes into rect=(x0,y0,x1,y1)."""
    x0, y0, x1, y1 = rect
    return [[(x0 + u * (x1 - x0), y0 + v * (y1 - y0)) for u, v in s] for s in strokes]
