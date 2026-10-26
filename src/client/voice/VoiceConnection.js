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
const DEFAULT_KICK_GRACE_MS = 5000;

// Живые соединения: owner (голосовой менеджер клиента) -> guildId -> соединение. Повторный
// joinVoiceChannel переиспользует соединение через rejoin(); разные клиенты не пересекаются.
const defaultOwner = {};
const connections = new WeakMap();

function ownerOf(adapterCreator) {
  return adapterCreator?.voiceManager ?? defaultOwner;
}

// JSON-RPC поверх WebSocket к голосовому серверу.
//   request:      { id, method, data }
//   response:     { id, response: true, data } | { id, response: true, error }
//   notification: { notification: true, method, data }
class VoiceSignaling {
  constructor(url, onNotification, onClose) {
    this.url = url;
    this.onNotification = onNotification;
    this.onClose = onClose;
    this.closing = false;
    this.ws = null;
    this.pending = new Map();
    this.nextId = 1;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocketImpl(this.url);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('close', () => {
        for (const [id, p] of this.pending) {
          this.pending.delete(id);
          p.reject(new Error('voice signaling closed'));
        }
        if (!this.closing) this.onClose?.();
      });
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
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`voice signaling timeout: ${method}`));
        }
      }, timeout);
      this.pending.set(id, {
        resolve: value => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: error => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.ws.send(JSON.stringify({ id, method, data }));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  close() {
    this.closing = true;
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

    this._owner = ownerOf(adapterCreator);
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

    this._kickTimer = null;
    this._started = false;
    this._destroyed = false;
    this._migration = 0; // счётчик переездов: результат устаревшего старта/переезда игнорируется
    this._readyAnnounced = false;
    this._roomChanged = false;
    this._stateReceived = false;

    let readyResolve;
    let readyReject;
    this._ready = new Promise((res, rej) => {
      readyResolve = res;
      readyReject = rej;
    });
    this._ready.catch(() => {}); // не роняем процесс, если никто не ждёт
    this._readyResolve = readyResolve;
    this._readyReject = readyReject;

    this._selfMute = Boolean(selfMute);
    this._selfDeaf = Boolean(selfDeaf);

    this._adapter = adapterCreator({
      onVoiceStateUpdate: data => {
        this.sessionId = data.session_id;
        if (data.channel_id === null || data.channel_id === undefined) {
          if (this._stateReceived) this.destroy();
          return;
        }
        this._stateReceived = true;
        const channelId = String(data.channel_id);
        if (channelId !== String(this.channelId)) {
          this.channelId = channelId;
          if (this._started) this._roomChanged = true;
        }
      },
      onVoiceServerUpdate: data => {
        // Повторный Voice Server Update у уже поднятого соединения приходит, когда голосовой сервер
        // канала сменили вручную (SetChannelVoiceServer -> migrateBotParticipant) или назначенный
        // сервер нездоров и бот повторил op 4; также после перемещения бота в другой канал (тот же
        // endpoint, но новая комната). Failover мёртвого сервера сюда не приходит — он только кикает.
        // Смена одного лишь токена сессию не трогает: бэкенд перевыпускает его на каждый
        // Voice State Update (например, при self_mute).
        const serverChanged =
          this._started && Boolean(data.endpoint) && (data.endpoint !== this.endpoint || this._roomChanged);
        this.token = data.token;
        if (data.endpoint || !this._started) this.endpoint = data.endpoint;
        if (serverChanged) {
          this._roomChanged = false;
          this._migrate();
        } else {
          this._maybeStart();
        }
      },
      // Шард отключился безвозвратно: полный локальный teardown без op 4 и без adapter.destroy().
      destroy: () => {
        if (this._destroyed) return;
        this._destroyed = true;
        this.state = 'destroyed';
        this._finalize();
        this.emit('destroyed');
      },
    });

    this._sendState(channelId);
  }

  _sendState(channelId) {
    // Op 4 — Voice State Update (просим сервер подключить нас к каналу).
    return this._adapter.sendPayload({
      op: 4,
      d: { guild_id: this.guildId, channel_id: channelId, self_mute: this._selfMute, self_deaf: this._selfDeaf },
    });
  }

  /**
   * Переместить соединение в другой канал (или обновить mute/deaf) без пересоздания.
   * @param {Object} options
   * @param {string} [options.channelId] ID нового голосового канала
   * @param {boolean} [options.selfMute]
   * @param {boolean} [options.selfDeaf]
   * @returns {boolean} Удалось ли отправить op 4
   */
  rejoin({ channelId = this.channelId, selfMute = this._selfMute, selfDeaf = this._selfDeaf } = {}) {
    if (this._destroyed) throw new Error('voice connection is destroyed');
    this._selfMute = Boolean(selfMute);
    this._selfDeaf = Boolean(selfDeaf);
    return this._sendState(channelId);
  }

  /** Дождаться готовности соединения (WebRTC поднят). */
  awaitReady(timeout = 30000) {
    let timer;
    const timeoutPromise = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error('voice connection timeout')), timeout);
    });
    return Promise.race([this._ready, timeoutPromise]).finally(() => clearTimeout(timer));
  }

  async _maybeStart() {
    if (this._started || this._destroyed || !this.token || !this.endpoint) return;
    this._started = true;
    const migration = this._migration;
    try {
      await this._start(migration);
      // Пока поднимались, голосовой сервер сменился — исход этого старта уже не важен,
      // готовность объявит _migrate.
      if (migration !== this._migration) return;
      this._markReady();
    } catch (error) {
      if (migration !== this._migration || this._destroyed) return;
      this._readyReject(error);
      if (this.listenerCount('error') > 0) this.emit('error', error);
      this.destroy();
    }
  }

  /** Соединение поднято: `ready` и awaitReady() срабатывают один раз, даже после переездов. */
  _markReady() {
    this.state = 'ready';
    if (this._readyAnnounced) return;
    this._readyAnnounced = true;
    this.emit('ready');
    this._readyResolve();
  }

  _signalingUrl() {
    let ep = this.endpoint || '';
    if (!ep.includes('://')) ep = `ws://${ep}`;
    return `${ep}${ep.includes('?') ? '&' : '?'}token=${this.token}`;
  }

  /**
   * Голосовой сервер сменился — пересобираем сессию на новом endpoint. Исходящий трек
   * сохраняется, поэтому текущее воспроизведение не прерывается.
   */
  async _migrate() {
    if (this._destroyed) return;
    const migration = ++this._migration;
    this.state = 'connecting';
    this._closeSession();
    try {
      await this._start(migration);
      if (migration !== this._migration || this._destroyed) return;
      this._markReady();
    } catch (error) {
      if (migration !== this._migration || this._destroyed) return;
      this._readyReject(error);
      if (this.listenerCount('error') > 0) this.emit('error', error);
      this.destroy();
    }
  }

  async _start(migration) {
    const check = () => {
      if (migration !== this._migration || this._destroyed) throw new Error('voice session superseded');
    };
    const signaling = new VoiceSignaling(
      this._signalingUrl(),
      (method, data) => {
        // Уведомления от уже заменённого сигналинга (прежний голосовой сервер) игнорируем —
        // иначе его запоздалый `kicked` уничтожил бы переехавшее соединение.
        if (this._signaling !== signaling) return undefined;
        return this._onNotification(method, data);
      },
      () => {
        if (this._signaling === signaling) this._scheduleKickDestroy();
      },
    );
    this._signaling = signaling;
    await signaling.connect();
    check();

    const routerRtpCapabilities = await signaling.request('getRouterRtpCapabilities', {});
    check();
    const device = new rtcClient.Device({ handlerName: 'Chrome111' });
    await device.load({ routerRtpCapabilities });
    check();
    this._device = device;

    await this._createSendTransport(check);
    await this._createRecvTransport(check);
    check();

    // Постоянный исходящий трек; play() подаёт в него PCM. Создаётся один раз и переживает
    // смену голосового сервера (stopTracks: false — закрытие продюсера трек не останавливает).
    if (!this._audioSource) {
      this._audioSource = new wrtc.nonstandard.RTCAudioSource();
      this._audioTrack = this._audioSource.createTrack();
    }
    this._producer = await this._sendTransport.produce({ track: this._audioTrack, stopTracks: false });

    check();
    const { producers } = await signaling.request('getProducers', {});
    check();
    for (const p of producers) await this._consume(p.producerId, p.userId, p.kind);
  }

  async _createSendTransport(check) {
    const params = await this._signaling.request('createWebRtcTransport', { direction: 'send' });
    check();
    this._sendTransport = this._device.createSendTransport(params);
    const signaling = this._signaling;
    const transport = this._sendTransport;
    transport.on('connect', ({ dtlsParameters }, callback, errback) =>
      signaling
        .request('connectTransport', { transportId: transport.id, dtlsParameters })
        .then(() => callback())
        .catch(errback),
    );
    transport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) =>
      signaling
        .request('produce', { transportId: transport.id, kind, rtpParameters, appData })
        .then(({ id }) => callback({ id }))
        .catch(errback),
    );
  }

  async _createRecvTransport(check) {
    const params = await this._signaling.request('createWebRtcTransport', { direction: 'recv' });
    check();
    this._recvTransport = this._device.createRecvTransport(params);
    const signaling = this._signaling;
    const transport = this._recvTransport;
    transport.on('connect', ({ dtlsParameters }, callback, errback) =>
      signaling
        .request('connectTransport', { transportId: transport.id, dtlsParameters })
        .then(() => callback())
        .catch(errback),
    );
  }

  async _consume(producerId, userId, kind) {
    const recv = this._recvTransport;
    const signaling = this._signaling;
    if (kind !== 'audio' || !recv || !signaling || this._consumers.has(producerId)) return;
    try {
      const params = await signaling.request('consume', {
        transportId: recv.id,
        producerId,
        rtpCapabilities: this._device.rtpCapabilities,
      });
      if (this._recvTransport !== recv) return;
      const consumer = await recv.consume(params);
      if (this._recvTransport !== recv) return;
      await signaling.request('resumeConsumer', { consumerId: consumer.id });
      if (this._recvTransport !== recv) return;
      this._consumers.set(producerId, consumer);
      this.emit('track', consumer.track, userId, producerId);
    } catch (error) {
      if (this._recvTransport === recv && this.listenerCount('error') > 0) this.emit('error', error);
    }
  }

  async _onNotification(method, data) {
    if (method === 'newProducer') {
      await this._consume(data.producerId, data.userId, data.kind);
    } else if (method === 'producerClosed') {
      if (data.producerId) this._consumers.delete(data.producerId);
    } else if (method === 'consumerClosed') {
      for (const [producerId, consumer] of this._consumers) {
        if (consumer.id === data.consumerId) this._consumers.delete(producerId);
      }
    } else if (method === 'kicked') {
      this._scheduleKickDestroy();
    }
  }

  /**
   * Сервер кикнул нас (или сигналинг оборвался). При перемещении бота в другой канал за киком сразу
   * следует переезд, поэтому уничтожаем соединение только если за grace-период переезда не было.
   */
  _scheduleKickDestroy() {
    if (this._destroyed) return;
    const migration = this._migration;
    clearTimeout(this._kickTimer);
    this._kickTimer = setTimeout(() => {
      this._kickTimer = null;
      if (!this._destroyed && migration === this._migration) this.destroy();
    }, VoiceConnection.kickGraceMs);
    this._kickTimer.unref?.();
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
    try {
      this._adapter?.sendPayload({
        op: 4,
        d: { guild_id: this.guildId, channel_id: null, self_mute: false, self_deaf: false },
      });
    } catch {
      // ignore
    }
    this._finalize();
    try {
      this._adapter?.destroy();
    } catch {
      // ignore
    }
    this.emit('destroyed');
  }

  _finalize() {
    clearTimeout(this._kickTimer);
    this._kickTimer = null;
    this.stop();
    this._closeSession();
    try {
      this._audioTrack?.stop();
    } catch {
      // ignore
    }
    this._audioTrack = null;
    this._audioSource = null;
    if (!this._readyAnnounced) this._readyReject(new Error('voice connection destroyed'));
    const byGuild = connections.get(this._owner);
    if (byGuild?.get(this.guildId) === this) byGuild.delete(this.guildId);
  }

  /** Закрыть сессию с текущим голосовым сервером, не трогая исходящий трек. */
  _closeSession() {
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
    this._producer = null;
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
  const owner = ownerOf(options.adapterCreator);
  let byGuild = connections.get(owner);
  const existing = byGuild?.get(options.guildId);
  if (existing && !existing._destroyed) {
    existing.rejoin({ channelId: options.channelId, selfMute: options.selfMute, selfDeaf: options.selfDeaf });
    return existing;
  }
  const connection = new VoiceConnection(options);
  if (!byGuild) {
    byGuild = new Map();
    connections.set(owner, byGuild);
  }
  byGuild.set(options.guildId, connection);
  return connection;
}

/**
 * How long (ms) the connection survives a kick or a lost signaling socket waiting for a move.
 * @type {number}
 */
VoiceConnection.kickGraceMs = DEFAULT_KICK_GRACE_MS;

module.exports = { VoiceConnection, joinVoiceChannel };
