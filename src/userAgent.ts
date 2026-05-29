import { VERSION } from "./version.js";

/**
 * Build the User-Agent header value emitted on every request.
 *
 * Format: `noetive-sdk-js/<VERSION> (<runtime><runtimeVersion>; <os>/<arch>)`.
 * The runtime token (e.g. `node24.11.1`, `bun1.1.30`, `deno1.45.0`) has no
 * separator between name and version — this matches the Go SDK's `go1.25.2`
 * and the Python SDK's `cpython3.12.1`, so server logs group requests by
 * runtime family consistently across SDK families. Tools that talk to
 * Semantik directly should reuse this so the wire-level identity matches.
 */
export function buildUserAgent(): string {
  const { runtime, version } = detectRuntime();
  const platform = detectPlatform();
  return platform
    ? `noetive-sdk-js/${VERSION} (${runtime}${version}; ${platform})`
    : `noetive-sdk-js/${VERSION} (${runtime}${version})`;
}

interface RuntimeInfo {
  runtime: string;
  version: string;
}

function detectRuntime(): RuntimeInfo {
  const g = globalThis as Record<string, unknown>;

  const deno = g.Deno as { version?: { deno?: string } } | undefined;
  if (deno?.version?.deno) {
    return { runtime: "deno", version: deno.version.deno };
  }

  const bun = g.Bun as { version?: string } | undefined;
  if (bun?.version) {
    return { runtime: "bun", version: bun.version };
  }

  const proc = g.process as { versions?: { node?: string } } | undefined;
  if (proc?.versions?.node) {
    return { runtime: "node", version: proc.versions.node };
  }

  const nav = g.navigator as { userAgent?: string } | undefined;
  if (nav?.userAgent) {
    return { runtime: "browser", version: condenseUserAgent(nav.userAgent) };
  }

  return { runtime: "unknown", version: "0" };
}

function detectPlatform(): string | undefined {
  const proc = (globalThis as { process?: { platform?: string; arch?: string } }).process;
  if (proc?.platform && proc?.arch) {
    return `${proc.platform}/${proc.arch}`;
  }
  return undefined;
}

/**
 * Browsers expose multi-line User-Agent strings packed with vendor noise.
 * Collapse whitespace and clip to keep the SDK's UA header at a reasonable
 * length without losing the leading product identifier.
 */
function condenseUserAgent(ua: string): string {
  const collapsed = ua.replace(/\s+/g, " ").trim();
  return collapsed.length > 80 ? `${collapsed.slice(0, 77)}...` : collapsed;
}
