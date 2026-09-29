export interface UILayoutState {
  version: number;
  accordions: Record<string, boolean>;
  panelOrder: string[] | null;
  sidePanels: Record<SidePanel, SidePanelState>;
}

export type SidePanel = "left" | "right";
export interface SidePanelState {
  collapsed: boolean;
  width: number;
}

export const MIN_SIDE_PANEL_WIDTH = 320;
export const MAX_SIDE_PANEL_WIDTH = 500;

const STORAGE_KEY = "ultra-paint:ui-layout";
const VERSION = 1;

export class UILayoutStore {
  private _state = $state<UILayoutState>(readStoredLayout());

  public getAccordionOpen(id: string, fallback: boolean): boolean {
    return this._state.accordions[id] ?? fallback;
  }

  public setAccordionOpen(id: string, open: boolean): void {
    this._state.accordions[id] = open;
    this.persist();
  }

  public get panelOrder(): string[] | null {
    return this._state.panelOrder ? [...this._state.panelOrder] : null;
  }

  public setPanelOrder(panelOrder: string[] | null): void {
    this._state.panelOrder = panelOrder ? [...panelOrder] : null;
    this.persist();
  }

  public sidePanel(panel: SidePanel): SidePanelState {
    return this._state.sidePanels[panel];
  }

  public setSidePanelCollapsed(panel: SidePanel, collapsed: boolean): void {
    this._state.sidePanels[panel].collapsed = collapsed;
    this.persist();
  }

  public setSidePanelWidth(panel: SidePanel, width: number): void {
    this._state.sidePanels[panel].width = clampSidePanelWidth(width);
    this.persist();
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify($state.snapshot(this._state)));
    } catch {
      // Layout persistence is optional and must not prevent the UI from working.
    }
  }
}

function readStoredLayout(): UILayoutState {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (isUILayoutState(value)) {
      return {
        version: VERSION,
        accordions: { ...value.accordions },
        panelOrder: value.panelOrder ? [...value.panelOrder] : null,
        sidePanels: {
          left: readSidePanel(value.sidePanels?.left),
          right: readSidePanel(value.sidePanels?.right),
        },
      };
    }
  } catch {
    // Missing or unavailable storage uses defaults.
  }
  return {
    version: VERSION,
    accordions: {},
    panelOrder: null,
    sidePanels: { left: readSidePanel(undefined), right: readSidePanel(undefined) },
  };
}

function clampSidePanelWidth(width: number): number {
  return Math.min(MAX_SIDE_PANEL_WIDTH, Math.max(MIN_SIDE_PANEL_WIDTH, width));
}

// `sidePanels` postdates layout version 1, so older stored layouts omit it and
// each field falls back independently instead of invalidating the whole layout.
function readSidePanel(value: Partial<SidePanelState> | undefined): SidePanelState {
  return {
    collapsed: value?.collapsed === true,
    width: clampSidePanelWidth(
      typeof value?.width === "number" && Number.isFinite(value.width)
        ? value.width
        : MIN_SIDE_PANEL_WIDTH,
    ),
  };
}

function isUILayoutState(value: unknown): value is Omit<UILayoutState, "sidePanels"> & {
  sidePanels?: Partial<Record<SidePanel, Partial<SidePanelState>>>;
} {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const accordions = candidate.accordions;
  const panelOrder = candidate.panelOrder;
  return (
    candidate.version === VERSION &&
    typeof accordions === "object" &&
    accordions !== null &&
    !Array.isArray(accordions) &&
    Object.values(accordions).every((open) => typeof open === "boolean") &&
    (panelOrder === null ||
      (Array.isArray(panelOrder) && panelOrder.every((id) => typeof id === "string")))
  );
}

export const uiLayoutStore = new UILayoutStore();
