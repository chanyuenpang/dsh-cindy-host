/**
 * Call one channel through the live Host's self-test route and print the reply.
 *
 * Usage: node tools/probe-channel.mjs <channel> '<json args array>'
 * Example: node tools/probe-channel.mjs file-browser:remote-op '[{"op":"exportFileStart","workdir":"G:\\x","relPath":"a.png"}]'
 */
const [channel, argsJson = '[]'] = process.argv.slice(2);
if (!channel) {
  console.error("usage: node tools/probe-channel.mjs <channel> '<json args>'");
  process.exit(1);
}
let args;
try {
  args = JSON.parse(argsJson);
} catch (error) {
  console.error(`args are not JSON: ${String(error?.message ?? error)}`);
  process.exit(1);
}
const started = Date.now();
const response = await fetch('http://127.0.0.1:3080/api/dsh-cindy-host/selftest', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ channel, args }),
});
const body = await response.json();
const elapsed = Date.now() - started;
const payload = body?.reply?.payload;
const bytes = Buffer.byteLength(JSON.stringify(body?.reply ?? body), 'utf8');
const summarize = (value) => {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value !== null && typeof value === 'object') return `object{${Object.keys(value).join(',')}}`;
  return JSON.stringify(value);
};
console.log(`${channel} ${elapsed}ms bytes=${bytes} ok=${payload?.ok}`);
console.log(payload?.ok === true ? `result: ${summarize(payload.result)}` : `error: ${JSON.stringify(payload?.error)}`);
console.log(JSON.stringify(payload?.ok === true ? payload.result : payload).slice(0, 1200));
