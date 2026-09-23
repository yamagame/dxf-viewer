import { describe, expect, it } from "vitest";
import { computeSelectableVertices, extractDrawData, type DrawCommand } from "./drawing-model";
import type { Segment } from "./geometry";

describe("drawing-model", () => {
  it("computes selectable vertices including intersections", () => {
    const segments: Segment[] = [
      { layer: "A", from: { x: 0, y: 0 }, to: { x: 10, y: 10 } },
      { layer: "B", from: { x: 0, y: 10 }, to: { x: 10, y: 0 } },
    ];
    const vertices = computeSelectableVertices(segments);
    expect(vertices).toContainEqual({ x: 0, y: 0 });
    expect(vertices).toContainEqual({ x: 10, y: 10 });
    expect(vertices).toContainEqual({ x: 5, y: 5 });
  });

  it("extracts draw data and bounds from entities", () => {
    const entities = [
      {
        type: "LINE",
        layer: "L1",
        vertices: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
        ],
      },
      {
        type: "CIRCLE",
        layer: "L2",
        center: { x: 5, y: 5 },
        radius: 2,
      },
    ];
    const result = extractDrawData(entities);
    expect(result.layers).toEqual([
      { name: "L1", visible: true },
      { name: "L2", visible: true },
    ]);
    expect(result.bounds).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 7 });
    expect(result.segments).toHaveLength(1);
    expect((result.commands[0] as DrawCommand).type).toBe("line");
  });

  it("keeps vertical, reversed and endpoint intersections when pruning distant segments", () => {
    const segments: Segment[] = [
      { layer: "A", from: { x: 10, y: 0 }, to: { x: 0, y: 0 } },
      { layer: "A", from: { x: 5, y: 5 }, to: { x: 5, y: -5 } },
      { layer: "A", from: { x: 0, y: 0 }, to: { x: -5, y: -5 } },
      { layer: "B", from: { x: 100, y: 100 }, to: { x: 110, y: 100 } },
    ];
    const vertices = computeSelectableVertices(segments);
    expect(vertices).toHaveLength(8);
    expect(vertices).toContainEqual({ x: 5, y: 0 });
    expect(vertices).toContainEqual({ x: 0, y: 0 });
    expect(vertices).toContainEqual({ x: 100, y: 100 });
  });

  it("preserves intersections within the segment endpoint tolerance", () => {
    const segments: Segment[] = [
      { layer: "A", from: { x: 0, y: 0 }, to: { x: 1000000, y: 0 } },
      { layer: "A", from: { x: 1000000.0005, y: -1 }, to: { x: 1000000.0005, y: 1 } },
    ];
    expect(computeSelectableVertices(segments)).toContainEqual({ x: 1000000.0005, y: 0 });
  });
});
