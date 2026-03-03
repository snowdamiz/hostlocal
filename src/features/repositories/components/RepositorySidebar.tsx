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
    <div class="flex min-h-0 flex-1 flex-col px-3 pt-12">
      <div class="flex min-h-0 flex-col gap-1 overflow-auto pr-0.5 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
        <Show when={props.repositoryListError()}>
          {(error) => (
            <p
              class="mb-1.5 rounded-[8px] border border-[var(--error-border)] bg-[var(--error-bg)] px-[7px] py-1.5 text-[11.5px] leading-[1.35] text-[var(--error-text)]"
              role="alert"
            >
              {error()}
            </p>
          )}
        </Show>
        <Show
          when={props.githubUser()}
          fallback={<p class="mt-0.5 text-[11.5px] text-[var(--text-muted)]">Connect GitHub to see your repositories.</p>}
        >
          <Show
            when={!props.isRepositoryListLoading()}
            fallback={<p class="mt-0.5 text-[11.5px] text-[var(--text-muted)]">Loading repositories...</p>}
          >
            <Show
              when={props.repositories().length > 0}
              fallback={<p class="mt-0.5 text-[11.5px] text-[var(--text-muted)]">No repositories found.</p>}
            >
              <For each={props.repositories()}>
                {(repository) => (
                  <button
                    type="button"
                    class="box-border inline-flex w-full appearance-none items-center gap-2 rounded-[10px] border border-transparent bg-transparent px-[10px] py-2 text-left text-[12.5px] font-semibold text-[var(--text-primary)] transition-colors duration-100 hover:bg-[var(--surface-border)] focus-visible:bg-[var(--app-bg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--surface-light)]"
                    classList={{
                      "bg-[var(--surface-border)]":
                        props.selectedRepositoryId() === repository.id,
                    }}
                    title={repository.fullName}
                    onClick={() => props.onSelectRepository(repository.id)}
                  >
                    <svg
                      class="h-[14px] w-[14px] shrink-0 fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.8]"
                      viewBox="0 0 24 24"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path d="M5 4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4v-5h6v5h4a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H5Z" />
                      <path d="M9 20v-5h6v5" />
                    </svg>
                    <p class="m-0 flex min-w-0 flex-1 flex-col gap-0.5">
                      <span class="block overflow-hidden text-ellipsis whitespace-nowrap">{repository.name}</span>
                    </p>
                    <span
                      class="shrink-0 rounded-full border border-[var(--surface-border-strong)] px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.02em] text-[var(--text-secondary)]"
                      classList={{
                        "border-[var(--repository-private-border)] text-[var(--repository-private-text)]":
                          repository.isPrivate,
                      }}
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
