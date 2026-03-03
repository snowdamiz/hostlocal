import { For, Show, type Accessor } from "solid-js";
import { siGithub } from "simple-icons";
import type { GithubRepositoryItem } from "../../../lib/commands";
import { highlightIssueCode, parseIssueBody, parseIssueInlineTokens } from "../../issue-content/issue-body";

interface IssueDetailsPanelProps {
  selectedBoardItem: Accessor<GithubRepositoryItem | null>;
  onClose: () => void;
  onOpenGithubItemPage: (url: string) => Promise<void>;
}

export function IssueDetailsPanel(props: IssueDetailsPanelProps) {
  return (
    <aside
      class="relative z-[110] m-0 flex min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--surface)] transition-[transform,opacity,border-color,box-shadow] duration-[var(--sidebar-panel-transition)] ease-out max-[900px]:absolute max-[900px]:bottom-0 max-[900px]:right-0 max-[900px]:top-[46px] max-[900px]:z-[130] max-[900px]:w-[min(88vw,var(--sidebar-right-width))]"
      classList={{
        "pointer-events-none translate-x-5 opacity-0 border-0 max-[900px]:translate-x-full": !props.selectedBoardItem(),
        "pointer-events-auto translate-x-0 opacity-100 border border-[var(--surface-border)] shadow-[-8px_0_18px_var(--sidebar-shadow-dark)] max-[900px]:translate-x-0":
          !!props.selectedBoardItem(),
      }}
      aria-label="Selected issue details"
      aria-hidden={!props.selectedBoardItem()}
    >
      <Show when={props.selectedBoardItem()} keyed>
        {(item) => {
          return (
            <>
              <header class="relative z-[130] flex items-start gap-[10px] border-b border-[var(--surface-border)] p-[18px]">
                <div class="min-w-0 flex-1">
                  <p class="m-0 text-[11px] font-semibold uppercase tracking-[0.04em] text-[var(--text-secondary)]">
                    {item.isPullRequest ? "Pull request" : "Issue"} #{item.number}
                  </p>
                  <h3 class="m-0 mt-1.5 break-words text-[14px] font-semibold leading-[1.45] text-[var(--text-primary)]">
                    {item.title}
                  </h3>
                </div>
                <button
                  type="button"
                  class="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[8px] border border-transparent bg-transparent text-[var(--text-secondary)] transition-[background-color,border-color,color] duration-120 hover:border-[var(--surface-border)] hover:bg-[var(--app-bg)] hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--surface-light)]"
                  aria-label="Close issue details"
                  title="Close details"
                  onClick={props.onClose}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden="true"
                    class="h-[14px] w-[14px] stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.8]"
                  >
                    <path d="M6 6 18 18" />
                    <path d="M18 6 6 18" />
                  </svg>
                </button>
              </header>

              <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
                <section class="flex flex-col gap-1.5 border-b border-[var(--surface-border)] pb-[10px]">
                  <p class="m-0 text-[10.5px] font-bold uppercase tracking-[0.05em] text-[var(--text-secondary)]">Issue Text</p>
                  <Show
                    when={item.body && item.body.trim().length > 0}
                    fallback={<p class="m-0 text-[11.5px] leading-[1.35] text-[var(--text-muted)]">No issue text provided.</p>}
                  >
                    <div class="flex flex-col gap-3">
                      <For each={parseIssueBody(item.body ?? "")}>
                        {(block) => {
                          if (block.kind === "code") {
                            return (
                              <pre class="m-0 flex flex-col gap-2 overflow-auto rounded-[10px] border border-[var(--surface-border)] bg-[var(--app-bg)] p-[10px]">
                                <Show when={block.language}>
                                  <span class="self-start rounded-full border border-[var(--surface-border)] px-[7px] py-0.5 text-[10px] font-semibold uppercase tracking-[0.03em] text-[var(--text-muted)]">
                                    {block.language}
                                  </span>
                                </Show>
                                <code
                                  class="hljs issue-code-theme m-0 block whitespace-pre bg-transparent font-mono text-[11.5px] leading-[1.5] text-[var(--syntax-text)]"
                                  innerHTML={highlightIssueCode(block.code, block.language)}
                                />
                              </pre>
                            );
                          }

                          return (
                            <p class="m-0 break-words whitespace-pre-wrap text-[12px] leading-[1.5] text-[var(--text-primary)]">
                              <For each={parseIssueInlineTokens(block.text)}>
                                {(token) => {
                                  if (token.kind === "inlineCode") {
                                    return (
                                      <code class="inline rounded-[6px] border border-[var(--surface-border)] bg-[var(--surface-dark)] px-[5px] py-px font-mono text-[0.92em] text-[var(--text-primary)]">
                                        {token.value}
                                      </code>
                                    );
                                  }

                                  return token.value;
                                }}
                              </For>
                            </p>
                          );
                        }}
                      </For>
                    </div>
                  </Show>
                </section>

                <div class="mt-auto flex items-stretch gap-2">
                  <a
                    class="inline-flex flex-1 items-center justify-center gap-[7px] rounded-[9px] border border-[var(--surface-border)] bg-[var(--surface-dark)] px-[10px] py-[9px] text-center text-[12px] font-semibold text-[var(--text-primary)] no-underline transition-colors duration-120 hover:bg-[var(--app-bg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--surface-light)]"
                    href={item.htmlUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(event) => {
                      event.preventDefault();
                      void props.onOpenGithubItemPage(item.htmlUrl);
                    }}
                  >
                    <svg
                      class="h-[14px] w-[14px] shrink-0 fill-current"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path d={siGithub.path} />
                    </svg>
                    <span>Open on GitHub</span>
                  </a>
                </div>
              </div>
            </>
          );
        }}
      </Show>
    </aside>
  );
}
