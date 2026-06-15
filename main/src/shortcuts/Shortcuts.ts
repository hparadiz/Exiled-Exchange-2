import { screen, globalShortcut } from "electron";
import { uIOhook, UiohookKey, UiohookWheelEvent } from "uiohook-napi";
import {
  LinuxEvdevHelper,
  type LinuxEvdevHelperEvent,
  type LinuxEvdevHotkey,
} from "linux-evdev-wayland-helper";
import {
  isModKey,
  KeyToElectron,
  mergeTwoHotkeys,
} from "../../../ipc/KeyToCode";
import { typeInChat, stashSearch } from "./text-box";
import { WidgetAreaTracker } from "../windowing/WidgetAreaTracker";
import { HostClipboard } from "./HostClipboard";
import { OcrWorker } from "../vision/link-main";
import type {
  LinuxHotkeyHelperStatus,
  LinuxShortcutBackendConfig,
  ShortcutAction,
} from "../../../ipc/types";
import type { Logger } from "../RemoteLogger";
import type { OverlayWindow } from "../windowing/OverlayWindow";
import type { GameWindow } from "../windowing/GameWindow";
import type { GameConfig } from "../host-files/GameConfig";
import type { ServerEvents } from "../server";

type UiohookKeyT = keyof typeof UiohookKey;
const UiohookToName = Object.fromEntries(
  Object.entries(UiohookKey).map(([k, v]) => [v, k]),
);

interface ShortcutActionWithId {
  id: string;
  entry: ShortcutAction;
}

export class Shortcuts {
  private actions: ShortcutAction[] = [];
  private linuxShortcutBackend?: LinuxShortcutBackendConfig;
  private linuxHelper?: LinuxEvdevHelper;
  private linuxHelperRunning = false;
  private linuxHelperReason = "";
  private linuxHelperActions = new Map<string, ShortcutAction>();
  private linuxHelperHotkeysKey: string | null = null;
  private linuxHelperRuntimeKey: string | null = null;
  private linuxHelperError: string | null = null;
  private stashScroll = false;
  private logKeys = false;
  private areaTracker: WidgetAreaTracker;
  private clipboard: HostClipboard;

  static async create(
    logger: Logger,
    overlay: OverlayWindow,
    poeWindow: GameWindow,
    gameConfig: GameConfig,
    server: ServerEvents,
  ) {
    const ocrWorker = await OcrWorker.create();
    const shortcuts = new Shortcuts(
      logger,
      overlay,
      poeWindow,
      gameConfig,
      server,
      ocrWorker,
    );
    return shortcuts;
  }

  private constructor(
    private logger: Logger,
    private overlay: OverlayWindow,
    private poeWindow: GameWindow,
    private gameConfig: GameConfig,
    private server: ServerEvents,
    private ocrWorker: OcrWorker,
  ) {
    this.areaTracker = new WidgetAreaTracker(server, overlay);
    this.clipboard = new HostClipboard(logger);

    this.poeWindow.on("active-change", (isActive) => {
      process.nextTick(() => {
        if (isActive === this.poeWindow.isActive) {
          if (isActive) {
            this.unregister();
            this.register();
          } else {
            this.unregister();
            this.registerOverlayShortcut();
          }
        }
      });
    });

    this.server.onEventAnyClient("CLIENT->MAIN::user-action", (e) => {
      if (e.action === "stash-search") {
        stashSearch(e.text, this.clipboard, this.overlay);
      } else if (e.action === "restart-linux-hotkey-helper") {
        this.restartLinuxHelper();
      }
    });

    uIOhook.on("keydown", (e) => {
      if (!this.logKeys) return;
      const pressed = eventToString(e);
      this.logger.write(`debug [Shortcuts] Keydown ${pressed}`);
    });
    uIOhook.on("keyup", (e) => {
      if (!this.logKeys) return;
      this.logger.write(
        `debug [Shortcuts] Keyup ${
          UiohookToName[e.keycode] || "not_supported_key"
        }`,
      );
    });

    uIOhook.on("wheel", (e) => {
      if (!e.ctrlKey || !this.poeWindow.isActive || !this.stashScroll) return;

      if (!isStashArea(e, this.poeWindow)) {
        if (e.rotation > 0) {
          uIOhook.keyTap(UiohookKey.ArrowRight);
        } else if (e.rotation < 0) {
          uIOhook.keyTap(UiohookKey.ArrowLeft);
        }
      }
    });
  }

  updateDelay(delay: number) {
    this.clipboard.updateDelay(delay);
  }

  get helperStatus(): LinuxHotkeyHelperStatus {
    const configured =
      process.platform === "linux" &&
      this.linuxShortcutBackend?.backend === "linux-evdev-helper";
    const elevation = this.linuxShortcutBackend?.elevation ?? "pkexec";

    return {
      isWayland: isWaylandSession(),
      configured,
      running: this.linuxHelperRunning,
      elevation,
      command: configured ? this.helperCommandText(elevation) : null,
      capturing: configured ? this.actions.map(({ shortcut }) => shortcut) : [],
      error: this.linuxHelperError,
    };
  }

  updateActions(
    actions: ShortcutAction[],
    stashScroll: boolean,
    logKeys: boolean,
    restoreClipboard: boolean,
    language: string,
    linuxShortcutBackend?: LinuxShortcutBackendConfig,
  ) {
    const shouldRefreshActiveBackend = this.poeWindow.isActive;
    if (shouldRefreshActiveBackend && this.linuxHelper) {
      this.logger.write(
        "info [linux-evdev-helper] Checking helper bindings because hotkeys changed.",
      );
    }

    if (shouldRefreshActiveBackend && !this.linuxHelper) {
      this.unregister();
    }

    this.linuxShortcutBackend = linuxShortcutBackend;
    this.stashScroll = stashScroll;
    this.logKeys = logKeys;
    this.clipboard.updateOptions(restoreClipboard);
    this.ocrWorker.updateOptions(language);

    const copyItemShortcut = mergeTwoHotkeys(
      "Ctrl + C",
      this.gameConfig.showModsKey,
    );
    if (copyItemShortcut !== "Ctrl + C") {
      actions.push({
        shortcut: copyItemShortcut,
        action: { type: "test-only" },
      });
    }

    const allShortcuts = new Set([
      "Ctrl + C",
      "Ctrl + V",
      "Ctrl + A",
      "Ctrl + F",
      "Ctrl + Enter",
      "Home",
      "Delete",
      "Enter",
      "ArrowUp",
      "ArrowRight",
      "ArrowLeft",
      copyItemShortcut,
    ]);

    for (const action of actions) {
      if (
        allShortcuts.has(action.shortcut) &&
        action.action.type !== "test-only"
      ) {
        this.logger.write(
          `error [Shortcuts] Hotkey "${action.shortcut}" reserved by the game will not be registered.`,
        );
      }
    }
    actions = actions.filter((action) => !allShortcuts.has(action.shortcut));

    const duplicates = new Set<string>();
    for (const action of actions) {
      if (allShortcuts.has(action.shortcut)) {
        this.logger.write(
          `error [Shortcuts] It is not possible to use the same hotkey "${action.shortcut}" for multiple actions.`,
        );
        duplicates.add(action.shortcut);
      } else {
        allShortcuts.add(action.shortcut);
      }
    }
    this.actions = actions.filter(
      (action) =>
        !duplicates.has(action.shortcut) ||
        action.action.type === "toggle-overlay",
    );

    if (this.shouldRunLinuxHelper()) {
      if (this.updateRunningLinuxHelper()) return;
      this.startLinuxHelper("wayland");
    } else if (shouldRefreshActiveBackend) {
      this.stopLinuxHelper();
      this.register();
    } else {
      this.stopLinuxHelper();
      this.registerOverlayShortcut();
    }
  }

  private register() {
    if (this.linuxHelperRunning) return;

    if (this.shouldRunLinuxHelper()) {
      this.startLinuxHelper("wayland");
      return;
    }

    this.registerElectronShortcuts();
  }

  private registerElectronShortcuts() {
    let failed = 0;
    for (const entry of this.actions) {
      const isOk = globalShortcut.register(
        shortcutToElectron(entry.shortcut),
        () => {
          this.runAction(entry);
        },
      );

      if (!isOk) {
        failed += 1;
        this.logger.write(
          `error [Shortcuts] Failed to register a shortcut "${entry.shortcut}". It is already registered by another application.`,
        );
      }

      if (entry.action.type === "test-only") {
        globalShortcut.unregister(shortcutToElectron(entry.shortcut));
      }
    }

    return failed;
  }

  private registerOverlayShortcut() {
    const entry = this.actions.find(
      (entry) => entry.action.type === "toggle-overlay",
    );
    if (!entry) return;

    const isOk = globalShortcut.register(
      shortcutToElectron(entry.shortcut),
      () => {
        this.runAction(entry);
      },
    );
    if (!isOk) {
      this.logger.write(
        `error [Shortcuts] Failed to register overlay shortcut "${entry.shortcut}". It is already registered by another application.`,
      );
    }
  }

  private unregister() {
    if (!this.shouldRunLinuxHelper()) {
      this.stopLinuxHelper();
    }
    globalShortcut.unregisterAll();
  }

  private startLinuxHelper(reason: string) {
    if (!this.linuxShortcutBackend) return;

    const hotkeys = this.buildLinuxHotkeys();
    const helper = this.linuxHelper ?? new LinuxEvdevHelper();
    if (!this.linuxHelper) {
      helper.on("event", (event) => {
        this.handleLinuxHelperEvent(event, helper);
      });
    }
    this.linuxHelper = helper;
    this.linuxHelperReason = reason;
    this.linuxHelperRuntimeKey = linuxBackendRuntimeKey(
      this.linuxShortcutBackend,
    );
    this.linuxHelperHotkeysKey = linuxHotkeysKey(hotkeys);
    globalShortcut.unregisterAll();
    this.registerElectronShortcuts();

    const helperPath = getConfiguredLinuxHelperPath(
      this.linuxShortcutBackend.helperPath,
    );
    const options = {
      ...(helperPath ? { helperPath } : {}),
      devices: this.linuxShortcutBackend.devices,
      hotkeys,
      elevation: this.linuxShortcutBackend.elevation ?? "pkexec",
      enableUinput: false as const,
      parentPid: process.pid,
    };
    helper[this.linuxHelperRunning ? "restart" : "start"](options).catch(
      (error) => {
        if (this.linuxHelper !== helper) return;
        this.logger.write(
          `error [linux-evdev-helper] ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        this.linuxHelperError = "helper process failed to start";
        this.stopLinuxHelper();
        if (!this.shouldRunLinuxHelper() && this.poeWindow.isActive) {
          this.registerElectronShortcuts();
        }
        this.emitHelperStatus();
      },
    );
    this.emitHelperStatus();
  }

  private updateRunningLinuxHelper() {
    if (!this.linuxHelper || !this.linuxShortcutBackend) return false;
    const runtimeKey = linuxBackendRuntimeKey(this.linuxShortcutBackend);
    if (runtimeKey !== this.linuxHelperRuntimeKey) return false;

    const hotkeys = this.buildLinuxHotkeys();
    const hotkeysKey = linuxHotkeysKey(hotkeys);
    if (hotkeysKey === this.linuxHelperHotkeysKey) {
      this.emitHelperStatus();
      return true;
    }

    this.linuxHelperHotkeysKey = hotkeysKey;
    this.linuxHelper
      .updateHotkeys(hotkeys)
      .then(() => {
        this.emitHelperStatus();
      })
      .catch((error) => {
        this.logger.write(
          `error [linux-evdev-helper] failed to update hotkeys: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        this.startLinuxHelper("hotkey-update-failed");
      });
    return true;
  }

  private handleLinuxHelperEvent(
    event: LinuxEvdevHelperEvent,
    helper: LinuxEvdevHelper,
  ) {
    if (event.type === "ready") {
      this.linuxHelperRunning = true;
      this.linuxHelperError = null;
      this.logger.write(
        `info [linux-evdev-helper] ready via ${this.linuxHelperReason}; devices=${event.devices.length}, hotkeys=${event.hotkeys}`,
      );
    } else if (event.type === "hotkey") {
      this.runLinuxHelperHotkey(event);
    } else if (event.type === "error") {
      this.logger.write(
        `error [linux-evdev-helper] ${event.code}: ${event.message}${
          event.detail ? ` (${event.detail})` : ""
        }`,
      );
    } else if (event.type === "exit") {
      if (this.linuxHelper === helper) this.linuxHelperRunning = false;
      if (!this.shouldRunLinuxHelper() && this.poeWindow.isActive) {
        this.registerElectronShortcuts();
      }
    }
    this.emitHelperStatus();
  }

  private runLinuxHelperHotkey(
    event: Extract<LinuxEvdevHelperEvent, { type: "hotkey" }>,
  ) {
    const entry = this.linuxHelperActions.get(event.id);
    if (!entry) {
      this.logger.write(
        `warn [linux-evdev-helper] Ignoring unknown hotkey id "${event.id}"`,
      );
      return;
    }
    if (
      !this.poeWindow.isActive &&
      entry.action.type !== "copy-item" &&
      entry.action.type !== "toggle-overlay"
    ) {
      return;
    }
    this.runAction(entry);
  }

  private buildLinuxHotkeys(): LinuxEvdevHotkey[] {
    const actions = this.actionsWithIds();
    this.linuxHelperActions = new Map(
      actions.map(({ id, entry }) => [id, entry]),
    );
    return actions.map(({ id, entry }) => ({
      id,
      accelerator: entry.shortcut,
      passthrough: true,
    }));
  }

  private stopLinuxHelper() {
    const helper = this.linuxHelper;
    helper?.removeAllListeners();
    this.linuxHelper = undefined;
    this.linuxHelperRunning = false;
    this.linuxHelperActions.clear();
    this.linuxHelperHotkeysKey = null;
    this.linuxHelperRuntimeKey = null;
    void helper?.stop();
  }

  private actionsWithIds(): ShortcutActionWithId[] {
    const configured = this.linuxShortcutBackend?.hotkeys ?? [];
    return this.actions.map((entry, index) => ({
      id:
        configured.find((hotkey) => hotkey.accelerator === entry.shortcut)
          ?.id ?? `shortcut-${index}`,
      entry,
    }));
  }

  private restartLinuxHelper() {
    if (!this.shouldRunLinuxHelper()) {
      this.emitHelperStatus();
      return;
    }
    this.logger.write(
      "info [linux-evdev-helper] Restart requested from settings.",
    );
    this.startLinuxHelper("manual-restart");
  }

  private shouldRunLinuxHelper() {
    return (
      process.platform === "linux" &&
      isWaylandSession() &&
      this.linuxShortcutBackend?.backend === "linux-evdev-helper"
    );
  }

  private helperCommandText(
    elevation: LinuxShortcutBackendConfig["elevation"] = "pkexec",
  ) {
    const helperPath = getConfiguredLinuxHelperPath(
      this.linuxShortcutBackend?.helperPath,
    );
    return linuxHelperCommandText(helperPath, elevation);
  }

  private emitHelperStatus() {
    this.server.sendEventTo("broadcast", {
      name: "MAIN->CLIENT::linux-hotkey-helper-state",
      payload: this.helperStatus,
    });
  }

  private runAction(entry: ShortcutAction) {
    if (this.logKeys) {
      this.logger.write(`debug [Shortcuts] Action type: ${entry.action.type}`);
    }

    if (entry.keepModKeys) {
      const nonModKey = entry.shortcut
        .split(" + ")
        .filter((key) => !isModKey(key))[0];
      uIOhook.keyToggle(UiohookKey[nonModKey as UiohookKeyT], "up");
    } else {
      entry.shortcut
        .split(" + ")
        .reverse()
        .forEach((key) => {
          uIOhook.keyToggle(UiohookKey[key as UiohookKeyT], "up");
        });
    }

    if (entry.action.type === "toggle-overlay") {
      this.areaTracker.removeListeners();
      this.overlay.toggleActiveState();
    } else if (entry.action.type === "paste-in-chat") {
      typeInChat(entry.action.text, entry.action.send, this.clipboard);
    } else if (entry.action.type === "trigger-event") {
      this.server.sendEventTo("broadcast", {
        name: "MAIN->CLIENT::widget-action",
        payload: { target: entry.action.target },
      });
    } else if (entry.action.type === "stash-search") {
      stashSearch(entry.action.text, this.clipboard, this.overlay);
    } else if (entry.action.type === "copy-item") {
      const { action } = entry;
      const pressPosition = screen.getCursorScreenPoint();

      this.clipboard
        .readItemText()
        .then((clipboard) => {
          this.areaTracker.removeListeners();
          if (action.focusOverlay) {
            this.overlay.assertOverlayActive();
          } else {
            this.overlay.assertOverlayVisible();
          }
          this.server.sendEventTo("last-active", {
            name: "MAIN->CLIENT::item-text",
            payload: {
              target: action.target,
              clipboard,
              position: pressPosition,
              focusOverlay: Boolean(action.focusOverlay),
            },
          });
        })
        .catch(() => {});

      pressKeysToCopyItemText(
        entry.keepModKeys
          ? entry.shortcut.split(" + ").filter((key) => isModKey(key))
          : undefined,
        this.gameConfig.showModsKey,
      );
    } else if (
      entry.action.type === "ocr-text" &&
      entry.action.target === "heist-gems"
    ) {
      if (process.platform !== "win32") return;

      const { action } = entry;
      const pressTime = Date.now();
      const imageData = this.poeWindow.screenshot();
      this.ocrWorker
        .findHeistGems({
          width: this.poeWindow.bounds.width,
          height: this.poeWindow.bounds.height,
          data: imageData,
        })
        .then((result) => {
          this.server.sendEventTo("last-active", {
            name: "MAIN->CLIENT::ocr-text",
            payload: {
              target: action.target,
              pressTime,
              ocrTime: result.elapsed,
              paragraphs: result.recognized.map((p) => p.text),
            },
          });
        })
        .catch(() => {});
    }
  }
}

function getConfiguredLinuxHelperPath(helperPath?: string) {
  return helperPath ?? process.env.EXILED_EXCHANGE_LINUX_HOTKEY_HELPER;
}

function linuxBackendRuntimeKey(config: LinuxShortcutBackendConfig) {
  return JSON.stringify({
    elevation: config.elevation ?? "pkexec",
    helperPath: config.helperPath ?? null,
    devices: [...(config.devices ?? [])].sort(),
    enableUinput: config.enableUinput ?? false,
  });
}

function linuxHotkeysKey(hotkeys: LinuxEvdevHotkey[]) {
  return JSON.stringify(
    hotkeys.map((hotkey) => ({
      id: hotkey.id,
      accelerator: hotkey.accelerator,
      passthrough: Boolean(hotkey.passthrough),
    })),
  );
}

function linuxHelperCommandText(
  helperPath: string | undefined,
  elevation: LinuxShortcutBackendConfig["elevation"],
) {
  const command = helperPath ?? "<linux-evdev-wayland-helper default>";
  if (elevation === "none") return command;
  if (elevation === "sudo") {
    return "error: sudo elevation is not supported; use pkexec or configure device permissions";
  }
  return `pkexec ${command}`;
}

const isWaylandSession = () =>
  process.env.XDG_SESSION_TYPE === "wayland" ||
  Boolean(process.env.WAYLAND_DISPLAY);

function pressKeysToCopyItemText(
  pressedModKeys: string[] = [],
  showModsKey: string,
) {
  let keys = mergeTwoHotkeys("Ctrl + C", showModsKey).split(" + ");
  keys = keys.filter((key) => key !== "C");
  if (process.platform !== "darwin") {
    // On non-Mac platforms, don't toggle keys that are already being pressed.
    //
    // For unknown reasons, we need to toggle pressed keys on Mac for advanced
    // mod descriptions to be copied. You can test this by setting the shortcut
    // to "Alt + any letter". They'll work with this line, but not if it's
    // commented out.
    keys = keys.filter((key) => !pressedModKeys.includes(key));
  }

  for (const key of keys) {
    uIOhook.keyToggle(UiohookKey[key as UiohookKeyT], "down");
  }

  // finally press `C` to copy text
  uIOhook.keyTap(UiohookKey.C);

  // Timeout to enforce release of keys
  // Game was dropping the release inputs for some reason
  setTimeout(() => {
    keys.reverse();
    for (const key of keys) {
      uIOhook.keyToggle(UiohookKey[key as UiohookKeyT], "up");
    }
  }, 10);
}

function isStashArea(mouse: UiohookWheelEvent, poeWindow: GameWindow): boolean {
  if (
    !poeWindow.bounds ||
    mouse.x > poeWindow.bounds.x + poeWindow.uiSidebarWidth
  )
    return false;

  return (
    mouse.y > poeWindow.bounds.y + (poeWindow.bounds.height * 154) / 1600 &&
    mouse.y < poeWindow.bounds.y + (poeWindow.bounds.height * 1192) / 1600
  );
}

function eventToString(e: {
  keycode: number;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}) {
  const { ctrlKey, shiftKey, altKey } = e;

  let code = UiohookToName[e.keycode];
  if (!code) return "not_supported_key";

  if (code === "Shift" || code === "Alt" || code === "Ctrl") return code;

  if (ctrlKey && shiftKey && altKey) code = `Ctrl + Shift + Alt + ${code}`;
  else if (shiftKey && altKey) code = `Shift + Alt + ${code}`;
  else if (ctrlKey && shiftKey) code = `Ctrl + Shift + ${code}`;
  else if (ctrlKey && altKey) code = `Ctrl + Alt + ${code}`;
  else if (altKey) code = `Alt + ${code}`;
  else if (ctrlKey) code = `Ctrl + ${code}`;
  else if (shiftKey) code = `Shift + ${code}`;

  return code;
}

function shortcutToElectron(shortcut: string) {
  return shortcut
    .split(" + ")
    .map((k) => KeyToElectron[k as keyof typeof KeyToElectron])
    .join("+");
}
