import { StrictMode, Suspense, lazy, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./ui/index.css";
import "./ui/i18n/i18n";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/sonner";
import { Auth, clearStoredAuth, getStoredAuth } from "@/auth/Auth";
import {
  appReadyPromise,
  getUserInfo,
  logoutUser,
} from "@/main-axios";
import { applyAccentColor, applyFontSize, applyUiFont } from "@/lib/theme";
import type { FontSizeId, UiFontId } from "@/types/ui-types";
import { useServiceWorker } from "@/hooks/use-service-worker";
import { UiPreferencesProvider } from "@/contexts/UiPreferencesContext";
import { BrandingProvider } from "@/contexts/BrandingContext";
import {
  startPluginRuntime,
  stopPluginRuntime,
} from "@/plugin-host/loader";
import { settledPromise } from "@/plugin-host/plugin-store";
import { resetShellBridge } from "@/plugin-host/shell-bridge";
import { preloadPermissions } from "@/hooks/use-permissions";
import { getUserPreferences } from "@/api/open-tabs-api";

const AppShell = lazy(() =>
  import("@/AppShell").then((module) => ({ default: module.AppShell })),
);

type Phase = "verifying" | "auth" | "loading" | "app";

function LoadingScreen() {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-background">
      <div className="size-5 rounded-full border-2 border-primary border-t-transparent animate-spin" />
    </div>
  );
}

async function prepareSignedInRuntime(): Promise<void> {
  await Promise.all([
    startPluginRuntime()
      .catch(() => {})
      .then(() => settledPromise()),
    preloadPermissions(),
    getUserPreferences().catch(() => undefined),
  ]);
}

function App() {
  const stored = getStoredAuth();
  const [phase, setPhase] = useState<Phase>(
    stored?.loggedIn ? "verifying" : "auth",
  );
  const [username, setUsername] = useState(stored?.username ?? "");

  useEffect(() => {
    const savedAccent = localStorage.getItem("nodeshell-accent");
    if (savedAccent) applyAccentColor(savedAccent);

    const savedSize = localStorage.getItem(
      "nodeshell-font-size",
    ) as FontSizeId | null;
    applyFontSize(savedSize ?? "md");

    applyUiFont(
      (localStorage.getItem("nodeshell-ui-font") as UiFontId | null) ??
        "jetbrains-mono",
    );
  }, []);

  useEffect(() => {
    if (phase !== "verifying") return;

    let cancelled = false;
    appReadyPromise
      .then(() => getUserInfo())
      .then(async (user) => {
        if (cancelled) return;
        setUsername(user.username || "");
        setPhase("loading");
        await prepareSignedInRuntime();
        if (!cancelled) setPhase("app");
      })
      .catch(() => {
        if (cancelled) return;
        clearStoredAuth();
        setPhase("auth");
      });

    return () => {
      cancelled = true;
    };
  }, [phase]);

  function handleLogin(name: string): void {
    setUsername(name);
    setPhase("loading");
    void prepareSignedInRuntime().then(() => setPhase("app"));
  }

  function handleLogout(): void {
    setPhase("loading");
    void Promise.allSettled([logoutUser(), stopPluginRuntime()]).finally(() => {
      resetShellBridge();
      clearStoredAuth();
      setUsername("");
      setPhase("auth");
    });
  }

  if (phase === "verifying" || phase === "loading") {
    return <LoadingScreen />;
  }

  if (phase === "auth") {
    return <Auth onLogin={handleLogin} />;
  }

  return (
    <Suspense fallback={<LoadingScreen />}>
      <UiPreferencesProvider>
        <AppShell username={username} onLogout={handleLogout} />
      </UiPreferencesProvider>
    </Suspense>
  );
}

function RootApp() {
  useServiceWorker();
  return <App />;
}

prepareClient();

function prepareClient(): void {
  void import("@/lib/client-cache-version")
    .then(({ prepareClientCacheVersion }) => prepareClientCacheVersion())
    .finally(() => {
      createRoot(document.getElementById("root")!).render(
        <StrictMode>
          <ThemeProvider defaultTheme="dark" storageKey="nodeshell-theme">
            <BrandingProvider>
              <RootApp />
            </BrandingProvider>
          </ThemeProvider>
          <Toaster position="bottom-right" />
        </StrictMode>,
      );
    });
}
