import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import {
  dismissIntakeToast,
  pruneIntakeToasts,
  subscribeToIntakeToasts,
  type IntakeRejectionToast,
} from "../intake/toast-store";

export function IntakeToastViewport() {
  const [toasts, setToasts] = createSignal<IntakeRejectionToast[]>([]);

  onMount(() => {
    const unsubscribe = subscribeToIntakeToasts((nextToasts) => {
      setToasts(nextToasts);
    });
    const pruneInterval = window.setInterval(() => {
      pruneIntakeToasts();
    }, 1000);

    onCleanup(() => {
      window.clearInterval(pruneInterval);
      unsubscribe();
    });
  });

  return (
    <section
      class="pointer-events-none absolute right-[var(--intake-toast-viewport-offset)] bottom-[var(--intake-toast-viewport-offset)] z-[150] flex w-[min(420px,calc(100%-(var(--intake-toast-viewport-offset)*2)))] flex-col gap-2"
      aria-live="polite"
      aria-atomic="false"
      aria-relevant="additions text"
    >
      <For each={toasts()}>
        {(toast) => (
          <article
            class="pointer-events-auto flex flex-col gap-[5px] rounded-[11px] border border-[var(--intake-toast-border)] bg-[var(--intake-toast-bg)] px-[11px] py-[10px] shadow-[0_8px_18px_var(--intake-toast-shadow)] [animation:fade-in_150ms_ease]"
            role="status"
          >
            <div class="flex items-center gap-2">
              <p class="m-0 text-[12px] font-bold tracking-[0.01em] text-[var(--intake-toast-title)]">Intake rejected</p>
              <Show when={toast.count > 1}>
                <span
                  class="inline-flex h-5 min-w-[26px] items-center justify-center rounded-full border border-[var(--intake-toast-counter-border)] bg-[var(--intake-toast-counter-bg)] px-[6px] text-[11px] font-bold text-[var(--intake-toast-counter-text)]"
                  aria-label={`${toast.count} repeated attempts`}
                >
                  x{toast.count}
                </span>
              </Show>
              <button
                type="button"
                class="ml-auto appearance-none rounded-[7px] border border-[var(--intake-toast-dismiss-border)] bg-[var(--intake-toast-dismiss-bg)] px-2 py-[3px] text-[11.5px] text-[var(--intake-toast-dismiss-text)] transition-colors duration-100 hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--surface-light)]"
                aria-label="Dismiss intake rejection message"
                onClick={() => dismissIntakeToast(toast.id)}
              >
                Dismiss
              </button>
            </div>
            <p class="m-0 text-[12px] leading-[1.4] text-[var(--intake-toast-rule)]">{toast.violatedRule}</p>
            <p class="m-0 text-[11.5px] leading-[1.35] text-[var(--intake-toast-hint)]">Fix: {toast.fixHint}</p>
          </article>
        )}
      </For>
    </section>
  );
}
