import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import {
  dismissRuntimeControlToast,
  pruneRuntimeControlToasts,
  subscribeToRuntimeControlToasts,
  type RuntimeControlToast,
} from "../runtime-control/toast-store";

const TOAST_SEVERITY_BORDER_CLASS: Record<RuntimeControlToast["severity"], string> = {
  success: "border-[var(--runtime-control-toast-success-border)]",
  warning: "border-[var(--runtime-control-toast-warning-border)]",
  error: "border-[var(--runtime-control-toast-error-border)]",
};

const TOAST_STATUS_CLASS: Record<RuntimeControlToast["status"], string> = {
  accepted:
    "border-[var(--runtime-control-toast-status-accepted-border)] bg-[var(--runtime-control-toast-status-accepted-bg)] text-[var(--runtime-control-toast-status-accepted-text)]",
  rejected:
    "border-[var(--runtime-control-toast-status-rejected-border)] bg-[var(--runtime-control-toast-status-rejected-bg)] text-[var(--runtime-control-toast-status-rejected-text)]",
};

const TOAST_STATUS_LABEL: Record<RuntimeControlToast["status"], string> = {
  accepted: "Accepted",
  rejected: "Rejected",
};

export function RuntimeControlToastViewport() {
  const [toasts, setToasts] = createSignal<RuntimeControlToast[]>([]);

  onMount(() => {
    const unsubscribe = subscribeToRuntimeControlToasts((nextToasts) => {
      setToasts(nextToasts);
    });
    const pruneInterval = window.setInterval(() => {
      pruneRuntimeControlToasts();
    }, 1000);

    onCleanup(() => {
      window.clearInterval(pruneInterval);
      unsubscribe();
    });
  });

  return (
    <section
      class="pointer-events-none absolute bottom-[var(--runtime-control-toast-viewport-offset)] left-[var(--runtime-control-toast-viewport-offset)] z-[150] flex w-[min(440px,calc(100%-(var(--runtime-control-toast-viewport-offset)*2)))] flex-col gap-2"
      aria-live="polite"
      aria-atomic="false"
      aria-relevant="additions text"
    >
      <For each={toasts()}>
        {(toast) => (
          <article
            class={`pointer-events-auto flex flex-col gap-[6px] rounded-[11px] border bg-[var(--runtime-control-toast-bg)] px-[11px] py-[10px] shadow-[0_8px_18px_var(--runtime-control-toast-shadow)] [animation:fade-in_150ms_ease] ${TOAST_SEVERITY_BORDER_CLASS[toast.severity]}`}
            role="status"
          >
            <div class="flex items-center gap-2">
              <p class="m-0 text-[12px] font-bold tracking-[0.01em] text-[var(--runtime-control-toast-title)]">{toast.actionLabel}</p>
              <span
                class={`inline-flex h-5 items-center rounded-full border px-[8px] text-[11px] font-bold tracking-[0.01em] ${TOAST_STATUS_CLASS[toast.status]}`}
              >
                {TOAST_STATUS_LABEL[toast.status]}
              </span>
              <Show when={toast.count > 1}>
                <span
                  class="inline-flex h-5 min-w-[26px] items-center justify-center rounded-full border border-[var(--runtime-control-toast-counter-border)] bg-[var(--runtime-control-toast-counter-bg)] px-[6px] text-[11px] font-bold text-[var(--runtime-control-toast-counter-text)]"
                  aria-label={`${toast.count} repeated acknowledgements`}
                >
                  x{toast.count}
                </span>
              </Show>
              <button
                type="button"
                class="ml-auto appearance-none rounded-[7px] border border-[var(--runtime-control-toast-dismiss-border)] bg-[var(--runtime-control-toast-dismiss-bg)] px-2 py-[3px] text-[11.5px] text-[var(--runtime-control-toast-dismiss-text)] transition-colors duration-100 hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--surface-light)]"
                aria-label="Dismiss runtime control acknowledgement"
                onClick={() => dismissRuntimeControlToast(toast.id)}
              >
                Dismiss
              </button>
            </div>
            <p class="m-0 text-[12px] leading-[1.4] text-[var(--runtime-control-toast-message)]">{toast.message}</p>
            <Show when={toast.reasonCode}>
              <p class="m-0 text-[11.5px] leading-[1.35] text-[var(--runtime-control-toast-meta)]">Reason: {toast.reasonCode}</p>
            </Show>
            <Show when={toast.fixHint}>
              <p class="m-0 text-[11.5px] leading-[1.35] text-[var(--runtime-control-toast-meta)]">Fix: {toast.fixHint}</p>
            </Show>
          </article>
        )}
      </For>
    </section>
  );
}
