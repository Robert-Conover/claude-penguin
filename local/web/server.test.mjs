import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createLocalServer } from './server.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
const close = server => new Promise(resolve => server.close(resolve));

test('serves preserved client, renders local addresses, proxies web services and all binary game sockets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'club-penguin-web-test-'));
  const put = async (name, value) => {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), value);
  };
  const original = '<html><head><title>Club Penguin</title></head><body><script>window.originalCallback=function(){};var media="{{ .Env.WEB_VANILLA_MEDIA }}/";</script></body></html>';
  await put('templates/vanilla-media/play/index.html.template', original);
  await put('templates/vanilla-media/media/play/web_service/environment_data.xml.template', '<data value="{{ .Env.WEB_VANILLA_PLAY }}/"/>');
  await put('servers.xml', '<servers><login address="{{ .Env.GAME_ADDRESS }}" port="{{ .Env.GAME_LOGIN_PORT }}"/><language locale="en"><server port="9875"/></language><language locale="fr"><server port="9878"/></language></servers>');
  await put('vanilla-media/media/play/v2/client/club_penguin.swf', Buffer.from([0x46, 0x57, 0x53, 0x09]));
  await put('vanilla-media/play/js/original.js', 'original callback');
  await put('.local/ruffle/ruffle.js', 'ruffle');
  await put('.local/ruffle/core.wasm', Buffer.from([0, 97, 115, 109]));
  const tcp = net.createServer(socket => socket.pipe(socket));
  const tcpPort = await listen(tcp);
  const dash = http.createServer((req, res) => {
    let body = '';
    req.on('data', data => { body += data; });
    req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ path: req.url, method: req.method, body })); });
  });
  const dashPort = await listen(dash);
  const server = createLocalServer({ root, publicOrigin: 'http://127.0.0.1:8080', loginHost: '127.0.0.1', loginPort: tcpPort, worldHost: '127.0.0.1', worldPort: tcpPort, snowHost: '127.0.0.1', snowPort: tcpPort, dashOrigin: `http://127.0.0.1:${dashPort}` });
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  try {
    const page = await fetch(origin).then(r => r.text());
    assert.match(page, /window.originalCallback/);
    assert.match(page, /http:\/\/127\.0\.0\.1:8080\/media\//);
    assert.match(page, /\/ruffle\/ruffle\.js/);
    assert.match(page, /\/ws\/snow/);
    assert.doesNotMatch(page, /\{\{/);
    assert.doesNotMatch(page, /bridge\/bootstrap/);
    const experiment = await fetch(`${origin}/?bridge=1`).then(r => r.text());
    assert.match(experiment, /bridge\/bootstrap\.js/);
    assert.ok(experiment.indexOf('/bridge/bootstrap.js') < experiment.indexOf('/ruffle/ruffle.js'));
    assert.match(experiment, /window.originalCallback/);
    assert.equal((await fetch(`${origin}/bridge/fixtures.json`)).status, 503);
    assert.equal((await fetch(`${origin}/bridge/panel.mjs`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal((await fetch(`${origin}/bridge/native-menu.mjs`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal((await fetch(`${origin}/bridge/assets/engine.swf`)).status, 404);
    await put('.local/client-bridge/engine.swf', 'patched-fixture');
    await put('vanilla-media/media/play/v2/client/engine.swf', 'original-fixture');
    assert.equal(await fetch(`${origin}/bridge/assets/engine.swf`).then(r => r.text()), 'patched-fixture');
    assert.equal(await fetch(`${origin}/media/play/v2/client/engine.swf`).then(r => r.text()), 'original-fixture');
    await put('.local/client-bridge/puffle_adoption.swf', 'derived-adoption');
    assert.equal((await fetch(`${origin}/bridge/assets/puffle_adoption.swf`)).status, 404, 'the ordinary page never serves the derived adoption module');
    const xml = await fetch(`${origin}/servers.xml`).then(r => r.text());
    assert.match(xml, /address="127\.0\.0\.1"/);
    assert.doesNotMatch(xml, /locale="fr"/);
    const swf = await fetch(`${origin}/media/play/v2/client/club_penguin.swf`, { headers: { range: 'bytes=1-2' } });
    assert.equal(swf.status, 206);
    assert.deepEqual(Buffer.from(await swf.arrayBuffer()), Buffer.from([0x57, 0x53]));
    assert.equal((await fetch(`${origin}/ruffle/core.wasm`)).headers.get('content-type'), 'application/wasm');
    assert.equal((await fetch(`${origin}/media/missing.swf`)).status, 404);
    const health = await fetch(`${origin}/healthz`).then(r => r.json());
    assert.deepEqual(health, { status: 'ready', clientPresent: true, rufflePresent: true });
    const registration = await fetch(`${origin}/en/penguin/create?local=1`, { method: 'POST', body: 'penguin=Test' }).then(r => r.json());
    assert.deepEqual(registration, { path: '/create/vanilla/en?local=1', method: 'POST', body: 'penguin=Test' });
    const autocomplete = await fetch(`${origin}/media/social/autocomplete/v2/search/suggestions?q=hi`).then(r => r.json());
    assert.equal(autocomplete.path, '/autocomplete?q=hi');
    await rm(path.join(root, '.local/ruffle/ruffle.js'));
    const notReady = await fetch(`${origin}/healthz`);
    assert.equal(notReady.status, 503);
    assert.deepEqual(await notReady.json(), { status: 'not_ready', clientPresent: true, rufflePresent: false });
    for (const route of ['login', 'world', 'snow']) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${route}`, { origin: 'http://127.0.0.1:8080' });
      await once(ws, 'open');
      const received = once(ws, 'message');
      const packet = Buffer.from('<policy-file-request/>\0');
      ws.send(packet);
      assert.deepEqual((await received)[0], packet);
      ws.close();
      await once(ws, 'close');
    }
  } finally {
    await close(server);
    await close(dash);
    await close(tcp);
    await rm(root, { recursive: true, force: true });
  }
});

test('media, overlay and fixture roots are configurable and the world port is templated into servers.xml', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'club-penguin-web-roots-'));
  const root = path.join(base, 'resources with space');
  const put = async (name, value) => {
    await mkdir(path.dirname(name), { recursive: true });
    await writeFile(name, value);
  };
  const media = path.join(base, 'media root'), bridge = path.join(base, 'bridge'), fixtures = path.join(base, 'public');
  const servers = await readFile(new URL('../../servers.xml', import.meta.url), 'utf8');
  await put(path.join(root, 'servers.xml'), servers);
  await put(path.join(root, 'templates/vanilla-media/play/index.html.template'), '<html><head></head><body>{{ .Env.WEB_VANILLA_MEDIA }}</body></html>');
  await put(path.join(media, 'media/play/v2/client/club_penguin.swf'), 'swf');
  await put(path.join(media, 'play/js/original.js'), 'from-configured-play');
  await put(path.join(bridge, 'engine.swf'), 'configured-overlay');
  await put(path.join(bridge, 'puffle_adoption.swf'), 'configured-adoption');
  await put(path.join(fixtures, 'fixtures.json'), 'not json');
  await put(path.join(root, '.local/ruffle/ruffle.js'), 'ruffle');
  // Decoys at today's default locations must be ignored.
  await put(path.join(root, 'vanilla-media/play/js/original.js'), 'DEFAULT-PATH');
  await put(path.join(root, '.local/client-bridge/engine.swf'), 'DEFAULT-OVERLAY');
  const server = createLocalServer({
    root, mediaRoot: media, clientBridgeRoot: bridge, bridgePublicRoot: fixtures, agentMode: true,
    publicOrigin: 'http://localhost:47080', loginPort: 47112, worldPort: 47875, snowPort: 47002,
  });
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  try {
    assert.equal(await fetch(`${origin}/js/original.js`).then(r => r.text()), 'from-configured-play');
    assert.equal(await fetch(`${origin}/bridge/assets/engine.swf`).then(r => r.text()), 'configured-overlay');
    assert.equal(await fetch(`${origin}/bridge/assets/puffle_adoption.swf`).then(r => r.text()), 'configured-adoption');
    assert.equal((await fetch(`${origin}/media/play/v2/client/club_penguin.swf`)).status, 200);
    assert.deepEqual(await fetch(`${origin}/healthz`).then(r => r.json()), { status: 'ready', clientPresent: true, rufflePresent: true });
    // fixtures.json is read from the configured directory (invalid JSON there is a 500, not a 503 "run the script").
    assert.equal((await fetch(`${origin}/bridge/fixtures.json`)).status, 500);
    for (const lang of ['servers.xml', 'media/servers.xml']) {
      const xml = await fetch(`${origin}/${lang}`).then(r => r.text());
      assert.match(xml, /<login address="localhost" port="47112"/);
      assert.match(xml, /<redemption address="localhost" port="47875"/);
      assert.match(xml, /name="Blizzard"[^>]*port="47875"/);
      assert.doesNotMatch(xml, /\{\{|9875/);
    }
  } finally {
    await close(server);
    await rm(base, { recursive: true, force: true });
  }
});

test('the default world port still renders 9875 into servers.xml', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'club-penguin-web-default-'));
  await mkdir(path.join(root), { recursive: true });
  await writeFile(path.join(root, 'servers.xml'), await readFile(new URL('../../servers.xml', import.meta.url), 'utf8'));
  const server = createLocalServer({ root });
  const port = await listen(server);
  try {
    const xml = await fetch(`http://127.0.0.1:${port}/servers.xml`).then(r => r.text());
    assert.match(xml, /<redemption address="localhost" port="9875"/);
    assert.match(xml, /name="Blizzard"[^>]*port="9875"/);
    assert.match(xml, /<login address="localhost" port="6112"/);
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test('AGENT_ORIGIN sets the home page puffle link outside agent mode', async () => {
  const { createLocalServer } = await import('./server.mjs');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-agent-origin-'));
  fs.mkdirSync(path.join(root, 'templates/vanilla-media/play'), { recursive: true });
  fs.writeFileSync(path.join(root, 'templates/vanilla-media/play/index.html.template'), '<a href="{{ .Env.WEB_AGENT_PLAY }}">x</a>');
  const server = createLocalServer({ root, publicOrigin: 'http://127.0.0.1:8080', agentOrigin: 'http://localhost:47081' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const body = await fetch(`http://127.0.0.1:${server.address().port}/`).then(r => r.text());
    assert.match(body, /http:\/\/localhost:47081\/\?bridge=1&amp;agents=1#\/login|http:\/\/localhost:47081\/\?bridge=1&agents=1#\/login/);
  } finally { server.close(); }
});
