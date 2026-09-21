import { describe, expect, it } from "vitest";
import {
  computeSelectableVertices,
  createDefaultLayerVisibility,
  extractDrawData,
  getVisibleSegments,
  isLayerVisible,
  type DrawCommand,
} from "./drawing-model";
import type { Segment } from "./geometry";

describe("drawing-model", () => {
  it("creates visible map with all layers enabled", () => {
    const visibility = createDefaultLayerVisibility(["A", "B"]);
    expect(visibility.get("A")).toBe(true);
    expect(visibility.get("B")).toBe(true);
  });

  it("checks visibility by layer map", () => {
    const visibility = new Map<string, boolean>([
      ["A", true],
      ["B", false],
    ]);
    expect(isLayerVisible(visibility, "A")).toBe(true);
    expect(isLayerVisible(visibility, "B")).toBe(false);
  });

  it("filters visible segments by layer visibility", () => {
    const segments: Segment[] = [
      { layer: "A", from: { x: 0, y: 0 }, to: { x: 10, y: 0 } },
      { layer: "B", from: { x: 0, y: 0 }, to: { x: 0, y: 10 } },
    ];
    const visibility = new Map<string, boolean>([
      ["A", true],
      ["B", false],
    ]);
    const result = getVisibleSegments(segments, visibility);
    expect(result).toHaveLength(1);
    expect(result[0].layer).toBe("A");
  });

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
    expect(result.layers).toEqual(["L1", "L2"]);
    expect(result.bounds).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 7 });
    expect(result.segments).toHaveLength(1);
    expect((result.commands[0] as DrawCommand).type).toBe("line");
  });
});
