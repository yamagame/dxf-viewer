import { normalizeLayerName, type Segment } from "./geometry";
import type { DrawCommand } from "./drawing-model";

export class LayerController {
  private layerNames: string[] = [];
  private visibility = new Map<string, boolean>();

  clear(): void {
    this.layerNames = [];
    this.visibility = new Map();
  }

  setLayers(layers: string[]): void {
    this.layerNames = [...layers];
    this.visibility = new Map();
    this.layerNames.forEach((layer) => {
      this.visibility.set(layer, true);
    });
  }

  getLayerNames(): string[] {
    return this.layerNames;
  }

  isVisible(layerName: unknown): boolean {
    if (!this.visibility.size) return true;
    return this.visibility.get(normalizeLayerName(layerName)) !== false;
  }

  setVisible(layer: string, visible: boolean): void {
    this.visibility.set(layer, visible);
  }

  filterVisibleSegments(segments: Segment[]): Segment[] {
    return segments.filter((segment) => this.isVisible(segment.layer));
  }

  filterVisibleCommands(commands: DrawCommand[]): DrawCommand[] {
    return commands.filter((command) => this.isVisible(command.layer));
  }
}
