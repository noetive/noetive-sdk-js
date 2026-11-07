import { describe, expect, it } from "vitest";
import { pacedFetch } from "../../integration/paced.js";

// The live harness's one retry: a rate_limited refusal is sent again, body and
// all, exactly once; any other refusal, a second rate_limited and a long wait
// come back as they are. Without it the live suite fails on its own pace; with
// a wider retry it would hide a real refusal.
describe("pacedFetch", () => {
  const limited = (ms: number) =>
    JSON.stringify({ error: { code: "rate_limited", retry_after_ms: ms } });
  const cases: [string, string[], number, string][] = [
    ["rate limited, then answered", [limited(5), '{"ok":true}'], 2, '"ok"'],
    ["rate limited twice", [limited(5), limited(5)], 2, "rate_limited"],
    [
      "a quota is not paced",
      [JSON.stringify({ error: { code: "quota_exceeded", retry_after_ms: 5 } })],
      1,
      "quota_exceeded",
    ],
    ["a long wait is not taken", [limited(60_000)], 1, "rate_limited"],
  ];
  for (const [name, answers, attempts, want] of cases) {
    it(name, async () => {
      const bodies: string[] = [];
      const fake = (async (_input: unknown, init?: RequestInit) => {
        bodies.push(String(init?.body));
        const answer = answers[Math.min(bodies.length - 1, answers.length - 1)] as string;
        return new Response(answer, {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;
      const res = await pacedFetch(fake)("https://bud.example/v1/x", {
        method: "POST",
        body: '{"q":"x"}',
      });
      expect(bodies).toEqual(Array(attempts).fill('{"q":"x"}'));
      expect(await res.text()).toContain(want);
    });
  }
});
