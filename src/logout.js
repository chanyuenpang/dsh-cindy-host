import { clearSession } from './auth-session.js';
await clearSession();
console.log('{"status":"signed-out"}');
