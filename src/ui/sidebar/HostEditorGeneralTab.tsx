import React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/button";
import { Input } from "@/components/input";
import { FakeSwitch, SectionCard, SettingRow } from "@/components/section-card";
import type { Host } from "@/types/ui-types";
import { Activity, Globe, Plus, Tag, Terminal, Trash2, X } from "lucide-react";
import { FolderPathPicker } from "./FolderPathPicker";
import { HostParentPicker } from "./HostParentPicker";
import { getSSHFolders } from "@/main-axios";
import type { HostEditorForm, HostProtocols } from "./HostEditorData";
import { Select2 } from "@/components/select2";
import { useHostProtocols } from "./host-protocols";
import {
  DefaultsOnly,
  HostDefaultBadge,
  HostOnly,
} from "@/lib/host-defaults-context";

type HostEditorSetField = <K extends keyof HostEditorForm>(
  key: K,
  value: HostEditorForm[K],
) => void;

export function HostEditorGeneralTab({
  form,
  setField,
  protocols,
  handleProtocolToggle,
  hosts,
  host,
  simpleMode = false,
}: {
  form: HostEditorForm;
  setField: HostEditorSetField;
  protocols: HostProtocols;
  handleProtocolToggle: (proto: keyof HostProtocols, value: boolean) => void;
  hosts: Host[];
  host: Host | null;
  /** Hides organizational/advanced fields; their values still save unchanged. */
  simpleMode?: boolean;
}) {
  const { t } = useTranslation();
  const pluginProtocols = useHostProtocols();

  // Tracks which picker is shown, independent of whether a value is set yet
  // -- switching to "parent host" mode with nothing picked shouldn't bounce
  // back to the folder picker just because parentHostId is still empty.
  const [placementMode, setPlacementMode] = React.useState<
    "folder" | "parentHost"
  >(form.parentHostId ? "parentHost" : "folder");

  const [folderMeta, setFolderMeta] = React.useState<
    Map<string, { color?: string; icon?: string }>
  >(new Map());

  React.useEffect(() => {
    let cancelled = false;
    const load = () => {
      getSSHFolders()
        .then((folders) => {
          if (cancelled) return;
          const map = new Map<string, { color?: string; icon?: string }>();
          for (const f of folders) {
            map.set(f.name, {
              color: f.color ?? undefined,
              icon: f.icon ?? undefined,
            });
          }
          setFolderMeta(map);
        })
        .catch(() => {});
    };
    load();
    window.addEventListener("termix:hosts-changed", load);
    return () => {
      cancelled = true;
      window.removeEventListener("termix:hosts-changed", load);
    };
  }, []);

  // Folders come from two sources: paths referenced by existing hosts, and
  // standalone folder records (including empty ones just created).
  // Intermediate ancestor paths are expanded so "A" appears even when only
  // "A / B" is directly stored on a host.
  const folderPaths = React.useMemo(() => {
    const set = new Set<string>();
    const addWithAncestors = (path: string) => {
      const parts = path.split(" / ");
      let accumulated = "";
      for (const part of parts) {
        accumulated = accumulated ? `${accumulated} / ${part}` : part;
        set.add(accumulated);
      }
    };
    for (const h of hosts) {
      if (h.folder) addWithAncestors(h.folder);
    }
    for (const path of folderMeta.keys()) addWithAncestors(path);
    return [...set];
  }, [hosts, folderMeta]);

  return (
    <>
      <HostOnly>
        {/* Protocols — enable/disable each connection type */}
        <SectionCard
          title={t("hosts.protocols")}
          icon={<Globe className="size-3.5" />}
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 py-3">
            {[
              {
                proto: "enableSsh",
                label: t("hosts.tabSsh"),
                desc: t("hosts.secureShell"),
                icon: <Terminal className="size-4" />,
              },
              ...pluginProtocols.map((protocol) => {
                const Icon = protocol.icon;
                return {
                  proto: protocol.settingKey,
                  label: t(protocol.titleKey),
                  desc: protocol.descriptionKey
                    ? t(protocol.descriptionKey)
                    : "",
                  icon: <Icon className="size-4" />,
                };
              }),
            ].map(({ proto, label, desc, icon }) => {
              const enabled = !!protocols[proto];
              return (
                <div
                  key={proto}
                  className={`flex items-center gap-3 p-3 border transition-colors ${enabled ? "border-accent-brand/20 bg-accent-brand/5" : "border-border bg-muted/10"}`}
                >
                  <div
                    className={`size-8 flex items-center justify-center shrink-0 ${enabled ? "text-accent-brand" : "text-muted-foreground/30"}`}
                  >
                    {icon}
                  </div>
                  <div className="flex flex-col gap-1 flex-1 min-w-0">
                    <span
                      className={`text-xs font-bold ${enabled ? "text-foreground" : "text-muted-foreground/50"}`}
                    >
                      {label}
                    </span>
                    <span className="text-[10px] text-muted-foreground/50">
                      {desc}
                    </span>
                  </div>
                  <FakeSwitch
                    checked={enabled}
                    onChange={(v: boolean) => handleProtocolToggle(proto, v)}
                  />
                </div>
              );
            })}
          </div>
        </SectionCard>

        <SectionCard
          title={t("hosts.connectionDetails")}
          icon={<Globe className="size-3.5" />}
        >
          <div className="flex flex-col gap-4 py-3">
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                {t("hosts.addressIp")}
              </label>
              <Input
                placeholder="10.0.0.1 or example.com"
                value={form.ip}
                onChange={(e) => setField("ip", e.target.value)}
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  {t("hosts.friendlyName")}
                </label>
                <Input
                  placeholder="e.g. Web Server Production"
                  value={form.name}
                  onChange={(e) => setField("name", e.target.value)}
                />
              </div>
            </div>
          </div>
        </SectionCard>

        {!Object.values(protocols).some(Boolean) && (
          <div className="flex items-center gap-3 p-3 border border-border bg-muted/20 text-xs text-muted-foreground">
            <Globe className="size-4 shrink-0 text-muted-foreground/40" />
            <span>{t("hosts.enableAtLeastOneProtocol")}</span>
          </div>
        )}
      </HostOnly>

      <SectionCard
        title={t("hosts.folderAndAdvanced")}
        icon={<Tag className="size-3.5" />}
        className={simpleMode ? "hidden" : undefined}
      >
        <HostOnly>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 py-3">
            <div className="flex flex-col gap-1.5 col-span-2 md:col-span-1">
              <div className="flex items-center justify-between">
                <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  {placementMode === "parentHost"
                    ? t("hosts.parentHost")
                    : t("hosts.folder")}
                </label>
                <button
                  type="button"
                  onClick={() => {
                    if (placementMode === "parentHost") {
                      setPlacementMode("folder");
                      setField("parentHostId", "");
                    } else {
                      setPlacementMode("parentHost");
                      setField("folder", "");
                    }
                  }}
                  className="text-[10px] text-accent-brand hover:underline"
                >
                  {placementMode === "parentHost"
                    ? t("hosts.useFolderInstead")
                    : t("hosts.useParentHostInstead")}
                </button>
              </div>
              {placementMode === "parentHost" ? (
                <HostParentPicker
                  value={String(form.parentHostId)}
                  onChange={(hostId) => setField("parentHostId", hostId)}
                  hosts={hosts}
                  excludeHostId={host?.id}
                />
              ) : (
                <FolderPathPicker
                  value={form.folder}
                  onChange={(path) => setField("folder", path)}
                  folderPaths={folderPaths}
                  folderMeta={folderMeta}
                />
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                {t("hosts.tags")}
              </label>
              <div className="flex flex-wrap items-center gap-1 min-h-9 px-2 py-1 border border-border bg-background focus-within:ring-1 focus-within:ring-ring">
                {form.tags.map((tag) => (
                  <span
                    key={tag}
                    className="flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] bg-muted border border-border/60 text-foreground"
                  >
                    {tag}
                    <button
                      type="button"
                      onClick={() =>
                        setField(
                          "tags",
                          form.tags.filter((tg) => tg !== tag),
                        )
                      }
                      className="text-muted-foreground hover:text-destructive ml-0.5"
                    >
                      <X className="size-2.5" />
                    </button>
                  </span>
                ))}
                <input
                  className="flex-1 min-w-16 text-xs bg-transparent outline-none placeholder:text-muted-foreground/50"
                  placeholder={form.tags.length === 0 ? t("hosts.addTag") : ""}
                  value={form.tagInput}
                  onChange={(e) => setField("tagInput", e.target.value)}
                  onKeyDown={(e) => {
                    if (
                      (e.key === " " || e.key === "Enter") &&
                      form.tagInput.trim()
                    ) {
                      e.preventDefault();
                      const tag = form.tagInput.trim();
                      if (!form.tags.includes(tag))
                        setField("tags", [...form.tags, tag]);
                      setField("tagInput", "");
                    } else if (
                      e.key === "Backspace" &&
                      !form.tagInput &&
                      form.tags.length > 0
                    ) {
                      setField("tags", form.tags.slice(0, -1));
                    }
                  }}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5 col-span-2">
              <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                {t("hosts.privateNotes")}
              </label>
              <textarea
                rows={3}
                placeholder={t("hosts.privateNotesPlaceholder")}
                className="w-full px-3 py-2 text-xs bg-background border border-border text-foreground placeholder:text-muted-foreground resize-none outline-none focus:ring-1 focus:ring-ring"
                value={form.notes}
                onChange={(e) => setField("notes", e.target.value)}
              />
            </div>
            <SettingRow
              label={t("hosts.pinToTop")}
              description={t("hosts.pinToTopDesc")}
            >
              <FakeSwitch
                checked={form.pin}
                onChange={(v) => setField("pin", v)}
              />
            </SettingRow>
          </div>
        </HostOnly>
        <div className="flex flex-col gap-3 border-t border-border pt-4 pb-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                {t("hosts.portKnockingSequence")}
              </span>
              <HostDefaultBadge settingKey="core.portKnockSequence" />
              <a
                href="https://docs.termix.site/features/networking/port-knocking"
                target="_blank"
                rel="noreferrer"
                className="text-[10px] text-accent-brand hover:underline"
              >
                {t("hosts.docsLink")}
              </a>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-[10px] px-2 border-accent-brand/40 text-accent-brand"
              onClick={() =>
                setField("portKnockSequence", [
                  ...form.portKnockSequence,
                  { port: 0, protocol: "tcp" as const, delay: 0 },
                ])
              }
            >
              <Plus className="size-3 mr-1" /> {t("hosts.addKnockBtn")}
            </Button>
          </div>
          {form.portKnockSequence.length === 0 && (
            <p className="text-[10px] text-muted-foreground/50">
              {t("hosts.noPortKnocking")}
            </p>
          )}
          <div className="flex flex-col gap-2">
            {form.portKnockSequence.map((knock, i) => (
              <div
                key={i}
                className="flex items-end gap-1.5 p-1.5 bg-muted/30 border border-border"
              >
                <span className="text-[9px] font-bold text-muted-foreground/50 mb-1.5 shrink-0">
                  {i + 1}.
                </span>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[9px] text-muted-foreground/60 uppercase font-bold tracking-wide px-0.5">
                    {t("hosts.knockPort")}
                  </span>
                  <Input
                    className="h-7 text-xs w-20 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    placeholder="8080"
                    type="number"
                    value={knock.port}
                    onChange={(e) => {
                      const updated = [...form.portKnockSequence];
                      updated[i] = {
                        ...updated[i],
                        port: Number(e.target.value),
                      };
                      setField("portKnockSequence", updated);
                    }}
                  />
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[9px] text-muted-foreground/60 uppercase font-bold tracking-wide px-0.5">
                    {t("hosts.protocol")}
                  </span>
                  <Select2
                    className="h-7 text-[10px] bg-background border border-border px-1"
                    value={knock.protocol}
                    onChange={(e) => {
                      const updated = [...form.portKnockSequence];
                      updated[i] = {
                        ...updated[i],
                        protocol: e.target.value as "tcp" | "udp",
                      };
                      setField("portKnockSequence", updated);
                    }}
                  >
                    <option value="tcp">TCP</option>
                    <option value="udp">UDP</option>
                  </Select2>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[9px] text-muted-foreground/60 uppercase font-bold tracking-wide px-0.5">
                    {t("hosts.delayAfterMs")}
                  </span>
                  <Input
                    className="h-7 text-xs w-20 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    placeholder="100"
                    type="number"
                    value={knock.delay}
                    onChange={(e) => {
                      const updated = [...form.portKnockSequence];
                      updated[i] = {
                        ...updated[i],
                        delay: Number(e.target.value),
                      };
                      setField("portKnockSequence", updated);
                    }}
                  />
                </div>
                <button
                  className="text-destructive p-1 mb-0.5"
                  onClick={() =>
                    setField(
                      "portKnockSequence",
                      form.portKnockSequence.filter((_, idx) => idx !== i),
                    )
                  }
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
        <DefaultsOnly settingKey="core.jumpHosts">
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  {t("hosts.jumpHostChainLabel")}
                  <HostDefaultBadge settingKey="core.jumpHosts" />
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 text-[10px] px-2 border-accent-brand/40 text-accent-brand"
                  onClick={() =>
                    setField("jumpHosts", [...form.jumpHosts, { hostId: "" }])
                  }
                >
                  <Plus className="size-3 mr-1" /> {t("hosts.addJumpBtn")}
                </Button>
              </div>
              {form.jumpHosts.length === 0 && (
                <p className="text-[10px] text-muted-foreground/50">
                  {t("hosts.noJumpHosts")}
                </p>
              )}
              <div className="flex flex-col gap-2">
                {form.jumpHosts.map((jh, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 p-2 bg-background border border-border"
                  >
                    <span className="text-[10px] font-bold text-muted-foreground shrink-0">
                      {i + 1}.
                    </span>
                    <Select2
                      className="flex h-7 flex-1 border border-border bg-background px-2 py-0 text-xs outline-none focus:ring-1 focus:ring-ring"
                      value={jh.hostId}
                      onChange={(e) => {
                        const updated = [...form.jumpHosts];
                        updated[i] = { hostId: e.target.value };
                        setField("jumpHosts", updated);
                      }}
                    >
                      <option value="">{t("hosts.selectAServer")}</option>
                      {hosts
                        .filter((h) => (host ? h.id !== host.id : true))
                        .map((h) => (
                          <option key={h.id} value={h.id}>
                            {h.name || h.ip}
                          </option>
                        ))}
                    </Select2>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 text-destructive"
                      onClick={() =>
                        setField(
                          "jumpHosts",
                          form.jumpHosts.filter((_, idx) => idx !== i),
                        )
                      }
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          </DefaultsOnly>
      </SectionCard>

      <SectionCard
        title={t("hosts.statusChecksLabel")}
        icon={<Activity className="size-3.5" />}
      >
        <div className="flex flex-col gap-0 py-1">
          <SettingRow
            label={t("hosts.enableStatusChecks")}
            description={t("hosts.enableStatusChecksDesc")}
            defaultKey="core.statusCheckEnabled"
          >
            <FakeSwitch
              checked={form.statusCheckEnabled}
              onChange={(value) => setField("statusCheckEnabled", value)}
            />
          </SettingRow>
          {form.statusCheckEnabled && (
            <SettingRow
              label={t("hosts.useGlobalInterval")}
              description={t("hosts.useGlobalIntervalDesc")}
              defaultKey="core.statusCheckInterval"
            >
              <FakeSwitch
                checked={form.statusCheckInterval === null}
                onChange={(useGlobal) =>
                  setField("statusCheckInterval", useGlobal ? null : 60)
                }
              />
            </SettingRow>
          )}
          {form.statusCheckEnabled && form.statusCheckInterval !== null && (
            <SettingRow
              label={t("hosts.checkIntervalS")}
              description={t("hosts.checkIntervalDesc")}
            >
              <Input
                type="number"
                min={5}
                max={86400}
                value={form.statusCheckInterval}
                onChange={(e) =>
                  setField("statusCheckInterval", Number(e.target.value))
                }
                className="w-20 h-7 text-xs text-right [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
            </SettingRow>
          )}
        </div>
      </SectionCard>
    </>
  );
}
