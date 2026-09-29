import { deleteStyle, fetchStyles, saveStyle, type PromptStyle } from "../ui/generation/stylesApi";
import { toastStore } from "./toastStore.svelte";

/** Forge prompt styles, shared by the apply menu and the editor modal. */
class StylesStore {
  public styles = $state<PromptStyle[]>([]);

  /** Names of the styles applied (in order) to the prompts at generate time. */
  public selected = $state<string[]>([]);

  private loading = false;

  /** Styles are optional: without a Forge style database the list stays empty (retried on next call). */
  public load(): void {
    if (this.loading) return;
    this.loading = true;
    fetchStyles()
      .then((styles) => {
        this.styles = styles;
        // Drop restored selections whose style no longer exists.
        this.selected = this.selected.filter((name) => styles.some((s) => s.name === name));
      })
      .catch(() => undefined)
      .finally(() => (this.loading = false));
  }

  public toggle(name: string): void {
    this.selected = this.selected.includes(name)
      ? this.selected.filter((candidate) => candidate !== name)
      : [...this.selected, name];
  }

  public deselect(name: string): void {
    this.selected = this.selected.filter((candidate) => candidate !== name);
  }

  /** Create a style, or edit/rename `originalName`. Resolves true on success. */
  public save(style: PromptStyle, originalName?: string): Promise<boolean> {
    return this.run(
      () => saveStyle(style, originalName),
      `Style "${style.name}" saved.`,
      () => {
        if (originalName && originalName !== style.name) {
          this.selected = this.selected.map((name) => (name === originalName ? style.name : name));
        }
      },
    );
  }

  public remove(name: string): Promise<boolean> {
    return this.run(
      () => deleteStyle(name),
      `Style "${name}" deleted.`,
      () => this.deselect(name),
    );
  }

  private async run(
    action: () => Promise<PromptStyle[]>,
    success: string,
    onSuccess: () => void,
  ): Promise<boolean> {
    try {
      this.styles = await action();
      onSuccess();
      toastStore.success(success);
      return true;
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : "Style request failed.");
      return false;
    }
  }
}

export const stylesStore = new StylesStore();
