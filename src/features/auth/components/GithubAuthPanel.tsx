import { Show, type Accessor } from "solid-js";
import { type GithubDeviceAuthStart, type GithubUser } from "../../../lib/commands";

interface GithubAuthPanelProps {
  authError: Accessor<string | null>;
  deviceFlow: Accessor<GithubDeviceAuthStart | null>;
  isPollingAuth: Accessor<boolean>;
  isCodeCopied: Accessor<boolean>;
  githubUser: Accessor<GithubUser | null>;
  isAuthChecking: Accessor<boolean>;
  isAuthStarting: Accessor<boolean>;
  isSigningOut: Accessor<boolean>;
  onOpenVerificationPage: () => Promise<void>;
  onCopyUserCode: () => Promise<void>;
  onConnectGithub: () => Promise<void>;
  onSignOutGithub: () => Promise<void>;
}

export function GithubAuthPanel(props: GithubAuthPanelProps) {
  return (
    <div class="mt-auto flex flex-col gap-2 border-t border-[var(--surface-border)] p-3">
      <Show when={props.authError()}>
        {(error) => (
          <p
            class="m-0 rounded-[8px] border border-[var(--error-border)] bg-[var(--error-bg)] px-2 py-[7px] text-[11.5px] leading-[1.35] text-[var(--error-text)]"
            role="alert"
          >
            {error()}
          </p>
        )}
      </Show>

      <Show when={props.deviceFlow()}>
        {(flow) => (
          <div class="flex flex-col gap-1.5 rounded-[10px] border border-[var(--surface-border)] bg-[var(--app-bg)] p-2">
            <p class="m-0 text-[12px] font-semibold text-[var(--text-primary)]">Confirm on GitHub</p>
            <button
              type="button"
              class="w-fit appearance-none border-0 bg-transparent p-0 text-[11.5px] text-[var(--text-secondary)] underline underline-offset-2 transition-colors duration-100 hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--surface-light)]"
              onClick={() => void props.onOpenVerificationPage()}
            >
              Open verification page
            </button>
            <button
              type="button"
              class="flex cursor-pointer items-center justify-between gap-2 rounded-[8px] border border-[var(--surface-border)] bg-[var(--surface)] px-2 py-1.5 text-[12px] font-semibold text-[var(--text-primary)]"
              onClick={() => void props.onCopyUserCode()}
            >
              <span class="font-mono tracking-[0.04em]">{flow().userCode}</span>
              <span class="text-[11.5px] font-medium text-[var(--text-secondary)]">
                {props.isCodeCopied() ? "Copied" : "Copy"}
              </span>
            </button>
            <p class="m-0 text-[11.5px] text-[var(--text-muted)]">
              {props.isPollingAuth() ? "Checking authorization..." : "Waiting for approval..."}
            </p>
          </div>
        )}
      </Show>

      <Show
        when={props.githubUser()}
        fallback={
          <button
            type="button"
            class="w-fit appearance-none border-0 bg-transparent p-0 text-[12px] text-[var(--text-secondary)] underline underline-offset-2 transition-colors duration-100 hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--surface-light)] disabled:cursor-not-allowed disabled:opacity-55"
            onClick={() => void props.onConnectGithub()}
            disabled={props.isAuthChecking() || props.isAuthStarting()}
          >
            {props.isAuthStarting() ? "Connecting..." : "Connect GitHub"}
          </button>
        }
      >
        {(user) => (
          <div class="flex min-w-0 items-center gap-2">
            <img
              class="h-6 w-6 shrink-0 rounded-full border border-[var(--surface-border)] object-cover"
              src={user().avatarUrl}
              alt={`${user().login} profile`}
              loading="lazy"
            />
            <a
              class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] font-semibold text-[var(--text-primary)] no-underline"
              href={user().htmlUrl}
              target="_blank"
              rel="noreferrer"
              title={user().login}
            >
              {user().login}
            </a>
            <button
              type="button"
              class="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[7px] border border-transparent bg-transparent text-[var(--text-secondary)] transition-[background-color,border-color,color,opacity] duration-120 hover:border-[var(--surface-border-strong)] hover:bg-[var(--app-bg)] hover:text-[var(--text-primary)] focus-visible:border-[var(--surface-border-strong)] focus-visible:bg-[var(--app-bg)] focus-visible:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--surface-light)] disabled:cursor-not-allowed disabled:opacity-55"
              onClick={() => void props.onSignOutGithub()}
              aria-label="Sign out of GitHub"
              title="Sign out"
              disabled={props.isSigningOut()}
            >
              <svg
                class="h-[13px] w-[13px] fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.9]"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
              >
                <path d="M14 7V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-3" />
                <path d="M10 12h10" />
                <path d="m17 8 4 4-4 4" />
              </svg>
            </button>
          </div>
        )}
      </Show>
    </div>
  );
}
