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
