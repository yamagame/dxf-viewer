import type { Point, Segment } from "./geometry";
import type { Bounds, DrawCommand, DrawingLayer, ExtractedDrawData } from "./drawing-model";
import type { JwwArcEntity, JwwDocument, JwwHeader, JwwLayerAddress, JwwLineEntity } from "./jww-parser";

// 扁平率がこの範囲を超えて 1 から離れる円弧は楕円・楕円弧として扱い、描画対象から外す。
const FLATNESS_EPSILON = 1e-9;
// レイヤ状態 0 はファイル内で非表示として保存されたレイヤを表す。
const HIDDEN_LAYER_STATE = 0;

type LayerEntry = { address: JwwLayerAddress; name: string; visible: boolean };

export function formatJwwLayerName(header: JwwHeader, address: JwwLayerAddress): string {
  const prefix = `${toHexDigit(address.group)}-${toHexDigit(address.layer)}`;
  const groupName = header.groups[address.group]?.name ?? "";
  const layerName = header.groups[address.group]?.layers[address.layer]?.name ?? "";
  if (!groupName && !layerName) return prefix;
  if (!groupName) return `${prefix} (${layerName})`;
  if (!layerName) return `${prefix} (${groupName})`;
  return `${prefix} (${groupName}/${layerName})`;
}

export function extractJwwDrawData(document: JwwDocument): ExtractedDrawData {
  const commands: DrawCommand[] = [];
  const segments: Segment[] = [];
  const layerEntries = new Map<string, LayerEntry>();
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

  const resolveLayer = (address: JwwLayerAddress): string => {
    const key = `${address.group}:${address.layer}`;
    const known = layerEntries.get(key);
    if (known) return known.name;
    const name = formatJwwLayerName(document.header, address);
    layerEntries.set(key, { address, name, visible: isLayerVisible(document.header, address) });
    return name;
  };

  for (const entity of document.entities) {
    if (entity.type === "line") {
      appendLine(entity, resolveLayer(entity.address), commands, segments, includePoint);
      continue;
    }
    if (Math.abs(entity.flatness - 1) > FLATNESS_EPSILON) continue;
    appendArc(entity, resolveLayer(entity.address), commands, includePoint);
  }

  if (!Number.isFinite(minX)) {
    return { commands: [], segments: [], layers: [], bounds: null };
  }

  const bounds: Bounds = { minX, minY, maxX, maxY };
  return { commands, segments, layers: toDrawingLayers(layerEntries), bounds };
}

function appendLine(
  entity: JwwLineEntity,
  layer: string,
  commands: DrawCommand[],
  segments: Segment[],
  includePoint: (x: number, y: number) => void
): void {
  const from: Point = { x: entity.from.x, y: entity.from.y };
  const to: Point = { x: entity.to.x, y: entity.to.y };
  includePoint(from.x, from.y);
  includePoint(to.x, to.y);
  segments.push({ layer, from, to });
  commands.push({ type: "line", layer, from, to });
}

function appendArc(
  entity: JwwArcEntity,
  layer: string,
  commands: DrawCommand[],
  includePoint: (x: number, y: number) => void
): void {
  const center: Point = { x: entity.center.x, y: entity.center.y };
  includePoint(center.x - entity.radius, center.y - entity.radius);
  includePoint(center.x + entity.radius, center.y + entity.radius);
  if (entity.fullCircle) {
    commands.push({ type: "circle", layer, center, radius: entity.radius });
    return;
  }
  commands.push({
    type: "arc",
    layer,
    center,
    radius: entity.radius,
    start: entity.startAngle,
    end: entity.startAngle + entity.sweepAngle,
  });
}

function isLayerVisible(header: JwwHeader, address: JwwLayerAddress): boolean {
  const state = header.groups[address.group]?.layers[address.layer]?.state;
  return state !== HIDDEN_LAYER_STATE;
}

function toDrawingLayers(layerEntries: Map<string, LayerEntry>): DrawingLayer[] {
  return Array.from(layerEntries.values())
    .sort((a, b) => a.address.group - b.address.group || a.address.layer - b.address.layer)
    .map((entry) => ({ name: entry.name, visible: entry.visible }));
}

function toHexDigit(value: number): string {
  return value.toString(16).toUpperCase();
}
