export interface UILayoutState {
  version: number;
  accordions: Record<string, boolean>;
  panelOrder: string[] | null;
}

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
      };
    }
  } catch {
    // Missing or unavailable storage uses defaults.
  }
  return { version: VERSION, accordions: {}, panelOrder: null };
}

function isUILayoutState(value: unknown): value is UILayoutState {
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
