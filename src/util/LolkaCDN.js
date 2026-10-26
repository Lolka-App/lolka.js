'use strict';

const { CDN } = require('@discordjs/rest');
const { resolveCdnBase } = require('./LolkaConstants');

const URL_PATTERN = /^https?:\/\//;

/**
 * CDN URL builder for Lolka. Lolka returns full URLs or storage keys (`avatars/{uid}/{uuid}.webp`) for assets,
 * the CDN does no resizing and serves only webp, so `size`, `extension` and `forceStatic` options are ignored
 * for such values.
 * @extends {CDN}
 */
class LolkaCDN extends CDN {
  constructor(cdn, mediaProxy) {
    const base = String(cdn ?? resolveCdnBase()).replace(/\/+$/, '');
    super(base, String(mediaProxy ?? base).replace(/\/+$/, ''));
  }

  /**
   * Resolves a Lolka asset value (full URL, storage key) into a URL.
   * @param {*} value The asset value
   * @returns {?string} The URL, or null if the value is a legacy hash that needs a route
   * @private
   */
  resolveAsset(value) {
    if (typeof value !== 'string') return null;
    if (URL_PATTERN.test(value)) return value;
    if (value.includes('/')) return `${this.cdn}/${value.replace(/^\/+/, '')}`;
    return null;
  }

  appAsset(clientId, assetHash, options) {
    return this.resolveAsset(assetHash) ?? super.appAsset(clientId, assetHash, options);
  }

  appIcon(clientId, iconHash, options) {
    return this.resolveAsset(iconHash) ?? super.appIcon(clientId, iconHash, options);
  }

  avatar(id, avatarHash, options) {
    return this.resolveAsset(avatarHash) ?? super.avatar(id, avatarHash, options);
  }

  avatarDecoration(userIdOrAsset, userAvatarDecoration, options) {
    if (userAvatarDecoration) {
      return this.resolveAsset(userAvatarDecoration) ?? super.avatarDecoration(userIdOrAsset, userAvatarDecoration, options);
    }
    return this.resolveAsset(userIdOrAsset) ?? super.avatarDecoration(userIdOrAsset);
  }

  banner(id, bannerHash, options) {
    return this.resolveAsset(bannerHash) ?? super.banner(id, bannerHash, options);
  }

  channelIcon(channelId, iconHash, options) {
    return this.resolveAsset(iconHash) ?? super.channelIcon(channelId, iconHash, options);
  }

  defaultAvatar(index) {
    return `${this.cdn}/system/avatars/${index}.jpg`;
  }

  discoverySplash(guildId, splashHash, options) {
    return this.resolveAsset(splashHash) ?? super.discoverySplash(guildId, splashHash, options);
  }

  emoji(emojiId) {
    return `${this.cdn}/emojis/${emojiId}.webp`;
  }

  guildMemberAvatar(guildId, userId, avatarHash, options) {
    return this.resolveAsset(avatarHash) ?? super.guildMemberAvatar(guildId, userId, avatarHash, options);
  }

  guildMemberBanner(guildId, userId, bannerHash, options) {
    return this.resolveAsset(bannerHash) ?? super.guildMemberBanner(guildId, userId, bannerHash, options);
  }

  icon(id, iconHash, options) {
    return this.resolveAsset(iconHash) ?? super.icon(id, iconHash, options);
  }

  roleIcon(roleId, roleIconHash, options) {
    return this.resolveAsset(roleIconHash) ?? super.roleIcon(roleId, roleIconHash, options);
  }

  splash(guildId, splashHash, options) {
    return this.resolveAsset(splashHash) ?? super.splash(guildId, splashHash, options);
  }

  stickerPackBanner(bannerId, options) {
    return this.resolveAsset(bannerId) ?? super.stickerPackBanner(bannerId, options);
  }

  teamIcon(teamId, iconHash, options) {
    return this.resolveAsset(iconHash) ?? super.teamIcon(teamId, iconHash, options);
  }

  guildScheduledEventCover(scheduledEventId, coverHash, options) {
    return this.resolveAsset(coverHash) ?? super.guildScheduledEventCover(scheduledEventId, coverHash, options);
  }

  soundboardSound(soundId) {
    return `${this.cdn}/soundboard/${soundId}.ogg`;
  }

  guildTagBadge(guildId, badgeHash, options) {
    return this.resolveAsset(badgeHash) ?? super.guildTagBadge(guildId, badgeHash, options);
  }
}

module.exports = LolkaCDN;
