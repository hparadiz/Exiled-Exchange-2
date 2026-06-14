#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildHelperConfig,
  discoverEventDevices,
} from "linux-evdev-wayland-helper";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argValue(name) {
  const prefix = `${name}=`;
  const arg = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

function splitList(value) {
  return value
    ? value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
    : [];
}

function defaultConfigPath() {
  return path.join(
    os.homedir(),
    ".config",
    "exiled-exchange-2",
    "apt-data",
    "config.json",
  );
}

function defaultHelperPath() {
  const helperName = process.argv.includes("--debug-events")
    ? "linux-evdev-helper-debug"
    : "linux-evdev-helper";
  const packageHelper = path.resolve(
    rootDir,
    "node_modules",
    "linux-evdev-wayland-helper",
    "native",
    "linux-evdev-helper",
    helperName,
  );
  if (fs.existsSync(packageHelper)) return packageHelper;
  const distHelper = path.resolve(rootDir, "dist", helperName);
  if (fs.existsSync(distHelper)) return distHelper;
  return path.resolve(rootDir, "..", "native", "linux-evdev-helper", helperName);
}

function discoverKeyboardEventDevices() {
  return discoverEventDevices();
}

function addAction(actions, shortcut, id, type) {
  if (!shortcut || typeof shortcut !== "string" || shortcut.trim() === "") return;
  actions.push({ id, shortcut: shortcut.trim(), type });
}

function actionsFromConfig(config) {
  const actions = [];
  addAction(actions, config.overlayKey, "overlay", "toggle-overlay");

  for (const widget of config.widgets ?? []) {
    if (widget.wmType === "price-check") {
      const hold = widget.hotkeyHold ? `${widget.hotkeyHold} + ` : "";
      addAction(actions, `${hold}${widget.hotkey}`, "price-check", "copy-item");
      addAction(actions, widget.hotkeyLocked, "price-check-locked", "copy-item");
    } else if (widget.wmType === "item-check") {
      addAction(actions, widget.hotkey, "item-check", "trigger-event");
    } else if (widget.wmType === "delve-grid") {
      addAction(actions, widget.toggleKey, "delve-grid", "trigger-event");
    } else if (widget.wmType === "stash-search") {
      for (const [index, entry] of (widget.entries ?? []).entries()) {
        addAction(actions, entry.hotkey, `stash-search-${index}`, "stash-search");
      }
    } else if (widget.wmType === "timer") {
      addAction(actions, widget.toggleKey, `timer-toggle-${widget.wmId}`, "trigger-event");
      addAction(actions, widget.resetKey, `timer-reset-${widget.wmId}`, "trigger-event");
    } else if (widget.wmType === "item-search") {
      addAction(actions, widget.ocrGemsKey, "ocr-gems", "ocr-text");
    }
  }

  const byShortcut = new Map();
  for (const action of actions) {
    if (!byShortcut.has(action.shortcut)) byShortcut.set(action.shortcut, action);
  }
  return Array.from(byShortcut.values());
}

function backendConfig(config) {
  return (
    config.linuxShortcutBackend ?? {
      backend: "linux-evdev-helper",
      mode: "enabled",
      elevation: "pkexec",
      enableUinput: false,
    }
  );
}

function launchConfigFromSettings(config) {
  const backend = backendConfig(config);
  const actions = actionsFromConfig(config);
  const actionAccelerators = new Set(actions.map((action) => action.shortcut));
  const configuredHotkeys = backend.hotkeys?.length
    ? backend.hotkeys.filter((hotkey) => actionAccelerators.has(hotkey.accelerator))
    : actions.map((action) => ({
        id: action.id,
        accelerator: action.shortcut,
        passthrough: true,
      }));

  const devices =
    process.argv.includes("--all-devices")
      ? discoverKeyboardEventDevices()
      : splitList(process.env.EXILED_EXCHANGE_LINUX_HOTKEY_DEVICES).length > 0
      ? splitList(process.env.EXILED_EXCHANGE_LINUX_HOTKEY_DEVICES)
      : Array.from(
          new Set([...(backend.devices ?? []), ...discoverKeyboardEventDevices()]),
        ).sort();

  if (!devices.length) throw new Error("no /dev/input/event* keyboard devices found");
  for (const device of devices) {
    if (!/^\/dev\/input\/event[0-9]+$/.test(device)) {
      throw new Error(`invalid evdev path: ${device}`);
    }
  }
  if (!configuredHotkeys.length) throw new Error("no settings hotkeys found for helper");

  return buildHelperConfig({
    devices,
    enableUinput: false,
    hotkeys: configuredHotkeys,
  }, process.pid);
}

function spawnCommand(helperPath, elevation) {
  const helperArgs = [];
  if (elevation === "none") return { command: helperPath, args: helperArgs };
  if (elevation === "sudo") return { command: "sudo", args: ["-A", helperPath, ...helperArgs] };
  return { command: "pkexec", args: [helperPath, ...helperArgs] };
}

function formatEvent(event) {
  if (event.type === "hotkey") {
    return `HOTKEY id=${event.id} accelerator=${event.accelerator} ts=${event.timestamp}`;
  }
  if (event.type === "ready") {
    return `READY devices=${event.devices.length} hotkeys=${event.hotkeys}`;
  }
  if (event.type === "configured") {
    return `CONFIGURED hotkeys=${event.hotkeys}`;
  }
  if (event.type === "error") {
    return `ERROR code=${event.code} message=${event.message}${event.detail ? ` detail=${event.detail}` : ""}`;
  }
  return JSON.stringify(event);
}

const configPath = path.resolve(argValue("--config") ?? process.env.EXILED_EXCHANGE_CONFIG ?? defaultConfigPath());
const helperPath = path.resolve(argValue("--helper") ?? process.env.EXILED_EXCHANGE_LINUX_HOTKEY_HELPER ?? defaultHelperPath());
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const backend = backendConfig(config);
const launchConfig = launchConfigFromSettings(config);
const command = spawnCommand(helperPath, backend.elevation ?? "pkexec");

console.log(`Config: ${configPath}`);
console.log(`Helper: ${helperPath}`);
console.log(`Command: ${command.command} ${command.args.join(" ")}`);
console.log(`Devices: ${launchConfig.devices.join(", ")}`);
console.log(`Hotkeys: ${launchConfig.hotkeys.map((hotkey) => `${hotkey.id}=${hotkey.accelerator}`).join(", ")}`);

const child = spawn(command.command, command.args, {
  stdio: ["pipe", "pipe", "pipe"],
});

let stdoutBuffer = "";
child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk.toString("utf8");
  for (;;) {
    const index = stdoutBuffer.indexOf("\n");
    if (index === -1) break;
    const line = stdoutBuffer.slice(0, index).trim();
    stdoutBuffer = stdoutBuffer.slice(index + 1);
    if (!line) continue;
    try {
      console.log(formatEvent(JSON.parse(line)));
    } catch (error) {
      console.log(`INVALID ${line} (${error.message})`);
    }
  }
});

child.stderr.on("data", (chunk) => {
  for (const line of chunk.toString("utf8").split(/\r?\n/)) {
    if (line.trim()) console.error(`helper stderr: ${line.trim()}`);
  }
});

child.on("error", (error) => {
  console.error(`failed to launch helper: ${error.message}`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  console.log(`Helper exited: ${signal ?? `code ${code ?? "unknown"}`}`);
});

child.stdin.end(`${JSON.stringify(launchConfig)}\n`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill("SIGTERM");
    setTimeout(() => process.exit(signal === "SIGINT" ? 130 : 143), 250);
  });
}
