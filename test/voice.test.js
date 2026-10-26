'use strict';

// Голосовое соединение против поддельных wrtc/mediasoup-client/prism-media и настоящего ws-«SFU» на localhost.

const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const Module = require('node:module');
const { describe, it } = require('node:test');
const WebSocket = require('ws');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const reg = { transports: [], sources: [], tracks: [] };
let deviceCount = 0;

class FakeTransport extends EventEmitter {
  constructor(direction, params) {
    super();
    this.id = params.id;
    this.direction = direction;
    this.closed = false;
    this.producers = [];
    reg.transports.push(this);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const producer of this.producers) producer.transportClosed();
  }

  async ensureConnected() {
    if (this.connected) return;
    this.connected = true;
    await new Promise((resolve, reject) => this.emit('connect', { dtlsParameters: {} }, resolve, reject));
  }

  async produce({ track, stopTracks = true }) {
    if (this.closed) throw new Error('closed');
    if (track.readyState === 'ended') throw new Error('track ended');
    try {
      await this.ensureConnected();
      const { id } = await new Promise((resolve, reject) =>
        this.emit('produce', { kind: 'audio', rtpParameters: {}, appData: {} }, resolve, reject),
      );
      if (this.closed) throw new Error('closed');
      const producer = {
        id,
        transportClosed() {
          if (stopTracks) track.stop();
        },
      };
      this.producers.push(producer);
      return producer;
    } catch (error) {
      if (stopTracks) track.stop();
      throw error;
    }
  }

  async consume(params) {
    if (this.closed) throw new Error('closed');
    await this.ensureConnected();
    return {
      id: params.id,
      track: {
        kind: 'audio',
        readyState: 'live',
        stop() {
          this.readyState = 'ended';
        },
      },
    };
  }
}

class FakeDevice {
  constructor() {
    this.index = deviceCount++;
    this.rtpCapabilities = {};
  }

  async load() {
  }

  createSendTransport(params) {
    return new FakeTransport('send', params);
  }

  createRecvTransport(params) {
    return new FakeTransport('recv', params);
  }
}

class FakeFF extends EventEmitter {
  read(size) {
    return Buffer.alloc(size, 1);
  }

  destroy() {
    this.destroyed = true;
  }
}

const fakes = {
  '@roamhq/wrtc': {
    nonstandard: {
      RTCAudioSource: class {
        constructor() {
          this.frames = 0;
          reg.sources.push(this);
        }

        createTrack() {
          const track = {
            readyState: 'live',
            stop() {
              track.readyState = 'ended';
            },
          };
          reg.tracks.push(track);
          return track;
        }

        onData() {
          this.frames++;
        }
      },
    },
  },
  'mediasoup-client': { Device: FakeDevice },
  'prism-media': { FFmpeg: FakeFF },
};

const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  return fakes[request] ?? originalLoad.call(this, request, ...rest);
};

const { VoiceConnection, joinVoiceChannel } = require('../src/client/voice/VoiceConnection');

VoiceConnection.kickGraceMs = 50;

let transportCounter = 0;
function makeServer(name, { delays = {}, fail = {} } = {}) {
  const wss = new WebSocket.WebSocketServer({ port: 0, host: '127.0.0.1' });
  const server = { name, conns: [], producers: [], delays, fail };
  wss.on('connection', ws => {
    const conn = { ws, closed: false };
    server.conns.push(conn);
    ws.on('close', () => {
      conn.closed = true;
    });
    ws.on('message', raw => {
      const message = JSON.parse(raw.toString());
      setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        let data = {};
        let error;
        if (server.fail[message.method]) error = `fail ${message.method}`;
        else if (message.method === 'getRouterRtpCapabilities') data = { codecs: [] };
        else if (message.method === 'createWebRtcTransport') data = { id: `${name}-T${++transportCounter}` };
        else if (message.method === 'produce') {
          data = { id: `${name}-P${server.producers.length + 1}` };
          server.producers.push(data.id);
        } else if (message.method === 'getProducers') data = { producers: [] };
        else if (message.method === 'consume') data = { id: `C-${message.data.producerId}` };
        ws.send(JSON.stringify(error ? { id: message.id, response: true, error } : { id: message.id, response: true, data }));
      }, server.delays[message.method] ?? 0);
    });
  });
  server.notify = (conn, method, data = {}) => conn.ws.send(JSON.stringify({ notification: true, method, data }));
  server.close = () =>
    new Promise(resolve => {
      for (const client of wss.clients) client.terminate();
      wss.close(resolve);
    });
  return new Promise(resolve =>
    wss.on('listening', () => {
      server.url = `ws://127.0.0.1:${wss.address().port}`;
      resolve(server);
    }),
  );
}

let guildCounter = 0;
function makeConn({ guildId = `g${++guildCounter}`, join = false, owner, state = true } = {}) {
  const sent = [];
  let methods;
  const adapterCreator = m => {
    methods = m;
    return {
      sendPayload: payload => {
        sent.push(payload);
        return true;
      },
      destroy: () => sent.push('adapter.destroy'),
    };
  };
  if (owner) adapterCreator.voiceManager = owner;
  const options = { channelId: '10', guildId, adapterCreator };
  const connection = join ? joinVoiceChannel(options) : new VoiceConnection(options);
  connection.events = [];
  for (const event of ['ready', 'destroyed', 'track', 'playing']) connection.on(event, () => connection.events.push(event));
  connection.on('error', () => {});
  if (state && methods) methods.onVoiceStateUpdate({ session_id: 's', channel_id: '10' });
  return { connection, sent, methods };
}

const liveTransports = () => reg.transports.filter(t => !t.closed);

async function withServers(names, fn) {
  const servers = await Promise.all(names.map(name => makeServer(name)));
  reg.transports.length = 0;
  reg.sources.length = 0;
  reg.tracks.length = 0;
  deviceCount = 0;
  try {
    await fn(...servers);
  } finally {
    await Promise.all(servers.map(server => server.close()));
  }
}

describe('VoiceConnection', () => {
  it('destroys and can be re-joined after a failed initial start', () =>
    withServers(['A'], async A => {
      A.fail.getRouterRtpCapabilities = true;
      const owner = {};
      const guildId = 'reuse-error';
      const first = makeConn({ guildId, join: true, owner });
      first.methods.onVoiceServerUpdate({ token: 't1', endpoint: A.url });
      await assert.rejects(first.connection.awaitReady(2000));
      assert.equal(first.connection.state, 'destroyed');
      assert.ok(first.sent.some(p => p.d?.channel_id === null));

      const second = makeConn({ guildId, join: true, owner, state: false });
      assert.notEqual(second.connection, first.connection);
      first.methods.onVoiceStateUpdate({ session_id: 's', channel_id: null });
      second.methods.onVoiceStateUpdate({ session_id: 's', channel_id: null });
      assert.equal(second.connection.state, 'connecting');
      second.connection.destroy();
    }));

  it('reuses a live connection per client and guild through rejoin', () =>
    withServers([], async () => {
      const owner = {};
      const other = {};
      const first = makeConn({ guildId: 'reuse', join: true, owner });
      const second = makeConn({ guildId: 'reuse', join: true, owner });
      assert.equal(second.connection, first.connection);
      assert.equal(first.sent.length, 2);
      assert.equal(first.sent[1].op, 4);
      const foreign = makeConn({ guildId: 'reuse', join: true, owner: other });
      assert.notEqual(foreign.connection, first.connection);
      first.connection.destroy();
      const again = makeConn({ guildId: 'reuse', join: true, owner });
      assert.notEqual(again.connection, first.connection);
      again.connection.destroy();
      foreign.connection.destroy();
    }));

  it('destroys after a kick with no move, and after an unexpected signaling close', () =>
    withServers(['A'], async A => {
      const kicked = makeConn();
      kicked.methods.onVoiceServerUpdate({ token: 't1', endpoint: A.url });
      await kicked.connection.awaitReady(2000);
      A.notify(A.conns[0], 'kicked');
      await sleep(20);
      assert.equal(kicked.connection.state, 'ready');
      await sleep(120);
      assert.equal(kicked.connection.state, 'destroyed');
      assert.ok(kicked.sent.some(p => p.d?.channel_id === null));

      const closed = makeConn();
      closed.methods.onVoiceServerUpdate({ token: 't2', endpoint: A.url });
      await closed.connection.awaitReady(2000);
      A.conns.at(-1).ws.terminate();
      await sleep(200);
      assert.equal(closed.connection.state, 'destroyed');
      assert.ok(closed.sent.some(p => p.d?.channel_id === null));
    }));

  it('ignores a token-only voice server update', () =>
    withServers(['A'], async A => {
      const { connection, methods } = makeConn();
      methods.onVoiceServerUpdate({ token: 't1', endpoint: A.url });
      await connection.awaitReady(2000);
      methods.onVoiceServerUpdate({ token: 't2', endpoint: A.url });
      await sleep(100);
      assert.equal(A.conns.length, 1);
      assert.equal(connection.state, 'ready');
      connection.destroy();
    }));

  it('migrates to another server keeping the outgoing track and emitting ready once', () =>
    withServers(['A', 'B'], async (A, B) => {
      const { connection, methods } = makeConn();
      methods.onVoiceServerUpdate({ token: 't1', endpoint: A.url });
      await connection.awaitReady(2000);
      methods.onVoiceServerUpdate({ token: 't2', endpoint: B.url });
      await sleep(200);
      assert.equal(connection.state, 'ready');
      assert.equal(connection.events.filter(e => e === 'ready').length, 1);
      assert.equal(reg.sources.length, 1);
      assert.deepEqual(reg.tracks.map(t => t.readyState), ['live']);
      assert.equal(B.producers.length, 1);
      assert.equal(liveTransports().length, 2);
      connection.destroy();
      assert.equal(liveTransports().length, 0);
    }));

  it('leaves no orphans when a second update arrives during start or migration', () =>
    withServers(['A', 'B'], async (A, B) => {
      B.delays.createWebRtcTransport = 40;
      const { connection, methods } = makeConn();
      methods.onVoiceServerUpdate({ token: 't1', endpoint: A.url });
      await connection.awaitReady(2000);
      methods.onVoiceServerUpdate({ token: 't2', endpoint: B.url });
      await sleep(10);
      methods.onVoiceServerUpdate({ token: 't3', endpoint: A.url });
      await sleep(400);
      assert.equal(connection.state, 'ready');
      assert.equal(liveTransports().length, 2);
      assert.ok(liveTransports().every(t => t === connection._sendTransport || t === connection._recvTransport));
      assert.equal(A.conns.filter(c => !c.closed).length, 1);
      assert.ok(B.conns.every(c => c.closed));
      assert.equal(reg.sources.length, 1);
      connection.destroy();
    }));

  it('does not resurrect anything when destroyed during migration', () =>
    withServers(['A', 'B'], async (A, B) => {
      B.delays.createWebRtcTransport = 60;
      const { connection, methods } = makeConn();
      methods.onVoiceServerUpdate({ token: 't1', endpoint: A.url });
      await connection.awaitReady(2000);
      methods.onVoiceServerUpdate({ token: 't2', endpoint: B.url });
      await sleep(20);
      connection.destroy();
      await sleep(300);
      assert.equal(connection.state, 'destroyed');
      assert.equal(liveTransports().length, 0);
      assert.equal(connection._audioSource, null);
      assert.deepEqual(reg.tracks.map(t => t.readyState), ['ended']);
    }));

  it('ignores kicked from the old signaling after a migration', () =>
    withServers(['A', 'B'], async (A, B) => {
      const { connection, methods, sent } = makeConn();
      methods.onVoiceServerUpdate({ token: 't1', endpoint: A.url });
      await connection.awaitReady(2000);
      const oldConn = A.conns[0];
      methods.onVoiceServerUpdate({ token: 't2', endpoint: B.url });
      await sleep(150);
      A.notify(oldConn, 'kicked');
      await sleep(50);
      assert.equal(connection.state, 'ready');
      assert.equal(sent.some(p => p.d?.channel_id === null), false);
      connection.destroy();
    }));

  it('destroys the connection when a migration fails', () =>
    withServers(['A', 'B'], async (A, B) => {
      B.fail.createWebRtcTransport = true;
      const { connection, methods, sent } = makeConn();
      methods.onVoiceServerUpdate({ token: 't1', endpoint: A.url });
      await connection.awaitReady(2000);
      methods.onVoiceServerUpdate({ token: 't2', endpoint: B.url });
      await sleep(200);
      assert.equal(connection.state, 'destroyed');
      assert.ok(sent.some(p => p.d?.channel_id === null));
      assert.equal(liveTransports().length, 0);
    }));

  it('re-establishes the session on the same endpoint after the bot is moved to another channel', () =>
    withServers(['A'], async A => {
      const { connection, methods } = makeConn();
      methods.onVoiceServerUpdate({ token: 't1', endpoint: A.url });
      await connection.awaitReady(2000);
      A.notify(A.conns[0], 'kicked');
      await sleep(30);
      methods.onVoiceStateUpdate({ session_id: 's', channel_id: '20' });
      methods.onVoiceServerUpdate({ token: 't-room20', endpoint: A.url });
      await sleep(200);
      assert.equal(connection.state, 'ready');
      assert.equal(connection.channelId, '20');
      assert.equal(A.conns.length, 2);
      assert.equal(reg.sources.length, 1);
      connection.destroy();
    }));

  it('rejoin sends op 4 with the new channel', () =>
    withServers([], async () => {
      const { connection, sent } = makeConn();
      connection.rejoin({ channelId: '30', selfMute: true });
      assert.deepEqual(sent.at(-1), {
        op: 4,
        d: { guild_id: connection.guildId, channel_id: '30', self_mute: true, self_deaf: false },
      });
      connection.destroy();
    }));

  it('adapter destroy during play tears down without crashing', () =>
    withServers(['A'], async A => {
      const { connection, methods, sent } = makeConn();
      methods.onVoiceServerUpdate({ token: 't1', endpoint: A.url });
      await connection.awaitReady(2000);
      connection.play('x.mp3');
      await sleep(450);
      methods.destroy();
      await sleep(100);
      assert.equal(connection.state, 'destroyed');
      assert.equal(connection._playTimer, null);
      assert.deepEqual(sent.filter(p => p === 'adapter.destroy' || p.d?.channel_id === null), []);
      assert.equal(liveTransports().length, 0);
    }));
});
