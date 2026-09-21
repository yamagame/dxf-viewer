import { distancePointToSegment, getVertexKey, type Point, type Segment } from "./geometry";
import { computeSelectableVertices } from "./drawing-model";

export class SelectionController {
  private selectableVertices: Point[] = [];
  private hoveredVertex: Point | null = null;

  constructor(
    private readonly vertexSnapPixel: number,
    private readonly edgeSnapPixel: number
  ) {}

  clear(): void {
    this.selectableVertices = [];
    this.hoveredVertex = null;
  }

  rebuildSelectableVertices(visibleSegments: Segment[]): void {
    this.selectableVertices = computeSelectableVertices(visibleSegments);
    if (this.hoveredVertex) {
      const keySet = new Set(this.selectableVertices.map((v) => getVertexKey(v.x, v.y)));
      const hoveredKey = getVertexKey(this.hoveredVertex.x, this.hoveredVertex.y);
      if (!keySet.has(hoveredKey)) {
        this.hoveredVertex = null;
      }
    }
  }

  getHoveredVertex(): Point | null {
    return this.hoveredVertex;
  }

  clearHoveredVertex(): void {
    this.hoveredVertex = null;
  }

  updateHoveredVertex(
    event: { clientX: number; clientY: number },
    canvasRect: DOMRect,
    modelToCanvas: (point: Point) => Point
  ): boolean {
    const nextHovered = this.findNearestVertex(event, canvasRect, modelToCanvas);
    const unchanged = this.hoveredVertex?.x === nextHovered?.x && this.hoveredVertex?.y === nextHovered?.y;
    if (unchanged) return false;
    this.hoveredVertex = nextHovered;
    return true;
  }

  findNearestVertex(
    event: { clientX: number; clientY: number },
    canvasRect: DOMRect,
    modelToCanvas: (point: Point) => Point
  ): Point | null {
    if (!this.selectableVertices.length) return null;
    const targetX = event.clientX - canvasRect.left;
    const targetY = event.clientY - canvasRect.top;
    let nearest: Point | null = null;
    let nearestDistance = Infinity;
    for (const vertex of this.selectableVertices) {
      const p = modelToCanvas(vertex);
      const distance = Math.hypot(p.x - targetX, p.y - targetY);
      if (distance < nearestDistance) {
        nearest = vertex;
        nearestDistance = distance;
      }
    }
    if (!nearest || nearestDistance > this.vertexSnapPixel) return null;
    return nearest;
  }

  findNearestEdge(
    visibleSegments: Segment[],
    event: { clientX: number; clientY: number },
    canvasRect: DOMRect,
    modelToCanvas: (point: Point) => Point
  ): Segment | null {
    if (!visibleSegments.length) return null;
    const targetX = event.clientX - canvasRect.left;
    const targetY = event.clientY - canvasRect.top;
    let nearest: Segment | null = null;
    let nearestDistance = Infinity;
    for (const segment of visibleSegments) {
      const from = modelToCanvas(segment.from);
      const to = modelToCanvas(segment.to);
      const distance = distancePointToSegment(targetX, targetY, from.x, from.y, to.x, to.y);
      if (distance < nearestDistance) {
        nearest = segment;
        nearestDistance = distance;
      }
    }
    if (!nearest || nearestDistance > this.edgeSnapPixel) return null;
    return nearest;
  }
}
