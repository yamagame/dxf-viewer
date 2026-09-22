import DxfParser from "dxf-parser";
import { getVertexKey, type Point, type Segment } from "./geometry";
import { extractDrawData, type DrawCommand } from "./drawing-model";
import { LayerController } from "./layer-controller";
import { MeasurementManager } from "./measurement-manager";
import { EdgeSelectionManager } from "./edge-selection-manager";
import { ViewportController } from "./viewport-controller";
import { SelectionController } from "./selection-controller";
import { CanvasRenderer } from "./canvas-renderer";

type PointerLikeEvent = { clientX: number; clientY: number };

function getRequiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Required element not found: #${id}`);
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

  private readonly layerController = new LayerController();
  private readonly measurementManager = new MeasurementManager();
  private readonly edgeSelectionManager = new EdgeSelectionManager();
  private readonly viewportController = new ViewportController(0.2, 20);
  private readonly selectionController = new SelectionController(12, 8);
  private readonly renderer = new CanvasRenderer(this.ctx);

  private drawCommands: DrawCommand[] = [];
  private drawSegments: Segment[] = [];
  private isShiftPressed = false;
  private isDragging = false;
  private isPanByMiddleButton = false;
  private activePointerId: number | null = null;
  private suppressNextClick = false;

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

  private hasLoadedDrawing(): boolean {
    return this.drawCommands.length > 0 && this.viewportController.hasBounds();
  }

  private setZoomControlsEnabled(enabled: boolean): void {
    this.fitButton.disabled = !enabled;
    this.zoomInButton.disabled = !enabled;
    this.zoomOutButton.disabled = !enabled;
  }

  private resetLoadedDataState(): void {
    this.drawCommands = [];
    this.drawSegments = [];
    this.layerController.clear();
    this.selectionController.clear();
    this.viewportController.clear();
    this.resetEdgeSelection();
    this.renderLayerControls();
    this.resetMeasurement();
    this.updatePanAvailabilityClass();
  }

  private updatePanAvailabilityClass(): void {
    const canPan = this.isShiftPressed && this.hasLoadedDrawing();
    this.canvas.classList.toggle("is-pan-ready", canPan);
  }

  private clearCanvas(): void {
    this.renderer.clear(this.canvas);
  }

  private modelToCanvas = (point: Point): Point => {
    const transform = this.viewportController.getTransform(this.canvas.width, this.canvas.height);
    return {
      x: point.x * transform.scale + transform.offsetX,
      y: -point.y * transform.scale + transform.offsetY,
    };
  };

  private getVisibleSegments(): Segment[] {
    return this.layerController.filterVisibleSegments(this.drawSegments);
  }

  private rebuildSelectableVertices(): void {
    this.selectionController.rebuildSelectableVertices(this.getVisibleSegments());
  }

  private resetEdgeSelection(): void {
    this.updateEdgeInfo(this.edgeSelectionManager.reset());
  }

  private updateEdgeInfo(message: string): void {
    if (!this.edgeInfoEl) return;
    this.edgeInfoEl.textContent = message;
  }

  private validateEdgeSelection(): void {
    const message = this.edgeSelectionManager.validateSelection((layerName) =>
      this.layerController.isVisible(layerName)
    );
    if (message) this.updateEdgeInfo(message);
  }

  private resetMeasurement(): void {
    this.selectionController.clearHoveredVertex();
    this.measureInfoEl.textContent = this.measurementManager.reset();
  }

  private renderLayerControls(): void {
    this.layerControlsEl.innerHTML = "";
    const layerNames = this.layerController.getLayerNames();
    if (!layerNames.length) {
      const empty = document.createElement("span");
      empty.textContent = "レイヤー: ファイル読込後に表示";
      this.layerControlsEl.appendChild(empty);
      return;
    }

    layerNames.forEach((layer) => {
      const label = document.createElement("label");
      label.className = "layer-item";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = this.layerController.isVisible(layer);
      checkbox.addEventListener("change", () => {
        this.layerController.setVisible(layer, checkbox.checked);
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

  private render(): void {
    if (!this.viewportController.hasBounds()) {
      this.clearCanvas();
      return;
    }
    const transform = this.viewportController.getTransform(this.canvas.width, this.canvas.height);
    const visibleCommands = this.layerController.filterVisibleCommands(this.drawCommands);
    this.renderer.render(this.canvas, visibleCommands, transform, {
      hoveredEdge: this.edgeSelectionManager.getHovered(),
      selectedEdge: this.edgeSelectionManager.getSelected(),
      hoveredVertex: this.selectionController.getHoveredVertex(),
      selectedMeasurePoints: this.measurementManager.getSelectedPoints(),
    });
  }

  private resizeCanvas(): void {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    if (this.hasLoadedDrawing()) this.render();
    else this.clearCanvas();
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
    if (event.code === "Equal" || event.code === "NumpadAdd") {
      event.preventDefault();
      this.viewportController.applyZoom(1.2);
      this.render();
    } else if (event.code === "Minus" || event.code === "NumpadSubtract") {
      event.preventDefault();
      this.viewportController.applyZoom(1 / 1.2);
      this.render();
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
      this.layerController.setLayers(extracted.layers);
      this.viewportController.setBounds(extracted.bounds);

      this.renderLayerControls();
      this.rebuildSelectableVertices();
      this.resetMeasurement();
      this.viewportController.fitToScreen(this.canvas.width, this.canvas.height, 30);
      this.setZoomControlsEnabled(true);
      this.updatePanAvailabilityClass();
      this.render();

      this.statusEl.textContent = `表示完了: ${file.name} (${this.drawCommands.length}要素, ${this.layerController.getLayerNames().length}レイヤー)`;
    } catch (error) {
      console.error(error);
      this.updatePanAvailabilityClass();
      this.statusEl.textContent = "DXFの解析に失敗しました。ファイル形式を確認してください。";
    }
  };

  private readonly onFitClick = (): void => {
    if (!this.hasLoadedDrawing()) return;
    this.viewportController.fitToScreen(this.canvas.width, this.canvas.height, 30);
    this.render();
  };

  private readonly onZoomInClick = (): void => {
    if (!this.hasLoadedDrawing()) return;
    this.viewportController.applyZoom(1.2);
    this.render();
  };

  private readonly onZoomOutClick = (): void => {
    if (!this.hasLoadedDrawing()) return;
    this.viewportController.applyZoom(1 / 1.2);
    this.render();
  };

  private endDrag(): void {
    if (!this.isDragging) return;
    const didDrag = this.viewportController.endPan();
    this.suppressNextClick = didDrag && !this.isPanByMiddleButton;
    this.isDragging = false;
    this.isPanByMiddleButton = false;
    if (this.activePointerId !== null && this.canvas.hasPointerCapture(this.activePointerId)) {
      this.canvas.releasePointerCapture(this.activePointerId);
    }
    this.activePointerId = null;
    this.canvas.classList.remove("is-dragging");
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.hasLoadedDrawing()) return;
    const panByMiddleButton = event.button === 1;
    const panByShiftDrag = event.button === 0 && event.shiftKey;
    if (!panByMiddleButton && !panByShiftDrag) return;

    this.isDragging = true;
    this.isPanByMiddleButton = panByMiddleButton;
    this.activePointerId = event.pointerId;
    this.viewportController.beginPan(event.clientX, event.clientY);
    event.preventDefault();
    this.canvas.setPointerCapture(event.pointerId);
    this.canvas.classList.add("is-dragging");
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.isDragging) {
      const changed = this.selectionController.updateHoveredVertex(
        event,
        this.canvas.getBoundingClientRect(),
        this.modelToCanvas
      );
      const nextHoveredEdge = this.selectionController.findNearestEdge(
        this.getVisibleSegments(),
        event,
        this.canvas.getBoundingClientRect(),
        this.modelToCanvas
      );
      const hoveredEdge = this.edgeSelectionManager.getHovered();
      const sameEdge =
        hoveredEdge?.layer === nextHoveredEdge?.layer &&
        hoveredEdge?.from.x === nextHoveredEdge?.from.x &&
        hoveredEdge?.from.y === nextHoveredEdge?.from.y &&
        hoveredEdge?.to.x === nextHoveredEdge?.to.x &&
        hoveredEdge?.to.y === nextHoveredEdge?.to.y;
      if (!sameEdge) {
        this.edgeSelectionManager.setHovered(nextHoveredEdge);
      }
      if (changed || !sameEdge) {
        this.render();
      }
      return;
    }

    if (event.pointerId !== this.activePointerId) return;
    if (!this.isPanByMiddleButton && !event.shiftKey) {
      this.endDrag();
      this.updatePanAvailabilityClass();
      return;
    }

    this.viewportController.updatePan(event.clientX, event.clientY);
    this.render();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointerId) return;
    this.endDrag();
    this.updatePanAvailabilityClass();
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointerId) return;
    this.endDrag();
    this.edgeSelectionManager.clearHovered();
    this.selectionController.clearHoveredVertex();
    this.render();
    this.updatePanAvailabilityClass();
  };

  private readonly onPointerLeave = (): void => {
    this.edgeSelectionManager.clearHovered();
    this.selectionController.clearHoveredVertex();
    this.render();
  };

  private readonly onCanvasClick = (event: MouseEvent): void => {
    if (!this.hasLoadedDrawing()) return;
    if (event.shiftKey) return;
    if (this.suppressNextClick) {
      this.suppressNextClick = false;
      return;
    }

    const nearestEdge = this.selectionController.findNearestEdge(
      this.getVisibleSegments(),
      event,
      this.canvas.getBoundingClientRect(),
      this.modelToCanvas
    );
    this.updateEdgeInfo(this.edgeSelectionManager.select(nearestEdge));

    const nearestVertex = this.selectionController.findNearestVertex(
      event,
      this.canvas.getBoundingClientRect(),
      this.modelToCanvas
    );
    if (!nearestVertex) {
      this.measureInfoEl.textContent = "距離測定: 頂点付近をクリックしてください。";
      this.render();
      return;
    }
    this.measureInfoEl.textContent = event.altKey
      ? this.measurementManager.advanceSecondPoint(nearestVertex)
      : this.measurementManager.selectPoint(nearestVertex);
    this.render();
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (!this.hasLoadedDrawing()) return;
    event.preventDefault();
    if (this.isDragging) return;
    if (event.deltaY < 0) {
      this.viewportController.applyZoom(1.2);
      this.render();
    } else if (event.deltaY > 0) {
      this.viewportController.applyZoom(1 / 1.2);
      this.render();
    }
  };
}

new DxfViewerApp();
