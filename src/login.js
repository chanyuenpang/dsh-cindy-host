import { loginWithPhone } from "./cindy-login.js";
import { loadSession, saveSession } from "./credential-store.js";

if (process.argv.includes("--help")) {
  console.log("Usage: CINDY_AUTH_BASE_URL=https://auth.example npm run login");
  process.exit(0);
}

const authBaseUrl = process.env.CINDY_AUTH_BASE_URL || readFlag("--auth-base-url");
const clientType = process.env.CINDY_CLIENT_TYPE || "desktop";

try {
  // Fail before contacting auth when persistence is unavailable. Windows CLI
  // has no DSH context: use the DSH settings card, not a plaintext fallback.
  await loadSession();
  const session = await loginWithPhone({ authBaseUrl, clientType });
  await saveSession(session);
  // Deliberately expose only the non-secret local device handle.
  console.log(JSON.stringify({ status: "authenticated", deviceId: session.deviceId }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Cindy login failed");
  process.exitCode = 1;
}

function readFlag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
