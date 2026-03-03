import { createSignal, onCleanup } from "solid-js";
import {
  githubAuthLogout,
  githubAuthPoll,
  githubAuthStart,
  githubAuthStatus,
  githubOpenVerificationUrl,
  type GithubDeviceAuthStart,
  type GithubUser,
} from "../../../lib/commands";

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

export function useGithubAuth() {
  const [githubUser, setGithubUser] = createSignal<GithubUser | null>(null);
  const [authError, setAuthError] = createSignal<string | null>(null);
  const [isAuthChecking, setIsAuthChecking] = createSignal(true);
  const [isAuthStarting, setIsAuthStarting] = createSignal(false);
  const [isPollingAuth, setIsPollingAuth] = createSignal(false);
  const [isSigningOut, setIsSigningOut] = createSignal(false);
  const [isCodeCopied, setIsCodeCopied] = createSignal(false);
  const [deviceFlow, setDeviceFlow] = createSignal<GithubDeviceAuthStart | null>(null);

  let pollTimeoutId: number | null = null;

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
      setAuthError(null);
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

  onCleanup(() => {
    clearPollTimer();
  });

  return {
    githubUser,
    authError,
    isAuthChecking,
    isAuthStarting,
    isPollingAuth,
    isSigningOut,
    isCodeCopied,
    deviceFlow,
    refreshAuthState,
    connectGithub,
    copyUserCode,
    signOutGithub,
    openVerificationPage,
  };
}
