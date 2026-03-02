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
    <section class="setup-shell">
      <div class="setup-panel">
        <div class="setup-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M3 7a2 2 0 0 1 2-2h4.2a2 2 0 0 1 1.4.58L12 7h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
          </svg>
        </div>
        <h1 class="setup-title">Choose your dev folder</h1>
        <p class="setup-subtitle">Select the root directory where you keep local projects.</p>

        <Show when={setupError()}>
          {(error) => (
            <p class="setup-error" role="alert">
              {error()}
            </p>
          )}
        </Show>

        <button
          type="button"
          class="setup-pick-btn"
          onClick={() => void browseForFolder()}
          disabled={isPickingFolder()}
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M3 7a2 2 0 0 1 2-2h4.2a2 2 0 0 1 1.4.58L12 7h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
          </svg>
          {isPickingFolder() ? "Opening…" : pendingFolder() ? "Change folder" : "Select Folder"}
        </button>

        <Show when={pendingFolder()}>
          {(folder) => <code class="setup-path">{folder()}</code>}
        </Show>

        <Show when={pendingFolder()}>
          <button
            type="button"
            class="setup-confirm-btn"
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
