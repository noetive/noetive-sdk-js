import { describe, expect, it } from "vitest";
import { buildUserAgent } from "../../src/userAgent.js";
import { VERSION } from "../../src/version.js";

describe("buildUserAgent", () => {
  it("starts with noetive-sdk-js/<VERSION>", () => {
    expect(buildUserAgent()).toMatch(new RegExp(`^noetive-sdk-js/${VERSION} `));
  });

  it("identifies the runtime with a name+version token (no slash)", () => {
    // Format mirrors Go's `go1.25.2` and Python's `cpython3.12.1` — runtime
    // name followed directly by version, then `;` and the os/arch.
    const ua = buildUserAgent();
    expect(ua).toMatch(/\((node|bun|deno|browser|unknown)\d/);
  });

  it("includes os/arch when process exposes them", () => {
    const ua = buildUserAgent();
    // Under Node, the second segment is platform/arch (e.g. "darwin/arm64").
    const proc = (globalThis as { process?: { platform?: string; arch?: string } }).process;
    if (proc?.platform && proc?.arch) {
      expect(ua).toContain(`${proc.platform}/${proc.arch}`);
    }
  });
});
