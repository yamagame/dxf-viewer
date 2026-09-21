import DxfParser from "dxf-parser";
import {
  distancePointToSegment,
  getVertexKey,
  type Point,
  type Segment,
} from "./geometry";
import {
  computeSelectableVertices,
  createDefaultLayerVisibility,
  extractDrawData,
  getVisibleSegments,
  isLayerVisible,
  type Bounds,
  type DrawCommand,
} from "./drawing-model";
type PointerLikeEvent = { clientX: number; clientY: number };

function getRequiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Required element not found: #${id}`);
  }
  return element as T;
}

const fileInput = getRequiredElement<HTMLInputElement>("fileInput");
const fitButton = getRequiredElement<HTMLButtonElement>("fitButton");
const zoomInButton = getRequiredElement<HTMLButtonElement>("zoomInButton");
const zoomOutButton = getRequiredElement<HTMLButtonElement>("zoomOutButton");
const layerControlsEl = getRequiredElement<HTMLDivElement>("layerControls");
const statusEl = getRequiredElement<HTMLParagraphElement>("status");
const edgeInfoEl = document.getElementById("edgeInfo");
const measureInfoEl = getRequiredElement<HTMLParagraphElement>("measureInfo");
const canvas = getRequiredElement<HTMLCanvasElement>("viewer");
const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;

let drawCommands: DrawCommand[] = [];
let drawSegments: Segment[] = [];
let selectableVertices: Point[] = [];
let layerNames: string[] = [];
let layerVisibility = new Map<string, boolean>();
let bounds: Bounds | null = null;
let zoomLevel = 1;
let baseScale = 1;
let panX = 0;
let panY = 0;
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let dragStartPanX = 0;
let dragStartPanY = 0;
let isShiftPressed = false;
let activePointerId: number | null = null;
let isPanByMiddleButton = false;
let didDrag = false;
let suppressNextClick = false;
let selectedMeasurePoints: Point[] = [];
let measurementDistance = null;
let measurementDeltaX = null;
let measurementDeltaY = null;
let selectedEdge: Segment | null = null;
let hoveredEdge: Segment | null = null;
let hoveredVertex: Point | null = null;
let viewTransform: { scale: number; offsetX: number; offsetY: number } = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
};

const ZOOM_STEP = 1.2;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 20;
const VERTEX_SNAP_PIXEL = 12;
const EDGE_SNAP_PIXEL = 8;

function hasLoadedDrawing(): boolean {
  return drawCommands.length > 0 && bounds !== null;
}

function setZoomControlsEnabled(enabled: boolean): void {
  fitButton.disabled = !enabled;
  zoomInButton.disabled = !enabled;
  zoomOutButton.disabled = !enabled;
}

function resetLoadedDataState(): void {
  drawCommands = [];
  drawSegments = [];
  selectableVertices = [];
  layerNames = [];
  layerVisibility = new Map();
  bounds = null;
  resetEdgeSelection();
  renderLayerControls();
  resetMeasurement();
  updatePanAvailabilityClass();
}

window.addEventListener("resize", (): void => {
  resizeCanvas();
});

window.addEventListener("keydown", (event: KeyboardEvent): void => {
  if (event.key === "Shift") {
    isShiftPressed = true;
    updatePanAvailabilityClass();
  }

  if (!hasLoadedDrawing()) return;

  if (isZoomInShortcut(event)) {
    event.preventDefault();
    applyZoom(ZOOM_STEP);
  } else if (isZoomOutShortcut(event)) {
    event.preventDefault();
    applyZoom(1 / ZOOM_STEP);
  }
});

window.addEventListener("keyup", (event: KeyboardEvent): void => {
  if (event.key !== "Shift") return;
  isShiftPressed = false;
  endDrag();
  updatePanAvailabilityClass();
});

window.addEventListener("blur", (): void => {
  isShiftPressed = false;
  endDrag();
  updatePanAvailabilityClass();
});

fileInput.addEventListener("change", async (): Promise<void> => {
  const [file] = fileInput.files || [];
  if (!file) return;

  statusEl.textContent = `読み込み中: ${file.name}`;
  setZoomControlsEnabled(false);
  resetLoadedDataState();
  clearCanvas();

  try {
    const text = await file.text();
    const parser = new DxfParser();
    const dxf = parser.parseSync(text);

    const extracted = extractDrawData(dxf.entities || []);
    if (!extracted.commands.length) {
      statusEl.textContent = "対応エンティティが見つかりませんでした。";
      return;
    }

    drawCommands = extracted.commands;
    drawSegments = extracted.segments;
    layerNames = extracted.layers;
    layerVisibility = createDefaultLayerVisibility(layerNames);
    renderLayerControls();
    rebuildSelectableVertices();
    bounds = extracted.bounds;
    resetMeasurement();
    fitToScreen();
    setZoomControlsEnabled(true);
    updatePanAvailabilityClass();
    statusEl.textContent = `表示完了: ${file.name} (${drawCommands.length}要素, ${layerNames.length}レイヤー)`;
  } catch (error) {
    console.error(error);
    updatePanAvailabilityClass();
    statusEl.textContent = "DXFの解析に失敗しました。ファイル形式を確認してください。";
  }
});

fitButton.addEventListener("click", (): void => {
  if (!hasLoadedDrawing()) return;
  fitToScreen();
});

zoomInButton.addEventListener("click", (): void => {
  if (!hasLoadedDrawing()) return;
  applyZoom(ZOOM_STEP);
});

zoomOutButton.addEventListener("click", (): void => {
  if (!hasLoadedDrawing()) return;
  applyZoom(1 / ZOOM_STEP);
});

canvas.addEventListener("pointerdown", (event: PointerEvent): void => {
  if (!hasLoadedDrawing()) return;
  const panByMiddleButton = event.button === 1;
  const panByShiftDrag = event.button === 0 && event.shiftKey;
  if (!panByMiddleButton && !panByShiftDrag) return;

  isPanByMiddleButton = panByMiddleButton;
  isDragging = true;
  activePointerId = event.pointerId;
  dragStartX = event.clientX;
  dragStartY = event.clientY;
  dragStartPanX = panX;
  dragStartPanY = panY;
  didDrag = false;
  event.preventDefault();
  canvas.setPointerCapture(event.pointerId);
  canvas.classList.add("is-dragging");
});

canvas.addEventListener("pointermove", (event: PointerEvent): void => {
  updateHoveredEdge(event);
  updateHoveredVertex(event);

  if (!isDragging || event.pointerId !== activePointerId) return;
  if (!isPanByMiddleButton && !event.shiftKey) {
    endDrag(event.pointerId);
    updatePanAvailabilityClass();
    return;
  }
  const deltaX = event.clientX - dragStartX;
  const deltaY = event.clientY - dragStartY;
  if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) {
    didDrag = true;
  }
  panX = dragStartPanX + deltaX;
  panY = dragStartPanY + deltaY;
  render();
});

canvas.addEventListener("pointerup", (event: PointerEvent): void => {
  if (isDragging && event.pointerId === activePointerId) {
    suppressNextClick = didDrag && !isPanByMiddleButton;
  }
  endDrag(event.pointerId);
  updatePanAvailabilityClass();
});

canvas.addEventListener("pointercancel", (event: PointerEvent): void => {
  if (isDragging && event.pointerId === activePointerId) {
    suppressNextClick = didDrag && !isPanByMiddleButton;
  }
  endDrag(event.pointerId);
  hoveredEdge = null;
  hoveredVertex = null;
  render();
  updatePanAvailabilityClass();
});

canvas.addEventListener("pointerleave", (): void => {
  hoveredEdge = null;
  hoveredVertex = null;
  render();
});

canvas.addEventListener("click", (event: MouseEvent): void => {
  if (!hasLoadedDrawing()) return;
  if (event.shiftKey) return;
  if (suppressNextClick) {
    suppressNextClick = false;
    return;
  }
  selectEdge(event);
  selectMeasureVertex(event);
});

canvas.addEventListener(
  "wheel",
  (event: WheelEvent): void => {
    if (!hasLoadedDrawing()) return;
    event.preventDefault();
    if (isDragging) {
      return;
    }
    if (event.deltaY < 0) {
      applyZoom(ZOOM_STEP);
    } else if (event.deltaY > 0) {
      applyZoom(1 / ZOOM_STEP);
    }
  },
  { passive: false }
);

function clearCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function isZoomInShortcut(event) {
  return event.code === "Equal" || event.code === "NumpadAdd";
}

function isZoomOutShortcut(event) {
  return event.code === "Minus" || event.code === "NumpadSubtract";
}

function endDrag(pointerId?: number) {
  if (!isDragging) return;
  if (pointerId !== undefined && pointerId !== activePointerId) return;
  isDragging = false;
  isPanByMiddleButton = false;
  if (activePointerId !== null && canvas.hasPointerCapture(activePointerId)) {
    canvas.releasePointerCapture(activePointerId);
  }
  activePointerId = null;
  canvas.classList.remove("is-dragging");
}

function updatePanAvailabilityClass() {
  const canPan = isShiftPressed && drawCommands.length > 0 && bounds;
  canvas.classList.toggle("is-pan-ready", Boolean(canPan));
}

function renderLayerControls() {
  layerControlsEl.innerHTML = "";
  if (!layerNames.length) {
    const empty = document.createElement("span");
    empty.textContent = "レイヤー: ファイル読込後に表示";
    layerControlsEl.appendChild(empty);
    return;
  }

  layerNames.forEach((layer) => {
    const label = document.createElement("label");
    label.className = "layer-item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = isLayerVisible(layerVisibility, layer);
    checkbox.addEventListener("change", () => {
      layerVisibility.set(layer, checkbox.checked);
      rebuildSelectableVertices();
      validateEdgeSelection();
      resetMeasurement();
      render();
    });

    const text = document.createElement("span");
    text.textContent = layer;

    label.appendChild(checkbox);
    label.appendChild(text);
    layerControlsEl.appendChild(label);
  });
}

function resetEdgeSelection() {
  selectedEdge = null;
  hoveredEdge = null;
  updateEdgeInfo("エッジ選択: エッジをクリックしてください。");
}

function updateEdgeInfo(message) {
  if (!edgeInfoEl) return;
  edgeInfoEl.textContent = message;
}

function validateEdgeSelection() {
  if (!selectedEdge) return;
  if (!isLayerVisible(layerVisibility, selectedEdge.layer)) {
    selectedEdge = null;
    updateEdgeInfo("エッジ選択: エッジをクリックしてください。");
  }
  if (hoveredEdge && !isLayerVisible(layerVisibility, hoveredEdge.layer)) {
    hoveredEdge = null;
  }
}

function resetMeasurement() {
  selectedMeasurePoints = [];
  measurementDistance = null;
  measurementDeltaX = null;
  measurementDeltaY = null;
  hoveredVertex = null;
  updateMeasurementInfo("距離測定: 2頂点をクリックしてください。");
}

function updateMeasurementInfo(message) {
  if (!measureInfoEl) return;
  measureInfoEl.textContent = message;
}

function modelToCanvas(point) {
  return {
    x: point.x * viewTransform.scale + viewTransform.offsetX,
    y: -point.y * viewTransform.scale + viewTransform.offsetY,
  };
}

function selectMeasureVertex(event: PointerLikeEvent): void {
  const nearest = findNearestVertexFromPointerEvent(event);
  if (!nearest) {
    updateMeasurementInfo("距離測定: 頂点付近をクリックしてください。");
    return;
  }

  if (selectedMeasurePoints.length >= 2) {
    selectedMeasurePoints = [];
    measurementDistance = null;
    measurementDeltaX = null;
    measurementDeltaY = null;
  }

  selectedMeasurePoints.push({ x: nearest.x, y: nearest.y });

  if (selectedMeasurePoints.length === 2) {
    const [a, b] = selectedMeasurePoints;
    measurementDeltaX = b.x - a.x;
    measurementDeltaY = b.y - a.y;
    measurementDistance = Math.hypot(b.x - a.x, b.y - a.y);
    updateMeasurementInfo(
      `距離: ${measurementDistance.toFixed(3)} (ΔX: ${measurementDeltaX.toFixed(3)}, ΔY: ${measurementDeltaY.toFixed(3)})`
    );
  } else {
    updateMeasurementInfo("距離測定: 2つ目の頂点をクリックしてください。");
  }

  render();
}

function selectEdge(event: PointerLikeEvent): void {
  const nearest = findNearestEdgeFromPointerEvent(event);
  if (!nearest) {
    selectedEdge = null;
    updateEdgeInfo("エッジ選択: エッジ付近をクリックしてください。");
    render();
    return;
  }
  selectedEdge = nearest;
  updateEdgeInfo(`選択エッジのレイヤー: ${nearest.layer}`);
  render();
}

function updateHoveredEdge(event: PointerLikeEvent): void {
  if (!drawCommands.length || !bounds || isDragging) return;
  const nextHovered = findNearestEdgeFromPointerEvent(event);
  if (
    hoveredEdge?.layer === nextHovered?.layer &&
    hoveredEdge?.from?.x === nextHovered?.from?.x &&
    hoveredEdge?.from?.y === nextHovered?.from?.y &&
    hoveredEdge?.to?.x === nextHovered?.to?.x &&
    hoveredEdge?.to?.y === nextHovered?.to?.y
  ) {
    return;
  }
  hoveredEdge = nextHovered;
  render();
}

function updateHoveredVertex(event: PointerLikeEvent): void {
  if (!drawCommands.length || !bounds || isDragging) return;
  const nextHovered = findNearestVertexFromPointerEvent(event);
  if (
    hoveredVertex?.x === nextHovered?.x &&
    hoveredVertex?.y === nextHovered?.y
  ) {
    return;
  }
  hoveredVertex = nextHovered;
  render();
}

function findNearestVertexFromPointerEvent(event: PointerLikeEvent): Point | null {
  if (!selectableVertices.length) return null;

  const canvasRect = canvas.getBoundingClientRect();
  const targetX = event.clientX - canvasRect.left;
  const targetY = event.clientY - canvasRect.top;

  let nearest = null;
  let nearestDistance = Infinity;

  for (const vertex of selectableVertices) {
    const p = modelToCanvas(vertex);
    const distance = Math.hypot(p.x - targetX, p.y - targetY);
    if (distance < nearestDistance) {
      nearest = vertex;
      nearestDistance = distance;
    }
  }

  if (!nearest || nearestDistance > VERTEX_SNAP_PIXEL) {
    return null;
  }

  return nearest;
}

function findNearestEdgeFromPointerEvent(event: PointerLikeEvent): Segment | null {
  const visibleSegments = getVisibleSegments(drawSegments, layerVisibility);
  if (!visibleSegments.length) return null;

  const canvasRect = canvas.getBoundingClientRect();
  const targetX = event.clientX - canvasRect.left;
  const targetY = event.clientY - canvasRect.top;

  let nearest = null;
  let nearestDistance = Infinity;

  for (const segment of visibleSegments) {
    const from = modelToCanvas(segment.from);
    const to = modelToCanvas(segment.to);
    const distance = distancePointToSegment(targetX, targetY, from.x, from.y, to.x, to.y);
    if (distance < nearestDistance) {
      nearest = segment;
      nearestDistance = distance;
    }
  }

  if (!nearest || nearestDistance > EDGE_SNAP_PIXEL) {
    return null;
  }
  return nearest;
}

function rebuildSelectableVertices() {
  const visibleSegments = getVisibleSegments(drawSegments, layerVisibility);
  const vertices = computeSelectableVertices(visibleSegments);
  const vertexKeySet = new Set(vertices.map((v) => getVertexKey(v.x, v.y)));
  selectableVertices = vertices;
  if (hoveredVertex) {
    const key = getVertexKey(hoveredVertex.x, hoveredVertex.y);
    if (!vertexKeySet.has(key)) {
      hoveredVertex = null;
    }
  }
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));

  if (canvas.width === width && canvas.height === height) {
    return;
  }

  canvas.width = width;
  canvas.height = height;

  if (drawCommands.length && bounds) {
    render();
  } else {
    clearCanvas();
  }
}

function getModelCenter() {
  if (!bounds) {
    return { x: 0, y: 0 };
  }
  return {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
  };
}

function getCurrentScale() {
  return baseScale * zoomLevel;
}

function getViewCenterModel() {
  const scale = getCurrentScale();
  const modelCenter = getModelCenter();
  return {
    x: modelCenter.x - panX / scale,
    y: modelCenter.y + panY / scale,
  };
}

function applyZoom(zoomFactor) {
  const viewCenter = getViewCenterModel();
  const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoomLevel * zoomFactor));
  zoomLevel = nextZoom;

  const scale = getCurrentScale();
  const modelCenter = getModelCenter();
  panX = (modelCenter.x - viewCenter.x) * scale;
  panY = (viewCenter.y - modelCenter.y) * scale;
  render();
}

function fitToScreen() {
  const padding = 30;
  const modelW = bounds.maxX - bounds.minX || 1;
  const modelH = bounds.maxY - bounds.minY || 1;
  const viewW = Math.max(1, canvas.width - padding * 2);
  const viewH = Math.max(1, canvas.height - padding * 2);

  const scaleX = viewW / modelW;
  const scaleY = viewH / modelH;
  baseScale = Math.min(scaleX, scaleY);
  zoomLevel = 1;
  panX = 0;
  panY = 0;
  render();
}

function render() {
  if (!bounds) {
    clearCanvas();
    return;
  }
  clearCanvas();

  const scale = getCurrentScale();
  const { x: centerX, y: centerY } = getModelCenter();

  const offsetX = canvas.width / 2 - centerX * scale + panX;
  const offsetY = canvas.height / 2 + centerY * scale + panY;

  const toCanvasX = (x) => x * scale + offsetX;
  const toCanvasY = (y) => -y * scale + offsetY;
  viewTransform.scale = scale;
  viewTransform.offsetX = offsetX;
  viewTransform.offsetY = offsetY;

  ctx.lineWidth = 1;
  ctx.strokeStyle = "#111827";

  const visibleCommands = drawCommands.filter((command) =>
    isLayerVisible(layerVisibility, command.layer)
  );
  for (const command of visibleCommands) {
    ctx.beginPath();

    if (command.type === "line") {
      ctx.moveTo(toCanvasX(command.from.x), toCanvasY(command.from.y));
      ctx.lineTo(toCanvasX(command.to.x), toCanvasY(command.to.y));
    } else if (command.type === "polyline") {
      const [first, ...rest] = command.vertices;
      ctx.moveTo(toCanvasX(first.x), toCanvasY(first.y));
      rest.forEach((v) => ctx.lineTo(toCanvasX(v.x), toCanvasY(v.y)));
      if (command.closed) {
        ctx.closePath();
      }
    } else if (command.type === "circle") {
      ctx.arc(
        toCanvasX(command.center.x),
        toCanvasY(command.center.y),
        command.radius * scale,
        0,
        Math.PI * 2
      );
    } else if (command.type === "arc") {
      ctx.arc(
        toCanvasX(command.center.x),
        toCanvasY(command.center.y),
        command.radius * scale,
        -command.end,
        -command.start,
        false
      );
    }

    ctx.stroke();
  }

  drawEdgeOverlay(toCanvasX, toCanvasY);
  drawMeasurementOverlay(toCanvasX, toCanvasY);
}

function drawEdgeOverlay(toCanvasX, toCanvasY) {
  if (hoveredEdge) {
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#3b82f6";
    ctx.beginPath();
    ctx.moveTo(toCanvasX(hoveredEdge.from.x), toCanvasY(hoveredEdge.from.y));
    ctx.lineTo(toCanvasX(hoveredEdge.to.x), toCanvasY(hoveredEdge.to.y));
    ctx.stroke();
    ctx.restore();
  }

  if (!selectedEdge) return;

  ctx.save();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#f59e0b";
  ctx.beginPath();
  ctx.moveTo(toCanvasX(selectedEdge.from.x), toCanvasY(selectedEdge.from.y));
  ctx.lineTo(toCanvasX(selectedEdge.to.x), toCanvasY(selectedEdge.to.y));
  ctx.stroke();
  ctx.restore();
}

function drawMeasurementOverlay(toCanvasX, toCanvasY) {
  if (hoveredVertex) {
    ctx.save();
    ctx.fillStyle = "#2563eb";
    ctx.beginPath();
    ctx.arc(toCanvasX(hoveredVertex.x), toCanvasY(hoveredVertex.y), 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  if (!selectedMeasurePoints.length) return;

  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.fillStyle = "#dc2626";
  ctx.strokeStyle = "#dc2626";

  if (selectedMeasurePoints.length === 2) {
    const [a, b] = selectedMeasurePoints;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(toCanvasX(a.x), toCanvasY(a.y));
    ctx.lineTo(toCanvasX(b.x), toCanvasY(b.y));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  for (const point of selectedMeasurePoints) {
    ctx.beginPath();
    ctx.arc(toCanvasX(point.x), toCanvasY(point.y), 5, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

resizeCanvas();
renderLayerControls();
updatePanAvailabilityClass();
