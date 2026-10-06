import type { AxiosInstance } from "axios";
import { authApi } from "@/main-axios";
import { getBasePath } from "@/lib/base-path";
import { getDeviceId } from "@/lib/device-id";
import { websocketAuthProtocols } from "@/lib/ws-auth";
import type { WebSocketConnectionTarget } from "@/lib/connection-origin";

const BACKEND_PORT = 30001;

function pluginApiPath(pluginId: string, path = ""): string {
  const suffix = path && !path.startsWith("/") ? `/${path}` : path;
  return `/plugin-api/${pluginId}${suffix}`;
}

export function createPluginApi(pluginId: string): AxiosInstance {
  const prefix = pluginApiPath(pluginId);

  return new Proxy(authApi, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;

      if (
        property === "get" ||
        property === "delete" ||
        property === "head" ||
        property === "options" ||
        property === "post" ||
        property === "put" ||
        property === "patch"
      ) {
        return (url: string, ...rest: unknown[]) =>
          (value as (...args: unknown[]) => unknown).call(
            target,
            `${prefix}${url.startsWith("/") ? url : `/${url}`}`,
            ...rest,
          );
      }

      return value.bind(target);
    },
  }) as AxiosInstance;
}

export function pluginFetch(
  pluginId: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const base = (authApi.defaults.baseURL ?? "").replace(/\/+$/, "");
  const headers = new Headers(init.headers);
  const deviceId = getDeviceId();
  if (deviceId) headers.set("X-NodeShell-Device-ID", deviceId);

  return fetch(`${base}${pluginApiPath(pluginId, path)}`, {
    credentials: "include",
    ...init,
    headers,
  });
}

export async function pluginWsUrl(
  pluginId: string,
  path: string,
): Promise<WebSocketConnectionTarget> {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  const route = `/plugin-ws/${pluginId}${suffix}`;
  const token = localStorage.getItem("jwt");
  const protocols = websocketAuthProtocols(token);

  const devProxy =
    process.env.NODE_ENV === "development" &&
    !import.meta.env.VITE_API_HOST &&
    (window.location.port === "3000" || window.location.port === "5173");

  const wsProtocol = window.location.protocol === "https:" ? "wss" : "ws";

  if (devProxy) {
    return {
      url: `${wsProtocol}://${window.location.host}/__termix_api/${BACKEND_PORT}${route}`,
      protocols,
    };
  }

  return {
    url: `${wsProtocol}://${window.location.host}${getBasePath()}${route}`,
    protocols,
  };
}
