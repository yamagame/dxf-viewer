import { getVertexKey, intersectSegments, INTERSECTION_EPSILON, normalizeLayerName, type Point, type Segment } from "./geometry";

export type DrawCommand =
  | { type: "line"; layer: string; from: Point; to: Point }
  | { type: "polyline"; layer: string; vertices: Point[]; closed: boolean }
  | { type: "circle"; layer: string; center: Point; radius: number }
  | { type: "arc"; layer: string; center: Point; radius: number; start: number; end: number };

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

export type DrawingLayer = { name: string; visible: boolean };

export type ExtractedDrawData = {
  commands: DrawCommand[];
  segments: Segment[];
  layers: DrawingLayer[];
  bounds: Bounds | null;
};

export function computeSelectableVertices(
  visibleSegments: Segment[],
  onProgress?: (completed: number, total: number) => void
): Point[] {
  const vertices: Point[] = [];
  const vertexKeySet = new Set<string>();

  const includeVertex = (x: number, y: number): void => {
    const key = getVertexKey(x, y);
    if (vertexKeySet.has(key)) return;
    vertexKeySet.add(key);
    const [normalizedX, normalizedY] = key.split(":").map(Number);
    vertices.push({ x: normalizedX, y: normalizedY });
  };

  for (const segment of visibleSegments) {
    includeVertex(segment.from.x, segment.from.y);
    includeVertex(segment.to.x, segment.to.y);
  }

  // Sort bounding boxes along X so disjoint ranges never reach the exact
  // intersection test. Pad by the same parametric tolerance as intersectSegments.
  const entries = visibleSegments.map((segment, index) => {
    const padX = Math.abs(segment.to.x - segment.from.x) * INTERSECTION_EPSILON;
    const padY = Math.abs(segment.to.y - segment.from.y) * INTERSECTION_EPSILON;
    return {
      segment, index,
      minX: Math.min(segment.from.x, segment.to.x) - padX,
      maxX: Math.max(segment.from.x, segment.to.x) + padX,
      minY: Math.min(segment.from.y, segment.to.y) - padY,
      maxY: Math.max(segment.from.y, segment.to.y) + padY,
    };
  }).sort((a, b) => a.minX - b.minX);

  onProgress?.(0, entries.length);
  for (let i = 0; i < entries.length; i += 1) {
    const a = entries[i];
    for (let j = i + 1; j < entries.length && entries[j].minX <= a.maxX; j += 1) {
      const b = entries[j];
      if (b.minY > a.maxY || b.maxY < a.minY) continue;
      // Preserve operand order and rounding from the original enumeration.
      const intersection = a.index < b.index
        ? intersectSegments(a.segment, b.segment)
        : intersectSegments(b.segment, a.segment);
      if (!intersection) continue;
      includeVertex(intersection.x, intersection.y);
    }
    if ((i + 1) % 256 === 0) onProgress?.(i + 1, entries.length);
  }
  onProgress?.(entries.length, entries.length);

  return vertices;
}

export function extractDrawData(entities: any[]): ExtractedDrawData {
  const commands: DrawCommand[] = [];
  const segments: Segment[] = [];
  const layersSet = new Set<string>();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const includePoint = (x: number, y: number): void => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };

  const includeVertices = (vertices: Array<{ x: number; y: number }> = []): void => {
    vertices.forEach((v) => includePoint(v.x, v.y));
  };

  for (const entity of entities) {
    const layer = normalizeLayerName(entity.layer);
    layersSet.add(layer);

    if (entity.type === "LINE" && entity.vertices?.length >= 2) {
      const [a, b] = entity.vertices;
      includePoint(a.x, a.y);
      includePoint(b.x, b.y);
      segments.push({
        layer,
        from: { x: a.x, y: a.y },
        to: { x: b.x, y: b.y },
      });
      commands.push({
        type: "line",
        layer,
        from: { x: a.x, y: a.y },
        to: { x: b.x, y: b.y },
      });
      continue;
    }

    if ((entity.type === "LWPOLYLINE" || entity.type === "POLYLINE") && entity.vertices?.length >= 2) {
      includeVertices(entity.vertices);
      for (let i = 0; i < entity.vertices.length - 1; i += 1) {
        segments.push({
          layer,
          from: { x: entity.vertices[i].x, y: entity.vertices[i].y },
          to: { x: entity.vertices[i + 1].x, y: entity.vertices[i + 1].y },
        });
      }
      if (entity.shape) {
        const first = entity.vertices[0];
        const last = entity.vertices[entity.vertices.length - 1];
        segments.push({
          layer,
          from: { x: last.x, y: last.y },
          to: { x: first.x, y: first.y },
        });
      }
      commands.push({
        type: "polyline",
        layer,
        vertices: entity.vertices.map((v: { x: number; y: number }) => ({ x: v.x, y: v.y })),
        closed: Boolean(entity.shape),
      });
      continue;
    }

    if (entity.type === "CIRCLE" && entity.center && Number.isFinite(entity.radius)) {
      includePoint(entity.center.x - entity.radius, entity.center.y - entity.radius);
      includePoint(entity.center.x + entity.radius, entity.center.y + entity.radius);
      commands.push({
        type: "circle",
        layer,
        center: { x: entity.center.x, y: entity.center.y },
        radius: entity.radius,
      });
      continue;
    }

    if (
      entity.type === "ARC" &&
      entity.center &&
      Number.isFinite(entity.radius) &&
      Number.isFinite(entity.startAngle) &&
      Number.isFinite(entity.endAngle)
    ) {
      includePoint(entity.center.x - entity.radius, entity.center.y - entity.radius);
      includePoint(entity.center.x + entity.radius, entity.center.y + entity.radius);
      commands.push({
        type: "arc",
        layer,
        center: { x: entity.center.x, y: entity.center.y },
        radius: entity.radius,
        start: (entity.startAngle * Math.PI) / 180,
        end: (entity.endAngle * Math.PI) / 180,
      });
    }
  }

  if (!Number.isFinite(minX)) {
    return { commands: [], segments: [], layers: [], bounds: null };
  }

  return {
    commands,
    segments,
    layers: Array.from(layersSet)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ name, visible: true })),
    bounds: { minX, minY, maxX, maxY },
  };
}
