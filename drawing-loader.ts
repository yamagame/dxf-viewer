import DxfParser from "dxf-parser";
import { extractDrawData, type ExtractedDrawData } from "./drawing-model";
import { extractJwwDrawData } from "./jww-drawing";
import { parseJww } from "./jww-parser";

export type DrawingFormat = "dxf" | "jww";

export type DrawingSource = { fileName: string; bytes: ArrayBuffer };

export type LoadDrawingResult =
  | { status: "loaded"; format: DrawingFormat; data: ExtractedDrawData }
  | { status: "empty"; message: string }
  | { status: "unsupported"; message: string }
  | { status: "failed"; message: string };

const UNSUPPORTED_MESSAGE = "対応していないファイル形式です。DXFまたはJWWファイルを選択してください。";
const EMPTY_MESSAGE = "対応エンティティが見つかりませんでした。";
const FAILED_MESSAGE: Record<DrawingFormat, string> = {
  dxf: "DXFの解析に失敗しました。ファイル形式を確認してください。",
  jww: "JWWの解析に失敗しました。ファイル形式を確認してください。",
};

function detectFormat(fileName: string): DrawingFormat | null {
  const lowered = fileName.toLowerCase();
  if (lowered.endsWith(".dxf")) return "dxf";
  if (lowered.endsWith(".jww")) return "jww";
  return null;
}

function extractDxfDrawData(bytes: ArrayBuffer): ExtractedDrawData {
  let text: string;
  try {
    // A fatal UTF-8 decode distinguishes valid UTF-8 from legacy DXF files
    // whose Japanese text is commonly stored as Shift_JIS / Windows-31J.
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("shift_jis").decode(bytes);
  }
  const parser = new DxfParser();
  const dxf: any = parser.parseSync(text);
  return extractDrawData(expandDxfInserts(dxf.entities || [], dxf.blocks || {}));
}

type Point = { x: number; y: number };
type PointTransform = (point: Point) => Point;

function expandDxfInserts(entities: any[], blocks: Record<string, any>): any[] {
  const identity: PointTransform = (point) => point;
  const transformEntities = (
    source: any[],
    parentTransform: PointTransform,
    parentRotation: number,
    parentScale: number,
    inheritedLayer: string | undefined,
    blockStack: Set<string>
  ): any[] => {
    const expanded: any[] = [];
    for (const entity of source) {
      if (entity.type === "INSERT") {
        const name = entity.name;
        const block = name && blocks[name];
        if (!block?.entities || blockStack.has(name)) continue;
        const rotation = ((entity.rotation ?? 0) * Math.PI) / 180;
        const sx = entity.xScale ?? 1;
        const sy = entity.yScale ?? 1;
        const base = block.position ?? { x: 0, y: 0 };
        const insertPosition = entity.position ?? { x: 0, y: 0 };
        const insertTransform: PointTransform = (point) => {
          const x = (point.x - base.x) * sx;
          const y = (point.y - base.y) * sy;
          return parentTransform({
            x: insertPosition.x + x * Math.cos(rotation) - y * Math.sin(rotation),
            y: insertPosition.y + x * Math.sin(rotation) + y * Math.cos(rotation),
          });
        };
        const nextStack = new Set(blockStack);
        nextStack.add(name);
        const columns = Math.max(1, Math.floor(entity.columnCount ?? 1));
        const rows = Math.max(1, Math.floor(entity.rowCount ?? 1));
        for (let row = 0; row < rows; row += 1) {
          for (let column = 0; column < columns; column += 1) {
            const offset = (point: Point): Point => insertTransform({
              x: point.x + column * (entity.columnSpacing ?? 0),
              y: point.y + row * (entity.rowSpacing ?? 0),
            });
            expanded.push(...transformEntities(
              block.entities,
              offset,
              parentRotation + rotation,
              parentScale * (Math.abs(sx) + Math.abs(sy)) / 2,
              entity.layer === "0" || !entity.layer ? inheritedLayer : entity.layer,
              nextStack
            ));
          }
        }
        continue;
      }

      const transformed = { ...entity, layer: entity.layer === "0" || !entity.layer ? inheritedLayer ?? entity.layer : entity.layer };
      const transformPoint = (point: Point): Point => parentTransform(point);
      if (Array.isArray(entity.vertices)) {
        transformed.vertices = entity.vertices.map((point: Point) => ({ ...point, ...transformPoint(point) }));
      }
      if (entity.position) transformed.position = transformPoint(entity.position);
      if (entity.startPoint) transformed.startPoint = transformPoint(entity.startPoint);
      if (entity.center) transformed.center = transformPoint(entity.center);
      if (Number.isFinite(entity.radius)) transformed.radius = entity.radius * parentScale;
      if (entity.type === "ARC" && entity.center) {
        const start = { x: Math.cos(entity.startAngle), y: Math.sin(entity.startAngle) };
        const end = { x: Math.cos(entity.endAngle), y: Math.sin(entity.endAngle) };
        const center = transformPoint(entity.center);
        const startPoint = transformPoint({ x: entity.center.x + start.x, y: entity.center.y + start.y });
        const endPoint = transformPoint({ x: entity.center.x + end.x, y: entity.center.y + end.y });
        transformed.startAngle = Math.atan2(startPoint.y - center.y, startPoint.x - center.x);
        transformed.endAngle = Math.atan2(endPoint.y - center.y, endPoint.x - center.x);
      }
      if (Number.isFinite(entity.rotation)) transformed.rotation = entity.rotation + parentRotation * 180 / Math.PI;
      if (Number.isFinite(entity.textHeight)) transformed.textHeight = entity.textHeight * parentScale;
      if (Number.isFinite(entity.height)) transformed.height = entity.height * parentScale;
      if (entity.type !== "POINT") expanded.push(transformed);
    }
    return expanded;
  };

  return transformEntities(entities, identity, 0, 1, undefined, new Set());
}

function extractDrawDataFor(format: DrawingFormat, bytes: ArrayBuffer): ExtractedDrawData {
  if (format === "dxf") return extractDxfDrawData(bytes);
  return extractJwwDrawData(parseJww(bytes));
}

export function loadDrawing(source: DrawingSource): LoadDrawingResult {
  const format = detectFormat(source.fileName);
  if (!format) return { status: "unsupported", message: UNSUPPORTED_MESSAGE };

  let data: ExtractedDrawData;
  try {
    data = extractDrawDataFor(format, source.bytes);
  } catch (error) {
    console.error(error);
    return { status: "failed", message: FAILED_MESSAGE[format] };
  }

  if (!data.commands.length) return { status: "empty", message: EMPTY_MESSAGE };
  return { status: "loaded", format, data };
}
