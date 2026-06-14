import type { LinuxShortcutBackendConfig } from "../../../../ipc/types";

interface LinuxEvdevBackendSelection {
  useHelper: boolean;
  reason: "disabled" | "explicit" | "register-failed" | "unsupported-platform";
}

export function selectLinuxEvdevBackend(
  platform: NodeJS.Platform,
  config: LinuxShortcutBackendConfig | undefined,
  failedElectronRegistrations: number,
): LinuxEvdevBackendSelection {
  if (platform !== "linux") {
    return { useHelper: false, reason: "unsupported-platform" };
  }

  if (!config || config.backend !== "linux-evdev-helper") {
    return { useHelper: false, reason: "disabled" };
  }

  if (
    config.mode !== "fallback" &&
    process.env.EXILED_EXCHANGE_LINUX_HOTKEYS !== "fallback"
  ) {
    return { useHelper: true, reason: "explicit" };
  }

  if (failedElectronRegistrations > 0) {
    return { useHelper: true, reason: "register-failed" };
  }

  return { useHelper: false, reason: "disabled" };
}
