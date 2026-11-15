import { execFileSync } from "node:child_process";

export function currentDisplayModes(report) {
  return (report.SPDisplaysDataType ?? []).flatMap((adapter) =>
    (adapter.spdisplays_ndrvs ?? []).map((display) => {
      const resolution = display._spdisplays_resolution ?? "";
      const resolutionRate = resolution.match(/@\s*(\d+(?:\.\d+)?)\s*Hz\b/i);
      const explicitRate = display.spdisplays_refreshRate?.match(/^(\d+(?:\.\d+)?)\s*Hz$/i);
      const rate = resolutionRate?.[1] ?? explicitRate?.[1];
      return {
        displayId: display._spdisplays_displayID ?? null,
        name: display._name ?? null,
        main: display.spdisplays_main === "spdisplays_yes",
        online: display.spdisplays_online === "spdisplays_yes",
        asleep: display.spdisplays_asleep === "spdisplays_yes",
        currentResolution: resolution || null,
        refreshRate: rate === undefined ? null : Number(rate),
        refreshRateSource: resolutionRate
          ? "_spdisplays_resolution"
          : explicitRate
            ? "spdisplays_refreshRate"
            : null,
      };
    }),
  );
}

export function qualifyDisplayPower({ battery, powerSettings, displays, platform = "darwin" }) {
  if (platform !== "darwin")
    return {
      status: "unsupported",
      reason: "Current OS display-mode qualification supports macOS.",
      platform,
    };
  const modes = currentDisplayModes(displays);
  const currentMode = modes.find((mode) => mode.main && mode.online && !mode.asleep) ?? null;
  const powerConnected = /^Now drawing from ['"]AC Power['"]/m.test(battery);
  const lowPower = powerSettings.match(/^\s*lowpowermode\s+([01])\s*$/m);
  const lowPowerMode = lowPower ? lowPower[1] === "1" : null;
  const refreshRate = currentMode?.refreshRate ?? null;
  const batteryPercent = battery.match(/\b(\d+)%;/);
  const reasons = [];
  if (!powerConnected) reasons.push("AC power is disconnected or unverified.");
  if (lowPowerMode !== false) reasons.push("Low-power mode must explicitly report zero.");
  if (refreshRate === null || refreshRate < 120)
    reasons.push("An awake online main display must report a current mode of at least 120Hz.");
  return {
    status: reasons.length ? "not_eligible" : "eligible",
    platform,
    powerConnected,
    lowPowerMode,
    batteryPercent: batteryPercent ? Number(batteryPercent[1]) : null,
    refreshRate,
    currentMode,
    modes,
    reasons,
  };
}

export function checkDisplayPower({ platform = process.platform, command = execFileSync } = {}) {
  if (platform !== "darwin") return qualifyDisplayPower({ platform });
  const options = { encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024 };
  const battery = command("pmset", ["-g", "batt"], options);
  const powerSettings = command("pmset", ["-g"], options);
  const displays = JSON.parse(command("system_profiler", ["SPDisplaysDataType", "-json"], options));
  return {
    ...qualifyDisplayPower({ battery, powerSettings, displays, platform }),
    capturedAt: new Date().toISOString(),
    raw: { battery, powerSettings, displays },
  };
}

// Playwright also loads this pure helper through its CommonJS test transform.
if (/(?:^|[\\/])check-display-power\.mjs$/.test(process.argv[1] ?? "")) {
  try {
    const result = checkDisplayPower();
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "eligible") process.exitCode = 2;
  } catch (error) {
    console.log(
      JSON.stringify({
        status: "not_eligible",
        reason: "OS power or display evidence could not be read.",
        error: error.message,
      }),
    );
    process.exitCode = 2;
  }
}
