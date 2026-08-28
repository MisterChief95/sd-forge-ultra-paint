export type ToastKind = "info" | "success" | "error";

export interface Toast {
  readonly id: string;
  readonly kind: ToastKind;
  readonly message: string;
}

const MAX_VISIBLE_TOASTS = 4;
const DEFAULT_DURATION_MS: Record<ToastKind, number> = {
  info: 4_000,
  success: 4_000,
  error: 8_000,
};

function newToastId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `toast-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  );
}

export class ToastStore {
  private _toasts = $state<Toast[]>([]);
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  public get toasts(): readonly Toast[] {
    return this._toasts;
  }

  public info(message: string): string {
    return this.add(message, "info");
  }

  public success(message: string): string {
    return this.add(message, "success");
  }

  public error(message: string): string {
    return this.add(message, "error");
  }

  public dismiss(id: string): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(id);
    this._toasts = this._toasts.filter((toast) => toast.id !== id);
  }

  public clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this._toasts = [];
  }

  private add(message: string, kind: ToastKind): string {
    const id = newToastId();
    const overflow = this._toasts.length - MAX_VISIBLE_TOASTS + 1;
    for (const toast of this._toasts.slice(0, Math.max(0, overflow))) {
      this.dismiss(toast.id);
    }

    this._toasts = [...this._toasts, { id, kind, message }];
    this.timers.set(
      id,
      setTimeout(() => this.dismiss(id), DEFAULT_DURATION_MS[kind]),
    );
    return id;
  }
}

export const toastStore = new ToastStore();
