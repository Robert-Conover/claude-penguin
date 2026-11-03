import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
