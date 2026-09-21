import type { Point } from "./geometry";
import type { Bounds } from "./drawing-model";

type PanState = {
  active: boolean;
  startX: number;
  startY: number;
  startPanX: number;
  startPanY: number;
  didDrag: boolean;
};

export type ViewTransform = { scale: number; offsetX: number; offsetY: number };

export class ViewportController {
  private bounds: Bounds | null = null;
  private zoomLevel = 1;
  private baseScale = 1;
  private panX = 0;
  private panY = 0;
  private pan: PanState = {
    active: false,
    startX: 0,
    startY: 0,
    startPanX: 0,
    startPanY: 0,
    didDrag: false,
  };

  constructor(
    private readonly minZoom: number,
    private readonly maxZoom: number
  ) {}

  clear(): void {
    this.bounds = null;
    this.zoomLevel = 1;
    this.baseScale = 1;
    this.panX = 0;
    this.panY = 0;
    this.pan.active = false;
    this.pan.didDrag = false;
  }

  setBounds(bounds: Bounds | null): void {
    this.bounds = bounds;
  }

  hasBounds(): boolean {
    return this.bounds !== null;
  }

  beginPan(clientX: number, clientY: number): void {
    this.pan.active = true;
    this.pan.startX = clientX;
    this.pan.startY = clientY;
    this.pan.startPanX = this.panX;
    this.pan.startPanY = this.panY;
    this.pan.didDrag = false;
  }

  updatePan(clientX: number, clientY: number): void {
    if (!this.pan.active) return;
    const deltaX = clientX - this.pan.startX;
    const deltaY = clientY - this.pan.startY;
    if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) {
      this.pan.didDrag = true;
    }
    this.panX = this.pan.startPanX + deltaX;
    this.panY = this.pan.startPanY + deltaY;
  }

  endPan(): boolean {
    const didDrag = this.pan.didDrag;
    this.pan.active = false;
    this.pan.didDrag = false;
    return didDrag;
  }

  fitToScreen(canvasWidth: number, canvasHeight: number, padding: number): void {
    if (!this.bounds) return;
    const modelW = this.bounds.maxX - this.bounds.minX || 1;
    const modelH = this.bounds.maxY - this.bounds.minY || 1;
    const viewW = Math.max(1, canvasWidth - padding * 2);
    const viewH = Math.max(1, canvasHeight - padding * 2);
    const scaleX = viewW / modelW;
    const scaleY = viewH / modelH;
    this.baseScale = Math.min(scaleX, scaleY);
    this.zoomLevel = 1;
    this.panX = 0;
    this.panY = 0;
  }

  applyZoom(zoomFactor: number): void {
    if (!this.bounds) return;
    const viewCenter = this.getViewCenterModel();
    this.zoomLevel = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoomLevel * zoomFactor));

    const scale = this.getCurrentScale();
    const modelCenter = this.getModelCenter();
    this.panX = (modelCenter.x - viewCenter.x) * scale;
    this.panY = (viewCenter.y - modelCenter.y) * scale;
  }

  getTransform(canvasWidth: number, canvasHeight: number): ViewTransform {
    const scale = this.getCurrentScale();
    const center = this.getModelCenter();
    return {
      scale,
      offsetX: canvasWidth / 2 - center.x * scale + this.panX,
      offsetY: canvasHeight / 2 + center.y * scale + this.panY,
    };
  }

  private getCurrentScale(): number {
    return this.baseScale * this.zoomLevel;
  }

  private getModelCenter(): Point {
    if (!this.bounds) return { x: 0, y: 0 };
    return {
      x: (this.bounds.minX + this.bounds.maxX) / 2,
      y: (this.bounds.minY + this.bounds.maxY) / 2,
    };
  }

  private getViewCenterModel(): Point {
    const scale = this.getCurrentScale();
    const center = this.getModelCenter();
    return {
      x: center.x - this.panX / scale,
      y: center.y + this.panY / scale,
    };
  }
}
