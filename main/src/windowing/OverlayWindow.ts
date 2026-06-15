import path from "path";
import {
  BrowserWindow,
  dialog,
  shell,
  Menu,
  screen,
  type Rectangle,
} from "electron";
import {
  OverlayController,
  OVERLAY_WINDOW_OPTS,
} from "electron-overlay-window";
import type { ServerEvents } from "../server";
import type { Logger } from "../RemoteLogger";
import type { GameWindow } from "./GameWindow";

export class OverlayWindow {
  public isInteractable = false;
  private window?: BrowserWindow;
  private overlayKey: string = "Shift + Space";
  private isOverlayKeyUsed = false;
  private pendingSettingsOpen = false;
  private bypassGameWindow =
    process.env.VITE_DEV_SERVER_URL != null ||
    process.env.EXILED_EXCHANGE_BYPASS_POE_WINDOW === "1";

  constructor(
    private server: ServerEvents,
    private logger: Logger,
    private poeWindow: GameWindow,
  ) {
    this.server.onEventAnyClient(
      "OVERLAY->MAIN::focus-game",
      this.assertGameActive,
    );
    this.poeWindow.on("active-change", this.handlePoeWindowActiveChange);
    this.poeWindow.onAttach(this.handleOverlayAttached);

    if (process.argv.includes("--no-overlay")) return;

    this.window = new BrowserWindow({
      icon: path.join(__dirname, process.env.STATIC!, "icon.png"),
      ...(this.bypassGameWindow
        ? {
            frame: false,
            show: false,
            transparent: true,
            resizable: false,
            fullscreenable: true,
            skipTaskbar: true,
            hasShadow: false,
            backgroundColor: "#00000000",
          }
        : OVERLAY_WINDOW_OPTS),
      width: 800,
      height: 600,
      webPreferences: {
        allowRunningInsecureContent: false,
        sandbox: !this.bypassGameWindow,
        webviewTag: !this.bypassGameWindow,
        spellcheck: false,
      },
    });

    this.window.setMenu(
      Menu.buildFromTemplate([
        { role: "editMenu" },
        { role: "reload" },
        { role: "toggleDevTools" },
      ]),
    );

    this.window.webContents.on("before-input-event", this.handleExtraCommands);
    this.window.webContents.on(
      "did-attach-webview",
      (_, webviewWebContents) => {
        webviewWebContents.on("before-input-event", this.handleExtraCommands);
      },
    );

    this.window.webContents.setWindowOpenHandler((details) => {
      shell.openExternal(details.url);
      return { action: "deny" };
    });

    if (this.bypassGameWindow) {
      this.fillMouseDisplay();
    }

    this.window.webContents.on("did-finish-load", () => {
      if (this.pendingSettingsOpen) {
        this.emitOpenSettings();
      }
    });
  }

  loadAppPage(port: number) {
    const url =
      process.env.VITE_DEV_SERVER_URL || `http://127.0.0.1:${port}/index.html`;

    if (!this.window) {
      shell.openExternal(url);
      return;
    }

    if (process.env.VITE_DEV_SERVER_URL) {
      this.window.loadURL(url);
      this.window.webContents.openDevTools({ mode: "detach", activate: false });
    } else {
      this.window.loadURL(url);
    }
  }

  assertOverlayActive = () => {
    if (this.bypassGameWindow && this.window) {
      this.isInteractable = true;
      this.assertOverlayVisible();
      this.window.focus();
      this.poeWindow.isActive = false;
      this.emitFocusState();
      return;
    }

    if (!this.isInteractable) {
      this.isInteractable = true;
      OverlayController.activateOverlay();
      this.poeWindow.isActive = false;
    }
  };

  assertOverlayVisible = () => {
    if (!this.bypassGameWindow || !this.window) return;

    this.fillMouseDisplay();
    this.window.setSkipTaskbar(true);
    if (this.window.isMinimized()) {
      this.window.restore();
    }
    this.window.showInactive();
    this.window.maximize();
    this.window.moveTop();
  };

  openSettings = () => {
    this.pendingSettingsOpen = true;
    this.assertOverlayActive();
    this.emitOpenSettings();
    setTimeout(this.emitOpenSettings, 250);
    setTimeout(this.emitOpenSettings, 1000);
  };

  private fillMouseDisplay() {
    if (!this.window) return;

    const bounds = getMouseDisplayBounds();
    this.window.setBounds(bounds);
  }

  assertGameActive = () => {
    if (this.bypassGameWindow) {
      this.isInteractable = false;
      this.poeWindow.isActive = false;
      this.pendingSettingsOpen = false;
      this.emitHideExclusiveWidget();
      this.emitFocusState();
      this.window?.hide();
      return;
    }

    if (this.isInteractable) {
      this.isInteractable = false;
      this.emitHideExclusiveWidget();
      OverlayController.focusTarget();
      this.poeWindow.isActive = true;
    }
  };

  toggleActiveState = () => {
    this.isOverlayKeyUsed = true;
    if (this.isInteractable) {
      this.assertGameActive();
    } else {
      this.assertOverlayActive();
    }
  };

  updateOpts(overlayKey: string, windowTitle: string) {
    this.overlayKey = overlayKey;
    if (this.bypassGameWindow) {
      this.server.sendEventTo("broadcast", {
        name: "MAIN->OVERLAY::overlay-attached",
        payload: undefined,
      });
      return;
    }
    this.poeWindow.attach(this.window, windowTitle);
  }

  private handleExtraCommands = (
    event: Electron.Event,
    input: Electron.Input,
  ) => {
    if (input.type !== "keyDown") return;

    let { code, control: ctrlKey, shift: shiftKey, alt: altKey } = input;

    if (code.startsWith("Key")) {
      code = code.slice("Key".length);
    } else if (code.startsWith("Digit")) {
      code = code.slice("Digit".length);
    }

    if (shiftKey && altKey) code = `Shift + Alt + ${code}`;
    else if (ctrlKey && shiftKey) code = `Ctrl + Shift + ${code}`;
    else if (ctrlKey && altKey) code = `Ctrl + Alt + ${code}`;
    else if (altKey) code = `Alt + ${code}`;
    else if (ctrlKey) code = `Ctrl + ${code}`;
    else if (shiftKey) code = `Shift + ${code}`;

    switch (code) {
      case "Escape":
      case "Ctrl + W": {
        event.preventDefault();
        process.nextTick(this.assertGameActive);
        break;
      }
      case this.overlayKey: {
        event.preventDefault();
        process.nextTick(this.toggleActiveState);
        break;
      }
    }
  };

  private handleOverlayAttached = (hasAccess?: boolean) => {
    if (hasAccess === false) {
      this.logger.write(
        "error [Overlay] PoE2 is running with administrator rights",
      );

      dialog.showErrorBox(
        "PoE2 window - No access",
        // ----------------------
        "Path of Exile 2 is running with administrator rights.\n" +
          "\n" +
          "You need to restart Exiled Exchange 2 with administrator rights.",
      );
    } else {
      this.server.sendEventTo("broadcast", {
        name: "MAIN->OVERLAY::overlay-attached",
        payload: undefined,
      });
    }
  };

  private handlePoeWindowActiveChange = (isActive: boolean) => {
    if (isActive && this.isInteractable) {
      this.isInteractable = false;
    }
    this.server.sendEventTo("broadcast", {
      name: "MAIN->OVERLAY::focus-change",
      payload: {
        game: isActive,
        overlay: this.isInteractable,
        usingHotkey: this.isOverlayKeyUsed,
      },
    });
    this.isOverlayKeyUsed = false;
  };

  private emitFocusState() {
    this.server.sendEventTo("broadcast", {
      name: "MAIN->OVERLAY::focus-change",
      payload: {
        game: this.poeWindow.isActive,
        overlay: this.isInteractable,
        usingHotkey: this.isOverlayKeyUsed,
      },
    });
    this.isOverlayKeyUsed = false;
  }

  private emitOpenSettings = () => {
    this.server.sendEventTo("broadcast", {
      name: "MAIN->CLIENT::open-settings",
      payload: undefined,
    });
  };

  private emitHideExclusiveWidget = () => {
    this.server.sendEventTo("broadcast", {
      name: "MAIN->OVERLAY::hide-exclusive-widget",
      payload: undefined,
    });
  };
}

function getMouseDisplayBounds(): Rectangle {
  return clampToDisplays(
    screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds,
  );
}

function clampToDisplays(bounds: Rectangle): Rectangle {
  const displays = screen.getAllDisplays();
  const display =
    displays.find((display) => intersects(bounds, display.bounds)) ??
    screen.getDisplayNearestPoint({
      x: bounds.x + Math.round(bounds.width / 2),
      y: bounds.y + Math.round(bounds.height / 2),
    });

  const area = display.bounds;
  return {
    width: Math.min(bounds.width, area.width),
    height: Math.min(bounds.height, area.height),
    x: Math.min(
      Math.max(bounds.x, area.x),
      area.x + area.width - Math.min(bounds.width, area.width),
    ),
    y: Math.min(
      Math.max(bounds.y, area.y),
      area.y + area.height - Math.min(bounds.height, area.height),
    ),
  };
}

function intersects(a: Rectangle, b: Rectangle) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}
