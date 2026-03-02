import { resolveIntakePolicyReason } from "./policy-reasons";

export const DEFAULT_INTAKE_TOAST_DEDUPE_WINDOW_MS = 8_000;
export const DEFAULT_INTAKE_TOAST_AUTO_DISMISS_MS = 9_000;

export interface IntakeRejectionToast {
  id: string;
  signature: string;
  reasonCode: string;
  violatedRule: string;
  fixHint: string;
  count: number;
  createdAtMs: number;
  updatedAtMs: number;
  expiresAtMs: number;
}

export interface IntakeToastStoreOptions {
  dedupeWindowMs?: number;
  autoDismissMs?: number;
  now?: () => number;
}

export interface IntakeToastStore {
  getToasts: () => IntakeRejectionToast[];
  pushRejectionToast: (reasonCode: string | null | undefined, fixHint?: string | null) => IntakeRejectionToast;
  dismissToast: (toastId: string) => void;
  clearToasts: () => void;
  pruneExpired: (atMs?: number) => void;
  subscribe: (listener: (toasts: IntakeRejectionToast[]) => void) => () => void;
}

function cloneToasts(toasts: IntakeRejectionToast[]) {
  return toasts.map((toast) => ({ ...toast }));
}

export function createIntakeToastStore(options: IntakeToastStoreOptions = {}): IntakeToastStore {
  const dedupeWindowMs = options.dedupeWindowMs ?? DEFAULT_INTAKE_TOAST_DEDUPE_WINDOW_MS;
  const autoDismissMs = options.autoDismissMs ?? DEFAULT_INTAKE_TOAST_AUTO_DISMISS_MS;
  const getNow = options.now ?? (() => Date.now());

  let sequence = 0;
  let toasts: IntakeRejectionToast[] = [];
  const listeners = new Set<(toasts: IntakeRejectionToast[]) => void>();

  const emit = () => {
    const snapshot = cloneToasts(toasts);
    listeners.forEach((listener) => listener(snapshot));
  };

  const pruneExpired = (atMs = getNow()) => {
    const remaining = toasts.filter((toast) => toast.expiresAtMs > atMs);
    if (remaining.length !== toasts.length) {
      toasts = remaining;
      emit();
    }
  };

  const pushRejectionToast = (reasonCode: string | null | undefined, fixHint?: string | null) => {
    const nowMs = getNow();
    pruneExpired(nowMs);

    const resolved = resolveIntakePolicyReason(reasonCode, fixHint);
    const existingIndex = toasts.findIndex(
      (toast) => toast.signature === resolved.signature && nowMs - toast.updatedAtMs <= dedupeWindowMs,
    );

    if (existingIndex >= 0) {
      const current = toasts[existingIndex];
      const merged: IntakeRejectionToast = {
        ...current,
        count: current.count + 1,
        updatedAtMs: nowMs,
        expiresAtMs: nowMs + autoDismissMs,
      };
      toasts = [...toasts.slice(0, existingIndex), merged, ...toasts.slice(existingIndex + 1)];
      emit();
      return { ...merged };
    }

    const nextToast: IntakeRejectionToast = {
      id: `intake-toast-${++sequence}`,
      signature: resolved.signature,
      reasonCode: resolved.reasonCode,
      violatedRule: resolved.violatedRule,
      fixHint: resolved.fixHint,
      count: 1,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      expiresAtMs: nowMs + autoDismissMs,
    };
    toasts = [...toasts, nextToast];
    emit();
    return { ...nextToast };
  };

  const dismissToast = (toastId: string) => {
    const remaining = toasts.filter((toast) => toast.id !== toastId);
    if (remaining.length !== toasts.length) {
      toasts = remaining;
      emit();
    }
  };

  const clearToasts = () => {
    if (toasts.length > 0) {
      toasts = [];
      emit();
    }
  };

  const subscribe = (listener: (nextToasts: IntakeRejectionToast[]) => void) => {
    listeners.add(listener);
    listener(cloneToasts(toasts));
    return () => {
      listeners.delete(listener);
    };
  };

  const getToasts = () => cloneToasts(toasts);

  return {
    getToasts,
    pushRejectionToast,
    dismissToast,
    clearToasts,
    pruneExpired,
    subscribe,
  };
}

export const intakeToastStore = createIntakeToastStore();

export function pushIntakeRejectionToast(reasonCode: string | null | undefined, fixHint?: string | null) {
  return intakeToastStore.pushRejectionToast(reasonCode, fixHint);
}

export function dismissIntakeToast(toastId: string) {
  intakeToastStore.dismissToast(toastId);
}

export function clearIntakeToasts() {
  intakeToastStore.clearToasts();
}

export function pruneIntakeToasts(atMs?: number) {
  intakeToastStore.pruneExpired(atMs);
}

export function subscribeToIntakeToasts(listener: (toasts: IntakeRejectionToast[]) => void) {
  return intakeToastStore.subscribe(listener);
}
