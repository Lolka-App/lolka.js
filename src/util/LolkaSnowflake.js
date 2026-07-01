'use strict';

// lolka snowflake: эпоха 2025-01-01 00:00:00 UTC, раскладка bwmarrin/snowflake
// (41 бит timestamp | 4 бита node | 10 бит step) => сдвиг времени = 14 бит.
// Заменяет @sapphire/snowflake DiscordSnowflake (фикс. Discord-раскладка: эпоха 2015, сдвиг 22).
// Экспортируется под именем DiscordSnowflake, чтобы остальной код discord.js работал без правок.

const EPOCH = 1735689600000n;
const SHIFT = 14n;
const INCREMENT_MASK = (1n << 10n) - 1n; // 10 бит step

let increment = 0n;

const LolkaSnowflake = {
  EPOCH,

  /**
   * Returns the creation timestamp (ms) encoded in a lolka snowflake id.
   * @param {string|bigint|number} id snowflake id
   * @returns {number}
   */
  timestampFrom(id) {
    return Number((BigInt(id) >> SHIFT) + EPOCH);
  },

  /**
   * Generates a lolka-layout snowflake (bigint). Used for nonces.
   * @param {{ timestamp?: number|bigint }} [options]
   * @returns {bigint}
   */
  generate({ timestamp = Date.now() } = {}) {
    const ts = BigInt(typeof timestamp === 'number' ? Math.floor(timestamp) : timestamp);
    increment = (increment + 1n) & INCREMENT_MASK;
    return ((ts - EPOCH) << SHIFT) | increment;
  },

  /**
   * Minimal deconstruct (timestamp only) for compatibility.
   * @param {string|bigint} id snowflake id
   */
  deconstruct(id) {
    const big = BigInt(id);
    return { id: big, timestamp: Number((big >> SHIFT) + EPOCH) };
  },

  /**
   * Compares two snowflakes numerically (epoch-independent — pure BigInt compare).
   * @param {string|bigint|number} a
   * @param {string|bigint|number} b
   * @returns {-1|0|1}
   */
  compare(a, b) {
    const bigA = BigInt(a);
    const bigB = BigInt(b);
    if (bigA === bigB) return 0;
    return bigA > bigB ? 1 : -1;
  },
};

module.exports = { LolkaSnowflake, DiscordSnowflake: LolkaSnowflake, Snowflake: LolkaSnowflake };
