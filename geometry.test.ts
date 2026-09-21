import { describe, expect, it } from "vitest";
import {
  distancePointToSegment,
  getVertexKey,
  intersectSegments,
  normalizeLayerName,
  type Segment,
} from "./geometry";

describe("geometry utilities", () => {
  it("normalizeLayerName falls back to 0", () => {
    expect(normalizeLayerName(undefined)).toBe("0");
    expect(normalizeLayerName("")).toBe("0");
    expect(normalizeLayerName("L-1")).toBe("L-1");
  });

  it("getVertexKey normalizes to 6 decimals", () => {
    expect(getVertexKey(1.23456789, 9.87654321)).toBe("1.234568:9.876543");
  });

  it("distancePointToSegment returns perpendicular distance", () => {
    const d = distancePointToSegment(5, 5, 0, 0, 10, 0);
    expect(d).toBeCloseTo(5, 6);
  });

  it("distancePointToSegment clamps to endpoints", () => {
    const d = distancePointToSegment(15, 0, 0, 0, 10, 0);
    expect(d).toBeCloseTo(5, 6);
  });

  it("intersectSegments returns crossing point", () => {
    const a: Segment = { layer: "A", from: { x: 0, y: 0 }, to: { x: 10, y: 10 } };
    const b: Segment = { layer: "B", from: { x: 0, y: 10 }, to: { x: 10, y: 0 } };
    const point = intersectSegments(a, b);
    expect(point).not.toBeNull();
    expect(point?.x).toBeCloseTo(5, 6);
    expect(point?.y).toBeCloseTo(5, 6);
  });

  it("intersectSegments returns null when disjoint", () => {
    const a: Segment = { layer: "A", from: { x: 0, y: 0 }, to: { x: 1, y: 0 } };
    const b: Segment = { layer: "B", from: { x: 2, y: 0 }, to: { x: 3, y: 0 } };
    expect(intersectSegments(a, b)).toBeNull();
  });
});
