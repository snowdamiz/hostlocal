import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import {
  createProject,
  githubAuthLogout,
  githubAuthPoll,
  githubAuthStart,
  githubAuthStatus,
  githubOpenVerificationUrl,
  listProjects,
  type CreatedProject,
  type GithubDeviceAuthStart,
  type GithubUser,
} from "../lib/commands";

export function MainLayout() {
  const [githubUser, setGithubUser] = createSignal<GithubUser | null>(null);
  const [authError, setAuthError] = createSignal<string | null>(null);
  const [isAuthChecking, setIsAuthChecking] = createSignal(true);
  const [isAuthStarting, setIsAuthStarting] = createSignal(false);
  const [isPollingAuth, setIsPollingAuth] = createSignal(false);
  const [isSigningOut, setIsSigningOut] = createSignal(false);
  const [isCodeCopied, setIsCodeCopied] = createSignal(false);
  const [deviceFlow, setDeviceFlow] = createSignal<GithubDeviceAuthStart | null>(null);
  const [isNewProjectDialogOpen, setIsNewProjectDialogOpen] = createSignal(false);
  const [pendingProjectName, setPendingProjectName] = createSignal("");
  const [newProjectError, setNewProjectError] = createSignal<string | null>(null);
  const [isCreatingProject, setIsCreatingProject] = createSignal(false);
  const [projects, setProjects] = createSignal<CreatedProject[]>([]);
  const [projectListError, setProjectListError] = createSignal<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = createSignal<number | null>(null);

  let pollTimeoutId: number | null = null;
  let newProjectNameInput: HTMLInputElement | undefined;

  const formatInvokeError = (error: unknown, fallback: string) => {
    if (error instanceof Error && error.message) {
      return error.message;
    }

    if (typeof error === "string" && error.trim().length > 0) {
      return error;
    }

    if (error && typeof error === "object" && "message" in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim().length > 0) {
        return message;
      }
    }

    return fallback;
  };

  const clearPollTimer = () => {
    if (pollTimeoutId !== null) {
      window.clearTimeout(pollTimeoutId);
      pollTimeoutId = null;
    }
  };

  const refreshAuthState = async () => {
    setIsAuthChecking(true);
    try {
      const status = await githubAuthStatus();
      setGithubUser(status.user);
    } catch {
      setGithubUser(null);
      setAuthError("Unable to load GitHub connection status.");
    } finally {
      setIsAuthChecking(false);
    }
  };

  const scheduleAuthPoll = (delayMs: number) => {
    clearPollTimer();
    pollTimeoutId = window.setTimeout(() => {
      void pollForGithubAuthorization(delayMs);
    }, delayMs);
  };

  const pollForGithubAuthorization = async (delayMs: number) => {
    if (!deviceFlow()) {
      return;
    }

    setIsPollingAuth(true);

    try {
      const pollResponse = await githubAuthPoll();
      if (pollResponse.status === "authorized") {
        clearPollTimer();
        setAuthError(null);
        setDeviceFlow(null);
        setIsCodeCopied(false);
        await refreshAuthState();
        return;
      }

      if (pollResponse.status === "pending") {
        scheduleAuthPoll(delayMs);
        return;
      }

      if (pollResponse.status === "slow_down") {
        scheduleAuthPoll(delayMs + 5000);
        return;
      }

      clearPollTimer();
      setDeviceFlow(null);
      setIsCodeCopied(false);
      if (pollResponse.status === "denied") {
        setAuthError("GitHub authorization was denied.");
      } else if (pollResponse.status === "expired") {
        setAuthError("GitHub authorization expired. Start again.");
      } else {
        setAuthError("GitHub authorization failed.");
      }
    } catch (error) {
      clearPollTimer();
      setDeviceFlow(null);
      setIsCodeCopied(false);
      setAuthError(formatInvokeError(error, "Unable to complete GitHub authorization."));
    } finally {
      setIsPollingAuth(false);
    }
  };

  const connectGithub = async () => {
    setAuthError(null);
    setIsAuthStarting(true);
    setIsCodeCopied(false);

    try {
      const flow = await githubAuthStart();
      setDeviceFlow(flow);
      scheduleAuthPoll(Math.max(1, flow.intervalSeconds) * 1000);
      try {
        await githubOpenVerificationUrl(flow.verificationUri);
      } catch {
        setAuthError("Could not open browser automatically. Use 'Open verification page'.");
      }
    } catch (error) {
      setAuthError(formatInvokeError(error, "Unable to start GitHub authorization."));
    } finally {
      setIsAuthStarting(false);
    }
  };

  const copyUserCode = async () => {
    const flow = deviceFlow();
    if (!flow) {
      return;
    }

    try {
      await navigator.clipboard.writeText(flow.userCode);
      setIsCodeCopied(true);
      window.setTimeout(() => setIsCodeCopied(false), 1500);
    } catch {
      setAuthError("Could not copy the GitHub code.");
    }
  };

  const signOutGithub = async () => {
    setIsSigningOut(true);
    setAuthError(null);

    try {
      await githubAuthLogout();
      clearPollTimer();
      setDeviceFlow(null);
      setGithubUser(null);
      setIsCodeCopied(false);
    } catch {
      setAuthError("Unable to sign out from GitHub.");
    } finally {
      setIsSigningOut(false);
    }
  };

  const openVerificationPage = async () => {
    const flow = deviceFlow();
    if (!flow) {
      return;
    }

    try {
      await githubOpenVerificationUrl(flow.verificationUri);
    } catch {
      setAuthError("Unable to open the verification page.");
    }
  };

  const selectedProject = () => {
    const projectId = selectedProjectId();
    if (projectId === null) {
      return null;
    }

    return projects().find((project) => project.id === projectId) ?? null;
  };

  const loadProjects = async () => {
    setProjectListError(null);
    try {
      const allProjects = await listProjects();
      setProjects(allProjects);
    } catch {
      setProjectListError("Unable to load projects.");
    }
  };

  const openNewProjectDialog = () => {
    setNewProjectError(null);
    setPendingProjectName("");
    setIsNewProjectDialogOpen(true);
    queueMicrotask(() => newProjectNameInput?.focus());
  };

  const closeNewProjectDialog = () => {
    if (isCreatingProject()) {
      return;
    }

    setNewProjectError(null);
    setPendingProjectName("");
    setIsNewProjectDialogOpen(false);
  };

  const submitCreateProject = async (event: SubmitEvent) => {
    event.preventDefault();

    const projectName = pendingProjectName().trim();
    if (!projectName) {
      setNewProjectError("Project name cannot be empty.");
      return;
    }

    setIsCreatingProject(true);
    setNewProjectError(null);

    try {
      const createdProject = await createProject(projectName);
      setProjects((currentProjects) => [createdProject, ...currentProjects]);
      setIsNewProjectDialogOpen(false);
      setPendingProjectName("");
    } catch (error) {
      setNewProjectError(formatInvokeError(error, "Unable to create project."));
    } finally {
      setIsCreatingProject(false);
    }
  };

  onMount(() => {
    void refreshAuthState();
    void loadProjects();
  });

  onCleanup(() => {
    clearPollTimer();
  });

  return (
    <div class={`layout${selectedProject() ? " layout-with-right-sidebar" : ""}`}>
      <aside class="sidebar sidebar-left">
        <div class="sidebar-actions">
          <button
            type="button"
            class="sidebar-new-project-btn"
            onClick={() => openNewProjectDialog()}
            aria-label="New Project"
            title="New Project"
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M4 7a2 2 0 0 1 2-2h4.2a2 2 0 0 1 1.4.58L13 7h5a2 2 0 0 1 2 2v3" />
              <path d="M8 18h6" />
              <path d="M18 15v6" />
              <path d="M15 18h6" />
            </svg>
            <span>New Project</span>
          </button>
        </div>
        <div class="sidebar-projects-panel">
          <div class="sidebar-projects">
            <Show when={projectListError()}>
              {(error) => (
                <p class="sidebar-projects-error" role="alert">
                  {error()}
                </p>
              )}
            </Show>
            <Show when={projects().length > 0} fallback={<p class="sidebar-projects-empty">No projects yet</p>}>
              <For each={projects()}>
                {(project) => (
                  <button
                    type="button"
                    class={`sidebar-project-item${selectedProjectId() === project.id ? " is-selected" : ""}`}
                    title={project.folderPath}
                    aria-pressed={selectedProjectId() === project.id}
                    onClick={() => setSelectedProjectId(project.id)}
                  >
                    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path d="M3 7a2 2 0 0 1 2-2h4.2a2 2 0 0 1 1.4.58L12 7h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
                    </svg>
                    <p class="sidebar-project-label">
                      <span class="sidebar-project-name-default">{project.name}</span>
                      <span class="sidebar-project-name-hover">{project.folderName}</span>
                    </p>
                  </button>
                )}
              </For>
            </Show>
          </div>
        </div>
        <div class="sidebar-fill" />
        <div class="sidebar-footer">
          <Show when={authError()}>
            {(error) => (
              <p class="sidebar-auth-error" role="alert">
                {error()}
              </p>
            )}
          </Show>

          <Show when={deviceFlow()}>
            {(flow) => (
              <div class="sidebar-device-flow">
                <p class="sidebar-device-title">Confirm on GitHub</p>
                <button
                  type="button"
                  class="sidebar-device-link"
                  onClick={() => void openVerificationPage()}
                >
                  Open verification page
                </button>
                <button type="button" class="sidebar-device-code" onClick={() => void copyUserCode()}>
                  <span>{flow().userCode}</span>
                  <span>{isCodeCopied() ? "Copied" : "Copy"}</span>
                </button>
                <p class="sidebar-device-hint">
                  {isPollingAuth() ? "Checking authorization..." : "Waiting for approval..."}
                </p>
              </div>
            )}
          </Show>

          <Show
            when={githubUser()}
            fallback={
              <button
                type="button"
                class="sidebar-connect-link"
                onClick={() => void connectGithub()}
                disabled={isAuthChecking() || isAuthStarting()}
              >
                {isAuthStarting() ? "Connecting..." : "Connect Github"}
              </button>
            }
          >
            {(user) => (
              <div class="sidebar-github-user">
                <img
                  class="sidebar-github-avatar"
                  src={user().avatarUrl}
                  alt={`${user().login} profile`}
                  loading="lazy"
                />
                <a
                  class="sidebar-github-login"
                  href={user().htmlUrl}
                  target="_blank"
                  rel="noreferrer"
                  title={user().login}
                >
                  {user().login}
                </a>
                <button
                  type="button"
                  class="sidebar-signout-btn"
                  onClick={() => void signOutGithub()}
                  aria-label="Sign out of GitHub"
                  title="Sign out"
                  disabled={isSigningOut()}
                >
                  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M14 7V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-3" />
                    <path d="M10 12h10" />
                    <path d="m17 8 4 4-4 4" />
                  </svg>
                </button>
              </div>
            )}
          </Show>
        </div>
      </aside>
      <section class="content">
        <header class="content-heading">
          <h2>{selectedProject()?.name ?? ""}</h2>
        </header>
      </section>
      <aside class={`sidebar sidebar-right${selectedProject() ? " sidebar-right-visible" : ""}`} />
      <Show when={isNewProjectDialogOpen()}>
        <div class="dialog-backdrop" onClick={() => closeNewProjectDialog()}>
          <div
            class="dialog-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-project-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="new-project-title" class="dialog-title">
              New Project
            </h2>
            <p class="dialog-subtitle">Create a project in your configured development folder.</p>
            <form class="dialog-form" onSubmit={(event) => void submitCreateProject(event)}>
              <label class="dialog-field-label" for="new-project-name">
                Project name
              </label>
              <input
                ref={newProjectNameInput}
                id="new-project-name"
                class="dialog-input"
                type="text"
                placeholder="My Project"
                autocomplete="off"
                value={pendingProjectName()}
                onInput={(event) => setPendingProjectName(event.currentTarget.value)}
                disabled={isCreatingProject()}
              />
              <Show when={newProjectError()}>
                {(error) => (
                  <p class="dialog-error" role="alert">
                    {error()}
                  </p>
                )}
              </Show>
              <div class="dialog-actions">
                <button
                  type="button"
                  class="dialog-cancel-btn"
                  onClick={() => closeNewProjectDialog()}
                  disabled={isCreatingProject()}
                >
                  Cancel
                </button>
                <button type="submit" class="dialog-confirm-btn" disabled={isCreatingProject()}>
                  {isCreatingProject() ? "Creating..." : "Create"}
                </button>
              </div>
            </form>
          </div>
        </div>
      </Show>
    </div>
  );
}
