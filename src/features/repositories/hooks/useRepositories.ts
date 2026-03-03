import { createEffect, createMemo, createSignal, type Accessor } from "solid-js";
import { githubListRepositories, type GithubRepository, type GithubUser } from "../../../lib/commands";

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

export function useRepositories(githubUser: Accessor<GithubUser | null>) {
  const [repositories, setRepositories] = createSignal<GithubRepository[]>([]);
  const [repositoryListError, setRepositoryListError] = createSignal<string | null>(null);
  const [isRepositoryListLoading, setIsRepositoryListLoading] = createSignal(false);
  const [selectedRepositoryId, setSelectedRepositoryId] = createSignal<number | null>(null);

  let repositoryRequestId = 0;

  const clearRepositoryState = () => {
    repositoryRequestId += 1;
    setRepositories([]);
    setSelectedRepositoryId(null);
    setRepositoryListError(null);
    setIsRepositoryListLoading(false);
  };

  const loadRepositories = async () => {
    const requestId = ++repositoryRequestId;
    setIsRepositoryListLoading(true);
    setRepositoryListError(null);

    try {
      const allRepositories = await githubListRepositories();
      if (requestId !== repositoryRequestId) {
        return;
      }

      setRepositories(allRepositories);
      setSelectedRepositoryId((currentRepositoryId) => {
        if (currentRepositoryId !== null && allRepositories.some((repository) => repository.id === currentRepositoryId)) {
          return currentRepositoryId;
        }

        return allRepositories.length > 0 ? allRepositories[0].id : null;
      });
    } catch (error) {
      if (requestId !== repositoryRequestId) {
        return;
      }

      setRepositories([]);
      setSelectedRepositoryId(null);
      setRepositoryListError(formatInvokeError(error, "Unable to load repositories."));
    } finally {
      if (requestId === repositoryRequestId) {
        setIsRepositoryListLoading(false);
      }
    }
  };

  const selectedRepository = createMemo(() => {
    const repositoryId = selectedRepositoryId();
    if (repositoryId === null) {
      return null;
    }

    return repositories().find((repository) => repository.id === repositoryId) ?? null;
  });

  createEffect(() => {
    if (!githubUser()) {
      clearRepositoryState();
      return;
    }

    void loadRepositories();
  });

  return {
    repositories,
    repositoryListError,
    isRepositoryListLoading,
    selectedRepositoryId,
    setSelectedRepositoryId,
    selectedRepository,
  };
}
