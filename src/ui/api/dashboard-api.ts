import { authApi, handleApiError } from "@/main-axios";

/** Record a lightweight host activity used by SSH/SFTP UX. */
export async function logActivity(
  type: string,
  hostId: number,
  hostName: string,
): Promise<{ message: string; id: number | string }> {
  try {
    const response = await authApi.post("/dashboard/activity/log", {
      type,
      hostId,
      hostName,
    });
    return response.data;
  } catch (error) {
    throw handleApiError(error, "log activity");
  }
}

export interface RecentActivityItem {
  id: number;
  userId: string;
  type: string;
  hostId: number;
  hostName: string;
  timestamp: string;
}

export async function getUptime(): Promise<{
  uptimeMs: number;
  uptimeSeconds: number;
  formatted: string;
}> {
  try {
    const response = await authApi.get("/dashboard/uptime");
    return response.data;
  } catch (error) {
    throw handleApiError(error, "fetch server uptime");
  }
}

export async function getRecentActivity(
  limit = 20,
): Promise<RecentActivityItem[]> {
  try {
    const response = await authApi.get("/dashboard/activity/recent", {
      params: { limit },
    });
    return response.data;
  } catch (error) {
    throw handleApiError(error, "fetch recent activity");
  }
}

export async function resetRecentActivity(): Promise<void> {
  try {
    await authApi.delete("/dashboard/activity/reset");
  } catch (error) {
    throw handleApiError(error, "reset recent activity");
  }
}
