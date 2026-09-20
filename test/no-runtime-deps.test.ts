import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The first invariant of this repository: the Agent Core must be runnable with
// a fake model and fake tools, without a process, database, network or UI.
// That is only true while the Core has no runtime dependencies at all.
// Every external integration arrives later as an adapter behind a port, and it
// must be justified by a step in the development sequence.
describe("dependency posture", () => {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  ) as Record<string, unknown>;

  it("declares no runtime dependencies", () => {
    expect(pkg["dependencies"]).toBeUndefined();
  });

  it("requires Node 22 or newer", () => {
    expect((pkg["engines"] as Record<string, string>)["node"]).toBe(">=22");
  });
});
