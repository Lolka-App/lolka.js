'use strict';

for (const key of Object.keys(process.env)) {
  if (key.startsWith('LOLKA_')) delete process.env[key];
}

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } = require('undici');
const {
  Client,
  Role,
  Webhook,
  WebhookClient,
  Invite,
  LolkaCDN,
  GuildMember,
  Message,
  GuildScheduledEvent,
  channelLink,
  messageLink,
} = require('../src');
const { BaseChannel } = require('../src/structures/BaseChannel');
const { resolveInviteCode } = require('../src/util/DataResolver');
const { fetchRecommendedShardCount, parseWebhookURL } = require('../src/util/Util');

const CDN = 'https://cdn.lolka.app';
const WEB = 'https://lolka.app';

describe('LolkaCDN', () => {
  const cdn = new LolkaCDN(CDN);

  it('builds URLs from storage keys and ignores options', () => {
    assert.equal(cdn.avatar('1', 'avatars/1/abc.webp'), `${CDN}/avatars/1/abc.webp`);
    assert.equal(
      cdn.avatar('1', 'avatars/1/abc_animated.webp', { size: 256, extension: 'png', forceStatic: true }),
      `${CDN}/avatars/1/abc_animated.webp`,
    );
    assert.equal(cdn.banner('1', 'banners/1/x.webp'), `${CDN}/banners/1/x.webp`);
    assert.equal(cdn.icon('1', 'icons/1/x.webp', { size: 64 }), `${CDN}/icons/1/x.webp`);
  });

  it('returns full URLs as is', () => {
    const url = `${CDN}/avatars/1/abc.webp`;
    assert.equal(cdn.avatar('1', url, { size: 128 }), url);
    assert.equal(cdn.roleIcon('1', url), url);
  });

  it('builds emoji and soundboard URLs', () => {
    assert.equal(cdn.emoji('42'), `${CDN}/emojis/42.webp`);
    assert.equal(cdn.emoji('42', { extension: 'gif', size: 64 }), `${CDN}/emojis/42.webp`);
    assert.equal(cdn.soundboardSound('7'), `${CDN}/soundboard/7.ogg`);
  });

  it('handles avatar decoration with a full URL', () => {
    const url = `${CDN}/decorations/a.webp`;
    assert.equal(cdn.avatarDecoration(url), url);
    assert.equal(cdn.avatarDecoration('decorations/a.webp'), url);
  });

  it('keeps legacy hashes on the Lolka base', () => {
    assert.equal(cdn.avatar('1', 'abcdef'), `${CDN}/avatars/1/abcdef.webp`);
  });

  it('is installed on the client', () => {
    const client = new Client({ intents: [] });
    assert.ok(client.rest.cdn instanceof LolkaCDN);
    assert.equal(client.rest.cdn.cdn, CDN);
    client.destroy();
  });
});

describe('links', () => {
  it('channelLink', () => {
    assert.equal(channelLink('2', '1'), `${WEB}/servers/1/channels/2`);
    assert.equal(channelLink('2'), `${WEB}/me/channels/2`);
    assert.equal(channelLink('2', '@me'), `${WEB}/me/channels/2`);
  });

  it('messageLink', () => {
    assert.equal(messageLink('2', '3', '1'), `${WEB}/servers/1/channels/2/3`);
    assert.equal(messageLink('2', '3'), `${WEB}/me/channels/2/3`);
  });
});

describe('invites', () => {
  it('matches lolka.gg and lolka.app/i', () => {
    assert.equal(Invite.InvitesPattern.exec('https://lolka.gg/AbC-123').groups.code, 'AbC-123');
    assert.equal(Invite.InvitesPattern.exec('https://lolka.app/i/AbC-123').groups.code, 'AbC-123');
    assert.equal(resolveInviteCode('https://lolka.gg/AbC-123'), 'AbC-123');
    assert.equal(resolveInviteCode('https://lolka.app/i/AbC-123'), 'AbC-123');
    assert.equal(resolveInviteCode('AbC-123'), 'AbC-123');
  });

  it('does not match foreign hosts', () => {
    assert.equal(Invite.InvitesPattern.exec('https://discord.gg/abc'), null);
    assert.equal(Invite.InvitesPattern.exec('https://xlolka.gg/abc'), null);
    assert.equal(Invite.InvitesPattern.exec('lolka.gg/abc').groups.code, 'abc');
    assert.equal(Invite.InvitesPattern.exec('https://www.lolka.gg/abc').groups.code, 'abc');
    assert.equal(Invite.InvitesPattern.exec('https://www.lolka.app/i/abc').groups.code, 'abc');
  });

  it('Invite#url', () => {
    const invite = Object.create(Invite.prototype);
    invite.code = 'AbC-123';
    assert.equal(invite.url, 'https://lolka.gg/AbC-123');
  });
});

describe('webhooks', () => {
  const url = 'https://lolka.app/api/webhooks/669645931661312/NjY5NjQ1OTMxNjYxMzEy.uBvJzDCfPo6ahB5wKbajf7QEvnwunN2GqcxjMuNbUak';

  it('parseWebhookURL', () => {
    assert.deepEqual(parseWebhookURL(url), {
      id: '669645931661312',
      token: 'NjY5NjQ1OTMxNjYxMzEy.uBvJzDCfPo6ahB5wKbajf7QEvnwunN2GqcxjMuNbUak',
    });
    assert.equal(parseWebhookURL('https://lolka.app/api/v10/webhooks/1/tok.en-_')?.token, 'tok.en-_');
    assert.equal(parseWebhookURL('https://lolka.app/api/bot/v10/webhooks/1/tok')?.id, '1');
    assert.equal(parseWebhookURL('https://example.com/nothing'), null);
  });

  it('WebhookClient handles decorated and invalid URLs', () => {
    const wrapped = new WebhookClient({ url: '<https://lolka.app/api/webhooks/1/tok>' });
    assert.equal(wrapped.options.rest.api, 'https://lolka.app/api/bot');
    wrapped.destroy();
    const prefixed = new WebhookClient({ url: 'Webhook: https://lolka.app/api/webhooks/1/tok' });
    assert.equal(prefixed.options.rest.api, 'https://lolka.app/api/bot');
    prefixed.destroy();
    assert.throws(() => new WebhookClient({ url: 'lolka.app/nope' }), { code: 'WebhookURLInvalid' });
    assert.throws(() => new WebhookClient({ url: 'http://localhost/api/webhooks/1/tok' }, 'bad'), TypeError);
  });

  it('WebhookClient with a foreign host sends to that host', () => {
    const wc = new WebhookClient({ url: 'http://localhost:8080/api/webhooks/1/tok' });
    assert.equal(wc.options.rest.api, 'http://localhost:8080/api/bot');
    wc.destroy();

    const explicit = new WebhookClient(
      { url: 'http://localhost:8080/api/webhooks/1/tok' },
      { rest: { api: 'https://example.org/api/bot' } },
    );
    assert.equal(explicit.options.rest.api, 'https://example.org/api/bot');
    explicit.destroy();
  });

  it('WebhookClient accepts a lolka URL', () => {
    const wc = new WebhookClient({ url });
    assert.equal(wc.id, '669645931661312');
    assert.equal(wc.url, url);
    wc.destroy();
  });

  it('Webhook#url', () => {
    const client = new Client({ intents: [] });
    const webhook = new Webhook(client, { id: '5', token: 'a.b' });
    assert.equal(webhook.url, `${WEB}/api/webhooks/5/a.b`);
    client.destroy();
  });
});

describe('Client#generateInvite', () => {
  it('builds a bot-authorize link', () => {
    const client = new Client({ intents: [] });
    client.application = { id: '123' };
    const link = new URL(client.generateInvite({ scopes: ['bot'], permissions: 8n }));
    assert.equal(link.origin + link.pathname, `${WEB}/bot-authorize`);
    assert.equal(link.searchParams.get('client_id'), '123');
    assert.equal(link.searchParams.get('scope'), 'bot');
    assert.equal(link.searchParams.get('permissions'), '8');
    client.destroy();
  });
});

describe('Role', () => {
  it('always has colors', () => {
    const client = new Client({ intents: [] });
    const guild = { id: '1', client };
    const role = new Role(client, { id: '2', name: 'r', color: 0xff0000, permissions: '0' }, guild);
    assert.deepEqual(role.colors, { primaryColor: 0xff0000, secondaryColor: null, tertiaryColor: null });
    assert.equal(role.hexColor, '#ff0000');

    role._patch({ id: '2', color: 0x00ff00 });
    assert.equal(role.hexColor, '#00ff00');

    const bare = new Role(client, { id: '3', name: 'r', permissions: '0', colors: null }, guild);
    assert.equal(bare.colors.primaryColor, 0);
    assert.equal(bare.hexColor, '#000000');

    const full = new Role(
      client,
      { id: '4', name: 'r', permissions: '0', colors: { primary_color: 1, secondary_color: 2, tertiary_color: null } },
      guild,
    );
    assert.deepEqual(full.colors, { primaryColor: 1, secondaryColor: 2, tertiaryColor: null });
    client.destroy();
  });
});

describe('GuildMember', () => {
  it('keeps avatarDecorationData unless explicitly nulled', () => {
    const client = new Client({ intents: [] });
    const guild = { id: '1', client };
    const member = new GuildMember(
      client,
      { user: { id: '9' }, roles: [], avatar_decoration_data: { asset: `${CDN}/d.webp`, sku_id: '1' } },
      guild,
    );
    assert.deepEqual(member.avatarDecorationData, { asset: `${CDN}/d.webp`, skuId: '1' });
    member._patch({ nick: 'x' });
    assert.equal(member.avatarDecorationData.asset, `${CDN}/d.webp`);
    member._patch({ avatar_decoration_data: null });
    assert.equal(member.avatarDecorationData, null);
    client.destroy();
  });
});

describe('GuildScheduledEvent', () => {
  it('url and createInviteURL use Lolka hosts', async () => {
    const event = Object.create(GuildScheduledEvent.prototype);
    event.id = '7';
    event.guildId = '1';
    event.channelId = '2';
    event.entityType = 2;
    Object.defineProperty(event, 'guild', { value: { invites: { create: async () => ({ code: 'abc' }) }, channels: { resolveId: id => id } } });
    assert.equal(event.url, `${WEB}/servers/1`);
    assert.equal(`${event}`.includes('discord'), false);
    assert.equal(await event.createInviteURL(), 'https://lolka.gg/abc?event=7');
  });
});

describe('fetchRecommendedShardCount', () => {
  it('queries the Lolka gateway/bot endpoint with the bot token', async () => {
    const previous = getGlobalDispatcher();
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    try {
      let auth;
      agent
        .get('https://lolka.app')
        .intercept({ path: '/api/bot/v10/gateway/bot', method: 'GET' })
        .reply(200, opts => {
          auth = opts.headers.Authorization ?? opts.headers.authorization;
          return { shards: 3 };
        });
      assert.equal(await fetchRecommendedShardCount('Bot tok'), 3);
      assert.equal(auth, 'Bot tok');

      agent
        .get('http://localhost:8089')
        .intercept({ path: '/v10/gateway/bot', method: 'GET' })
        .reply(200, { shards: 2 });
      assert.equal(await fetchRecommendedShardCount('tok', { api: 'http://localhost:8089/' }), 2);
    } finally {
      setGlobalDispatcher(previous);
      await agent.close();
    }
  });
});

describe('structure URLs', () => {
  it('BaseChannel#url', () => {
    const client = new Client({ intents: [] });
    const guildChannel = new BaseChannel(client, { id: '2', type: 0 });
    guildChannel.guildId = '1';
    assert.equal(guildChannel.url, `${WEB}/servers/1/channels/2`);
    const dm = new BaseChannel(client, { id: '3', type: 1 });
    assert.equal(dm.url, `${WEB}/me/channels/3`);
    client.destroy();
  });

  it('Message#url', () => {
    const client = new Client({ intents: [] });
    const inGuild = new Message(client, { id: '5', channel_id: '2', guild_id: '1', author: { id: '9' } });
    assert.equal(inGuild.url, `${WEB}/servers/1/channels/2/5`);
    const dm = new Message(client, { id: '6', channel_id: '3', author: { id: '9' } });
    assert.equal(dm.url, `${WEB}/me/channels/3/6`);
    client.destroy();
  });
});
