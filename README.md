# lolka.js

**Fork of [discord.js](https://github.com/discordjs/discord.js) (stable release 14.26.4), licensed under Apache-2.0.**
Copyright (c) the discord.js contributors.

`lolka.js` is a Node.js module for interacting with the **lolka** bot API. It targets lolka by
default (REST/Gateway, no manual overrides needed), decodes lolka snowflakes, and resolves lolka
CDN asset URLs. See [`NOTICE`](https://github.com/Lolka-App/lolka.js/blob/main/NOTICE) /
[`LICENSE`](https://github.com/Lolka-App/lolka.js/blob/main/LICENSE) for licensing.

## Installing

```sh
npm install lolka.js
```

**Node.js 18 or newer is required.**

## Quick Example

```js
const { Client, GatewayIntentBits } = require('lolka.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

client.once('ready', () => {
	console.log(`Logged on as ${client.user.tag}`);
});

client.on('messageCreate', (message) => {
	if (message.author.bot) return;
	if (message.content === 'ping') message.channel.send('pong');
});

client.login('token');
```

## Voice

Voice works over WebRTC (lolka's voice stack, not Discord's UDP transport) and ships with the base
install — there's nothing extra to add. The API is in the spirit of `@discordjs/voice`: get a
connection with `joinVoiceChannel`, play audio, and (optionally) receive other participants' audio.

```js
const { Client, GatewayIntentBits, joinVoiceChannel } = require('lolka.js');

const client = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages],
});

client.on('messageCreate', async (message) => {
	if (message.content !== '!play') return;

	const channel = message.member?.voice?.channel;
	if (!channel) return message.reply('Join a voice channel first.');

	const connection = joinVoiceChannel({
		channelId: channel.id,
		guildId: channel.guild.id,
		adapterCreator: channel.guild.voiceAdapterCreator,
	});

	// receive other participants' audio (optional)
	connection.on('track', (track, userId) => {
		// `track` is a MediaStreamTrack from @roamhq/wrtc
		console.log(`receiving audio from ${userId}`);
	});

	await connection.awaitReady();
	connection.play('song.mp3'); // a file path or any Readable stream (decoded via ffmpeg)

	connection.on('idle', () => console.log('playback finished'));
});

client.login('token');
```

Leave the channel with `connection.destroy()`, and stop playback (without leaving) with
`connection.stop()`. Playing files requires `ffmpeg` to be available in the bot's environment.

Calling `joinVoiceChannel` again for a guild that already has a live connection reuses it and moves the
bot via `connection.rejoin({ channelId, selfMute, selfDeaf })` (all fields optional), like `@discordjs/voice`.
Moving the bot between channels, or the channel being moved to another voice server, is transparent to
`play()`: the outgoing track is kept and playback continues. After such a move the `track` event fires
again for every participant (the old tracks end), and `ready` is still emitted only once. If the voice
server kicks the bot, or the connection to the voice server is lost, and no move follows within a few
seconds, the connection is destroyed (`state` stays `'ready'` during that grace period). A failed initial
start also destroys the connection, so the next `joinVoiceChannel` creates a fresh one. Connections are
reused per client and guild, so several clients in one process do not interfere.

`joinVoiceChannel(options)` accepts:

| option | type | description |
| --- | --- | --- |
| `channelId` | `string` | Voice channel id |
| `guildId` | `string` | Guild id |
| `adapterCreator` | `Function` | `guild.voiceAdapterCreator` |
| `selfMute` | `boolean` | default `false` |
| `selfDeaf` | `boolean` | default `false` |

## Configuration

`lolka.js` talks to the public lolka by default. These environment variables override the endpoints
(read when a client is created, no trailing slash needed):

| variable | default | description |
| --- | --- | --- |
| `LOLKA_API_BASE` | `https://lolka.app/api/bot` | Bot API base (the library appends `/v10`). The gateway URL is taken from `GET /gateway/bot` |
| `LOLKA_CDN` | `https://cdn.lolka.app` | CDN for avatars, banners, icons, emojis, soundboard |
| `LOLKA_WEB` | `https://lolka.app` | Web client, used for channel/message links and bot authorization |
| `LOLKA_INVITE` | `https://lolka.gg` | Base of invite links |

### CDN

The lolka CDN does no resizing and serves only webp, so the `size`, `extension` and `forceStatic`
options of `avatarURL()`, `iconURL()`, `bannerURL()` and friends are ignored. `client.rest.cdn` is a
`LolkaCDN` (exported, together with the `LolkaCDNBase`, `LolkaWebBase`, `LolkaInviteBase` and
`LolkaApiBase` constants, which are snapshots of the values at load time).

### Links

- `invite.url` is `https://lolka.gg/{code}`; invites are also recognised as `https://lolka.app/i/{code}`
- `client.generateInvite()` returns `https://lolka.app/bot-authorize?client_id=...`
- `webhook.url` is `https://lolka.app/api/webhooks/{id}/{token}`; `WebhookClient` accepts such URLs
- `channel.url` is `https://lolka.app/servers/{guild}/channels/{channel}` (DMs: `/me/channels/{channel}`),
  `message.url` appends `/{message}`
- the exported `channelLink()` and `messageLink()` build the same URLs
