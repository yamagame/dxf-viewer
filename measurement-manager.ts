import type { Point } from "./geometry";

export class MeasurementManager {
  private selectedPoints: Point[] = [];

  reset(): string {
    this.selectedPoints = [];
    return "距離測定: 2頂点をクリックしてください。";
  }

  selectPoint(point: Point): string {
    if (this.selectedPoints.length >= 2) {
      this.selectedPoints = [];
    }

    this.selectedPoints.push({ x: point.x, y: point.y });

    if (this.selectedPoints.length === 2) {
      const [a, b] = this.selectedPoints;
      const distance = Math.hypot(b.x - a.x, b.y - a.y);
      const deltaX = b.x - a.x;
      const deltaY = b.y - a.y;
      return `距離: ${distance.toFixed(3)} (ΔX: ${deltaX.toFixed(3)}, ΔY: ${deltaY.toFixed(3)})`;
    }

    return "距離測定: 2つ目の頂点をクリックしてください。";
  }

  getSelectedPoints(): Point[] {
    return this.selectedPoints;
  }
}
