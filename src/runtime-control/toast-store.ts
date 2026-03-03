export const DEFAULT_RUNTIME_CONTROL_TOAST_DEDUPE_WINDOW_MS = 8_000;
export const DEFAULT_RUNTIME_CONTROL_TOAST_AUTO_DISMISS_MS = 9_000;

export type RuntimeControlToastStatus = "accepted" | "rejected";
export type RuntimeControlToastSeverity = "success" | "warning" | "error";

export interface RuntimeControlToast {
  id: string;
  signature: string;
  action: string;
  actionLabel: string;
  status: RuntimeControlToastStatus;
  severity: RuntimeControlToastSeverity;
  reasonCode: string | null;
  fixHint: string | null;
  message: string;
  count: number;
  createdAtMs: number;
  updatedAtMs: number;
  expiresAtMs: number;
}

export interface RuntimeControlToastInput {
  action: string;
  actionLabel?: string | null;
  status: RuntimeControlToastStatus;
  severity?: RuntimeControlToastSeverity | null;
  reasonCode?: string | null;
  fixHint?: string | null;
  message?: string | null;
}

export interface RuntimeControlToastStoreOptions {
  dedupeWindowMs?: number;
  autoDismissMs?: number;
  now?: () => number;
}

export interface RuntimeControlToastStore {
  getToasts: () => RuntimeControlToast[];
  pushToast: (input: RuntimeControlToastInput) => RuntimeControlToast;
  dismissToast: (toastId: string) => void;
  clearToasts: () => void;
  pruneExpired: (atMs?: number) => void;
  subscribe: (listener: (toasts: RuntimeControlToast[]) => void) => () => void;
}

function normalizeToken(value: string | null | undefined) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeOptionalText(value: string | null | undefined) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toTitleCase(value: string) {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "Control action";
  }

  return trimmed
    .split(/[\s_-]+/g)
    .filter(Boolean)
    .map((segment) => `${segment[0]?.toUpperCase() ?? ""}${segment.slice(1).toLowerCase()}`)
    .join(" ");
}

function resolveActionLabel(input: RuntimeControlToastInput) {
  return normalizeOptionalText(input.actionLabel) ?? toTitleCase(input.action);
}

function resolveSeverity(input: RuntimeControlToastInput): RuntimeControlToastSeverity {
  if (input.severity) {
    return input.severity;
  }

  return input.status === "accepted" ? "success" : "error";
}

function resolveMessage(input: RuntimeControlToastInput, actionLabel: string) {
  return (
    normalizeOptionalText(input.message) ??
    (input.status === "accepted" ? `${actionLabel} accepted.` : `${actionLabel} rejected.`)
  );
}

function resolveReasonCode(input: RuntimeControlToastInput) {
  const normalized = normalizeOptionalText(input.reasonCode);
  if (normalized) {
    return normalized;
  }

  return `${normalizeToken(input.action)}_${input.status}`.replace(/_+/g, "_");
}

function resolveSignature(input: RuntimeControlToastInput, normalized: {
  actionLabel: string;
  severity: RuntimeControlToastSeverity;
  reasonCode: string;
  fixHint: string | null;
  message: string;
}) {
  return [
    normalizeToken(input.action),
    input.status,
    normalized.severity,
    normalizeToken(normalized.actionLabel),
    normalizeToken(normalized.reasonCode),
    normalizeToken(normalized.fixHint),
    normalizeToken(normalized.message),
  ].join("|");
}

function cloneToasts(toasts: RuntimeControlToast[]) {
  return toasts.map((toast) => ({ ...toast }));
}

export function createRuntimeControlToastStore(options: RuntimeControlToastStoreOptions = {}): RuntimeControlToastStore {
  const dedupeWindowMs = options.dedupeWindowMs ?? DEFAULT_RUNTIME_CONTROL_TOAST_DEDUPE_WINDOW_MS;
  const autoDismissMs = options.autoDismissMs ?? DEFAULT_RUNTIME_CONTROL_TOAST_AUTO_DISMISS_MS;
  const getNow = options.now ?? (() => Date.now());

  let sequence = 0;
  let toasts: RuntimeControlToast[] = [];
  const listeners = new Set<(toasts: RuntimeControlToast[]) => void>();

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

  const pushToast = (input: RuntimeControlToastInput) => {
    const nowMs = getNow();
    pruneExpired(nowMs);

    const actionLabel = resolveActionLabel(input);
    const severity = resolveSeverity(input);
    const reasonCode = resolveReasonCode(input);
    const fixHint = normalizeOptionalText(input.fixHint);
    const message = resolveMessage(input, actionLabel);
    const signature = resolveSignature(input, {
      actionLabel,
      severity,
      reasonCode,
      fixHint,
      message,
    });

    const existingIndex = toasts.findIndex(
      (toast) => toast.signature === signature && nowMs - toast.updatedAtMs <= dedupeWindowMs,
    );

    if (existingIndex >= 0) {
      const current = toasts[existingIndex];
      const merged: RuntimeControlToast = {
        ...current,
        count: current.count + 1,
        updatedAtMs: nowMs,
        expiresAtMs: nowMs + autoDismissMs,
      };
      toasts = [...toasts.slice(0, existingIndex), merged, ...toasts.slice(existingIndex + 1)];
      emit();
      return { ...merged };
    }

    const nextToast: RuntimeControlToast = {
      id: `runtime-control-toast-${++sequence}`,
      signature,
      action: input.action,
      actionLabel,
      status: input.status,
      severity,
      reasonCode,
      fixHint,
      message,
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

  const subscribe = (listener: (nextToasts: RuntimeControlToast[]) => void) => {
    listeners.add(listener);
    listener(cloneToasts(toasts));
    return () => {
      listeners.delete(listener);
    };
  };

  const getToasts = () => cloneToasts(toasts);

  return {
    getToasts,
    pushToast,
    dismissToast,
    clearToasts,
    pruneExpired,
    subscribe,
  };
}

export const runtimeControlToastStore = createRuntimeControlToastStore();

export function pushRuntimeControlToast(input: RuntimeControlToastInput) {
  return runtimeControlToastStore.pushToast(input);
}

export function dismissRuntimeControlToast(toastId: string) {
  runtimeControlToastStore.dismissToast(toastId);
}

export function clearRuntimeControlToasts() {
  runtimeControlToastStore.clearToasts();
}

export function pruneRuntimeControlToasts(atMs?: number) {
  runtimeControlToastStore.pruneExpired(atMs);
}

export function subscribeToRuntimeControlToasts(listener: (toasts: RuntimeControlToast[]) => void) {
  return runtimeControlToastStore.subscribe(listener);
}
