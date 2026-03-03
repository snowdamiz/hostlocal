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
    <aside class="sidebar-right" aria-label="Selected issue details" aria-hidden={!props.selectedBoardItem()}>
      <Show when={props.selectedBoardItem()} keyed>
        {(item) => {
          return (
            <>
              <header class="sidebar-issue-header">
                <div class="sidebar-issue-header-copy">
                  <p class="sidebar-issue-kicker">
                    {item.isPullRequest ? "Pull request" : "Issue"} #{item.number}
                  </p>
                  <h3 class="sidebar-issue-title">{item.title}</h3>
                </div>
                <button
                  type="button"
                  class="sidebar-issue-close"
                  aria-label="Close issue details"
                  title="Close details"
                  onClick={props.onClose}
                >
                  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M6 6 18 18" />
                    <path d="M18 6 6 18" />
                  </svg>
                </button>
              </header>

              <div class="sidebar-issue-content">
                <section class="sidebar-issue-section">
                  <p class="sidebar-issue-section-title">Issue Text</p>
                  <Show
                    when={item.body && item.body.trim().length > 0}
                    fallback={<p class="sidebar-issue-inline-empty">No issue text provided.</p>}
                  >
                    <div class="sidebar-issue-body-content">
                      <For each={parseIssueBody(item.body ?? "")}>
                        {(block) => {
                          if (block.kind === "code") {
                            return (
                              <pre class="sidebar-issue-code-block">
                                <Show when={block.language}>
                                  <span class="sidebar-issue-code-language">{block.language}</span>
                                </Show>
                                <code class="hljs sidebar-issue-code" innerHTML={highlightIssueCode(block.code, block.language)} />
                              </pre>
                            );
                          }

                          return (
                            <p class="sidebar-issue-body-paragraph">
                              <For each={parseIssueInlineTokens(block.text)}>
                                {(token) => {
                                  if (token.kind === "inlineCode") {
                                    return <code class="sidebar-issue-inline-code">{token.value}</code>;
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

                <div class="sidebar-issue-actions">
                  <a
                    class="sidebar-issue-link"
                    href={item.htmlUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(event) => {
                      event.preventDefault();
                      void props.onOpenGithubItemPage(item.htmlUrl);
                    }}
                  >
                    <svg class="sidebar-issue-github-icon" viewBox="0 0 24 24" aria-hidden="true">
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
