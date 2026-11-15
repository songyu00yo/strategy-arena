export type SystemDisplayReport = {
  SPDisplaysDataType?: Array<{
    spdisplays_ndrvs?: Array<{
      _name?: string;
      _spdisplays_displayID?: string;
      _spdisplays_resolution?: string;
      spdisplays_refreshRate?: string;
      spdisplays_main?: string;
      spdisplays_online?: string;
      spdisplays_asleep?: string;
    }>;
  }>;
};
export type CurrentDisplayMode = {
  displayId: string | null;
  name: string | null;
  main: boolean;
  online: boolean;
  asleep: boolean;
  currentResolution: string | null;
  refreshRate: number | null;
  refreshRateSource: string | null;
};
export function currentDisplayModes(report: SystemDisplayReport): CurrentDisplayMode[];
export type DisplayPowerQualification = {
  status: "eligible" | "not_eligible" | "unsupported";
  reason?: string;
  platform: string;
  powerConnected?: boolean;
  lowPowerMode?: boolean | null;
  batteryPercent?: number | null;
  refreshRate?: number | null;
  currentMode?: CurrentDisplayMode | null;
  modes?: CurrentDisplayMode[];
  reasons?: string[];
  capturedAt?: string;
  raw?: { battery: string; powerSettings: string; displays: SystemDisplayReport };
};
export function qualifyDisplayPower(input: {
  battery?: string;
  powerSettings?: string;
  displays?: SystemDisplayReport;
  platform?: string;
}): DisplayPowerQualification;
export function checkDisplayPower(options?: { platform?: string }): DisplayPowerQualification;
