// Minimal AS3 Houdini protocol client for engine-owned owner sessions. It
// mirrors local/verify_game.py: NUL-framed XML handshake on the login server,
// then an authenticated world session. Connections are loopback-only, and
// credentials never appear in errors or logs.
import net from 'node:net';
import { createHash } from 'node:crypto';

const MAX_BUFFER = 4_000_000;
const MAX_PENDING = 1000;

export class GameProtocolError extends Error {
  constructor(message, { code = 'PROTOCOL', gameError = null } = {}) {
    super(message);
    this.code = code;
    this.gameError = gameError;
  }
}

const md5 = value => createHash('md5').update(value, 'utf8').digest('hex');
const swap = value => value.slice(16, 32) + value.slice(0, 16);
const escapeXml = value => String(value).replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);
const unescapeXml = value => value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name]);

/** Mirrors Houdini Crypto.get_login_hash and Dash registration. */
export function loginPasswordHash(password, randomKey) {
  return swap(md5(swap(md5(password).toUpperCase()) + randomKey + 'Y(02.>\'H}t":E1'));
}

function parse(message) {
  if (message.startsWith('<')) {
    const action = /<body\b[^>]*\baction=(["'])([^"']*)\1/.exec(message)?.[2];
    if (action === undefined) throw new GameProtocolError('Malformed XML server response.');
    const key = /<k>(?:<!\[CDATA\[)?([^<\]]*)(?:\]\]>)?<\/k>/.exec(message)?.[1];
    return { kind: 'xml', command: action, args: [], key: key === undefined ? null : unescapeXml(key) };
  }
  if (!message.startsWith('%xt%') || !message.endsWith('%')) throw new GameProtocolError('Malformed game response.');
  const parts = message.split('%').slice(1, -1);
  return { kind: 'xt', command: parts[1], args: parts.slice(3) };
}

export class GameConnection {
  static async open(port, { host = '127.0.0.1', timeoutMs = 15000 } = {}) {
    if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new GameProtocolError('Game sessions are loopback-only.');
    const socket = net.createConnection({ host, port });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new GameProtocolError('Timed out connecting to the game server.', { code: 'UNAVAILABLE' })); }, timeoutMs);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.once('error', error => { clearTimeout(timer); reject(new GameProtocolError(`The game server is unavailable on port ${port} (${error.code ?? 'error'}). Start the game with ./local/start.`, { code: 'UNAVAILABLE' })); });
    });
    return new GameConnection(socket, timeoutMs);
  }

  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.buffer = Buffer.alloc(0);
    this.packets = [];
    this.waiters = new Set();
    this.failure = null;
    socket.on('data', chunk => this.#receive(chunk));
    socket.on('error', () => this.#fail(new GameProtocolError('The game connection failed.', { code: 'UNAVAILABLE' })));
    socket.on('close', () => this.#fail(new GameProtocolError('The game server closed the connection unexpectedly.', { code: 'UNAVAILABLE' })));
  }

  #fail(error) {
    this.failure ??= error;
    for (const waiter of this.waiters) waiter();
  }

  #receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_BUFFER) { this.#fail(new GameProtocolError('Unexpectedly large server packet.')); this.socket.destroy(); return; }
    let index;
    while ((index = this.buffer.indexOf(0)) >= 0) {
      const raw = this.buffer.subarray(0, index).toString('utf8');
      this.buffer = this.buffer.subarray(index + 1);
      try { this.packets.push(parse(raw)); }
      catch (error) { this.#fail(error); this.socket.destroy(); return; }
      if (this.packets.length > MAX_PENDING) { this.#fail(new GameProtocolError('Too many unrelated server responses.')); this.socket.destroy(); return; }
    }
    for (const waiter of this.waiters) waiter();
  }

  send(message) { this.socket.write(Buffer.concat([Buffer.from(message, 'utf8'), Buffer.from([0])])); }
  xt(command, ...args) { this.send(`%xt%s%${command}%-1%${args.map(String).join('%')}%`); }
  xml(action, children = '') { this.send(`<msg t="sys"><body action="${action}" r="0">${children}</body></msg>`); }
  login(username, credential) { this.xml('login', `<login z="w1"><nick>${escapeXml(username)}</nick><pword>${escapeXml(credential)}</pword></login>`); }

  /**
   * Resolve the first matching packet. A Houdini error packet (`e`) rejects
   * with its numeric code so callers can distinguish explicit rejections.
   */
  wait(kind, command, { timeoutMs = this.timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const check = () => {
        const errorIndex = this.packets.findIndex(packet => packet.kind === 'xt' && packet.command === 'e');
        if (errorIndex >= 0) {
          const [packet] = this.packets.splice(errorIndex, 1);
          finish(); reject(new GameProtocolError(`The game returned error ${packet.args.join(', ')}.`, { code: 'GAME_ERROR', gameError: Number(packet.args[0]) }));
          return;
        }
        const index = this.packets.findIndex(packet => packet.kind === kind && packet.command === command);
        if (index >= 0) { const [packet] = this.packets.splice(index, 1); finish(); resolve(packet); return; }
        if (this.failure) { finish(); reject(this.failure); }
      };
      const timer = setTimeout(() => { finish(); reject(new GameProtocolError(`Timed out waiting for the game server (${kind}:${command}).`, { code: 'UNAVAILABLE' })); }, timeoutMs);
      const finish = () => { clearTimeout(timer); this.waiters.delete(check); };
      this.waiters.add(check);
      check();
    });
  }

  async waitXt(command, options) { return (await this.wait('xt', command, options)).args; }

  async handshake() {
    this.xml('verChk', '<ver v="253"/>');
    await this.wait('xml', 'apiOK');
    this.xml('rndK');
    const key = (await this.wait('xml', 'rndK')).key;
    if (!key) throw new GameProtocolError('The game server did not return an authentication key.');
    return key;
  }

  close() { this.socket.destroy(); }
}

/**
 * Log in through the login server, then authenticate to the world and wait
 * until the player is placed in a room. Returns the open world connection.
 */
export async function worldSession({ username, password, loginPort = 6112, worldPort = 9875, host = '127.0.0.1', timeoutMs = 15000 }) {
  let rawLogin, confirmation, penguinId, loginKey;
  const login = await GameConnection.open(loginPort, { host, timeoutMs });
  try {
    const randomKey = await login.handshake();
    login.login(username, loginPasswordHash(password, randomKey));
    let response;
    try { response = await login.waitXt('l'); }
    catch (error) {
      if (error.code === 'GAME_ERROR') throw new GameProtocolError(`The managed owner could not log in (game error ${error.gameError}).`, { code: 'LOGIN_REFUSED', gameError: error.gameError });
      throw error;
    }
    if (response.length < 2) throw new GameProtocolError('Incomplete AS3 login response.');
    [rawLogin, confirmation] = response;
    const fields = rawLogin.split('|');
    if (fields.length !== 7 || fields[2] !== username.toLowerCase()) throw new GameProtocolError('The AS3 login response identifies the wrong account.', { code: 'MISMATCH' });
    penguinId = Number(fields[0]);
    loginKey = fields[3];
    if (!Number.isSafeInteger(penguinId) || penguinId <= 0) throw new GameProtocolError('The AS3 login response has an invalid player ID.');
  } finally { login.close(); }

  const world = await GameConnection.open(worldPort, { host, timeoutMs });
  try {
    const randomKey = await world.handshake();
    world.login(rawLogin, `${swap(md5(loginKey + randomKey))}${loginKey}#${confirmation}`);
    await world.waitXt('l');
    world.xt('j#js', penguinId, loginKey);
    await world.waitXt('js');
    const player = await world.waitXt('lp');
    if (player[0]?.split('|')[0] !== String(penguinId)) throw new GameProtocolError('The world loaded the wrong player.', { code: 'MISMATCH' });
    const spawn = await world.waitXt('jr');
    await world.waitXt('pgu'); // Drain the unsolicited initial puffle list.
    if (!/^\d+$/.test(spawn[0] ?? '')) throw new GameProtocolError('The world did not place the player in a room.');
    return { world, penguinId };
  } catch (error) { world.close(); throw error; }
}
