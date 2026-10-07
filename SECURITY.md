# Security Policy

## Supported versions

`@noetive/sdk` follows [Semantic Versioning](https://semver.org/). Security
fixes are issued for the current minor release and the one immediately
preceding it.

| Version | Supported |
|---|---|
| 0.2.x | :white_check_mark: |
| 0.1.x | :white_check_mark: |
| < 0.1 | :x: |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report suspected vulnerabilities privately to **security@noetive.eu**. Include:

- A description of the issue and its impact.
- The smallest reproducing example or proof-of-concept.
- The SDK version (`VERSION` exported from `@noetive/sdk`) and the runtime
  (Node / Bun / Deno / browser) plus version.
- Any known mitigations.

You can expect:

- An acknowledgement within **2 business days**.
- A triage + severity assessment within **5 business days**.
- A fix timeline proportional to the severity (critical issues aim for a
  patched release within 14 days of confirmation).

We credit reporters in the release notes unless you prefer to remain
anonymous.

## Scope

This policy covers vulnerabilities in the `@noetive/sdk` package itself,
including:

- Credential mishandling (logging, leaking, or echoing API keys).
- Request/response parsing bugs that lead to memory corruption, resource
  exhaustion, or remote code execution.
- TLS / transport-layer misconfigurations.
- Dependency confusion, typosquatting, or supply-chain concerns on the
  published package.

Vulnerabilities in the Noetive services themselves (Semantik at
`https://semantik.noetive.io`, Bud at `https://bud.noetive.io`) should be reported to the same address; they
will be forwarded to the service team.

## Hardening guidance for SDK users

- **Never commit API keys.** Set `NOETIVE_KEY_SECRET` in environment variables,
  secret managers, or CI secret stores — not source code.
- **Rotate keys regularly.** Revoke and reissue any key that leaks into logs,
  screenshots, or version control.
- **Scope keys narrowly** when the dashboard supports it (e.g. separate keys
  for dev / staging / prod, or per-service identities).
- **Keep the SDK up to date.** `npm install -E @noetive/sdk@latest` pulls the
  latest patched release.
- **Validate TLS.** The SDK requires HTTPS and uses the runtime's default
  certificate trust store. Do not disable certificate verification in
  production via custom `fetch` injection.
- **Redact keys in error handling.** `NoetiveError` never echoes the API key
  itself; the `Client.toString()` and Node `util.inspect` hooks redact the
  credential. If you log request payloads, redact the `Authorization` header
  before writing.

## Hardening behaviours built into the SDK

- The API key is held only as the precomputed `Bearer …` value inside an
  internal transport. `Client.toString()` and the Node `util.inspect` hook
  redact it so a stray `console.log(client)` cannot leak the credential.
- Error envelopes are decoded with a 64 KiB body cap so a misconfigured proxy
  cannot exhaust SDK memory.
- SSE frames are capped at 64 KiB; oversize frames surface as `MalformedSseError`
  rather than growing without bound.
  The cap counts bytes and covers a line still being read, so a stream that
  never ends a line cannot grow memory either.
- The Bud client (`@noetive/sdk/bud`) redacts its credential the same way,
  never follows a redirect (a 3xx cannot carry the credential to a host the
  caller did not name), caps responses at 32 MiB and stream frames at 4 MiB,
  and retries only a connection that failed before any response. A send or
  update is retried only when it carries an `idempotency_key`, and no retry
  policy can widen that. A forwarding client holds no key at all and sends only
  the credential given for each call.
- A server-supplied `retry_after_ms` hint is capped at one hour to defend
  against a misbehaving or malicious server parking a retrying caller.
- The default transport refuses gzip compression on the subscribe stream so a
  broken proxy cannot inject framing ambiguity.

## Cryptography

The SDK itself performs no cryptography beyond what the runtime (Node, Bun,
Deno, browser) provides for TLS. API keys are opaque bearer tokens; the SDK
checks only that the supplied key is non-empty — the server is the source of
truth on key validity.
