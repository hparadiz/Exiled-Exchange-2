import { describe, expect, it } from "vitest";
import {
  buildHelperConfig,
  buildSpawnCommand,
  defaultHelperPath,
  NdjsonParser,
  parseAccelerator,
} from "../../main/node_modules/linux-evdev-wayland-helper/dist/index.js";
import { selectLinuxEvdevBackend } from "../../main/src/shortcuts/linux-evdev/backend-selection";

describe("linux evdev accelerator parser", () => {
  it("parses common accelerators", () => {
    expect(parseAccelerator("Ctrl+D")).toMatchObject({
      keyCode: "KEY_D",
      modifiers: ["ctrl"],
    });
    expect(parseAccelerator("Ctrl + Alt + D")).toMatchObject({
      keyCode: "KEY_D",
      modifiers: ["alt", "ctrl"],
    });
    expect(parseAccelerator("Shift + Space")).toMatchObject({
      keyCode: "KEY_SPACE",
      modifiers: ["shift"],
    });
    expect(parseAccelerator("F9")).toMatchObject({
      keyCode: "KEY_F9",
      modifiers: [],
    });
  });

  it("rejects unsupported or modifier-only accelerators", () => {
    expect(() => parseAccelerator("Ctrl")).toThrow();
    expect(() => parseAccelerator("Ctrl + D + F")).toThrow();
    expect(() => parseAccelerator("Ctrl + MediaPlayPause")).toThrow();
    expect(() => parseAccelerator("N")).toThrow();
  });
});

describe("linux evdev NDJSON parser", () => {
  it("handles partial lines and invalid lines", () => {
    const parser = new NdjsonParser<unknown>();

    expect(parser.push('{"type":"ready"')).toEqual([]);
    expect(() => parser.push('}\nnot-json\n{"type":"hotkey"}\n')).toThrow();
  });

  it("returns parsed complete lines", () => {
    const parser = new NdjsonParser<unknown>();
    parser.push('{"type":"ready"');
    expect(parser.push('}\n{"type":"hotkey"}\n')).toEqual([
      { type: "ready" },
      { type: "hotkey" },
    ]);
  });
});

describe("linux evdev backend selection", () => {
  const config = { backend: "linux-evdev-helper" as const, devices: ["/dev/input/event4"] };

  it("stays disabled by default and on non-Linux platforms", () => {
    expect(selectLinuxEvdevBackend("darwin", config, 1)).toEqual({
      useHelper: false,
      reason: "unsupported-platform",
    });
    expect(selectLinuxEvdevBackend("linux", undefined, 1)).toEqual({
      useHelper: false,
      reason: "disabled",
    });
  });

  it("uses the helper when explicitly configured", () => {
    expect(selectLinuxEvdevBackend("linux", config, 0)).toEqual({
      useHelper: true,
      reason: "explicit",
    });
  });

  it("uses the helper only after registration failure in fallback mode", () => {
    const fallbackConfig = { ...config, mode: "fallback" as const };
    expect(selectLinuxEvdevBackend("linux", fallbackConfig, 0)).toEqual({
      useHelper: false,
      reason: "disabled",
    });
    expect(selectLinuxEvdevBackend("linux", fallbackConfig, 1)).toEqual({
      useHelper: true,
      reason: "register-failed",
    });
  });
});

describe("linux evdev helper config", () => {
  it("parses configured hotkeys for the package helper protocol", () => {
    const launchConfig = buildHelperConfig({
      devices: ["/dev/input/event4"],
      hotkeys: [{ id: "price-check", accelerator: "Ctrl + D" }],
    });

    expect(launchConfig.hotkeys).toHaveLength(1);
    expect(launchConfig.parentPid).toBe(process.pid);
    expect(launchConfig.hotkeys[0]).toMatchObject({
      id: "price-check",
      accelerator: "Ctrl + D",
      parsed: { keyCode: "KEY_D", modifiers: ["ctrl"] },
    });
  });

  it("rejects unsafe bare letter hotkeys", () => {
    expect(() =>
      buildHelperConfig({
        devices: ["/dev/input/event4"],
        hotkeys: [{ id: "not-an-app-action", accelerator: "N" }],
      }),
    ).toThrow("basic alphabet key accelerators must include a modifier");
  });

  it("rejects non-evdev input paths", () => {
    expect(() =>
      buildHelperConfig({
        devices: ["/tmp/keyboard"],
        hotkeys: [{ id: "price-check", accelerator: "Ctrl + D" }],
      }),
    ).toThrow("invalid evdev device path");
  });
});

describe("linux evdev elevated spawn command", () => {
  it("uses explicit pkexec or no elevation", () => {
    const helperPath = defaultHelperPath();
    expect(buildSpawnCommand({
      helperPath,
      elevation: "pkexec",
      hotkeys: [],
    })).toEqual({
      command: "pkexec",
      args: [helperPath],
    });
    expect(buildSpawnCommand({
      helperPath,
      elevation: "none",
      hotkeys: [],
    })).toEqual({
      command: helperPath,
      args: [],
    });
  });

  it("does not expose sudo shell elevation from the package", () => {
    expect(() =>
      buildSpawnCommand({
        helperPath: defaultHelperPath(),
        elevation: "sudo",
        hotkeys: [],
      }),
    ).toThrow("sudo elevation is intentionally unsupported");
  });
});
