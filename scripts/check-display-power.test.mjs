import assert from "node:assert/strict";
import test from "node:test";
import { checkDisplayPower, qualifyDisplayPower } from "./check-display-power.mjs";

const eligible = {
  battery: "Now drawing from 'AC Power'\n -InternalBattery-0 12%; charging; 1:00 remaining\n",
  powerSettings: "Currently in use:\n lowpowermode 0\n",
  displays: {
    SPDisplaysDataType: [
      {
        spdisplays_ndrvs: [
          {
            _name: "Color LCD",
            _spdisplays_resolution: "1800 x 1169 @ 120.00Hz",
            spdisplays_main: "spdisplays_yes",
            spdisplays_online: "spdisplays_yes",
          },
        ],
      },
    ],
  },
};

test("AC power, explicit low-power zero and an awake current 120Hz mode qualify", () => {
  const result = qualifyDisplayPower(eligible);
  assert.equal(result.status, "eligible");
  assert.equal(result.powerConnected, true);
  assert.equal(result.lowPowerMode, false);
  assert.equal(result.refreshRate, 120);
  assert.equal(result.batteryPercent, 12);
});

for (const [name, override] of [
  ["battery power", { battery: "Now drawing from 'Battery Power'\n12%; discharging;" }],
  ["missing AC evidence", { battery: "Power state unavailable" }],
  ["low-power mode enabled", { powerSettings: "lowpowermode 1\n" }],
  ["missing low-power mode evidence", { powerSettings: "standby 0\n" }],
  ["no current display", { displays: {} }],
])
  test(`ineligible ${name} remains blocked`, () => {
    assert.equal(qualifyDisplayPower({ ...eligible, ...override }).status, "not_eligible");
  });

for (const [name, change] of [
  ["asleep", { spdisplays_asleep: "spdisplays_yes" }],
  ["offline", { spdisplays_online: "spdisplays_no" }],
  ["60Hz", { _spdisplays_resolution: "1800 x 1169 @ 60Hz" }],
  ["product label only", { _name: "120Hz capable", _spdisplays_resolution: "1800 x 1169" }],
])
  test(`current display ${name} cannot pass`, () => {
    const display = { ...eligible.displays.SPDisplaysDataType[0].spdisplays_ndrvs[0], ...change };
    assert.equal(
      qualifyDisplayPower({
        ...eligible,
        displays: { SPDisplaysDataType: [{ spdisplays_ndrvs: [display] }] },
      }).status,
      "not_eligible",
    );
  });

test("unsupported platforms perform no OS commands", () => {
  const result = checkDisplayPower({
    platform: "linux",
    command() {
      assert.fail("OS command must not run");
    },
  });
  assert.equal(result.status, "unsupported");
});

test("the read-only probe preserves raw evidence and exact command arguments", () => {
  const calls = [];
  const result = checkDisplayPower({
    platform: "darwin",
    command(file, args) {
      calls.push([file, args]);
      if (file === "system_profiler") return JSON.stringify(eligible.displays);
      return args.length === 2 ? eligible.battery : eligible.powerSettings;
    },
  });
  assert.equal(result.status, "eligible");
  assert.deepEqual(calls, [
    ["pmset", ["-g", "batt"]],
    ["pmset", ["-g"]],
    ["system_profiler", ["SPDisplaysDataType", "-json"]],
  ]);
  assert.deepEqual(result.raw.displays, eligible.displays);
  assert.equal(result.raw.battery, eligible.battery);
});

test("zero percent is retained as measured data", () => {
  assert.equal(
    qualifyDisplayPower({ ...eligible, battery: "Now drawing from 'AC Power'\n0%; charging;" })
      .batteryPercent,
    0,
  );
});
