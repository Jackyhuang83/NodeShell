import "@xterm/xterm/css/xterm.css";
import { Copy, SquareTerminal, Terminal } from "lucide-react";
import type {
  PluginTabRecord,
  TabProps,
  TermixApp,
} from "@termix/plugin-sdk/frontend";
import { loadTerminal } from "./terminal/TerminalTabContent";
import { TerminalTabWithRegistry } from "./TerminalTabWithRegistry";
import { HostTerminalSection } from "./settings/HostTerminalSection";
import { hostSetting } from "./terminal-api";
import {
  TERMINAL_KEYBINDING_DEFAULTS,
  validateSendControlCode,
  validateSendText,
} from "./lib/keybinding-dispatch";
import {
  PasteNote,
  SendControlCodeEditor,
  SendTextEditor,
} from "./lib/keybinding-editors";

interface TerminalOpenOptions {
  path?: string;
  label?: string;
}

export function activate(app: TermixApp): void {
  app.registerTab("terminal", TerminalTabWithRegistry, {
    icon: Terminal,
    titleKey: "nav.terminal",
    persistent: true,
    session: true,
    commandTarget: true,
    ownBackground: true,
    restore: (host) => !!host.enableSsh,
    activityTypes: ["terminal"],
    preload: loadTerminal,
  });

  app.registerAction(
    "terminal.duplicateTab",
    ((_handle: unknown, tab?: PluginTabRecord) => {
      if (tab?.type === "terminal" && tab.host) {
        app.tabs.openTab(tab.host, "terminal", { forceNewTab: true });
      }
    }) as never,
    { permission: "use" },
  );

  app.registerSlotContribution("tab.menu", {
    actionId: "terminal.duplicateTab",
    titleKey: "terminal.duplicateTab",
    icon: Copy,
    kind: "button",
    when: ({ tab }) => {
      const target = tab as PluginTabRecord | undefined;
      return target?.type === "terminal" && !!target.host;
    },
  });

  app.registerHostAction({
    id: "terminal",
    titleKey: "nav.terminal",
    icon: Terminal,
    kind: "connect",
    priority: 100,
    order: 10,
    tabType: "terminal",
    when: (host) =>
      !!host.enableSsh && hostSetting(host, "enableTerminal", true),
  });

  app.registerHostEditorSection({
    id: "terminal",
    group: "ssh",
    titleKey: "hosts.tabTerminal",
    icon: SquareTerminal,
    order: 10,
    defaults: true,
    component: HostTerminalSection,
  });

  app.registerKeybindingAction({ id: "copy", titleKey: "keybindings.copy" });
  app.registerKeybindingAction({
    id: "paste",
    titleKey: "keybindings.paste",
    editor: PasteNote,
  });
  app.registerKeybindingAction({
    id: "sendControlCode",
    titleKey: "keybindings.sendControlCode",
    editor: SendControlCodeEditor,
    validate: validateSendControlCode,
  });
  app.registerKeybindingAction({
    id: "sendText",
    titleKey: "keybindings.sendText",
    editor: SendTextEditor,
    validate: validateSendText,
  });
  for (const binding of TERMINAL_KEYBINDING_DEFAULTS) {
    app.registerKeybindingDefault(binding);
  }

  // Used by File Manager to open a shell at the current remote path.
  app.registerAction("terminal.open", ((
    host: Parameters<TermixApp["tabs"]["openTab"]>[0],
    options: TerminalOpenOptions = {},
  ) =>
    app.tabs.openTab(host, "terminal", {
      forceNewTab: true,
      label: options.label,
      data: options.path ? { initialPath: options.path } : undefined,
    })) as never);
}
