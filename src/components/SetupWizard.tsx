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
    <section class="grid h-full w-full place-items-center">
      <div class="box-border flex w-[316px] flex-col gap-2.5 rounded-[14px] border border-border-strong bg-surface-panel p-[22px]">
        <div class="mb-0.5 grid h-9 w-9 place-items-center rounded-[9px] border border-border-strong bg-surface-canvas" aria-hidden="true">
          <svg
            class="h-4 w-4 fill-none stroke-text-muted stroke-[1.6] [stroke-linecap:round] [stroke-linejoin:round]"
            viewBox="0 0 24 24"
          >
            <path d="M3 7a2 2 0 0 1 2-2h4.2a2 2 0 0 1 1.4.58L12 7h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
          </svg>
        </div>
        <h1 class="m-0 text-[15px] font-bold tracking-[-0.01em] text-text-strong">Choose your dev folder</h1>
        <p class="m-0 text-[13px] leading-[1.45] text-text-body">
          Select the root directory where you keep local projects.
        </p>

        <Show when={setupError()}>
          {(error) => (
            <p
              class="m-0 rounded-lg border border-status-danger-border bg-status-danger-surface px-2.5 py-[7px] text-xs leading-[1.4] text-status-danger-ink"
              role="alert"
            >
              {error()}
            </p>
          )}
        </Show>

        <button
          type="button"
          class="mt-1 box-border flex w-full items-center gap-[7px] rounded-[9px] border border-border-strong bg-surface-canvas px-[11px] py-[9px] text-left text-[13px] font-medium text-text-body transition-colors duration-150 hover:text-text-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-strong disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => void browseForFolder()}
          disabled={isPickingFolder()}
        >
          <svg
            class="h-[13px] w-[13px] shrink-0 fill-none stroke-current stroke-[1.7] [stroke-linecap:round] [stroke-linejoin:round]"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path d="M3 7a2 2 0 0 1 2-2h4.2a2 2 0 0 1 1.4.58L12 7h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
          </svg>
          {isPickingFolder() ? "Opening…" : pendingFolder() ? "Change folder" : "Select Folder"}
        </button>

        <Show when={pendingFolder()}>
          {(folder) => (
            <code class="block break-all rounded-lg border border-border-strong bg-surface-canvas px-2.5 py-2 font-mono text-[11.5px] leading-[1.45] text-text-body">
              {folder()}
            </code>
          )}
        </Show>

        <Show when={pendingFolder()}>
          <button
            type="button"
            class="mt-0.5 box-border w-full rounded-[9px] border border-border-strong bg-surface-elevated px-[14px] py-[9px] text-[13px] font-semibold text-text-strong transition-colors duration-150 hover:bg-surface-panel focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-strong disabled:cursor-not-allowed disabled:opacity-50"
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
