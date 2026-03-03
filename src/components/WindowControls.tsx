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
    <div class="window-controls absolute z-[120] m-1 hidden items-center" aria-label="Window controls">
      <button
        type="button"
        aria-label="Close window"
        class="window-control window-control-close cursor-pointer appearance-none border-0 bg-transparent p-0 transition-[background-color,border-color,color] duration-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--surface-light)]"
        onClick={() => void runWindowAction(() => appWindow.close())}
      />
      <button
        type="button"
        aria-label="Minimize window"
        class="window-control window-control-minimize cursor-pointer appearance-none border-0 bg-transparent p-0 transition-[background-color,border-color,color] duration-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--surface-light)]"
        onClick={() => void runWindowAction(() => appWindow.minimize())}
      />
      <button
        type="button"
        aria-label="Toggle maximize window"
        class="window-control window-control-maximize cursor-pointer appearance-none border-0 bg-transparent p-0 transition-[background-color,border-color,color] duration-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--surface-light)]"
        onClick={() => void runWindowAction(() => appWindow.toggleMaximize())}
      />
    </div>
  );
}
