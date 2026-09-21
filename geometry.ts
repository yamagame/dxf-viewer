export type Point = { x: number; y: number };
export type Segment = { layer: string; from: Point; to: Point };

export const INTERSECTION_EPSILON = 1e-9;

export function normalizeLayerName(layerName: unknown): string {
  if (!layerName || typeof layerName !== "string") return "0";
  return layerName;
}

export function getVertexKey(x: number, y: number): string {
  const normalizedX = Number(x.toFixed(6));
  const normalizedY = Number(y.toFixed(6));
  return `${normalizedX}:${normalizedY}`;
}

export function distancePointToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) {
    return Math.hypot(px - x1, py - y1);
  }
  const t = ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy);
  const clampedT = Math.max(0, Math.min(1, t));
  const cx = x1 + clampedT * dx;
  const cy = y1 + clampedT * dy;
  return Math.hypot(px - cx, py - cy);
}

export function cross2D(a: Point, b: Point): number {
  return a.x * b.y - a.y * b.x;
}

export function intersectSegments(
  segA: Segment,
  segB: Segment,
  epsilon: number = INTERSECTION_EPSILON
): Point | null {
  const p = segA.from;
  const r = { x: segA.to.x - segA.from.x, y: segA.to.y - segA.from.y };
  const q = segB.from;
  const s = { x: segB.to.x - segB.from.x, y: segB.to.y - segB.from.y };

  const rxs = cross2D(r, s);
  const qMinusP = { x: q.x - p.x, y: q.y - p.y };
  const qpxr = cross2D(qMinusP, r);

  if (Math.abs(rxs) < epsilon) {
    if (Math.abs(qpxr) < epsilon) {
      return null;
    }
    return null;
  }

  const t = cross2D(qMinusP, s) / rxs;
  const u = cross2D(qMinusP, r) / rxs;
  const inRange = (value: number) => value >= -epsilon && value <= 1 + epsilon;

  if (!inRange(t) || !inRange(u)) {
    return null;
  }

  return {
    x: p.x + t * r.x,
    y: p.y + t * r.y,
  };
}
