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
    <div class="sidebar-footer">
      <Show when={props.authError()}>
        {(error) => (
          <p class="sidebar-auth-error" role="alert">
            {error()}
          </p>
        )}
      </Show>

      <Show when={props.deviceFlow()}>
        {(flow) => (
          <div class="sidebar-device-flow">
            <p class="sidebar-device-title">Confirm on GitHub</p>
            <button
              type="button"
              class="sidebar-device-link"
              onClick={() => void props.onOpenVerificationPage()}
            >
              Open verification page
            </button>
            <button type="button" class="sidebar-device-code" onClick={() => void props.onCopyUserCode()}>
              <span>{flow().userCode}</span>
              <span>{props.isCodeCopied() ? "Copied" : "Copy"}</span>
            </button>
            <p class="sidebar-device-hint">
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
            class="sidebar-connect-link"
            onClick={() => void props.onConnectGithub()}
            disabled={props.isAuthChecking() || props.isAuthStarting()}
          >
            {props.isAuthStarting() ? "Connecting..." : "Connect GitHub"}
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
              onClick={() => void props.onSignOutGithub()}
              aria-label="Sign out of GitHub"
              title="Sign out"
              disabled={props.isSigningOut()}
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
  );
}
