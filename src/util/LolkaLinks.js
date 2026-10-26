'use strict';

const { resolveWebBase } = require('./LolkaConstants');

/**
 * Formats a channel link for a channel.
 * @param {string} channelId The id of the channel
 * @param {string} [guildId] The id of the guild; DM-like channels (no guild or `@me`) use `/me/channels`
 * @returns {string}
 */
function channelLink(channelId, guildId) {
  const base = resolveWebBase();
  return !guildId || guildId === '@me'
    ? `${base}/me/channels/${channelId}`
    : `${base}/servers/${guildId}/channels/${channelId}`;
}

/**
 * Formats a message link for a channel.
 * @param {string} channelId The id of the channel
 * @param {string} messageId The id of the message
 * @param {string} [guildId] The id of the guild; DM-like channels (no guild or `@me`) use `/me/channels`
 * @returns {string}
 */
function messageLink(channelId, messageId, guildId) {
  return `${channelLink(channelId, guildId)}/${messageId}`;
}

module.exports = { channelLink, messageLink };
