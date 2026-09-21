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
type ViewTransform = { scale: number; offsetX: number; offsetY: number };

function getRequiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Required element not found: #${id}`);
  }
  return element as T;
}

class DxfViewerApp {
  private readonly fileInput = getRequiredElement<HTMLInputElement>("fileInput");
  private readonly fitButton = getRequiredElement<HTMLButtonElement>("fitButton");
  private readonly zoomInButton = getRequiredElement<HTMLButtonElement>("zoomInButton");
  private readonly zoomOutButton = getRequiredElement<HTMLButtonElement>("zoomOutButton");
  private readonly layerControlsEl = getRequiredElement<HTMLDivElement>("layerControls");
  private readonly statusEl = getRequiredElement<HTMLParagraphElement>("status");
  private readonly edgeInfoEl = document.getElementById("edgeInfo");
  private readonly measureInfoEl = getRequiredElement<HTMLParagraphElement>("measureInfo");
  private readonly canvas = getRequiredElement<HTMLCanvasElement>("viewer");
  private readonly ctx = this.canvas.getContext("2d") as CanvasRenderingContext2D;

  private drawCommands: DrawCommand[] = [];
  private drawSegments: Segment[] = [];
  private selectableVertices: Point[] = [];
  private layerNames: string[] = [];
  private layerVisibility = new Map<string, boolean>();
  private bounds: Bounds | null = null;

  private zoomLevel = 1;
  private baseScale = 1;
  private panX = 0;
  private panY = 0;

  private isShiftPressed = false;
  private isDragging = false;
  private activePointerId: number | null = null;
  private isPanByMiddleButton = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragStartPanX = 0;
  private dragStartPanY = 0;
  private didDrag = false;
  private suppressNextClick = false;

  private selectedMeasurePoints: Point[] = [];
  private measurementDistance: number | null = null;
  private measurementDeltaX: number | null = null;
  private measurementDeltaY: number | null = null;

  private selectedEdge: Segment | null = null;
  private hoveredEdge: Segment | null = null;
  private hoveredVertex: Point | null = null;

  private viewTransform: ViewTransform = { scale: 1, offsetX: 0, offsetY: 0 };

  private readonly ZOOM_STEP = 1.2;
  private readonly MIN_ZOOM = 0.2;
  private readonly MAX_ZOOM = 20;
  private readonly VERTEX_SNAP_PIXEL = 12;
  private readonly EDGE_SNAP_PIXEL = 8;

  constructor() {
    this.bindEvents();
    this.resizeCanvas();
    this.renderLayerControls();
    this.updatePanAvailabilityClass();
  }

  private bindEvents(): void {
    window.addEventListener("resize", this.onWindowResize);
    window.addEventListener("keydown", this.onWindowKeyDown);
    window.addEventListener("keyup", this.onWindowKeyUp);
    window.addEventListener("blur", this.onWindowBlur);

    this.fileInput.addEventListener("change", this.onFileChange);
    this.fitButton.addEventListener("click", this.onFitClick);
    this.zoomInButton.addEventListener("click", this.onZoomInClick);
    this.zoomOutButton.addEventListener("click", this.onZoomOutClick);

    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerCancel);
    this.canvas.addEventListener("pointerleave", this.onPointerLeave);
    this.canvas.addEventListener("click", this.onCanvasClick);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
  }

  private readonly onWindowResize = (): void => {
    this.resizeCanvas();
  };

  private readonly onWindowKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Shift") {
      this.isShiftPressed = true;
      this.updatePanAvailabilityClass();
    }

    if (!this.hasLoadedDrawing()) return;
    if (this.isZoomInShortcut(event)) {
      event.preventDefault();
      this.applyZoom(this.ZOOM_STEP);
      return;
    }
    if (this.isZoomOutShortcut(event)) {
      event.preventDefault();
      this.applyZoom(1 / this.ZOOM_STEP);
    }
  };

  private readonly onWindowKeyUp = (event: KeyboardEvent): void => {
    if (event.key !== "Shift") return;
    this.isShiftPressed = false;
    this.endDrag();
    this.updatePanAvailabilityClass();
  };

  private readonly onWindowBlur = (): void => {
    this.isShiftPressed = false;
    this.endDrag();
    this.updatePanAvailabilityClass();
  };

  private readonly onFileChange = async (): Promise<void> => {
    const [file] = this.fileInput.files || [];
    if (!file) return;

    this.statusEl.textContent = `読み込み中: ${file.name}`;
    this.setZoomControlsEnabled(false);
    this.resetLoadedDataState();
    this.clearCanvas();

    try {
      const text = await file.text();
      const parser = new DxfParser();
      const dxf = parser.parseSync(text);
      const extracted = extractDrawData(dxf.entities || []);

      if (!extracted.commands.length) {
        this.statusEl.textContent = "対応エンティティが見つかりませんでした。";
        return;
      }

      this.drawCommands = extracted.commands;
      this.drawSegments = extracted.segments;
      this.layerNames = extracted.layers;
      this.layerVisibility = createDefaultLayerVisibility(this.layerNames);
      this.bounds = extracted.bounds;

      this.renderLayerControls();
      this.rebuildSelectableVertices();
      this.resetMeasurement();
      this.fitToScreen();
      this.setZoomControlsEnabled(true);
      this.updatePanAvailabilityClass();

      this.statusEl.textContent = `表示完了: ${file.name} (${this.drawCommands.length}要素, ${this.layerNames.length}レイヤー)`;
    } catch (error) {
      console.error(error);
      this.updatePanAvailabilityClass();
      this.statusEl.textContent = "DXFの解析に失敗しました。ファイル形式を確認してください。";
    }
  };

  private readonly onFitClick = (): void => {
    if (!this.hasLoadedDrawing()) return;
    this.fitToScreen();
  };

  private readonly onZoomInClick = (): void => {
    if (!this.hasLoadedDrawing()) return;
    this.applyZoom(this.ZOOM_STEP);
  };

  private readonly onZoomOutClick = (): void => {
    if (!this.hasLoadedDrawing()) return;
    this.applyZoom(1 / this.ZOOM_STEP);
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.hasLoadedDrawing()) return;
    const panByMiddleButton = event.button === 1;
    const panByShiftDrag = event.button === 0 && event.shiftKey;
    if (!panByMiddleButton && !panByShiftDrag) return;

    this.isPanByMiddleButton = panByMiddleButton;
    this.isDragging = true;
    this.activePointerId = event.pointerId;
    this.dragStartX = event.clientX;
    this.dragStartY = event.clientY;
    this.dragStartPanX = this.panX;
    this.dragStartPanY = this.panY;
    this.didDrag = false;
    event.preventDefault();
    this.canvas.setPointerCapture(event.pointerId);
    this.canvas.classList.add("is-dragging");
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    this.updateHoveredEdge(event);
    this.updateHoveredVertex(event);

    if (!this.isDragging || event.pointerId !== this.activePointerId) return;
    if (!this.isPanByMiddleButton && !event.shiftKey) {
      this.endDrag(event.pointerId);
      this.updatePanAvailabilityClass();
      return;
    }

    const deltaX = event.clientX - this.dragStartX;
    const deltaY = event.clientY - this.dragStartY;
    if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) {
      this.didDrag = true;
    }
    this.panX = this.dragStartPanX + deltaX;
    this.panY = this.dragStartPanY + deltaY;
    this.render();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.isDragging && event.pointerId === this.activePointerId) {
      this.suppressNextClick = this.didDrag && !this.isPanByMiddleButton;
    }
    this.endDrag(event.pointerId);
    this.updatePanAvailabilityClass();
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    if (this.isDragging && event.pointerId === this.activePointerId) {
      this.suppressNextClick = this.didDrag && !this.isPanByMiddleButton;
    }
    this.endDrag(event.pointerId);
    this.hoveredEdge = null;
    this.hoveredVertex = null;
    this.render();
    this.updatePanAvailabilityClass();
  };

  private readonly onPointerLeave = (): void => {
    this.hoveredEdge = null;
    this.hoveredVertex = null;
    this.render();
  };

  private readonly onCanvasClick = (event: MouseEvent): void => {
    if (!this.hasLoadedDrawing()) return;
    if (event.shiftKey) return;
    if (this.suppressNextClick) {
      this.suppressNextClick = false;
      return;
    }
    this.selectEdge(event);
    this.selectMeasureVertex(event);
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (!this.hasLoadedDrawing()) return;
    event.preventDefault();
    if (this.isDragging) return;
    if (event.deltaY < 0) {
      this.applyZoom(this.ZOOM_STEP);
    } else if (event.deltaY > 0) {
      this.applyZoom(1 / this.ZOOM_STEP);
    }
  };

  private hasLoadedDrawing(): boolean {
    return this.drawCommands.length > 0 && this.bounds !== null;
  }

  private setZoomControlsEnabled(enabled: boolean): void {
    this.fitButton.disabled = !enabled;
    this.zoomInButton.disabled = !enabled;
    this.zoomOutButton.disabled = !enabled;
  }

  private resetLoadedDataState(): void {
    this.drawCommands = [];
    this.drawSegments = [];
    this.selectableVertices = [];
    this.layerNames = [];
    this.layerVisibility = new Map();
    this.bounds = null;
    this.resetEdgeSelection();
    this.renderLayerControls();
    this.resetMeasurement();
    this.updatePanAvailabilityClass();
  }

  private clearCanvas(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private isZoomInShortcut(event: KeyboardEvent): boolean {
    return event.code === "Equal" || event.code === "NumpadAdd";
  }

  private isZoomOutShortcut(event: KeyboardEvent): boolean {
    return event.code === "Minus" || event.code === "NumpadSubtract";
  }

  private endDrag(pointerId?: number): void {
    if (!this.isDragging) return;
    if (pointerId !== undefined && pointerId !== this.activePointerId) return;
    this.isDragging = false;
    this.isPanByMiddleButton = false;
    if (this.activePointerId !== null && this.canvas.hasPointerCapture(this.activePointerId)) {
      this.canvas.releasePointerCapture(this.activePointerId);
    }
    this.activePointerId = null;
    this.canvas.classList.remove("is-dragging");
  }

  private updatePanAvailabilityClass(): void {
    const canPan = this.isShiftPressed && this.hasLoadedDrawing();
    this.canvas.classList.toggle("is-pan-ready", canPan);
  }

  private renderLayerControls(): void {
    this.layerControlsEl.innerHTML = "";
    if (!this.layerNames.length) {
      const empty = document.createElement("span");
      empty.textContent = "レイヤー: ファイル読込後に表示";
      this.layerControlsEl.appendChild(empty);
      return;
    }

    this.layerNames.forEach((layer) => {
      const label = document.createElement("label");
      label.className = "layer-item";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = isLayerVisible(this.layerVisibility, layer);
      checkbox.addEventListener("change", () => {
        this.layerVisibility.set(layer, checkbox.checked);
        this.rebuildSelectableVertices();
        this.validateEdgeSelection();
        this.resetMeasurement();
        this.render();
      });

      const text = document.createElement("span");
      text.textContent = layer;

      label.appendChild(checkbox);
      label.appendChild(text);
      this.layerControlsEl.appendChild(label);
    });
  }

  private resetEdgeSelection(): void {
    this.selectedEdge = null;
    this.hoveredEdge = null;
    this.updateEdgeInfo("エッジ選択: エッジをクリックしてください。");
  }

  private updateEdgeInfo(message: string): void {
    if (!this.edgeInfoEl) return;
    this.edgeInfoEl.textContent = message;
  }

  private validateEdgeSelection(): void {
    if (!this.selectedEdge) return;
    if (!isLayerVisible(this.layerVisibility, this.selectedEdge.layer)) {
      this.selectedEdge = null;
      this.updateEdgeInfo("エッジ選択: エッジをクリックしてください。");
    }
    if (this.hoveredEdge && !isLayerVisible(this.layerVisibility, this.hoveredEdge.layer)) {
      this.hoveredEdge = null;
    }
  }

  private resetMeasurement(): void {
    this.selectedMeasurePoints = [];
    this.measurementDistance = null;
    this.measurementDeltaX = null;
    this.measurementDeltaY = null;
    this.hoveredVertex = null;
    this.updateMeasurementInfo("距離測定: 2頂点をクリックしてください。");
  }

  private updateMeasurementInfo(message: string): void {
    this.measureInfoEl.textContent = message;
  }

  private modelToCanvas(point: Point): Point {
    return {
      x: point.x * this.viewTransform.scale + this.viewTransform.offsetX,
      y: -point.y * this.viewTransform.scale + this.viewTransform.offsetY,
    };
  }

  private selectMeasureVertex(event: PointerLikeEvent): void {
    const nearest = this.findNearestVertexFromPointerEvent(event);
    if (!nearest) {
      this.updateMeasurementInfo("距離測定: 頂点付近をクリックしてください。");
      return;
    }

    if (this.selectedMeasurePoints.length >= 2) {
      this.selectedMeasurePoints = [];
      this.measurementDistance = null;
      this.measurementDeltaX = null;
      this.measurementDeltaY = null;
    }

    this.selectedMeasurePoints.push({ x: nearest.x, y: nearest.y });

    if (this.selectedMeasurePoints.length === 2) {
      const [a, b] = this.selectedMeasurePoints;
      this.measurementDeltaX = b.x - a.x;
      this.measurementDeltaY = b.y - a.y;
      this.measurementDistance = Math.hypot(b.x - a.x, b.y - a.y);
      this.updateMeasurementInfo(
        `距離: ${this.measurementDistance.toFixed(3)} (ΔX: ${this.measurementDeltaX.toFixed(3)}, ΔY: ${this.measurementDeltaY.toFixed(3)})`
      );
    } else {
      this.updateMeasurementInfo("距離測定: 2つ目の頂点をクリックしてください。");
    }

    this.render();
  }

  private selectEdge(event: PointerLikeEvent): void {
    const nearest = this.findNearestEdgeFromPointerEvent(event);
    if (!nearest) {
      this.selectedEdge = null;
      this.updateEdgeInfo("エッジ選択: エッジ付近をクリックしてください。");
      this.render();
      return;
    }
    this.selectedEdge = nearest;
    this.updateEdgeInfo(`選択エッジのレイヤー: ${nearest.layer}`);
    this.render();
  }

  private updateHoveredEdge(event: PointerLikeEvent): void {
    if (!this.hasLoadedDrawing() || this.isDragging) return;
    const nextHovered = this.findNearestEdgeFromPointerEvent(event);
    if (
      this.hoveredEdge?.layer === nextHovered?.layer &&
      this.hoveredEdge?.from?.x === nextHovered?.from?.x &&
      this.hoveredEdge?.from?.y === nextHovered?.from?.y &&
      this.hoveredEdge?.to?.x === nextHovered?.to?.x &&
      this.hoveredEdge?.to?.y === nextHovered?.to?.y
    ) {
      return;
    }
    this.hoveredEdge = nextHovered;
    this.render();
  }

  private updateHoveredVertex(event: PointerLikeEvent): void {
    if (!this.hasLoadedDrawing() || this.isDragging) return;
    const nextHovered = this.findNearestVertexFromPointerEvent(event);
    if (this.hoveredVertex?.x === nextHovered?.x && this.hoveredVertex?.y === nextHovered?.y) {
      return;
    }
    this.hoveredVertex = nextHovered;
    this.render();
  }

  private findNearestVertexFromPointerEvent(event: PointerLikeEvent): Point | null {
    if (!this.selectableVertices.length) return null;
    const canvasRect = this.canvas.getBoundingClientRect();
    const targetX = event.clientX - canvasRect.left;
    const targetY = event.clientY - canvasRect.top;

    let nearest: Point | null = null;
    let nearestDistance = Infinity;

    for (const vertex of this.selectableVertices) {
      const p = this.modelToCanvas(vertex);
      const distance = Math.hypot(p.x - targetX, p.y - targetY);
      if (distance < nearestDistance) {
        nearest = vertex;
        nearestDistance = distance;
      }
    }

    if (!nearest || nearestDistance > this.VERTEX_SNAP_PIXEL) {
      return null;
    }
    return nearest;
  }

  private findNearestEdgeFromPointerEvent(event: PointerLikeEvent): Segment | null {
    const visibleSegments = getVisibleSegments(this.drawSegments, this.layerVisibility);
    if (!visibleSegments.length) return null;

    const canvasRect = this.canvas.getBoundingClientRect();
    const targetX = event.clientX - canvasRect.left;
    const targetY = event.clientY - canvasRect.top;

    let nearest: Segment | null = null;
    let nearestDistance = Infinity;

    for (const segment of visibleSegments) {
      const from = this.modelToCanvas(segment.from);
      const to = this.modelToCanvas(segment.to);
      const distance = distancePointToSegment(targetX, targetY, from.x, from.y, to.x, to.y);
      if (distance < nearestDistance) {
        nearest = segment;
        nearestDistance = distance;
      }
    }

    if (!nearest || nearestDistance > this.EDGE_SNAP_PIXEL) {
      return null;
    }
    return nearest;
  }

  private rebuildSelectableVertices(): void {
    const visibleSegments = getVisibleSegments(this.drawSegments, this.layerVisibility);
    const vertices = computeSelectableVertices(visibleSegments);
    const vertexKeySet = new Set(vertices.map((v) => getVertexKey(v.x, v.y)));
    this.selectableVertices = vertices;
    if (this.hoveredVertex) {
      const key = getVertexKey(this.hoveredVertex.x, this.hoveredVertex.y);
      if (!vertexKeySet.has(key)) {
        this.hoveredVertex = null;
      }
    }
  }

  private resizeCanvas(): void {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    if (this.canvas.width === width && this.canvas.height === height) return;

    this.canvas.width = width;
    this.canvas.height = height;

    if (this.hasLoadedDrawing()) {
      this.render();
    } else {
      this.clearCanvas();
    }
  }

  private getModelCenter(): Point {
    if (!this.bounds) {
      return { x: 0, y: 0 };
    }
    return {
      x: (this.bounds.minX + this.bounds.maxX) / 2,
      y: (this.bounds.minY + this.bounds.maxY) / 2,
    };
  }

  private getCurrentScale(): number {
    return this.baseScale * this.zoomLevel;
  }

  private getViewCenterModel(): Point {
    const scale = this.getCurrentScale();
    const modelCenter = this.getModelCenter();
    return {
      x: modelCenter.x - this.panX / scale,
      y: modelCenter.y + this.panY / scale,
    };
  }

  private applyZoom(zoomFactor: number): void {
    const viewCenter = this.getViewCenterModel();
    const nextZoom = Math.max(this.MIN_ZOOM, Math.min(this.MAX_ZOOM, this.zoomLevel * zoomFactor));
    this.zoomLevel = nextZoom;

    const scale = this.getCurrentScale();
    const modelCenter = this.getModelCenter();
    this.panX = (modelCenter.x - viewCenter.x) * scale;
    this.panY = (viewCenter.y - modelCenter.y) * scale;
    this.render();
  }

  private fitToScreen(): void {
    if (!this.bounds) return;
    const padding = 30;
    const modelW = this.bounds.maxX - this.bounds.minX || 1;
    const modelH = this.bounds.maxY - this.bounds.minY || 1;
    const viewW = Math.max(1, this.canvas.width - padding * 2);
    const viewH = Math.max(1, this.canvas.height - padding * 2);

    const scaleX = viewW / modelW;
    const scaleY = viewH / modelH;
    this.baseScale = Math.min(scaleX, scaleY);
    this.zoomLevel = 1;
    this.panX = 0;
    this.panY = 0;
    this.render();
  }

  private render(): void {
    if (!this.bounds) {
      this.clearCanvas();
      return;
    }
    this.clearCanvas();

    const scale = this.getCurrentScale();
    const { x: centerX, y: centerY } = this.getModelCenter();
    const offsetX = this.canvas.width / 2 - centerX * scale + this.panX;
    const offsetY = this.canvas.height / 2 + centerY * scale + this.panY;

    const toCanvasX = (x: number): number => x * scale + offsetX;
    const toCanvasY = (y: number): number => -y * scale + offsetY;

    this.viewTransform.scale = scale;
    this.viewTransform.offsetX = offsetX;
    this.viewTransform.offsetY = offsetY;

    this.ctx.lineWidth = 1;
    this.ctx.strokeStyle = "#111827";

    const visibleCommands = this.drawCommands.filter((command) =>
      isLayerVisible(this.layerVisibility, command.layer)
    );

    for (const command of visibleCommands) {
      this.ctx.beginPath();
      if (command.type === "line") {
        this.ctx.moveTo(toCanvasX(command.from.x), toCanvasY(command.from.y));
        this.ctx.lineTo(toCanvasX(command.to.x), toCanvasY(command.to.y));
      } else if (command.type === "polyline") {
        const [first, ...rest] = command.vertices;
        this.ctx.moveTo(toCanvasX(first.x), toCanvasY(first.y));
        rest.forEach((v) => this.ctx.lineTo(toCanvasX(v.x), toCanvasY(v.y)));
        if (command.closed) this.ctx.closePath();
      } else if (command.type === "circle") {
        this.ctx.arc(
          toCanvasX(command.center.x),
          toCanvasY(command.center.y),
          command.radius * scale,
          0,
          Math.PI * 2
        );
      } else if (command.type === "arc") {
        this.ctx.arc(
          toCanvasX(command.center.x),
          toCanvasY(command.center.y),
          command.radius * scale,
          -command.end,
          -command.start,
          false
        );
      }
      this.ctx.stroke();
    }

    this.drawEdgeOverlay(toCanvasX, toCanvasY);
    this.drawMeasurementOverlay(toCanvasX, toCanvasY);
  }

  private drawEdgeOverlay(toCanvasX: (x: number) => number, toCanvasY: (y: number) => number): void {
    if (this.hoveredEdge) {
      this.ctx.save();
      this.ctx.lineWidth = 2;
      this.ctx.strokeStyle = "#3b82f6";
      this.ctx.beginPath();
      this.ctx.moveTo(toCanvasX(this.hoveredEdge.from.x), toCanvasY(this.hoveredEdge.from.y));
      this.ctx.lineTo(toCanvasX(this.hoveredEdge.to.x), toCanvasY(this.hoveredEdge.to.y));
      this.ctx.stroke();
      this.ctx.restore();
    }

    if (!this.selectedEdge) return;
    this.ctx.save();
    this.ctx.lineWidth = 3;
    this.ctx.strokeStyle = "#f59e0b";
    this.ctx.beginPath();
    this.ctx.moveTo(toCanvasX(this.selectedEdge.from.x), toCanvasY(this.selectedEdge.from.y));
    this.ctx.lineTo(toCanvasX(this.selectedEdge.to.x), toCanvasY(this.selectedEdge.to.y));
    this.ctx.stroke();
    this.ctx.restore();
  }

  private drawMeasurementOverlay(
    toCanvasX: (x: number) => number,
    toCanvasY: (y: number) => number
  ): void {
    if (this.hoveredVertex) {
      this.ctx.save();
      this.ctx.fillStyle = "#2563eb";
      this.ctx.beginPath();
      this.ctx.arc(toCanvasX(this.hoveredVertex.x), toCanvasY(this.hoveredVertex.y), 5, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.restore();
    }

    if (!this.selectedMeasurePoints.length) return;

    this.ctx.save();
    this.ctx.lineWidth = 1.5;
    this.ctx.fillStyle = "#dc2626";
    this.ctx.strokeStyle = "#dc2626";

    if (this.selectedMeasurePoints.length === 2) {
      const [a, b] = this.selectedMeasurePoints;
      this.ctx.setLineDash([6, 4]);
      this.ctx.beginPath();
      this.ctx.moveTo(toCanvasX(a.x), toCanvasY(a.y));
      this.ctx.lineTo(toCanvasX(b.x), toCanvasY(b.y));
      this.ctx.stroke();
      this.ctx.setLineDash([]);
    }

    for (const point of this.selectedMeasurePoints) {
      this.ctx.beginPath();
      this.ctx.arc(toCanvasX(point.x), toCanvasY(point.y), 5, 0, Math.PI * 2);
      this.ctx.fill();
    }

    this.ctx.restore();
  }
}

new DxfViewerApp();
