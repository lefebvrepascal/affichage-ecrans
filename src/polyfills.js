/* Petits compléments pour les navigateurs intégrés aux TV (moteurs anciens). ES5 uniquement. */
(function () {
  'use strict';
  var AP = Array.prototype, SP = String.prototype;

  if (!AP.forEach) AP.forEach = function (fn, t) { for (var i = 0; i < this.length; i++) if (i in this) fn.call(t, this[i], i, this); };
  if (!AP.find) AP.find = function (fn, t) { for (var i = 0; i < this.length; i++) if (fn.call(t, this[i], i, this)) return this[i]; };
  if (!AP.some) AP.some = function (fn, t) { for (var i = 0; i < this.length; i++) if (fn.call(t, this[i], i, this)) return true; return false; };
  if (!AP.includes) AP.includes = function (v) { return this.indexOf(v) !== -1; };
  if (!AP.flatMap) AP.flatMap = function (fn, t) {
    var out = [];
    for (var i = 0; i < this.length; i++) { var r = fn.call(t, this[i], i, this); if (Array.isArray(r)) out.push.apply(out, r); else out.push(r); }
    return out;
  };
  if (!Array.from) Array.from = function (src, map) {
    var out = [], n = src && src.length != null ? src.length : 0;
    for (var i = 0; i < n; i++) out.push(map ? map(src[i], i) : src[i]);
    return out;
  };
  if (window.NodeList && !NodeList.prototype.forEach) NodeList.prototype.forEach = AP.forEach;

  if (!SP.padStart) SP.padStart = function (len, fill) {
    var s = String(this); fill = fill == null ? ' ' : String(fill);
    while (s.length < len) s = fill + s;
    return s.slice(s.length - Math.max(len, String(this).length));
  };
  if (!SP.includes) SP.includes = function (v) { return this.indexOf(v) !== -1; };
  if (!SP.startsWith) SP.startsWith = function (v) { return this.indexOf(v) === 0; };

  if (!Object.assign) Object.assign = function (t) {
    for (var i = 1; i < arguments.length; i++) { var s = arguments[i]; if (s) for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) t[k] = s[k]; }
    return t;
  };

  if (!window.URLSearchParams) window.URLSearchParams = function (q) {
    var map = {};
    String(q || '').replace(/^\?/, '').split('&').forEach(function (p) {
      if (!p) return; var i = p.indexOf('=');
      var k = decodeURIComponent((i < 0 ? p : p.slice(0, i)).replace(/\+/g, ' '));
      map[k] = i < 0 ? '' : decodeURIComponent(p.slice(i + 1).replace(/\+/g, ' '));
    });
    this.get = function (k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; };
  };

  if (!Date.now) Date.now = function () { return new Date().getTime(); };
})();
