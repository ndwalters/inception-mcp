// Flag tables taken from the Inception REST API docs (Data Models > *PublicStates).

type FlagTable = Record<number, string>;

export const AREA_STATES: FlagTable = {
  1: "Armed",
  2: "Alarm",
  4: "EntryDelay",
  8: "ExitDelay",
  16: "ArmWarning",
  32: "DeferDisarmed",
  64: "DetectingActiveInputs",
  128: "WalkTestActive",
  256: "AwayArm", // armed in Full mode
  512: "StayArm", // armed in Perimeter mode
  1024: "SleepArm", // armed in Night mode
  2048: "Disarmed",
  4096: "ArmReady",
};

export const DOOR_STATES: FlagTable = {
  1: "Unlocked",
  2: "Open",
  4: "LockedOut",
  8: "Forced",
  16: "HeldOpenWarning",
  32: "HeldOpenTooLong",
  64: "Breakglass",
  128: "ReaderTamper",
  256: "Locked",
  512: "Closed",
  1024: "HeldResponseMuted",
  2048: "BatteryLow",
  4096: "LockOffline",
};

export const INPUT_STATES: FlagTable = {
  1: "Active", // unsealed
  2: "Tamper",
  4: "Isolated",
  8: "Mask",
  16: "LowBattery",
  32: "PollFailed",
  64: "Sealed",
  128: "WirelessDoorBatteryLow",
  256: "WirelessDoorLockOffline",
};

export const OUTPUT_STATES: FlagTable = {
  1: "On",
  2: "Off",
};

export function decodeFlags(table: FlagTable, value: unknown): string[] {
  const v = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(v)) return [];
  const names: string[] = [];
  let rest = v;
  for (const [bit, name] of Object.entries(table)) {
    const b = Number(bit);
    if ((v & b) !== 0) {
      names.push(name);
      rest &= ~b;
    }
  }
  if (rest !== 0) names.push(`Unknown(0x${(rest >>> 0).toString(16)})`);
  return names;
}

export const STATE_TABLES = {
  area: AREA_STATES,
  door: DOOR_STATES,
  input: INPUT_STATES,
  output: OUTPUT_STATES,
} as const;

export type ItemType = keyof typeof STATE_TABLES;
