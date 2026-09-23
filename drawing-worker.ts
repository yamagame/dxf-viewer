import { loadDrawing } from "./drawing-loader";
import { computeSelectableVertices } from "./drawing-model";
import type { DrawingWorkerRequest, DrawingWorkerMessage } from "./drawing-worker-protocol";

function send(message: DrawingWorkerMessage): void {
  self.postMessage(message);
}

self.onmessage = (event: MessageEvent<DrawingWorkerRequest>) => {
  let lastPercent = -1;
  const reportProgress = (completed: number, total: number): void => {
    const percent = total ? Math.floor(completed / total * 100) : 100;
    if (percent === lastPercent) return;
    lastPercent = percent;
    send({ type: "progress", completed, total });
  };
  try {
    const request = event.data;
    if (request.type === "vertices") {
      const vertices = computeSelectableVertices(request.segments, reportProgress);
      send({ type: "result", result: { type: "vertices", vertices } });
      return;
    }
    const result = loadDrawing(request.source);
    // Initial selection preparation must also stay off the main thread.
    const hiddenLayers = new Set(result.status === "loaded"
      ? result.data.layers.filter((layer) => !layer.visible).map((layer) => layer.name)
      : []);
    const vertices = result.status === "loaded"
      ? computeSelectableVertices(result.data.segments.filter((segment) => !hiddenLayers.has(segment.layer)), reportProgress)
      : [];
    send({ type: "result", result: { type: "drawing", result, vertices } });
  } catch (error) {
    send({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
