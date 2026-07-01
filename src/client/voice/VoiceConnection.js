'use strict';

// WebRTC-голос для lolka.js.
//
// lolka voice работает через WebRTC (как клиенты lolka), а не через Discord UDP.
// Использует официальный WebRTC-клиент поверх @roamhq/wrtc для Node
// и говорит с голосовым сервером по простому JSON-RPC поверх WebSocket.
//
// Публичный API в духе @discordjs/voice:
//   const conn = joinVoiceChannel({ channelId, guildId, adapterCreator });
//   await conn.awaitReady();
//   conn.play('song.mp3');                 // путь к файлу или Readable-поток
//   conn.on('track', (track, userId) => {}); // приём чужого звука (wrtc MediaStreamTrack)
//   conn.destroy();

const EventEmitter = require('node:events');

// Зависимости голоса подгружаются лениво: `require('lolka.js')` не тянет WebRTC,
// пока голос реально не используется.
let wrtc;
let rtcClient;
let WebSocketImpl;
let FFmpeg;
let depsReady = false;

function ensureVoiceDeps() {
  if (depsReady) return;
  wrtc = require('@roamhq/wrtc');
  rtcClient = require('mediasoup-client');
  WebSocketImpl = require('ws');
  FFmpeg = require('prism-media').FFmpeg;
  // WebRTC-клиент браузерный, ему нужны WebRTC-глобалы.
  for (const key of [
    'RTCPeerConnection', 'RTCSessionDescription', 'RTCIceCandidate', 'MediaStream',
    'MediaStreamTrack', 'RTCRtpSender', 'RTCRtpReceiver', 'RTCRtpTransceiver',
    'RTCDtlsTransport', 'RTCIceTransport', 'RTCDataChannel', 'RTCSctpTransport',
  ]) {
    if (wrtc[key] && !global[key]) global[key] = wrtc[key];
  }
  depsReady = true;
}

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_SAMPLES = 480; // 10 мс
const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2;

// JSON-RPC поверх WebSocket к голосовому серверу.
//   request:      { id, method, data }
//   response:     { id, response: true, data } | { id, response: true, error }
//   notification: { notification: true, method, data }
class VoiceSignaling {
  constructor(url, onNotification) {
    this.url = url;
    this.onNotification = onNotification;
    this.ws = null;
    this.pending = new Map();
    this.nextId = 1;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocketImpl(this.url);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', buffer => {
        let obj;
        try {
          obj = JSON.parse(buffer.toString());
        } catch {
          return;
        }
        if (obj.response) {
          const p = this.pending.get(obj.id);
          if (p) {
            this.pending.delete(obj.id);
            if (obj.error) p.reject(new Error(String(obj.error)));
            else p.resolve(obj.data ?? {});
          }
        } else if (obj.notification) {
          Promise.resolve(this.onNotification(obj.method, obj.data ?? {})).catch(() => {});
        }
      });
    });
  }

  request(method, data = {}, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, data }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`voice signaling timeout: ${method}`));
        }
      }, timeout);
    });
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Активное голосовое соединение в канале.
 * @extends {EventEmitter}
 */
class VoiceConnection extends EventEmitter {
  constructor({ channelId, guildId, adapterCreator, selfMute = false, selfDeaf = false }) {
    super();
    if (!channelId || !guildId || typeof adapterCreator !== 'function') {
      throw new TypeError('joinVoiceChannel requires { channelId, guildId, adapterCreator }');
    }
    ensureVoiceDeps();

    this.channelId = channelId;
    this.guildId = guildId;
    this.state = 'connecting';

    this.sessionId = null;
    this.token = null;
    this.endpoint = null;

    this._signaling = null;
    this._device = null;
    this._sendTransport = null;
    this._recvTransport = null;
    this._audioSource = null;
    this._audioTrack = null;
    this._producer = null;
    this._consumers = new Map();

    this._playToken = null;
    this._playTimer = null;
    this._playFF = null;

    this._started = false;
    this._destroyed = false;

    let readyResolve;
    let readyReject;
    this._ready = new Promise((res, rej) => {
      readyResolve = res;
      readyReject = rej;
    });
    this._ready.catch(() => {}); // не роняем процесс, если никто не ждёт
    this._readyResolve = readyResolve;
    this._readyReject = readyReject;

    this._adapter = adapterCreator({
      onVoiceStateUpdate: data => {
        this.sessionId = data.session_id;
        if (data.channel_id === null || data.channel_id === undefined) {
          this.destroy();
        }
      },
      onVoiceServerUpdate: data => {
        this.token = data.token;
        this.endpoint = data.endpoint;
        this._maybeStart();
      },
      destroy: () => this._cleanup(),
    });

    // Op 4 — Voice State Update (просим сервер подключить нас к каналу).
    this._adapter.sendPayload({
      op: 4,
      d: { guild_id: guildId, channel_id: channelId, self_mute: Boolean(selfMute), self_deaf: Boolean(selfDeaf) },
    });
  }

  /** Дождаться готовности соединения (WebRTC поднят). */
  awaitReady(timeout = 30000) {
    return Promise.race([
      this._ready,
      new Promise((_, rej) => setTimeout(() => rej(new Error('voice connection timeout')), timeout)),
    ]);
  }

  async _maybeStart() {
    if (this._started || this._destroyed || !this.token || !this.endpoint) return;
    this._started = true;
    try {
      await this._start();
      this.state = 'ready';
      this.emit('ready');
      this._readyResolve();
    } catch (error) {
      this.state = 'error';
      this.emit('error', error);
      this._readyReject(error);
    }
  }

  _signalingUrl() {
    let ep = this.endpoint || '';
    if (!ep.includes('://')) ep = `ws://${ep}`;
    return `${ep}${ep.includes('?') ? '&' : '?'}token=${this.token}`;
  }

  async _start() {
    this._signaling = new VoiceSignaling(this._signalingUrl(), (method, data) => this._onNotification(method, data));
    await this._signaling.connect();

    const routerRtpCapabilities = await this._signaling.request('getRouterRtpCapabilities', {});
    this._device = new rtcClient.Device({ handlerName: 'Chrome111' });
    await this._device.load({ routerRtpCapabilities });

    await this._createSendTransport();
    await this._createRecvTransport();

    // Постоянный исходящий трек; play() подаёт в него PCM.
    this._audioSource = new wrtc.nonstandard.RTCAudioSource();
    this._audioTrack = this._audioSource.createTrack();
    this._producer = await this._sendTransport.produce({ track: this._audioTrack });

    const { producers } = await this._signaling.request('getProducers', {});
    for (const p of producers) await this._consume(p.producerId, p.userId, p.kind);
  }

  async _createSendTransport() {
    const params = await this._signaling.request('createWebRtcTransport', { direction: 'send' });
    this._sendTransport = this._device.createSendTransport(params);
    this._sendTransport.on('connect', ({ dtlsParameters }, callback, errback) =>
      this._signaling
        .request('connectTransport', { transportId: this._sendTransport.id, dtlsParameters })
        .then(() => callback())
        .catch(errback),
    );
    this._sendTransport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) =>
      this._signaling
        .request('produce', { transportId: this._sendTransport.id, kind, rtpParameters, appData })
        .then(({ id }) => callback({ id }))
        .catch(errback),
    );
  }

  async _createRecvTransport() {
    const params = await this._signaling.request('createWebRtcTransport', { direction: 'recv' });
    this._recvTransport = this._device.createRecvTransport(params);
    this._recvTransport.on('connect', ({ dtlsParameters }, callback, errback) =>
      this._signaling
        .request('connectTransport', { transportId: this._recvTransport.id, dtlsParameters })
        .then(() => callback())
        .catch(errback),
    );
  }

  async _consume(producerId, userId, kind) {
    if (this._consumers.has(producerId) || !this._recvTransport) return;
    try {
      const params = await this._signaling.request('consume', {
        transportId: this._recvTransport.id,
        producerId,
        rtpCapabilities: this._device.rtpCapabilities,
      });
      const consumer = await this._recvTransport.consume(params);
      await this._signaling.request('resumeConsumer', { consumerId: consumer.id });
      this._consumers.set(producerId, consumer);
      this.emit('track', consumer.track, userId, producerId);
    } catch (error) {
      this.emit('error', error);
    }
  }

  async _onNotification(method, data) {
    if (method === 'newProducer') {
      await this._consume(data.producerId, data.userId, data.kind);
    } else if (method === 'consumerClosed' || method === 'producerClosed') {
      if (data.producerId) this._consumers.delete(data.producerId);
    } else if (method === 'kicked') {
      this.destroy();
    }
  }

  /**
   * Проиграть аудио в канал.
   * @param {string|import('node:stream').Readable} input Путь к файлу или Readable-поток (любой формат — через ffmpeg).
   */
  play(input) {
    if (!this._audioSource) throw new Error('voice connection is not ready');
    this.stop();

    const args =
      typeof input === 'string'
        ? ['-i', input]
        : ['-i', 'pipe:0'];
    const ff = new FFmpeg({
      args: [...args, '-analyzeduration', '0', '-loglevel', '0', '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS)],
    });
    if (typeof input !== 'string' && input && typeof input.pipe === 'function') input.pipe(ff);

    let ended = false;
    ff.on('end', () => {
      ended = true;
    });
    ff.on('error', error => {
      ended = true;
      this.emit('error', error);
    });

    const token = {};
    this._playToken = token;
    this._playFF = ff;
    const start = performance.now();
    let frame = 0;
    this.emit('playing');

    const tick = () => {
      if (this._playToken !== token) return;
      let chunk = ff.read(FRAME_BYTES);
      if (ended && !chunk) {
        this._playToken = null;
        this.emit('idle');
        return;
      }
      // wrtc требует Int16Array в отдельном ArrayBuffer ровно нужного размера.
      const ab = new ArrayBuffer(FRAME_BYTES);
      if (chunk) {
        if (chunk.length < FRAME_BYTES) {
          const padded = Buffer.alloc(FRAME_BYTES);
          chunk.copy(padded);
          chunk = padded;
        }
        new Uint8Array(ab).set(chunk.subarray(0, FRAME_BYTES));
      }
      // Если данных нет (джиттер) — кадр остаётся тишиной, расписание не сбиваем.
      this._audioSource.onData({
        samples: new Int16Array(ab),
        sampleRate: SAMPLE_RATE,
        bitsPerSample: 16,
        channelCount: CHANNELS,
        numberOfFrames: FRAME_SAMPLES,
      });
      frame += 1;
      const target = start + frame * 10;
      this._playTimer = setTimeout(tick, Math.max(0, target - performance.now()));
    };

    // preroll ~400 мс: даём ffmpeg наполнить буфер, чтобы не было стартовых пропусков.
    this._playTimer = setTimeout(tick, 400);
  }

  /** Остановить текущее воспроизведение. */
  stop() {
    this._playToken = null;
    if (this._playTimer) {
      clearTimeout(this._playTimer);
      this._playTimer = null;
    }
    if (this._playFF) {
      try {
        this._playFF.destroy();
      } catch {
        // ignore
      }
      this._playFF = null;
    }
  }

  /** Выйти из канала и освободить ресурсы. */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.state = 'destroyed';
    this.stop();
    try {
      this._adapter?.sendPayload({
        op: 4,
        d: { guild_id: this.guildId, channel_id: null, self_mute: false, self_deaf: false },
      });
    } catch {
      // ignore
    }
    this._cleanup();
    try {
      this._adapter?.destroy();
    } catch {
      // ignore
    }
    this.emit('destroyed');
  }

  _cleanup() {
    this._consumers.clear();
    for (const transport of [this._sendTransport, this._recvTransport]) {
      try {
        transport?.close();
      } catch {
        // ignore
      }
    }
    this._sendTransport = null;
    this._recvTransport = null;
    this._signaling?.close();
    this._signaling = null;
  }
}

/**
 * Подключиться к голосовому каналу.
 * @param {Object} options
 * @param {string} options.channelId ID голосового канала
 * @param {string} options.guildId ID сервера
 * @param {Function} options.adapterCreator `guild.voiceAdapterCreator`
 * @param {boolean} [options.selfMute=false]
 * @param {boolean} [options.selfDeaf=false]
 * @returns {VoiceConnection}
 */
function joinVoiceChannel(options) {
  return new VoiceConnection(options);
}

module.exports = { VoiceConnection, joinVoiceChannel };
