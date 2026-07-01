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

`joinVoiceChannel(options)` accepts:

| option | type | description |
| --- | --- | --- |
| `channelId` | `string` | Voice channel id |
| `guildId` | `string` | Guild id |
| `adapterCreator` | `Function` | `guild.voiceAdapterCreator` |
| `selfMute` | `boolean` | default `false` |
| `selfDeaf` | `boolean` | default `false` |
