import test from "node:test";
import assert from "node:assert/strict";
import { loginWithEmail } from "../src/cindy-login.js";

test("uses explicit email-code endpoints without exposing tokens", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (url.endsWith("/request-code")) return new Response(JSON.stringify({ status: "sent" }), { status: 200 });
    return new Response(JSON.stringify({ status: "ok", accessToken: "access-secret", refreshToken: "refresh-secret", membership: { id: "personal", kind: "personal", role: "owner", displayName: "Owner", email: null, orgId: null, orgName: null } }), { status: 200 });
  };
  try {
    const answers = ["owner@example.test", "123456"];
    const session = await loginWithEmail({ authBaseUrl: "https://auth.example.test/", prompt: async () => answers.shift() });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, "https://auth.example.test/api/auth/email/request-code");
    assert.equal(calls[1].body.email, "owner@example.test");
    assert.equal(calls[1].body.code, "123456");
    assert.equal(typeof session.deviceId, "string");
    assert.equal(session.accessToken, "access-secret");
  } finally { globalThis.fetch = originalFetch; }
});

test("defaults to the mainland Cindy auth endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    return new Response(JSON.stringify({ status: "sent" }), { status: 200 });
  };
  try {
    await assert.rejects(() => loginWithEmail({ prompt: async () => "owner@example.test" }), /Unsupported Cindy login outcome/);
    assert.equal(urls[0], "https://auth.cindy.com.cn/api/auth/email/request-code");
  } finally { globalThis.fetch = originalFetch; }
});
