import { describe, expect, it } from "vitest";
import { LayerController } from "./layer-controller";
import { MeasurementManager } from "./measurement-manager";
import { EdgeSelectionManager } from "./edge-selection-manager";
import type { DrawCommand } from "./drawing-model";
import type { Segment } from "./geometry";

describe("LayerController", () => {
  const segments: Segment[] = [
    { layer: "A", from: { x: 0, y: 0 }, to: { x: 1, y: 0 } },
    { layer: "B", from: { x: 0, y: 0 }, to: { x: 0, y: 1 } },
  ];
  const commands: DrawCommand[] = [
    { type: "line", layer: "A", from: { x: 0, y: 0 }, to: { x: 1, y: 0 } },
    { type: "line", layer: "B", from: { x: 0, y: 0 }, to: { x: 0, y: 1 } },
  ];

  it("toggles layer visibility and filters items", () => {
    const controller = new LayerController();
    controller.setLayers([
      { name: "A", visible: true },
      { name: "B", visible: true },
    ]);
    controller.setVisible("B", false);

    expect(controller.filterVisibleSegments(segments)).toHaveLength(1);
    expect(controller.isVisible("A")).toBe(true);
    expect(controller.isVisible("B")).toBe(false);
  });

  it("keeps a layer given as initially invisible hidden from drawing and segments", () => {
    const controller = new LayerController();
    controller.setLayers([
      { name: "A", visible: true },
      { name: "B", visible: false },
    ]);

    expect(controller.getLayerNames()).toEqual(["A", "B"]);
    expect(controller.isVisible("B")).toBe(false);
    expect(controller.filterVisibleSegments(segments)).toHaveLength(1);
    expect(controller.filterVisibleCommands(commands)).toHaveLength(1);
  });

  it("restores an initially invisible layer once it is switched to visible", () => {
    const controller = new LayerController();
    controller.setLayers([
      { name: "A", visible: true },
      { name: "B", visible: false },
    ]);
    controller.setVisible("B", true);

    expect(controller.isVisible("B")).toBe(true);
    expect(controller.filterVisibleSegments(segments)).toHaveLength(2);
    expect(controller.filterVisibleCommands(commands)).toHaveLength(2);
  });

  it("lists every layer even when all of them start invisible", () => {
    const controller = new LayerController();
    controller.setLayers([
      { name: "A", visible: false },
      { name: "B", visible: false },
    ]);

    expect(controller.getLayerNames()).toEqual(["A", "B"]);
    expect(controller.filterVisibleCommands(commands)).toHaveLength(0);
    expect(controller.filterVisibleSegments(segments)).toHaveLength(0);
  });
});

describe("MeasurementManager", () => {
  it("returns distance text after two points", () => {
    const manager = new MeasurementManager();
    expect(manager.selectPoint({ x: 0, y: 0 })).toContain("2つ目の頂点");
    const msg = manager.selectPoint({ x: 3, y: 4 });
    expect(msg).toContain("距離: 5.000");
    expect(msg).toContain("ΔX: 3.000");
    expect(msg).toContain("ΔY: 4.000");
  });

  it("advances second point to first, then sets new second point", () => {
    const manager = new MeasurementManager();
    manager.selectPoint({ x: 0, y: 0 });
    manager.selectPoint({ x: 3, y: 4 });
    const msg = manager.advanceSecondPoint({ x: 6, y: 8 });
    expect(msg).toContain("距離: 5.000");
    expect(msg).toContain("ΔX: 3.000");
    expect(msg).toContain("ΔY: 4.000");
  });
});

describe("EdgeSelectionManager", () => {
  it("selects edge and clears selection when hidden", () => {
    const manager = new EdgeSelectionManager();
    const edge: Segment = { layer: "A", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } };
    expect(manager.select(edge)).toContain("A");
    const msg = manager.validateSelection((layer) => layer !== "A");
    expect(msg).toContain("エッジ選択");
    expect(manager.getSelected()).toBeNull();
  });
});
