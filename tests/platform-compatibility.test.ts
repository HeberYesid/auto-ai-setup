import { describe, expect, it } from "vitest";
import { getAutoSkillsSpawnSpec } from "../src/infrastructure/process/autoskills-process.js";

const supportedPlatforms = ["darwin", "linux", "win32"] as const;

describe("platform compatibility", () => {
  it("runs only on a supported target operating system", () => {
    expect(supportedPlatforms).toContain(process.platform);
  });

  it("uses npx directly on POSIX systems", () => {
    const args = ["--yes", "autoskills"];

    expect(getAutoSkillsSpawnSpec("darwin", args)).toEqual({ executable: "npx", args });
    expect(getAutoSkillsSpawnSpec("linux", args)).toEqual({ executable: "npx", args });
  });

  it("invokes npx.cmd through cmd.exe on Windows", () => {
    expect(getAutoSkillsSpawnSpec("win32", ["--yes", "autoskills"])).toEqual({
      executable: "cmd.exe",
      args: ["/d", "/s", "/c", "npx.cmd --yes autoskills"],
    });
  });

  it("selects a command valid for the current runner", () => {
    const spec = getAutoSkillsSpawnSpec(process.platform, ["--yes", "autoskills"]);

    expect(spec.executable).toBe(process.platform === "win32" ? "cmd.exe" : "npx");
    expect(spec.args).toEqual(process.platform === "win32" ? ["/d", "/s", "/c", "npx.cmd --yes autoskills"] : ["--yes", "autoskills"]);
  });
});
