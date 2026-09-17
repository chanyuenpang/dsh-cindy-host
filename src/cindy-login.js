import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

/** Explicit email-code login. Tokens remain in memory and are never printed or persisted. */
export const MAINLAND_CINDY_AUTH_BASE_URL = "https://auth.cindy.com.cn";

export function loginWithEmail(options = {}) { return loginWithVerification({ ...options, kind: "email", identifierLabel: "Cindy email" }); }
export function loginWithPhone(options = {}) { return loginWithVerification({ ...options, kind: "phone", identifierLabel: "Cindy phone number" }); }

async function loginWithVerification({ authBaseUrl = MAINLAND_CINDY_AUTH_BASE_URL, locale = "zh-CN", clientType = "desktop", prompt = defaultPrompt, kind, identifierLabel }) {
  const base = authBaseUrl.replace(/\/$/, "");
  const deviceId = randomUUID();
  const identifier = await prompt(`${identifierLabel}: `);
  await request(base, `/api/auth/${kind}/request-code`, { [kind]: identifier, locale });
  const code = await prompt("Verification code: " );
  const outcome = await request(base, `/api/auth/${kind}/verify-code`, { [kind]: identifier, code, deviceId, clientType, locale });
  const resolved = await resolveLoginOutcome({ base, outcome, deviceId, prompt });
  const tokens = selectTokenPair(resolved);
  return { authBaseUrl: base, deviceId, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt };
}

export async function refreshLogin({ authBaseUrl, deviceId, refreshToken }) {
  const base = authBaseUrl.replace(/\/$/, "");
  return request(base, "/api/auth/refresh", { deviceId, refreshToken });
}

/**
 * Send one Cindy auth request. Shared by the interactive CLI flow below and the
 * settings-card flow in `cindy-login-flow.js`, so both speak the same wire.
 *
 * A failure carries `status` when the service answered at all. That distinction is
 * load-bearing for refresh: "the service said this refresh token is invalid" and
 * "the request never arrived" look identical otherwise, and treating the second as
 * the first signs the user out (see `refreshStoredSession`). A transport failure
 * carries `transport: true` and no status.
 */
export async function cindyRequest(base, path, body) {
  let response;
  try {
    response = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (error) {
    const failure = new Error(`Cindy request failed to reach the service: ${String(error?.message ?? error)}`);
    failure.transport = true;
    throw failure;
  }
  if (!response.ok) {
    const failure = new Error(`Cindy authentication failed (HTTP ${response.status})`);
    failure.status = response.status;
    throw failure;
  }
  return response.json();
}

const request = cindyRequest;

async function resolveLoginOutcome({ base, outcome, deviceId, prompt }) {
  if (outcome.status === "ok") return outcome;
  if (outcome.status === "select_account") {
    const choices = outcome.accounts.map((account, index) => `${index + 1}. ${account.displayName}`).join("\n");
    const answer = await prompt(`Select Cindy account:\n${choices}\n> `);
    const selected = outcome.accounts[Number(answer) - 1];
    if (!selected) throw new Error("Invalid Cindy account selection");
    return request(base, "/api/auth/select-account", { loginTicket: outcome.loginTicket, accountId: selected.id, deviceId });
  }
  if (outcome.status === "binding_required") throw new Error("Cindy account binding is required; complete binding in Cindy first");
  if (outcome.status === "sso_verification_required") throw new Error("Cindy SSO verification is required; this MVP supports email-code login only");
  throw new Error("Unsupported Cindy login outcome");
}

function selectTokenPair(outcome) {
  const tokens = outcome.tokens || outcome;
  if (typeof tokens.accessToken !== "string" || typeof tokens.refreshToken !== "string") throw new Error("Cindy authentication returned no token pair");
  return tokens;
}

async function defaultPrompt(label) {
  const rl = createInterface({ input: stdin, output: stdout });
  try { return (await rl.question(label)).trim(); } finally { rl.close(); }
}
