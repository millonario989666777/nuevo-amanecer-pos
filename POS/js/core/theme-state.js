/* Shared appearance state. Legacy snapshots are migration input only. */
(function (root) {
  'use strict';
  var key = 'na_v9_appearance', memory = {}, migrated = false;
  var mq = root.matchMedia ? root.matchMedia('(prefers-color-scheme: dark)') : null;
  function read() {
    try { var d = JSON.parse(root.localStorage.getItem(key) || '{}'); memory = d && typeof d === 'object' && !Array.isArray(d) ? d : {}; } catch (_) {}
    return memory;
  }
  function valid(m) { return m === 'claro' || m === 'noche' || m === 'auto'; }
  function mode() { var m = read().mode; return valid(m) ? m : 'claro'; }
  function isDark() { var m = mode(); return m === 'noche' || (m === 'auto' && !!(mq && mq.matches)); }
  function apply() {
    var dark = isDark(), doc = root.document;
    if (doc.body) doc.body.classList.toggle('dark', dark);
    root.isDark = dark;
    if (typeof root.__naSetIsDark === 'function') root.__naSetIsDark(dark);
    var button = doc.getElementById('btnDarkMode');
    if (button) button.innerHTML = root.NA_ICON ? root.NA_ICON(dark ? 'sun' : 'moon') : (dark ? '☀️' : '🌙');
    if (typeof root.setToggle === 'function') root.setToggle('darkToggle', dark);
    return dark;
  }
  function setMode(m) {
    var d = read(); d.mode = valid(m) ? m : 'claro';
    try { root.localStorage.setItem(key, JSON.stringify(d)); } catch (_) {}
    return apply();
  }
  function resolveLegacy(legacyIsDark) {
    if (!migrated) {
      migrated = true;
      var d = read();
      if (!Object.prototype.hasOwnProperty.call(d, 'mode')) setMode(legacyIsDark === true ? 'noche' : 'claro');
    }
    return mode();
  }
  root.NA_THEME = { mode: mode, isDark: isDark, setMode: setMode, toggle: function () { return setMode(isDark() ? 'claro' : 'noche'); }, apply: apply, resolveLegacy: resolveLegacy };
  function onScheme() { if (mode() === 'auto') apply(); }
  if (mq) { if (mq.addEventListener) mq.addEventListener('change', onScheme); else if (mq.addListener) mq.addListener(onScheme); }
  apply();
  root.document.addEventListener('DOMContentLoaded', apply);
})(window);
