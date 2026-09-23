import type { DrawingSource, LoadDrawingResult } from "./drawing-loader";
import type { Point, Segment } from "./geometry";

export type DrawingWorkerRequest =
  | { type: "load"; source: DrawingSource }
  | { type: "vertices"; segments: Segment[] };

export type DrawingWorkerResult =
  | { type: "drawing"; result: LoadDrawingResult; vertices: Point[] }
  | { type: "vertices"; vertices: Point[] };

export type DrawingWorkerMessage =
  | { type: "progress"; completed: number; total: number }
  | { type: "result"; result: DrawingWorkerResult }
  | { type: "error"; message: string };
