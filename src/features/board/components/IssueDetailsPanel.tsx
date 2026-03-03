import { For, Show, createSignal, type Accessor } from "solid-js";
import { siGithub } from "simple-icons";
import type {
  GithubRepositoryItem,
  RuntimeIssueRunHistoryItem,
  RuntimeIssueRunSummary,
  RuntimeRepositoryRunSnapshotItem,
  RuntimeRunTelemetryEventPayload,
} from "../../../lib/commands";
import { resolveIntakePolicyReason } from "../../../intake/policy-reasons";
import { highlightIssueCode, parseIssueBody, parseIssueInlineTokens } from "../../issue-content/issue-body";

interface IssueDetailsPanelProps {
  selectedBoardItem: Accessor<GithubRepositoryItem | null>;
  selectedBoardRuntime: Accessor<RuntimeRepositoryRunSnapshotItem | null>;
  selectedBoardRuntimeHistory: Accessor<RuntimeIssueRunHistoryItem[]>;
  selectedBoardRuntimeTelemetry: Accessor<RuntimeRunTelemetryEventPayload[]>;
  selectedBoardRuntimeSummary: Accessor<RuntimeIssueRunSummary | null>;
  selectedRuntimeControlAvailability: Accessor<{
    canPauseRun: boolean;
    canResumeRun: boolean;
    canAbortRun: boolean;
    canSteerRun: boolean;
    pendingAction: "pause" | "resume" | "abort" | "steer" | null;
    hasPendingAction: boolean;
  }>;
  runtimeControlPendingAction: Accessor<"pause" | "resume" | "abort" | "steer" | null>;
  onPauseRun: () => Promise<unknown>;
  onResumeRun: () => Promise<unknown>;
  onAbortRun: (reason?: string | null) => Promise<unknown>;
  onSteerRun: (instruction: string) => Promise<unknown>;
  onClose: () => void;
  onOpenGithubItemPage: (url: string) => Promise<void>;
}

const formatRuntimeTimestamp = (value: string | null | undefined) => {
  if (!value) {
    return "recently";
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }
  return new Date(parsed).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};

const formatStatusLabel = (value: string) =>
  value
    .split("-")
    .filter((segment) => segment.length > 0)
    .map((segment) => `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`)
    .join(" ");

export function IssueDetailsPanel(props: IssueDetailsPanelProps) {
  const [steeringInstruction, setSteeringInstruction] = createSignal("");
  const [isAbortDialogOpen, setIsAbortDialogOpen] = createSignal(false);
  const [abortReason, setAbortReason] = createSignal("");

  const runtimeControlAvailability = () => props.selectedRuntimeControlAvailability();
  const pendingAction = () => props.runtimeControlPendingAction();
  const isActionPending = (action: "pause" | "resume" | "abort" | "steer") => pendingAction() === action;

  const resolveActionLabel = (action: "pause" | "resume" | "abort") => {
    if (!isActionPending(action)) {
      return action === "pause" ? "Pause" : action === "resume" ? "Resume" : "Abort";
    }
    if (action === "pause") {
      return "Pausing...";
    }
    if (action === "resume") {
      return "Resuming...";
    }
    return "Aborting...";
  };

  const submitSteeringInstruction = async () => {
    const instruction = steeringInstruction().trim();
    if (instruction.length === 0) {
      return;
    }
    if (!runtimeControlAvailability().canSteerRun || runtimeControlAvailability().hasPendingAction) {
      return;
    }
    await props.onSteerRun(instruction);
    setSteeringInstruction("");
  };

  const closeAbortDialog = () => {
    if (isActionPending("abort")) {
      return;
    }
    setIsAbortDialogOpen(false);
    setAbortReason("");
  };

  const confirmAbort = async () => {
    if (!runtimeControlAvailability().canAbortRun || runtimeControlAvailability().hasPendingAction) {
      return;
    }
    await props.onAbortRun(abortReason().trim() || null);
    setIsAbortDialogOpen(false);
    setAbortReason("");
  };

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
                  <p class="m-0 text-[10.5px] font-bold uppercase tracking-[0.05em] text-[var(--text-secondary)]">Current Runtime Stage</p>
                  <Show
                    when={props.selectedBoardRuntime()}
                    fallback={<p class="m-0 text-[11.5px] leading-[1.35] text-[var(--text-muted)]">No runtime metadata yet.</p>}
                  >
                    {(runtime) => {
                      const resolvedReason = () =>
                        runtime().terminalStatus
                          ? resolveIntakePolicyReason(runtime().reasonCode, runtime().fixHint)
                          : null;
                      return (
                        <div class="flex flex-col gap-2">
                          <div class="flex flex-wrap items-center gap-2">
                            <span class="inline-flex rounded-full border border-[var(--surface-border)] px-[8px] py-[3px] text-[10.5px] font-semibold text-[var(--text-primary)]">
                              {runtime().stage}
                            </span>
                            <Show when={runtime().stage === "queued" && runtime().queuePosition !== null}>
                              <span class="inline-flex rounded-full border border-[var(--surface-border)] px-[8px] py-[3px] text-[10.5px] font-semibold text-[var(--text-secondary)]">
                                queue position {runtime().queuePosition}
                              </span>
                            </Show>
                            <Show when={runtime().terminalStatus}>
                              <span class="inline-flex rounded-full border border-[var(--surface-border)] px-[8px] py-[3px] text-[10.5px] font-semibold text-[var(--text-primary)]">
                                {runtime().terminalStatus}
                              </span>
                            </Show>
                          </div>
                          <Show when={resolvedReason()}>
                            {(reason) => (
                              <div class="flex flex-col gap-1 rounded-[8px] border border-[var(--surface-border)] bg-[var(--surface-dark)] p-2 text-[11px] leading-[1.35] text-[var(--text-secondary)]">
                                <span class="font-semibold text-[var(--text-primary)]">{reason().reasonCode}</span>
                                <span>{reason().violatedRule}</span>
                                <span>{reason().fixHint}</span>
                              </div>
                            )}
                          </Show>
                          <div class="flex flex-col gap-2 rounded-[8px] border border-[var(--surface-border)] bg-[var(--surface-dark)] p-2">
                            <p class="m-0 text-[10px] font-semibold uppercase tracking-[0.04em] text-[var(--text-secondary)]">
                              Run controls
                            </p>
                            <div class="flex flex-wrap gap-2">
                              <button
                                type="button"
                                class="rounded-[8px] border border-[var(--surface-border)] bg-[var(--surface)] px-[10px] py-[6px] text-[11px] font-semibold text-[var(--text-primary)] transition-[border-color,background-color,color] duration-120 hover:border-[var(--surface-light)] hover:bg-[var(--app-bg)] disabled:cursor-not-allowed disabled:opacity-55"
                                disabled={!runtimeControlAvailability().canPauseRun || runtimeControlAvailability().hasPendingAction}
                                onClick={() => {
                                  void props.onPauseRun();
                                }}
                              >
                                {resolveActionLabel("pause")}
                              </button>
                              <button
                                type="button"
                                class="rounded-[8px] border border-[var(--surface-border)] bg-[var(--surface)] px-[10px] py-[6px] text-[11px] font-semibold text-[var(--text-primary)] transition-[border-color,background-color,color] duration-120 hover:border-[var(--surface-light)] hover:bg-[var(--app-bg)] disabled:cursor-not-allowed disabled:opacity-55"
                                disabled={!runtimeControlAvailability().canResumeRun || runtimeControlAvailability().hasPendingAction}
                                onClick={() => {
                                  void props.onResumeRun();
                                }}
                              >
                                {resolveActionLabel("resume")}
                              </button>
                              <button
                                type="button"
                                class="rounded-[8px] border border-[var(--error-border)] bg-[var(--error-bg)] px-[10px] py-[6px] text-[11px] font-semibold text-[var(--error-text)] transition-[border-color,background-color,color] duration-120 hover:border-[var(--error-text)] hover:bg-[var(--surface)] disabled:cursor-not-allowed disabled:opacity-55"
                                disabled={!runtimeControlAvailability().canAbortRun || runtimeControlAvailability().hasPendingAction}
                                onClick={() => {
                                  setIsAbortDialogOpen(true);
                                }}
                              >
                                {resolveActionLabel("abort")}
                              </button>
                            </div>
                            <div class="flex flex-col gap-1.5">
                              <label
                                for="runtime-steering-input"
                                class="m-0 text-[10px] font-semibold uppercase tracking-[0.04em] text-[var(--text-secondary)]"
                              >
                                Steering
                              </label>
                              <textarea
                                id="runtime-steering-input"
                                class="min-h-[66px] w-full resize-y rounded-[8px] border border-[var(--surface-border)] bg-[var(--surface)] px-[9px] py-[7px] text-[11.5px] leading-[1.4] text-[var(--text-primary)] outline-none transition-[border-color,box-shadow] duration-120 placeholder:text-[var(--text-muted)] focus-visible:border-[var(--surface-light)] focus-visible:shadow-[0_0_0_1px_var(--surface-light)] disabled:cursor-not-allowed disabled:opacity-60"
                                value={steeringInstruction()}
                                placeholder="Add one instruction for the current run."
                                disabled={!runtimeControlAvailability().canSteerRun || runtimeControlAvailability().hasPendingAction}
                                onInput={(event) => setSteeringInstruction(event.currentTarget.value)}
                                onKeyDown={(event) => {
                                  if (event.key !== "Enter" || event.shiftKey) {
                                    return;
                                  }
                                  event.preventDefault();
                                  void submitSteeringInstruction();
                                }}
                              />
                              <div class="flex items-center justify-between gap-2">
                                <p class="m-0 text-[10.5px] leading-[1.3] text-[var(--text-muted)]">
                                  Send one instruction at a time. Press Enter to submit.
                                </p>
                                <button
                                  type="button"
                                  class="rounded-[8px] border border-[var(--surface-border)] bg-[var(--surface)] px-[10px] py-[6px] text-[11px] font-semibold text-[var(--text-primary)] transition-[border-color,background-color,color] duration-120 hover:border-[var(--surface-light)] hover:bg-[var(--app-bg)] disabled:cursor-not-allowed disabled:opacity-55"
                                  disabled={
                                    !runtimeControlAvailability().canSteerRun ||
                                    runtimeControlAvailability().hasPendingAction ||
                                    steeringInstruction().trim().length === 0
                                  }
                                  onClick={() => {
                                    void submitSteeringInstruction();
                                  }}
                                >
                                  {isActionPending("steer") ? "Sending..." : "Send"}
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    }}
                  </Show>
                </section>

                <section class="flex flex-col gap-1.5 border-b border-[var(--surface-border)] pb-[10px]">
                  <p class="m-0 text-[10.5px] font-bold uppercase tracking-[0.05em] text-[var(--text-secondary)]">Live runtime activity</p>
                  <Show
                    when={props.selectedBoardRuntimeTelemetry().length > 0}
                    fallback={
                      <p class="m-0 text-[11.5px] leading-[1.35] text-[var(--text-muted)]">
                        No runtime telemetry yet.
                      </p>
                    }
                  >
                    <ol class="m-0 flex list-none flex-col gap-2 p-0">
                      <For each={props.selectedBoardRuntimeTelemetry()}>
                        {(event) => (
                          <li class="rounded-[8px] border border-[var(--surface-border)] bg-[var(--surface-dark)] p-2">
                            <div class="flex flex-wrap items-center gap-2">
                              <span class="inline-flex rounded-full border border-[var(--surface-border)] px-[8px] py-[2px] text-[10.5px] font-semibold text-[var(--text-primary)]">
                                {event.stage}
                              </span>
                              <span class="inline-flex rounded-full border border-[var(--surface-border)] px-[8px] py-[2px] text-[10.5px] text-[var(--text-secondary)]">
                                {event.kind}
                              </span>
                              <span class="text-[10.5px] text-[var(--text-muted)]">
                                {formatRuntimeTimestamp(event.createdAt)}
                              </span>
                            </div>
                            <p class="m-0 mt-1.5 break-words text-[11.5px] leading-[1.4] text-[var(--text-primary)]">
                              {event.message}
                            </p>
                          </li>
                        )}
                      </For>
                    </ol>
                  </Show>
                </section>

                <section class="flex flex-col gap-1.5 border-b border-[var(--surface-border)] pb-[10px]">
                  <p class="m-0 text-[10.5px] font-bold uppercase tracking-[0.05em] text-[var(--text-secondary)]">Run summary</p>
                  <Show
                    when={props.selectedBoardRuntimeSummary()}
                    fallback={
                      <p class="m-0 text-[11.5px] leading-[1.35] text-[var(--text-muted)]">
                        Run summary will appear once runtime evidence is available.
                      </p>
                    }
                  >
                    {(summary) => (
                      <div class="flex flex-col gap-2 rounded-[8px] border border-[var(--surface-border)] bg-[var(--surface-dark)] p-2">
                        <div class="flex flex-wrap items-center gap-2">
                          <span class="inline-flex rounded-full border border-[var(--surface-border)] px-[8px] py-[2px] text-[10.5px] font-semibold text-[var(--text-primary)]">
                            {formatStatusLabel(summary().completion.status)}
                          </span>
                          <span class="text-[10.5px] text-[var(--text-muted)]">
                            {formatRuntimeTimestamp(summary().completion.terminalAt)}
                          </span>
                        </div>

                        <div class="flex flex-col gap-1.5">
                          <p class="m-0 text-[10px] font-semibold uppercase tracking-[0.04em] text-[var(--text-secondary)]">
                            Key actions
                          </p>
                          <Show
                            when={summary().keyActions.length > 0}
                            fallback={
                              <p class="m-0 text-[11px] leading-[1.35] text-[var(--text-muted)]">
                                No summary actions were recorded.
                              </p>
                            }
                          >
                            <ul class="m-0 flex list-disc flex-col gap-1 pl-4 text-[11px] leading-[1.4] text-[var(--text-primary)]">
                              <For each={summary().keyActions}>
                                {(action) => (
                                  <li>
                                    <span>{action.message}</span>
                                  </li>
                                )}
                              </For>
                            </ul>
                          </Show>
                        </div>

                        <div class="flex flex-col gap-1.5">
                          <p class="m-0 text-[10px] font-semibold uppercase tracking-[0.04em] text-[var(--text-secondary)]">
                            Validation outcomes
                          </p>
                          <div class="flex flex-wrap gap-2">
                            <span class="inline-flex items-center gap-1 rounded-full border border-[var(--surface-border)] px-[8px] py-[2px] text-[10.5px] text-[var(--text-secondary)]">
                              <span class="font-semibold text-[var(--text-primary)]">Code</span>
                              <span>{formatStatusLabel(summary().validationOutcomes.code)}</span>
                            </span>
                            <span class="inline-flex items-center gap-1 rounded-full border border-[var(--surface-border)] px-[8px] py-[2px] text-[10.5px] text-[var(--text-secondary)]">
                              <span class="font-semibold text-[var(--text-primary)]">Browser</span>
                              <span>{formatStatusLabel(summary().validationOutcomes.browser)}</span>
                            </span>
                          </div>
                        </div>
                      </div>
                    )}
                  </Show>
                </section>

                <section class="flex flex-col gap-1.5 border-b border-[var(--surface-border)] pb-[10px]">
                  <p class="m-0 text-[10.5px] font-bold uppercase tracking-[0.05em] text-[var(--text-secondary)]">Runtime history</p>
                  <Show
                    when={props.selectedBoardRuntimeHistory().length > 0}
                    fallback={<p class="m-0 text-[11.5px] leading-[1.35] text-[var(--text-muted)]">No runtime history available.</p>}
                  >
                    <ol class="m-0 flex list-none flex-col gap-2 p-0">
                      <For each={props.selectedBoardRuntimeHistory()}>
                        {(run) => {
                          const resolvedReason = () =>
                            run.terminalStatus ? resolveIntakePolicyReason(run.reasonCode, run.fixHint) : null;
                          return (
                            <li class="rounded-[8px] border border-[var(--surface-border)] bg-[var(--surface-dark)] p-2">
                              <div class="flex flex-wrap items-center gap-2">
                                <span class="inline-flex rounded-full border border-[var(--surface-border)] px-[8px] py-[2px] text-[10.5px] font-semibold text-[var(--text-primary)]">
                                  {run.stage}
                                </span>
                                <Show when={run.stage === "queued" && run.queuePosition !== null}>
                                  <span class="inline-flex rounded-full border border-[var(--surface-border)] px-[8px] py-[2px] text-[10.5px] text-[var(--text-secondary)]">
                                    queue position {run.queuePosition}
                                  </span>
                                </Show>
                                <Show when={run.terminalStatus}>
                                  <span class="inline-flex rounded-full border border-[var(--surface-border)] px-[8px] py-[2px] text-[10.5px] font-semibold text-[var(--text-primary)]">
                                    {run.terminalStatus}
                                  </span>
                                </Show>
                              </div>
                              <p class="m-0 mt-1 text-[10.5px] text-[var(--text-muted)]">
                                {formatRuntimeTimestamp(run.terminalAt ?? run.updatedAt)}
                              </p>
                              <Show when={resolvedReason()}>
                                {(reason) => (
                                  <div class="mt-1 text-[11px] leading-[1.35] text-[var(--text-secondary)]">
                                    <p class="m-0 font-semibold text-[var(--text-primary)]">{reason().reasonCode}</p>
                                    <p class="m-0">{reason().fixHint}</p>
                                  </div>
                                )}
                              </Show>
                            </li>
                          );
                        }}
                      </For>
                    </ol>
                  </Show>
                </section>

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
              <Show when={isAbortDialogOpen()}>
                <div
                  class="absolute inset-0 z-[180] flex items-center justify-center bg-[var(--sidebar-shadow-dark)] p-3 backdrop-blur-[1px]"
                  role="presentation"
                  onClick={(event) => {
                    if (event.target !== event.currentTarget) {
                      return;
                    }
                    closeAbortDialog();
                  }}
                >
                  <section
                    class="w-[min(92vw,360px)] rounded-[10px] border border-[var(--surface-border)] bg-[var(--surface)] p-3 shadow-[0_16px_36px_var(--sidebar-shadow-dark)]"
                    role="dialog"
                    aria-modal="true"
                    aria-label="Confirm runtime abort"
                  >
                    <p class="m-0 text-[12.5px] font-semibold text-[var(--text-primary)]">Abort this run?</p>
                    <p class="m-0 mt-1 text-[11px] leading-[1.4] text-[var(--text-secondary)]">
                      This stops the active run and finalizes it as cancelled.
                    </p>
                    <label
                      for="runtime-abort-reason"
                      class="mt-2 block text-[10px] font-semibold uppercase tracking-[0.04em] text-[var(--text-secondary)]"
                    >
                      Reason (optional)
                    </label>
                    <textarea
                      id="runtime-abort-reason"
                      class="mt-1 min-h-[72px] w-full resize-y rounded-[8px] border border-[var(--surface-border)] bg-[var(--surface-dark)] px-[9px] py-[7px] text-[11.5px] leading-[1.4] text-[var(--text-primary)] outline-none transition-[border-color,box-shadow] duration-120 placeholder:text-[var(--text-muted)] focus-visible:border-[var(--surface-light)] focus-visible:shadow-[0_0_0_1px_var(--surface-light)] disabled:cursor-not-allowed disabled:opacity-60"
                      value={abortReason()}
                      placeholder="Share why this run was aborted."
                      disabled={isActionPending("abort")}
                      onInput={(event) => setAbortReason(event.currentTarget.value)}
                    />
                    <div class="mt-3 flex items-center justify-end gap-2">
                      <button
                        type="button"
                        class="rounded-[8px] border border-[var(--surface-border)] bg-[var(--surface)] px-[10px] py-[6px] text-[11px] font-semibold text-[var(--text-primary)] transition-[border-color,background-color,color] duration-120 hover:border-[var(--surface-light)] hover:bg-[var(--app-bg)] disabled:cursor-not-allowed disabled:opacity-55"
                        onClick={closeAbortDialog}
                        disabled={isActionPending("abort")}
                      >
                        Keep run
                      </button>
                      <button
                        type="button"
                        class="rounded-[8px] border border-[var(--error-border)] bg-[var(--error-bg)] px-[10px] py-[6px] text-[11px] font-semibold text-[var(--error-text)] transition-[border-color,background-color,color] duration-120 hover:border-[var(--error-text)] hover:bg-[var(--surface)] disabled:cursor-not-allowed disabled:opacity-55"
                        onClick={() => {
                          void confirmAbort();
                        }}
                        disabled={!runtimeControlAvailability().canAbortRun || runtimeControlAvailability().hasPendingAction}
                      >
                        {isActionPending("abort") ? "Aborting..." : "Confirm abort"}
                      </button>
                    </div>
                  </section>
                </div>
              </Show>
            </>
          );
        }}
      </Show>
    </aside>
  );
}
