import assert from 'node:assert/strict';
import { it } from 'node:test';
import {
  LolkaApiBase,
  LolkaCDN,
  LolkaCDNBase,
  LolkaInviteBase,
  LolkaWebBase,
  channelLink,
  messageLink,
} from '../src/index.js';

it('exposes Lolka named exports to ESM', () => {
  assert.equal(typeof LolkaCDN, 'function');
  for (const base of [LolkaCDNBase, LolkaWebBase, LolkaInviteBase, LolkaApiBase]) {
    assert.match(base, /^https?:\/\/.+[^/]$/);
  }
  assert.equal(channelLink('2', '1'), `${LolkaWebBase}/servers/1/channels/2`);
  assert.equal(messageLink('2', '3'), `${LolkaWebBase}/me/channels/2/3`);
});
