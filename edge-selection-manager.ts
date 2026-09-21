import type { Segment } from "./geometry";

export class EdgeSelectionManager {
  private selectedEdge: Segment | null = null;
  private hoveredEdge: Segment | null = null;

  reset(): string {
    this.selectedEdge = null;
    this.hoveredEdge = null;
    return "エッジ選択: エッジをクリックしてください。";
  }

  select(edge: Segment | null): string {
    this.selectedEdge = edge;
    if (!edge) {
      return "エッジ選択: エッジ付近をクリックしてください。";
    }
    return `選択エッジのレイヤー: ${edge.layer}`;
  }

  getSelected(): Segment | null {
    return this.selectedEdge;
  }

  getHovered(): Segment | null {
    return this.hoveredEdge;
  }

  setHovered(edge: Segment | null): void {
    this.hoveredEdge = edge;
  }

  clearHovered(): void {
    this.hoveredEdge = null;
  }

  validateSelection(isVisible: (layerName: string) => boolean): string | null {
    if (this.selectedEdge && !isVisible(this.selectedEdge.layer)) {
      this.selectedEdge = null;
      return "エッジ選択: エッジをクリックしてください。";
    }
    if (this.hoveredEdge && !isVisible(this.hoveredEdge.layer)) {
      this.hoveredEdge = null;
    }
    return null;
  }
}
