/**
 * sd-forge-ultra-paint -- keeps the PixiJS scene graph in sync with the store.
 *
 * `LayerTree` is the only thing that mutates scene-graph structure. It
 * subscribes to `LayerStore` and, on every document change, reconciles:
 *
 *   store `Document`  ->  Map<LayerId, LayerNode>  ->  root `Container`
 *
 * Reconciliation is create / update / destroy rather than teardown-and-rebuild,
 * so textures stay uploaded and PixiJS batching stays warm across edits.
 *
 * STACKING ORDER, the one thing that is easy to get backwards:
 *   - Our schema says index 0 of `layerOrder` / `GroupLayer.children` is the
 *     TOP of the stack (Photoshop convention).
 *   - PixiJS draws children in array order, so the LAST child is drawn on top.
 *   - Therefore the ordered id list is attached in REVERSE.
 */

import { Container } from "pixi.js";

import type { LayerStore, Unsubscribe } from "../state/layerStore.svelte";
import type { Document, Layer, LayerId } from "../state/schema";
import { LayerNode } from "./LayerNode";

export class LayerTree {
  /** The document root. `UltraPaintApp` adds this to `app.stage`. */
  public readonly root: Container;

  private readonly store: LayerStore;

  private readonly nodes = new Map<LayerId, LayerNode>();

  private readonly unsubscribe: Unsubscribe;

  private destroyed = false;

  constructor(store: LayerStore) {
    this.store = store;
    this.root = new Container({ label: "ultra-paint:document-root" });

    this.unsubscribe = store.subscribe((doc) => this.reconcile(doc));
    // Adopt whatever is already in the store (non-empty on re-mount).
    this.reconcile(store.getDocument());
  }

  /** The scene node for a layer, if it currently exists. */
  public getNode(id: LayerId): LayerNode | undefined {
    return this.nodes.get(id);
  }

  /** Number of live scene nodes. Useful for tests and diagnostics. */
  public get nodeCount(): number {
    return this.nodes.size;
  }

  /**
   * Bring the scene graph in line with `doc`.
   *
   * Four passes: destroy removed, create added, update kept, then re-attach
   * everything in document order.
   */
  public reconcile(doc: Document): void {
    if (this.destroyed) return;

    const byId = new Map<LayerId, Layer>();
    for (const layer of doc.layers) byId.set(layer.id, layer);

    // 1. Destroy nodes whose layer is gone.
    for (const [id, node] of [...this.nodes]) {
      if (!byId.has(id)) {
        node.container.removeFromParent();
        node.destroy();
        this.nodes.delete(id);
      }
    }

    // 2/3. Create nodes for new layers, update the ones we keep.
    for (const layer of doc.layers) {
      const existing = this.nodes.get(layer.id);
      if (existing) {
        existing.update(layer);
        continue;
      }
      let texture;
      switch (layer.kind) {
        case "raster":
        case "mask":
        case "control":
          texture = this.store.getTexture(layer.id);
          break;
        case "group":
          texture = undefined;
          break;
        default: {
          const exhaustive: never = layer;
          throw new Error(`[ultra-paint] unsupported layer kind: ${String(exhaustive)}`);
        }
      }
      if (layer.kind !== "group" && !texture) {
        // A paintable layer with no registered texture is a store bug, not
        // a render-time condition. Skip it rather than throwing and
        // leaving the scene graph half-reconciled.
        console.warn(`[ultra-paint] ${layer.kind} layer "${layer.id}" has no texture; skipping`);
        continue;
      }
      this.nodes.set(layer.id, new LayerNode(layer, texture));
    }

    // 4. Re-attach in document order, root first then each group.
    // Mask and regular rows are independent stacks in the UI. Keep every
    // root mask above regular content regardless of which stack changed
    // most recently; order within each filtered stack still follows the
    // document's index-0-is-top convention.
    const rootOrder = [
      ...doc.layerOrder.filter((id) => byId.get(id)?.kind === "mask"),
      ...doc.layerOrder.filter((id) => byId.get(id)?.kind !== "mask"),
    ];
    this.attachOrdered(this.root, rootOrder);
    for (const layer of doc.layers) {
      if (layer.kind !== "group") continue;
      const groupNode = this.nodes.get(layer.id);
      if (!groupNode) continue;
      this.attachOrdered(groupNode.container, layer.children);
    }
  }

  /** Detach every node and drop the subscription. Leaves `root` empty. */
  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    this.unsubscribe();
    for (const node of this.nodes.values()) {
      node.container.removeFromParent();
      node.destroy();
    }
    this.nodes.clear();
    this.root.destroy({ children: false });
  }

  // ------------------------------------------------------------ internals

  /**
   * Attach the containers for `order` into `parent`, bottom-to-top.
   *
   * `addChild` on a child the parent already owns simply moves it to the end,
   * so walking the reversed list appends bottom first and leaves the array in
   * exactly the intended draw order without any index arithmetic.
   */
  private attachOrdered(parent: Container, order: readonly LayerId[]): void {
    for (let i = order.length - 1; i >= 0; i--) {
      const id = order[i];
      if (id === undefined) continue;
      const node = this.nodes.get(id);
      if (!node || node.isDestroyed) continue;
      parent.addChild(node.container);
    }
  }
}
