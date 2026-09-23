import type { Point, Segment } from "./geometry";
import type { DrawCommand } from "./drawing-model";
import type { ViewTransform } from "./viewport-controller";

type OverlayState = {
  hoveredEdge: Segment | null;
  selectedEdge: Segment | null;
  hoveredVertex: Point | null;
  selectedMeasurePoints: Point[];
  selectedText: Extract<DrawCommand, { type: "text" }> | null;
};

export class CanvasRenderer {
  constructor(private readonly ctx: CanvasRenderingContext2D) {}

  clear(canvas: HTMLCanvasElement): void {
    this.ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  render(
    canvas: HTMLCanvasElement,
    commands: DrawCommand[],
    transform: ViewTransform,
    overlays: OverlayState
  ): void {
    this.clear(canvas);

    const toCanvasX = (x: number): number => x * transform.scale + transform.offsetX;
    const toCanvasY = (y: number): number => -y * transform.scale + transform.offsetY;

    this.ctx.lineWidth = 1;
    this.ctx.strokeStyle = "#111827";

    for (const command of commands) {
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
          command.radius * transform.scale,
          0,
          Math.PI * 2
        );
      } else if (command.type === "arc") {
        this.ctx.arc(
          toCanvasX(command.center.x),
          toCanvasY(command.center.y),
          command.radius * transform.scale,
          -command.end,
          -command.start,
          false
        );
      } else if (command.type === "text") {
        this.ctx.save();
        this.ctx.translate(toCanvasX(command.position.x), toCanvasY(command.position.y));
        this.ctx.rotate(-command.rotation);
        this.ctx.fillStyle = overlays.selectedText === command ? "#2563eb" : "#111827";
        this.ctx.font = `${Math.max(1, command.height * transform.scale)}px sans-serif`;
        this.ctx.textBaseline = "alphabetic";
        this.ctx.fillText(command.text.replace(/\\P/g, "\n"), 0, 0);
        this.ctx.restore();
        continue;
      }
      this.ctx.stroke();
    }

    this.drawEdgeOverlay(toCanvasX, toCanvasY, overlays.hoveredEdge, overlays.selectedEdge);
    this.drawMeasurementOverlay(
      toCanvasX,
      toCanvasY,
      overlays.hoveredVertex,
      overlays.selectedMeasurePoints
    );
  }

  private drawEdgeOverlay(
    toCanvasX: (x: number) => number,
    toCanvasY: (y: number) => number,
    hoveredEdge: Segment | null,
    selectedEdge: Segment | null
  ): void {
    if (hoveredEdge) {
      this.ctx.save();
      this.ctx.lineWidth = 2;
      this.ctx.strokeStyle = "#3b82f6";
      this.ctx.beginPath();
      this.ctx.moveTo(toCanvasX(hoveredEdge.from.x), toCanvasY(hoveredEdge.from.y));
      this.ctx.lineTo(toCanvasX(hoveredEdge.to.x), toCanvasY(hoveredEdge.to.y));
      this.ctx.stroke();
      this.ctx.restore();
    }

    if (!selectedEdge) return;
    this.ctx.save();
    this.ctx.lineWidth = 3;
    this.ctx.strokeStyle = "#f59e0b";
    this.ctx.beginPath();
    this.ctx.moveTo(toCanvasX(selectedEdge.from.x), toCanvasY(selectedEdge.from.y));
    this.ctx.lineTo(toCanvasX(selectedEdge.to.x), toCanvasY(selectedEdge.to.y));
    this.ctx.stroke();
    this.ctx.restore();
  }

  private drawMeasurementOverlay(
    toCanvasX: (x: number) => number,
    toCanvasY: (y: number) => number,
    hoveredVertex: Point | null,
    selectedMeasurePoints: Point[]
  ): void {
    if (hoveredVertex) {
      this.ctx.save();
      this.ctx.fillStyle = "#2563eb";
      this.ctx.beginPath();
      this.ctx.arc(toCanvasX(hoveredVertex.x), toCanvasY(hoveredVertex.y), 5, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.restore();
    }

    if (!selectedMeasurePoints.length) return;

    this.ctx.save();
    this.ctx.lineWidth = 1.5;
    this.ctx.fillStyle = "#dc2626";
    this.ctx.strokeStyle = "#dc2626";

    if (selectedMeasurePoints.length === 2) {
      const [a, b] = selectedMeasurePoints;
      this.ctx.setLineDash([6, 4]);
      this.ctx.beginPath();
      this.ctx.moveTo(toCanvasX(a.x), toCanvasY(a.y));
      this.ctx.lineTo(toCanvasX(b.x), toCanvasY(b.y));
      this.ctx.stroke();
      this.ctx.setLineDash([]);
    }

    for (const point of selectedMeasurePoints) {
      this.ctx.beginPath();
      this.ctx.arc(toCanvasX(point.x), toCanvasY(point.y), 5, 0, Math.PI * 2);
      this.ctx.fill();
    }

    this.ctx.restore();
  }
}
