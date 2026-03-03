import { For, Show, type Accessor } from "solid-js";
import { type GithubRepository, type GithubUser } from "../../../lib/commands";

interface RepositorySidebarProps {
  githubUser: Accessor<GithubUser | null>;
  repositories: Accessor<GithubRepository[]>;
  repositoryListError: Accessor<string | null>;
  isRepositoryListLoading: Accessor<boolean>;
  selectedRepositoryId: Accessor<number | null>;
  onSelectRepository: (repositoryId: number) => void;
}

export function RepositorySidebar(props: RepositorySidebarProps) {
  return (
    <div class="sidebar-repositories-panel">
      <div class="sidebar-repositories">
        <Show when={props.repositoryListError()}>
          {(error) => (
            <p class="sidebar-repositories-error" role="alert">
              {error()}
            </p>
          )}
        </Show>
        <Show when={props.githubUser()} fallback={<p class="sidebar-repositories-empty">Connect GitHub to see your repositories.</p>}>
          <Show
            when={!props.isRepositoryListLoading()}
            fallback={<p class="sidebar-repositories-empty">Loading repositories...</p>}
          >
            <Show
              when={props.repositories().length > 0}
              fallback={<p class="sidebar-repositories-empty">No repositories found.</p>}
            >
              <For each={props.repositories()}>
                {(repository) => (
                  <button
                    type="button"
                    class={`sidebar-repository-item${props.selectedRepositoryId() === repository.id ? " is-selected" : ""}`}
                    title={repository.fullName}
                    onClick={() => props.onSelectRepository(repository.id)}
                  >
                    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path d="M5 4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4v-5h6v5h4a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H5Z" />
                      <path d="M9 20v-5h6v5" />
                    </svg>
                    <p class="sidebar-repository-label">
                      <span class="sidebar-repository-name">{repository.name}</span>
                    </p>
                    <span
                      class={`sidebar-repository-visibility${repository.isPrivate ? " is-private" : ""}`}
                    >
                      {repository.isPrivate ? "Private" : "Public"}
                    </span>
                  </button>
                )}
              </For>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  );
}
