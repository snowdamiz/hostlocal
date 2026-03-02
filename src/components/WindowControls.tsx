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
    <div
      class="window-controls absolute z-[120] m-1 hidden items-center [html[data-platform='macos']_&]:top-3 [html[data-platform='macos']_&]:left-[14px] [html[data-platform='macos']_&]:flex [html[data-platform='macos']_&]:gap-2 [html[data-platform='non-macos']_&]:right-0 [html[data-platform='non-macos']_&]:top-0 [html[data-platform='non-macos']_&]:flex [html[data-platform='non-macos']_&]:gap-0"
      aria-label="Window controls"
    >
      <button
        type="button"
        aria-label="Close window"
        class="window-control window-control-close appearance-none border-none bg-transparent p-0 transition-colors [html[data-platform='macos']_&]:inline-block [html[data-platform='macos']_&]:h-[14px] [html[data-platform='macos']_&]:w-[14px] [html[data-platform='macos']_&]:rounded-full [html[data-platform='macos']_&]:border [html[data-platform='macos']_&]:border-border-strong [html[data-platform='macos']_&]:bg-surface-elevated [html[data-platform='non-macos']_&]:inline-flex [html[data-platform='non-macos']_&]:h-[var(--drag-region-height)] [html[data-platform='non-macos']_&]:w-[46px] [html[data-platform='non-macos']_&]:items-center [html[data-platform='non-macos']_&]:justify-center [html[data-platform='non-macos']_&]:text-base [html[data-platform='non-macos']_&]:leading-none [html[data-platform='non-macos']_&]:text-text-muted [html[data-platform='non-macos']_&]:hover:bg-surface-panel [html[data-platform='non-macos']_&]:hover:text-text-strong"
        onClick={() => void runWindowAction(() => appWindow.close())}
      />
      <button
        type="button"
        aria-label="Minimize window"
        class="window-control window-control-minimize appearance-none border-none bg-transparent p-0 transition-colors [html[data-platform='macos']_&]:inline-block [html[data-platform='macos']_&]:h-[14px] [html[data-platform='macos']_&]:w-[14px] [html[data-platform='macos']_&]:rounded-full [html[data-platform='macos']_&]:border [html[data-platform='macos']_&]:border-border-strong [html[data-platform='macos']_&]:bg-surface-elevated [html[data-platform='non-macos']_&]:inline-flex [html[data-platform='non-macos']_&]:h-[var(--drag-region-height)] [html[data-platform='non-macos']_&]:w-[46px] [html[data-platform='non-macos']_&]:items-center [html[data-platform='non-macos']_&]:justify-center [html[data-platform='non-macos']_&]:text-base [html[data-platform='non-macos']_&]:leading-none [html[data-platform='non-macos']_&]:text-text-muted [html[data-platform='non-macos']_&]:hover:bg-surface-panel [html[data-platform='non-macos']_&]:hover:text-text-strong"
        onClick={() => void runWindowAction(() => appWindow.minimize())}
      />
      <button
        type="button"
        aria-label="Toggle maximize window"
        class="window-control window-control-maximize appearance-none border-none bg-transparent p-0 transition-colors [html[data-platform='macos']_&]:inline-block [html[data-platform='macos']_&]:h-[14px] [html[data-platform='macos']_&]:w-[14px] [html[data-platform='macos']_&]:rounded-full [html[data-platform='macos']_&]:border [html[data-platform='macos']_&]:border-border-strong [html[data-platform='macos']_&]:bg-surface-elevated [html[data-platform='non-macos']_&]:inline-flex [html[data-platform='non-macos']_&]:h-[var(--drag-region-height)] [html[data-platform='non-macos']_&]:w-[46px] [html[data-platform='non-macos']_&]:items-center [html[data-platform='non-macos']_&]:justify-center [html[data-platform='non-macos']_&]:text-base [html[data-platform='non-macos']_&]:leading-none [html[data-platform='non-macos']_&]:text-text-muted [html[data-platform='non-macos']_&]:hover:bg-surface-panel [html[data-platform='non-macos']_&]:hover:text-text-strong"
        onClick={() => void runWindowAction(() => appWindow.toggleMaximize())}
      />
    </div>
  );
}
