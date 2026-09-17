import { loginWithPhone } from "./cindy-login.js";
import { saveSession } from "./credential-store.js";

if (process.argv.includes("--help")) {
  console.log("Usage: CINDY_AUTH_BASE_URL=https://auth.example npm run login");
  process.exit(0);
}

const authBaseUrl = process.env.CINDY_AUTH_BASE_URL || readFlag("--auth-base-url");
const clientType = process.env.CINDY_CLIENT_TYPE || "desktop";

try {
  const session = await loginWithPhone({ authBaseUrl, clientType });
  // Persist so the settings card sees the same session the terminal just made.
  // Best-effort: a host with no OS credential store still gets a usable handle.
  try {
    await saveSession(session);
  } catch {
    console.error("Cindy logged in, but the OS credential store is unavailable; the settings card will not see this session");
  }
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
