// Observational command hook. Always exit successfully with empty stdout: this
// helper must never make permission decisions or inject text into Claude.
import http from 'node:http';

const MAX_BODY = 1024 * 1024;
let body = '';
let tooLarge = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (tooLarge) return;
  body += chunk;
  if (Buffer.byteLength(body) > MAX_BODY) { tooLarge = true; body = ''; }
});
process.stdin.on('error', () => {});
process.stdin.on('end', () => {
  if (tooLarge) return;
  try {
    const url = new URL(process.env.CLAUDE_PENGUIN_HOOK_URL);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return;
    const workerId = process.env.CLAUDE_PENGUIN_WORKER_ID;
    const token = process.env.CLAUDE_PENGUIN_HOOK_TOKEN;
    if (!workerId || !token) return;
    const event = JSON.parse(body);
    const request = http.request(url, {
      method: 'POST', timeout: 2500,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    }, response => response.resume());
    request.on('error', () => {});
    request.on('timeout', () => request.destroy());
    request.end(JSON.stringify({ workerId, event }));
  } catch { /* A missing observer must not block the actual terminal. */ }
});
