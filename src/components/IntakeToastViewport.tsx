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
      class="intake-toast-viewport"
      aria-live="polite"
      aria-atomic="false"
      aria-relevant="additions text"
    >
      <For each={toasts()}>
        {(toast) => (
          <article class="intake-toast-card" role="status">
            <div class="intake-toast-header">
              <p class="intake-toast-title">Intake rejected</p>
              <Show when={toast.count > 1}>
                <span class="intake-toast-count" aria-label={`${toast.count} repeated attempts`}>
                  x{toast.count}
                </span>
              </Show>
              <button
                type="button"
                class="intake-toast-dismiss"
                aria-label="Dismiss intake rejection message"
                onClick={() => dismissIntakeToast(toast.id)}
              >
                Dismiss
              </button>
            </div>
            <p class="intake-toast-rule">{toast.violatedRule}</p>
            <p class="intake-toast-hint">Fix: {toast.fixHint}</p>
          </article>
        )}
      </For>
    </section>
  );
}
