'use strict';

// FNV-1a хеш от десятичной строки id % 6 — та же формула, что в веб/мобильном клиенте Lolka
// (client/common/ui/Avatar/utils/color.ts), чтобы дефолтная аватарка совпадала во всех клиентах.
function lolkaDefaultAvatarIndex(id) {
  let h = 2166136261;
  const s = String(id);
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  }
  return (h >>> 0) % 6;
}

module.exports = { lolkaDefaultAvatarIndex };
