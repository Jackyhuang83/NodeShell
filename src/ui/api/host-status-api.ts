import axios, { type AxiosRequestConfig } from "axios";
import { handleApiError, sshHostApi } from "@/main-axios";
import type { ServerStatus } from "@/main-axios";
import { getCachedServerStatuses } from "@/lib/hosts-request-cache";

const STATUS_RETRY_SCHEDULE: ReadonlyArray<{
  timeoutMs: number;
  pauseAfterMs: number | null;
}> = [
  { timeoutMs: 2000, pauseAfterMs: 3000 },
  { timeoutMs: 5000, pauseAfterMs: 5000 },
  { timeoutMs: 8000, pauseAfterMs: null },
];

function isTransientStatusError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  if (error.response) return false;

  const code = error.code;
  if (!code) return true;

  return (
    code === "ECONNABORTED" ||
    code === "ETIMEDOUT" ||
    code === "ERR_NETWORK" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET"
  );
}

export async function getAllServerStatuses(): Promise<
  Record<number, ServerStatus>
> {
  return getCachedServerStatuses(async () => {
    let lastError: unknown = null;

    for (let i = 0; i < STATUS_RETRY_SCHEDULE.length; i++) {
      const { timeoutMs, pauseAfterMs } = STATUS_RETRY_SCHEDULE[i];
      const isFinalAttempt = i === STATUS_RETRY_SCHEDULE.length - 1;

      try {
        const response = await sshHostApi.get("/status", {
          timeout: timeoutMs,
          __silentRetry: !isFinalAttempt,
        } as AxiosRequestConfig & { __silentRetry?: boolean });
        return response.data || {};
      } catch (error) {
        lastError = error;
        if (!isTransientStatusError(error) || pauseAfterMs === null) break;
        await new Promise((resolve) => setTimeout(resolve, pauseAfterMs));
      }
    }

    if (lastError) {
      handleApiError(lastError, "fetch server statuses");
    }
    return {};
  });
}

export async function getServerStatusById(id: number): Promise<ServerStatus> {
  try {
    const response = await sshHostApi.get(`/status/${id}`);
    return response.data;
  } catch (error) {
    handleApiError(error, "fetch server status");
    throw error;
  }
}

export async function refreshServerPolling(): Promise<void> {
  try {
    await sshHostApi.post("/status/refresh");
  } catch (error) {
    console.warn("Failed to refresh status checks:", error);
  }
}

export async function getStatusCheckSettings(): Promise<{
  statusCheckInterval: number;
}> {
  try {
    const response = await sshHostApi.get("/status/settings");
    return response.data;
  } catch (error) {
    handleApiError(error, "fetch status check settings");
    throw error;
  }
}

export async function updateStatusCheckSettings(settings: {
  statusCheckInterval: number;
}): Promise<void> {
  try {
    await sshHostApi.put("/status/settings", settings);
  } catch (error) {
    handleApiError(error, "update status check settings");
  }
}
