'use strict';

const resolveBase = (name, fallback) => {
  const value = process.env[name]?.trim();
  return (value || fallback).replace(/\/+$/, '');
};

/**
 * Resolves the Lolka CDN base URL (no trailing slash) from `LOLKA_CDN` at call time.
 * @returns {string}
 */
const resolveCdnBase = () => resolveBase('LOLKA_CDN', 'https://cdn.lolka.app');

/**
 * Resolves the Lolka web client base URL (no trailing slash) from `LOLKA_WEB` at call time.
 * @returns {string}
 */
const resolveWebBase = () => resolveBase('LOLKA_WEB', 'https://lolka.app');

/**
 * Resolves the Lolka invite links base URL (no trailing slash) from `LOLKA_INVITE` at call time.
 * @returns {string}
 */
const resolveInviteBase = () => resolveBase('LOLKA_INVITE', 'https://lolka.gg');

/**
 * Resolves the Lolka bot API base URL (no trailing slash) from `LOLKA_API_BASE` at call time.
 * @returns {string}
 */
const resolveApiBase = () => resolveBase('LOLKA_API_BASE', 'https://lolka.app/api/bot');

module.exports = {
  resolveCdnBase,
  resolveWebBase,
  resolveInviteBase,
  resolveApiBase,
  // Snapshots taken when the module is first loaded, kept for the public exports.
  LolkaCDNBase: resolveCdnBase(),
  LolkaWebBase: resolveWebBase(),
  LolkaInviteBase: resolveInviteBase(),
  LolkaApiBase: resolveApiBase(),
};
