import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { WebSocket } from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const origin = new URL(process.env.PUBLIC_ORIGIN ?? 'http://localhost:8080').origin;
const report = {
  checkedAt: new Date().toISOString(), origin,
  scope: 'HTTP asset availability and real game-server WebSocket transport/AS3-version handshake; no browser or gameplay execution',
  http: [], sockets: [], integrationNotes: [],
};
const assets = new Map();
const addAsset = (url, kind, required = true) => {
  const resolved = new URL(url, origin);
  if (resolved.origin !== origin) return;
  const key = resolved.pathname + resolved.search;
  const existing = assets.get(key);
  if (!existing) assets.set(key, { url: key, kind, required });
  else if (required) existing.required = true;
};

async function get(urlPath, kind, required = true) {
  const result = { url: urlPath, method: 'GET', kind, required, ok: false };
  try {
    const response = await fetch(new URL(urlPath, origin), { signal: AbortSignal.timeout(20000), redirect: 'follow' });
    const body = Buffer.from(await response.arrayBuffer());
    Object.assign(result, { status: response.status, bytes: body.length, contentType: response.headers.get('content-type'), ok: response.status === 200 && body.length > 0 });
    if (result.ok && kind === 'swf') result.ok = /^[FCZ]WS$/.test(body.toString('ascii', 0, 3));
    if (result.ok && kind === 'wasm') result.ok = body.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109])) && result.contentType === 'application/wasm';
    if (result.ok && kind === 'script') {
      try { new Script(body.toString('utf8'), { filename: urlPath }); }
      catch (error) { result.ok = false; result.error = `JavaScript syntax: ${error.message}`; }
    }
    if (!result.ok && !result.error) result.error = 'Unexpected HTTP status, empty body, or file signature';
    report.http.push(result);
    return { result, body };
  } catch (error) {
    result.error = error.message;
    report.http.push(result);
    return { result, body: Buffer.alloc(0) };
  }
}

async function socketCheck(route, name, payload, expected) {
  const result = { route, name, ok: false };
  report.sockets.push(result);
  try {
    result.response = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/ws/${route}`, { origin });
      let reply = '';
      const timer = setTimeout(() => { ws.terminate(); reject(new Error('Socket response timed out')); }, 8000);
      const finish = error => { clearTimeout(timer); if (error) reject(error); else resolve(reply); };
      ws.on('open', () => ws.send(Buffer.from(payload)));
      ws.on('message', data => {
        reply += data.toString();
        if (expected.test(reply)) { ws.close(); finish(); }
      });
      ws.on('error', finish);
      ws.on('close', () => { if (!expected.test(reply)) finish(new Error(`Closed without expected response: ${reply}`)); });
    });
    result.ok = expected.test(result.response);
  } catch (error) { result.error = error.message; }
}

try {
  const page = await get('/', 'html');
  if (!page.result.ok) throw new Error('Local play page is unavailable');
  const rawHtml = page.body.toString('utf8');
  // Downlevel-revealed IE conditionals render their contents in modern browsers.
  // Hidden IE-only conditionals and ordinary HTML comments do not.
  const html = rawHtml.replace(/<!--\s*\[if[^\]]*\]><!-->/gi, '').replace(/<!--<!\[endif\]-->/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  const attribute = (tag, name) => new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(tag)?.[2];
  for (const [tag] of html.matchAll(/<script\b[^>]*>/gi)) {
    const src = attribute(tag, 'src'); if (src) addAsset(src, 'script');
  }
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    if (attribute(tag, 'rel')?.toLowerCase() === 'stylesheet') addAsset(attribute(tag, 'href'), 'stylesheet');
  }
  for (const match of rawHtml.matchAll(/"(?:friendsUrl|swfAddressUrl)"\s*:\s*("(?:[^"\\]|\\.)*")/g)) addAsset(JSON.parse(match[1]), 'script');

  // These dependencies are loaded by the original friends bootstrap, not HTML tags.
  const friendBootstrap = await readFile(path.join(root, 'vanilla-media/play/js/disney-friends-ostrta-min.js'), 'utf8');
  for (const name of ['stylesMinified', 'stylesClub']) {
    const array = new RegExp(`${name}:\\[([^\\]]*)\\]`).exec(friendBootstrap)?.[1] ?? '';
    for (const [, href] of array.matchAll(/href:"([^"]+)"/g)) addAsset('/' + href, 'stylesheet');
  }
  const libraries = /libraryScripts:\[([^\]]*)\]/.exec(friendBootstrap)?.[1] ?? '';
  for (const [, src] of libraries.matchAll(/"([^"]+)"/g)) addAsset('/' + src, 'script');
  addAsset('/js/disney/disney-friends-with-ui-min.js', 'script');
  for (const file of await readdir(path.join(root, '.local/ruffle'))) if (file.endsWith('.wasm')) addAsset('/ruffle/' + file, 'wasm');
  for (const file of ['club_penguin', 'load', 'shell', 'login', 'engine', 'interface', 'igloo', 'puffle_care', 'puffle_adoption']) addAsset(`/media/play/v2/client/${file}.swf`, 'swf');
  addAsset('/media/play/v2/client/fonts/en/FontLibrary.swf', 'swf');
  addAsset('/media/play/web_service/environment_data.xml', 'xml');
  addAsset('/servers.xml', 'xml');
  addAsset('/en/penguin/create', 'registration');
  addAsset('/healthz', 'json');

  const gameConfig = await get('/media/play/web_service/game_configs/games.json', 'json');
  if (gameConfig.result.ok) {
    const games = JSON.parse(gameConfig.body.toString('utf8'));
    report.minigames = Object.entries(games).filter(([, game]) => typeof game.path === 'string').map(([id, game]) => ({ id, name: game.name, path: game.path }));
    for (const game of report.minigames) addAsset('/media/play/v2/games/' + game.path, 'swf', false);
  }
  const pending = [...assets.values()];
  for (let i = 0; i < pending.length; i += 6) {
    await Promise.all(pending.slice(i, i + 6).map(asset => get(asset.url, asset.kind, asset.required)));
  }
  for (const route of ['login', 'world']) {
    await socketCheck(route, 'Flash policy exchange', '<policy-file-request/>\0', /<cross-domain-policy>/);
    await socketCheck(route, 'AS3 version 253 accepted', '<msg t="sys"><body action="verChk" r="0"><ver v="253" /></body></msg>\0', /action=["']apiOK["']/);
  }
  report.integrationNotes.push(
    'The original AS3 template launches club_penguin.swf, supplies media URLs through FlashVars, and retains the original CP.FlashClient and ExternalInterface callback code.',
    'Ruffle is inserted in the document head before SWFObject detection and original scripts.',
    'The original friends bootstrap already derives its base URL from window.location, so its inspected scripts/styles remain same-origin.',
    'Native Flash availability checks are left intact and rely on Ruffle plugin polyfills; actual browser execution is still required to verify them.',
    'Minigame entrypoint availability is checked from the preserved game registry; missing retired/seasonal entries are reported separately and are not assumed playable.',
    'HTTP success and protocol handshakes do not verify rendering, in-game navigation, minigame execution, sound, or full Ruffle compatibility.'
  );
} catch (error) { report.fatal = error.message; }
const missingGameUrls = new Set(report.http.filter(c => !c.required && !c.ok).map(c => c.url));
report.summary = {
  httpChecks: report.http.length,
  requiredHttpFailures: report.http.filter(c => c.required && !c.ok).length,
  inventoryHttpFailures: report.http.filter(c => !c.required && !c.ok).length,
  socketChecks: report.sockets.length,
  socketFailures: report.sockets.filter(c => !c.ok).length,
  missingMinigames: (report.minigames ?? []).filter(g => missingGameUrls.has('/media/play/v2/games/' + g.path)),
  browserGameplayVerified: false,
};
await mkdir(path.join(root, '.local'), { recursive: true });
await writeFile(path.join(root, '.local/http-verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report.summary, null, 2));
for (const failure of report.http.filter(c => c.required && !c.ok)) console.error(`${failure.method} ${failure.url}: ${failure.error} (${failure.status ?? 'network'})`);
for (const failure of report.sockets.filter(c => !c.ok)) console.error(`${failure.route}: ${failure.error}`);
if (report.fatal) console.error(report.fatal);
if (report.fatal || report.summary.requiredHttpFailures || report.summary.socketFailures) process.exitCode = 1;
