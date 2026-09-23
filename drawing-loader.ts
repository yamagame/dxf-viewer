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
  return extractDrawData(dxf.entities || []);
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
