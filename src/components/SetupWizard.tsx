import { Show, createSignal } from "solid-js";
import { pickDevelopmentFolder, setDevelopmentFolder } from "../lib/commands";

interface SetupWizardProps {
  onComplete: () => void;
}

export function SetupWizard(props: SetupWizardProps) {
  const [pendingFolder, setPendingFolder] = createSignal<string | null>(null);
  const [isPickingFolder, setIsPickingFolder] = createSignal(false);
  const [isSavingSetup, setIsSavingSetup] = createSignal(false);
  const [setupError, setSetupError] = createSignal<string | null>(null);

  const browseForFolder = async () => {
    setSetupError(null);
    setIsPickingFolder(true);

    try {
      const folder = await pickDevelopmentFolder();
      if (folder) {
        setPendingFolder(folder);
      }
    } catch {
      setSetupError("Unable to open folder picker. Please try again.");
    } finally {
      setIsPickingFolder(false);
    }
  };

  const completeSetup = async () => {
    const folder = pendingFolder();
    if (!folder) {
      setSetupError("Choose a development folder before continuing.");
      return;
    }

    setIsSavingSetup(true);
    setSetupError(null);

    try {
      await setDevelopmentFolder(folder);
      props.onComplete();
    } catch {
      setSetupError("Unable to save your folder selection. Please try again.");
    } finally {
      setIsSavingSetup(false);
    }
  };

  return (
    <section class="grid h-full w-full place-items-center px-4">
      <div class="box-border flex w-[316px] flex-col gap-[10px] rounded-[14px] border border-[var(--surface-border)] bg-[var(--surface)] p-[22px]">
        <div
          class="mb-0.5 grid h-9 w-9 place-items-center rounded-[9px] border border-[var(--surface-border)] bg-[var(--app-bg)]"
          aria-hidden="true"
        >
          <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4">
            <path
              class="fill-none stroke-[var(--text-muted)] [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.6]"
              d="M3 7a2 2 0 0 1 2-2h4.2a2 2 0 0 1 1.4.58L12 7h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"
            />
          </svg>
        </div>
        <h1 class="m-0 text-[15px] font-bold tracking-[-0.01em] text-[var(--text-primary)]">Choose your dev folder</h1>
        <p class="m-0 text-[13px] leading-[1.45] text-[var(--text-secondary)]">
          Select the root directory where you keep local projects.
        </p>

        <Show when={setupError()}>
          {(error) => (
            <p class="m-0 rounded-[8px] border border-[var(--error-border)] bg-[var(--error-bg)] px-[10px] py-[7px] text-[12px] leading-[1.4] text-[var(--error-text)]" role="alert">
              {error()}
            </p>
          )}
        </Show>

        <button
          type="button"
          class="mt-1 box-border flex w-full appearance-none items-center gap-[7px] rounded-[9px] border border-[var(--surface-border)] bg-[var(--app-bg)] px-[11px] py-[9px] text-left text-[13px] font-medium text-[var(--text-secondary)] transition-[border-color,color] duration-150 hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--surface-border)] disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => void browseForFolder()}
          disabled={isPickingFolder()}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
            class="h-[13px] w-[13px] shrink-0 fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.7]"
          >
            <path d="M3 7a2 2 0 0 1 2-2h4.2a2 2 0 0 1 1.4.58L12 7h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
          </svg>
          {isPickingFolder() ? "Opening…" : pendingFolder() ? "Change folder" : "Select Folder"}
        </button>

        <Show when={pendingFolder()}>
          {(folder) => (
            <code class="block break-all rounded-[8px] border border-[var(--surface-border)] bg-[var(--app-bg)] px-[10px] py-[8px] font-mono text-[11.5px] leading-[1.45] text-[var(--text-secondary)] [animation:fade-in_150ms_ease]">
              {folder()}
            </code>
          )}
        </Show>

        <Show when={pendingFolder()}>
          <button
            type="button"
            class="mt-0.5 box-border w-full appearance-none rounded-[9px] border border-[var(--surface-border)] bg-[var(--surface-light)] px-[14px] py-[9px] text-[13px] font-semibold text-[var(--text-primary)] transition-[background-color,border-color] duration-150 hover:bg-[var(--surface)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--surface-border)] disabled:cursor-not-allowed disabled:opacity-50 [animation:fade-in_150ms_ease]"
            onClick={() => void completeSetup()}
            disabled={isSavingSetup()}
          >
            {isSavingSetup() ? "Starting…" : "Confirm & Start"}
          </button>
        </Show>
      </div>
    </section>
  );
}
