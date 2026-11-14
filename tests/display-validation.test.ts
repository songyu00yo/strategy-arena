import { describe, expect, it } from "vitest";
import { currentDisplayModes } from "./display/display-validation";

describe("current OS display-mode evidence", () => {
  it("reads the refresh rate from the current resolution field", () => {
    expect(
      currentDisplayModes({
        SPDisplaysDataType: [
          {
            spdisplays_ndrvs: [
              {
                _name: "Color LCD",
                _spdisplays_displayID: "1",
                _spdisplays_resolution: "1800 x 1169 @ 120.00Hz",
                spdisplays_online: "spdisplays_yes",
                spdisplays_main: "spdisplays_yes",
              },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        displayId: "1",
        name: "Color LCD",
        main: true,
        online: true,
        asleep: false,
        currentResolution: "1800 x 1169 @ 120.00Hz",
        refreshRate: 120,
        refreshRateSource: "_spdisplays_resolution",
      },
    ]);
  });

  it("keeps an explicitly reported 60Hz current mode", () => {
    const [display] = currentDisplayModes({
      SPDisplaysDataType: [
        {
          spdisplays_ndrvs: [
            {
              _name: "240Hz capable display",
              _spdisplays_resolution: "1920 x 1080 @ 60Hz",
              spdisplays_main: "spdisplays_yes",
              spdisplays_online: "spdisplays_yes",
            },
          ],
        },
      ],
    });
    expect(display.refreshRate).toBe(60);
  });

  it("requires an explicit current mode even when the product label advertises high refresh", () => {
    const [display] = currentDisplayModes({
      SPDisplaysDataType: [
        {
          spdisplays_ndrvs: [
            {
              _name: "ProMotion 120Hz",
              _spdisplays_resolution: "1800 x 1169",
            },
          ],
        },
      ],
    });
    expect(display.refreshRate).toBeNull();
    expect(display.refreshRateSource).toBeNull();
  });

  it("accepts the dedicated current refresh-rate field", () => {
    const [display] = currentDisplayModes({
      SPDisplaysDataType: [
        {
          spdisplays_ndrvs: [
            {
              spdisplays_refreshRate: "144 Hz",
            },
          ],
        },
      ],
    });
    expect(display.refreshRate).toBe(144);
    expect(display.refreshRateSource).toBe("spdisplays_refreshRate");
  });

  it("retains sleep and connection state for the physical-session gate", () => {
    const [display] = currentDisplayModes({
      SPDisplaysDataType: [
        {
          spdisplays_ndrvs: [
            {
              _spdisplays_resolution: "1800 x 1169 @ 120Hz",
              spdisplays_asleep: "spdisplays_yes",
              spdisplays_online: "spdisplays_yes",
            },
          ],
        },
      ],
    });
    expect(display.asleep).toBe(true);
    expect(display.main).toBe(false);
    expect(display.online).toBe(true);
  });

  it("retains each adapter's display independently", () => {
    const displays = currentDisplayModes({
      SPDisplaysDataType: [
        { spdisplays_ndrvs: [{ _name: "Main", _spdisplays_resolution: "1800 x 1169 @ 120Hz" }] },
        { spdisplays_ndrvs: [{ _name: "External", _spdisplays_resolution: "1920 x 1080 @ 60Hz" }] },
      ],
    });
    expect(displays.map((display) => display.refreshRate)).toEqual([120, 60]);
  });

  it("keeps missing current-mode data explicit", () => {
    expect(currentDisplayModes({})).toEqual([]);
    expect(currentDisplayModes({ SPDisplaysDataType: [{}] })).toEqual([]);
  });
});
