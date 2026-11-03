import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { readFile, stat, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer, createWebSocketStream } from 'ws';
import { pipeline } from 'node:stream';

const here = path.dirname(fileURLToPath(import.meta.url));
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.swf': 'application/x-shockwave-flash', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

export function renderTemplate(template, env) {
  return template
    .replace(/\{\{\s*\(parseUrl\s+\.Env\.(\w+)\)\.(Host|Path)\s*\}\}/g,
      (_, key, part) => { const url = new URL(env[key]); return part === 'Host' ? url.host : url.pathname.replace(/\/$/, ''); })
    .replace(/\{\{\s*\.Env\.(\w+)\s*\}\}/g, (_, key) => {
      if (env[key] === undefined) throw new Error(`Missing template value ${key}`);
      return String(env[key]);
    });
}

function dashPath(urlPath) {
  const penguin = urlPath.match(/^\/(?:(en|es|fr|pt)\/)?penguin\/(create|activate|forgot-password)(\/.*)?$/);
  if (penguin) {
    const [, lang = 'en', action, suffix = ''] = penguin;
    const route = { create: 'create/vanilla', activate: 'activate/vanilla', 'forgot-password': 'password' }[action];
    return `/${route}/${lang}${suffix}`;
  }
  const avatar = urlPath.match(/^\/(?:media\/)?avatar\/(.+)\/cp$/);
  if (avatar) return `/avatar/${avatar[1]}`;
  if (/^\/(?:.*\/)?web-service\/snfgenerator\/session$/.test(urlPath)) return '/session';
  if (urlPath === '/api/v0.2/xxx/game/get/world-name-service/start_world_request') return '/swrequest';
  if (urlPath === '/manager' || urlPath.startsWith('/manager/')) return urlPath;
  if (urlPath === '/media/social/autocomplete/v2/search/suggestions' || urlPath === '/social/autocomplete/v2/search/suggestions') return '/autocomplete';
  return null;
}

export function createLocalServer(options = {}) {
  const root = path.resolve(options.root ?? process.env.PROJECT_ROOT ?? path.join(here, '../..'));
  const ruffleRoot = path.resolve(options.ruffleRoot ?? process.env.RUFFLE_ROOT ?? path.join(root, '.local/ruffle'));
  const publicOrigin = new URL(options.publicOrigin ?? process.env.PUBLIC_ORIGIN ?? 'http://localhost:8080').origin;
  const publicUrl = new URL(publicOrigin);
  const gameAddress = publicUrl.hostname;
  const loginPort = Number(options.loginPort ?? process.env.LOGIN_PORT ?? 6112);
  const worldPort = Number(options.worldPort ?? process.env.WORLD_PORT ?? 9875);
  const snowPort = Number(options.snowPort ?? process.env.SNOW_PORT ?? 7002);
  const dashOrigin = options.dashOrigin ?? process.env.DASH_ORIGIN ?? 'http://dash:3000';
  const env = {
    WEB_VANILLA_PLAY: publicOrigin, WEB_VANILLA_MEDIA: `${publicOrigin}/media`,
    GAME_ADDRESS: gameAddress, GAME_LOGIN_PORT: String(loginPort),
  };
  const socketTargets = new Map([
    ['/ws/login', { host: options.loginHost ?? process.env.LOGIN_HOST ?? 'login', port: loginPort }],
    ['/ws/world', { host: options.worldHost ?? process.env.WORLD_HOST ?? 'world', port: worldPort }],
    ['/ws/snow', { host: options.snowHost ?? process.env.SNOW_HOST ?? 'snowflake', port: snowPort }],
  ]);
  const wsOrigin = publicOrigin.replace(/^http/, 'ws');
  const ruffleConfig = {
    allowScriptAccess: true, autoplay: 'on', unmuteOverlay: 'visible',
    splashScreen: false, logLevel: 'warn',
    socketProxy: [
      { host: gameAddress, port: loginPort, proxyUrl: `${wsOrigin}/ws/login` },
      { host: gameAddress, port: worldPort, proxyUrl: `${wsOrigin}/ws/world` },
      { host: gameAddress, port: snowPort, proxyUrl: `${wsOrigin}/ws/snow` },
    ],
  };
  const injectRuffle = `<script>window.RufflePlayer=window.RufflePlayer||{};window.RufflePlayer.config=${JSON.stringify(ruffleConfig)};</script>\n<script src="/ruffle/ruffle.js"></script>`;
  const playRoot = path.join(root, 'vanilla-media/play');
  const mediaRoot = path.join(root, 'vanilla-media/media');
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024, perMessageDeflate: false });
  const sockets = new Set();

  function reply(res, status, content, type = 'text/plain; charset=utf-8', method = 'GET') {
    const body = Buffer.from(content);
    res.writeHead(status, { 'content-type': type, 'content-length': body.length, 'cache-control': 'no-store' });
    res.end(method === 'HEAD' ? undefined : body);
  }

  function proxyDash(req, res, targetPath, search) {
    const target = new URL(targetPath + search, dashOrigin);
    const upstream = http.request(target, {
      method: req.method,
      headers: { ...req.headers, host: target.host, 'x-forwarded-host': publicUrl.host, 'x-forwarded-proto': publicUrl.protocol.slice(0, -1) },
    }, incoming => {
      const headers = { ...incoming.headers };
      if (headers.location?.startsWith(dashOrigin)) headers.location = headers.location.replace(dashOrigin, publicOrigin);
      res.writeHead(incoming.statusCode, headers);
      incoming.pipe(res);
    });
    upstream.on('error', error => {
      console.error(`Dash ${req.method} ${targetPath}: ${error.code ?? error.message}`);
      if (!res.headersSent) reply(res, 502, 'Local web services are not ready.'); else res.destroy(error);
    });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  }

  async function serveFile(req, res, directory, relative) {
    let file = path.resolve(directory, `.${relative.startsWith('/') ? relative : `/${relative}`}`);
    const absoluteRoot = path.resolve(directory);
    if (file !== absoluteRoot && !file.startsWith(absoluteRoot + path.sep)) return reply(res, 403, 'Forbidden');
    let info;
    try {
      info = await stat(file);
      if (info.isDirectory()) { file = path.join(file, 'index.html'); info = await stat(file); }
      const actual = await realpath(file);
      const actualRoot = await realpath(directory);
      if (actual !== actualRoot && !actual.startsWith(actualRoot + path.sep)) return reply(res, 403, 'Forbidden');
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) {
        console.warn(`404 ${req.url.split('?')[0]}`);
        return reply(res, 404, 'Not found');
      }
      throw error;
    }
    if (!info.isFile()) return reply(res, 404, 'Not found');
    const headers = { 'content-type': types[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'accept-ranges': 'bytes', 'cache-control': 'no-cache' };
    let start = 0, end = info.size - 1, status = 200;
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'content-range': `bytes */${info.size}` }); return res.end(); }
      start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
      if (start > end || start >= info.size) { res.writeHead(416, { 'content-range': `bytes */${info.size}` }); return res.end(); }
      status = 206;
      headers['content-range'] = `bytes ${start}-${end}/${info.size}`;
    }
    headers['content-length'] = Math.max(0, end - start + 1);
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || info.size === 0) return res.end();
    createReadStream(file, { start, end }).on('error', error => res.destroy(error)).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, publicOrigin);
      const urlPath = decodeURIComponent(url.pathname);
      if (urlPath.includes('\0')) return reply(res, 400, 'Invalid path');
      const upstreamPath = dashPath(urlPath);
      if (upstreamPath) return proxyDash(req, res, upstreamPath, url.search);
      if (!['GET', 'HEAD'].includes(req.method)) return reply(res, 405, 'Method not allowed');
      if (urlPath === '/healthz') {
        const present = async file => stat(file).then(s => s.isFile()).catch(() => false);
        const files = await Promise.all([
          present(path.join(mediaRoot, 'play/v2/client/club_penguin.swf')),
          present(path.join(ruffleRoot, 'ruffle.js')),
        ]);
        const ready = files.every(Boolean);
        return reply(res, ready ? 200 : 503, JSON.stringify({ status: ready ? 'ready' : 'not_ready', clientPresent: files[0], rufflePresent: files[1] }), 'application/json', req.method);
      }
      if (['/', '/index.html', '/en/', '/en/index.html', '/es/', '/fr/', '/pt/'].includes(urlPath)) {
        const lang = /^\/(es|fr|pt)\//.exec(urlPath)?.[1];
        const templatePath = path.join(root, 'templates/vanilla-media/play', lang ?? '', 'index.html.template');
        const original = await readFile(templatePath, 'utf8');
        const html = renderTemplate(original, env).replace(/(<head\b[^>]*>)/i, `$1\n${injectRuffle}`);
        return reply(res, 200, html, types['.html'], req.method);
      }
      if (['/servers.xml', '/play/servers.xml', '/media/servers.xml', '/media/play/servers.xml'].includes(urlPath)) {
        const template = await readFile(path.join(root, 'servers.xml'), 'utf8');
        // Only the English world is launched for the local baseline.
        const xml = renderTemplate(template, env).replace(/\s*<language locale="(?:es|pt|fr)">[\s\S]*?<\/language>/g, '');
        return reply(res, 200, xml, types['.xml'], req.method);
      }
      if (urlPath === '/media/play/web_service/environment_data.xml') {
        const template = await readFile(path.join(root, 'templates/vanilla-media/media/play/web_service/environment_data.xml.template'), 'utf8');
        return reply(res, 200, renderTemplate(template, env), types['.xml'], req.method);
      }
      if (urlPath === '/penguin/logout') { res.writeHead(302, { location: '/#/login' }); return res.end(); }
      if (urlPath.startsWith('/ruffle/')) return await serveFile(req, res, ruffleRoot, urlPath.slice('/ruffle'.length));
      if (urlPath.startsWith('/media/')) return await serveFile(req, res, mediaRoot, urlPath.slice('/media'.length));
      return await serveFile(req, res, playRoot, urlPath);
    } catch (error) {
      console.error(`HTTP ${req.method} ${req.url.split('?')[0]}: ${error.message}`);
      if (!res.headersSent) reply(res, error instanceof URIError ? 400 : 500, 'Local runtime request failed.'); else res.destroy(error);
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const target = socketTargets.get(new URL(req.url, publicOrigin).pathname);
    if (!target || (req.headers.origin && req.headers.origin !== publicOrigin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wsServer.handleUpgrade(req, socket, head, ws => {
      const upstream = net.connect(target.port, target.host);
      const stream = createWebSocketStream(ws);
      sockets.add(upstream);
      upstream.setNoDelay(true);
      upstream.setTimeout(30000, () => { if (upstream.connecting) upstream.destroy(new Error('Connection timeout')); });
      upstream.on('connect', () => upstream.setTimeout(0));
      upstream.on('error', error => {
        console.error(`Socket ${target.host}:${target.port}: ${error.code ?? error.message}`);
        if (ws.readyState === WebSocket.OPEN) ws.close(1011, 'Local game server unavailable');
      });
      upstream.on('close', () => sockets.delete(upstream));
      pipeline(stream, upstream, () => {});
      pipeline(upstream, stream, () => {});
    });
  });
  server.on('close', () => { for (const socket of sockets) socket.destroy(); for (const ws of wsServer.clients) ws.terminate(); wsServer.close(); });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createLocalServer();
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.BIND_ADDRESS ?? '127.0.0.1';
  server.listen(port, host, () => console.log(`Club Penguin local web listening on ${host}:${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close(() => process.exit(0)));
}
