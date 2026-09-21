import DxfParser from "dxf-parser";

type Point = { x: number; y: number };
type Segment = { layer: string; from: Point; to: Point };

type DrawCommand =
  | { type: "line"; layer: string; from: Point; to: Point }
  | { type: "polyline"; layer: string; vertices: Point[]; closed: boolean }
  | { type: "circle"; layer: string; center: Point; radius: number }
  | { type: "arc"; layer: string; center: Point; radius: number; start: number; end: number };

type ExtractedDrawData = {
  commands: DrawCommand[];
  segments: Segment[];
  layers: string[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
};

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
let bounds = null;
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
let viewTransform = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
};

const ZOOM_STEP = 1.2;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 20;
const VERTEX_SNAP_PIXEL = 12;
const EDGE_SNAP_PIXEL = 8;
const INTERSECTION_EPSILON = 1e-9;

window.addEventListener("resize", () => {
  resizeCanvas();
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Shift") {
    isShiftPressed = true;
    updatePanAvailabilityClass();
  }

  if (!drawCommands.length || !bounds) return;

  if (isZoomInShortcut(event)) {
    event.preventDefault();
    applyZoom(ZOOM_STEP);
  } else if (isZoomOutShortcut(event)) {
    event.preventDefault();
    applyZoom(1 / ZOOM_STEP);
  }
});

window.addEventListener("keyup", (event) => {
  if (event.key !== "Shift") return;
  isShiftPressed = false;
  endDrag();
  updatePanAvailabilityClass();
});

window.addEventListener("blur", () => {
  isShiftPressed = false;
  endDrag();
  updatePanAvailabilityClass();
});

fileInput.addEventListener("change", async (event) => {
  const [file] = fileInput.files || [];
  if (!file) return;

  statusEl.textContent = `読み込み中: ${file.name}`;
  fitButton.disabled = true;
  zoomInButton.disabled = true;
  zoomOutButton.disabled = true;
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
    fitButton.disabled = false;
    zoomInButton.disabled = false;
    zoomOutButton.disabled = false;
    updatePanAvailabilityClass();
    statusEl.textContent = `表示完了: ${file.name} (${drawCommands.length}要素, ${layerNames.length}レイヤー)`;
  } catch (error) {
    console.error(error);
    updatePanAvailabilityClass();
    statusEl.textContent = "DXFの解析に失敗しました。ファイル形式を確認してください。";
  }
});

fitButton.addEventListener("click", () => {
  if (!drawCommands.length || !bounds) return;
  fitToScreen();
});

zoomInButton.addEventListener("click", () => {
  if (!drawCommands.length || !bounds) return;
  applyZoom(ZOOM_STEP);
});

zoomOutButton.addEventListener("click", () => {
  if (!drawCommands.length || !bounds) return;
  applyZoom(1 / ZOOM_STEP);
});

canvas.addEventListener("pointerdown", (event) => {
  if (!drawCommands.length || !bounds) return;
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

canvas.addEventListener("pointermove", (event) => {
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

canvas.addEventListener("pointerup", (event) => {
  if (isDragging && event.pointerId === activePointerId) {
    suppressNextClick = didDrag && !isPanByMiddleButton;
  }
  endDrag(event.pointerId);
  updatePanAvailabilityClass();
});

canvas.addEventListener("pointercancel", (event) => {
  if (isDragging && event.pointerId === activePointerId) {
    suppressNextClick = didDrag && !isPanByMiddleButton;
  }
  endDrag(event.pointerId);
  hoveredEdge = null;
  hoveredVertex = null;
  render();
  updatePanAvailabilityClass();
});

canvas.addEventListener("pointerleave", () => {
  hoveredEdge = null;
  hoveredVertex = null;
  render();
});

canvas.addEventListener("click", (event) => {
  if (!drawCommands.length || !bounds) return;
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
  (event) => {
    if (!drawCommands.length || !bounds) return;
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

function normalizeLayerName(layerName) {
  if (!layerName || typeof layerName !== "string") return "0";
  return layerName;
}

function createDefaultLayerVisibility(layers) {
  const visibility = new Map();
  layers.forEach((layer) => {
    visibility.set(layer, true);
  });
  return visibility;
}

function isLayerVisible(layerName) {
  if (!layerVisibility.size) return true;
  return layerVisibility.get(normalizeLayerName(layerName)) !== false;
}

function renderLayerControls() {
  if (!layerControlsEl) return;
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
    checkbox.checked = isLayerVisible(layer);
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

function getVisibleSegments() {
  return drawSegments.filter((segment) => isLayerVisible(segment.layer));
}

function validateEdgeSelection() {
  if (!selectedEdge) return;
  if (!isLayerVisible(selectedEdge.layer)) {
    selectedEdge = null;
    updateEdgeInfo("エッジ選択: エッジをクリックしてください。");
  }
  if (hoveredEdge && !isLayerVisible(hoveredEdge.layer)) {
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

function selectMeasureVertex(event) {
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

function selectEdge(event) {
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

function updateHoveredEdge(event) {
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

function updateHoveredVertex(event) {
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

function findNearestVertexFromPointerEvent(event) {
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

function findNearestEdgeFromPointerEvent(event) {
  const visibleSegments = getVisibleSegments();
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

function distancePointToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) {
    return Math.hypot(px - x1, py - y1);
  }
  const t = ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy);
  const clampedT = Math.max(0, Math.min(1, t));
  const cx = x1 + clampedT * dx;
  const cy = y1 + clampedT * dy;
  return Math.hypot(px - cx, py - cy);
}

function getVertexKey(x, y) {
  const normalizedX = Number(x.toFixed(6));
  const normalizedY = Number(y.toFixed(6));
  return `${normalizedX}:${normalizedY}`;
}

function rebuildSelectableVertices() {
  const vertices = [];
  const vertexKeySet = new Set();
  const visibleSegments = getVisibleSegments();

  const includeVertex = (x, y) => {
    const key = getVertexKey(x, y);
    if (vertexKeySet.has(key)) return;
    vertexKeySet.add(key);
    const [normalizedX, normalizedY] = key.split(":").map(Number);
    vertices.push({ x: normalizedX, y: normalizedY });
  };

  for (const segment of visibleSegments) {
    includeVertex(segment.from.x, segment.from.y);
    includeVertex(segment.to.x, segment.to.y);
  }

  for (let i = 0; i < visibleSegments.length - 1; i += 1) {
    for (let j = i + 1; j < visibleSegments.length; j += 1) {
      const intersection = intersectSegments(visibleSegments[i], visibleSegments[j]);
      if (!intersection) continue;
      includeVertex(intersection.x, intersection.y);
    }
  }

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

function extractDrawData(entities: any[]): ExtractedDrawData {
  const commands = [];
  const segments = [];
  const layersSet = new Set<string>();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const includePoint = (x, y) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };

  const includeVertices = (vertices = []) => {
    vertices.forEach((v) => includePoint(v.x, v.y));
  };

  for (const entity of entities) {
    const layer = normalizeLayerName(entity.layer);
    layersSet.add(layer);

    if (entity.type === "LINE" && entity.vertices?.length >= 2) {
      const [a, b] = entity.vertices;
      includePoint(a.x, a.y);
      includePoint(b.x, b.y);
      segments.push({
        layer,
        from: { x: a.x, y: a.y },
        to: { x: b.x, y: b.y },
      });
      commands.push({
        type: "line",
        layer,
        from: { x: a.x, y: a.y },
        to: { x: b.x, y: b.y },
      });
      continue;
    }

    if (
      (entity.type === "LWPOLYLINE" || entity.type === "POLYLINE") &&
      entity.vertices?.length >= 2
    ) {
      includeVertices(entity.vertices);
      for (let i = 0; i < entity.vertices.length - 1; i += 1) {
        segments.push({
          layer,
          from: { x: entity.vertices[i].x, y: entity.vertices[i].y },
          to: { x: entity.vertices[i + 1].x, y: entity.vertices[i + 1].y },
        });
      }
      if (entity.shape) {
        const first = entity.vertices[0];
        const last = entity.vertices[entity.vertices.length - 1];
        segments.push({
          layer,
          from: { x: last.x, y: last.y },
          to: { x: first.x, y: first.y },
        });
      }
      commands.push({
        type: "polyline",
        layer,
        vertices: entity.vertices.map((v) => ({ x: v.x, y: v.y })),
        closed: Boolean(entity.shape),
      });
      continue;
    }

    if (entity.type === "CIRCLE" && entity.center && Number.isFinite(entity.radius)) {
      includePoint(entity.center.x - entity.radius, entity.center.y - entity.radius);
      includePoint(entity.center.x + entity.radius, entity.center.y + entity.radius);
      commands.push({
        type: "circle",
        layer,
        center: { x: entity.center.x, y: entity.center.y },
        radius: entity.radius,
      });
      continue;
    }

    if (
      entity.type === "ARC" &&
      entity.center &&
      Number.isFinite(entity.radius) &&
      Number.isFinite(entity.startAngle) &&
      Number.isFinite(entity.endAngle)
    ) {
      includePoint(entity.center.x - entity.radius, entity.center.y - entity.radius);
      includePoint(entity.center.x + entity.radius, entity.center.y + entity.radius);
      commands.push({
        type: "arc",
        layer,
        center: { x: entity.center.x, y: entity.center.y },
        radius: entity.radius,
        start: (entity.startAngle * Math.PI) / 180,
        end: (entity.endAngle * Math.PI) / 180,
      });
    }
  }

  if (!Number.isFinite(minX)) {
    return { commands: [], segments: [], layers: [], bounds: null };
  }

  return {
    commands,
    segments,
    layers: Array.from(layersSet).sort((a, b) => a.localeCompare(b)),
    bounds: { minX, minY, maxX, maxY },
  };
}

function intersectSegments(segA, segB) {
  const p = segA.from;
  const r = { x: segA.to.x - segA.from.x, y: segA.to.y - segA.from.y };
  const q = segB.from;
  const s = { x: segB.to.x - segB.from.x, y: segB.to.y - segB.from.y };

  const rxs = cross2D(r, s);
  const qMinusP = { x: q.x - p.x, y: q.y - p.y };
  const qpxr = cross2D(qMinusP, r);

  if (Math.abs(rxs) < INTERSECTION_EPSILON) {
    if (Math.abs(qpxr) < INTERSECTION_EPSILON) {
      return null;
    }
    return null;
  }

  const t = cross2D(qMinusP, s) / rxs;
  const u = cross2D(qMinusP, r) / rxs;
  const inRange = (value) => value >= -INTERSECTION_EPSILON && value <= 1 + INTERSECTION_EPSILON;

  if (!inRange(t) || !inRange(u)) {
    return null;
  }

  return {
    x: p.x + t * r.x,
    y: p.y + t * r.y,
  };
}

function cross2D(a, b) {
  return a.x * b.y - a.y * b.x;
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

  const visibleCommands = drawCommands.filter((command) => isLayerVisible(command.layer));
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
