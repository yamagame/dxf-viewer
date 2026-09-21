import { describe, expect, it } from "vitest";
import { ViewportController } from "./viewport-controller";
import { SelectionController } from "./selection-controller";
import type { Point, Segment } from "./geometry";

function toCanvas(point: Point): Point {
  return point;
}

describe("ViewportController", () => {
  it("fits bounds to screen and updates transform", () => {
    const viewport = new ViewportController(0.2, 20);
    viewport.setBounds({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
    viewport.fitToScreen(200, 200, 0);
    const transform = viewport.getTransform(200, 200);
    expect(transform.scale).toBeCloseTo(2, 6);
    expect(transform.offsetX).toBeCloseTo(0, 6);
    expect(transform.offsetY).toBeCloseTo(200, 6);
  });

  it("tracks pan drag and reports movement", () => {
    const viewport = new ViewportController(0.2, 20);
    viewport.setBounds({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
    viewport.fitToScreen(200, 200, 0);
    viewport.beginPan(10, 10);
    viewport.updatePan(20, 10);
    expect(viewport.endPan()).toBe(true);
  });
});

describe("SelectionController", () => {
  const rect = { left: 0, top: 0 } as DOMRect;

  it("finds nearest vertex after rebuilding candidates", () => {
    const selection = new SelectionController(12, 8);
    const segments: Segment[] = [
      { layer: "A", from: { x: 0, y: 0 }, to: { x: 10, y: 10 } },
      { layer: "B", from: { x: 0, y: 10 }, to: { x: 10, y: 0 } },
    ];
    selection.rebuildSelectableVertices(segments);
    const vertex = selection.findNearestVertex({ clientX: 5, clientY: 5 }, rect, toCanvas);
    expect(vertex).toEqual({ x: 5, y: 5 });
  });

  it("finds nearest edge", () => {
    const selection = new SelectionController(12, 8);
    const segments: Segment[] = [
      { layer: "A", from: { x: 0, y: 0 }, to: { x: 10, y: 0 } },
    ];
    const edge = selection.findNearestEdge(segments, { clientX: 3, clientY: 2 }, rect, toCanvas);
    expect(edge?.layer).toBe("A");
  });
});
