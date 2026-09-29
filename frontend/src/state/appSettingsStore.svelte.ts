export interface AppSettings {
  tagAutocomplete: boolean;
}

const STORAGE_KEY = "ultra-paint:app-settings";

export class AppSettingsStore {
  private _state = $state<AppSettings>(readStoredSettings());

  public get tagAutocomplete(): boolean {
    return this._state.tagAutocomplete;
  }

  public setTagAutocomplete(enabled: boolean): void {
    this._state.tagAutocomplete = enabled;
    this.persist();
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify($state.snapshot(this._state)));
    } catch {
      // Persistence is optional and must not prevent the UI from working.
    }
  }
}

function readStoredSettings(): AppSettings {
  let stored: Partial<AppSettings> | null = null;
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
  } catch {
    // Missing or unavailable storage uses defaults.
  }
  return { tagAutocomplete: stored?.tagAutocomplete !== false };
}

export const appSettingsStore = new AppSettingsStore();
