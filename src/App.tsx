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
    <main class={`app ${setupStatus() === "ready" ? "app-main" : "app-onboarding"}`}>
      <div class="drag-region" data-tauri-drag-region />
      <WindowControls />
      <Switch>
        <Match when={setupStatus() === "loading"}>
          <section class="setup-shell">
            <div class="setup-spinner" />
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
