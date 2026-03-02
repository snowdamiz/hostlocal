import "./App.css";
import { Match, Switch, createSignal, onMount } from "solid-js";
import { MainLayout } from "./components/MainLayout";
import { SetupWizard } from "./components/SetupWizard";
import { WindowControls } from "./components/WindowControls";
import { getDevelopmentFolder } from "./lib/commands";

type SetupStatus = "loading" | "wizard" | "ready";

function App() {
  const [setupStatus, setSetupStatus] = createSignal<SetupStatus>("loading");

  onMount(() => {
    void loadSetupState();
  });

  const loadSetupState = async () => {
    try {
      const folder = await getDevelopmentFolder();
      setSetupStatus(folder ? "ready" : "wizard");
    } catch {
      setSetupStatus("wizard");
    }
  };

  return (
    <main class="relative h-full w-full overflow-hidden rounded-[var(--radius-app-shell)] bg-surface-canvas">
      <div class="absolute inset-x-0 top-0 z-[100] h-[var(--drag-region-height)]" data-tauri-drag-region />
      <WindowControls />
      <Switch>
        <Match when={setupStatus() === "loading"}>
          <section class="grid h-full w-full place-items-center">
            <div class="h-5 w-5 animate-[spin_700ms_linear_infinite] rounded-full border-2 border-border-strong border-t-text-muted" />
          </section>
        </Match>
        <Match when={setupStatus() === "wizard"}>
          <SetupWizard onComplete={() => setSetupStatus("ready")} />
        </Match>
        <Match when={setupStatus() === "ready"}>
          <MainLayout />
        </Match>
      </Switch>
    </main>
  );
}

export default App;
