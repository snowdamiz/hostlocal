import { getCurrentWindow } from "@tauri-apps/api/window";

const appWindow = getCurrentWindow();

async function runWindowAction(action: () => Promise<void>) {
  try {
    await action();
  } catch (error) {
    console.error("Window action failed", error);
  }
}

export function WindowControls() {
  return (
    <div class="window-controls" aria-label="Window controls">
      <button
        type="button"
        aria-label="Close window"
        class="window-control window-control-close"
        onClick={() => void runWindowAction(() => appWindow.close())}
      />
      <button
        type="button"
        aria-label="Minimize window"
        class="window-control window-control-minimize"
        onClick={() => void runWindowAction(() => appWindow.minimize())}
      />
      <button
        type="button"
        aria-label="Toggle maximize window"
        class="window-control window-control-maximize"
        onClick={() => void runWindowAction(() => appWindow.toggleMaximize())}
      />
    </div>
  );
}
