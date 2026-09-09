// Theme: light by default for everyone, dark as an explicit choice.
//
// Loaded in <head> before the stylesheet applies, so the choice is on <html>
// before first paint and a dark-theme user never sees a white flash. The
// choice lives in localStorage under `kd.theme`; prefers-color-scheme is not
// consulted (founder's decision, 2026-09-06). A `?theme=light|dark` query
// parameter overrides for one page load — used to screenshot both grounds.
//
// The toggle is markup only: any element with `data-theme-toggle` holding
// buttons with `data-theme-choice="light|dark"`. This script marks the chosen
// state and handles the click; app.js and admin.js know nothing about it.
(function () {
  var KEY = 'kd.theme';
  var root = document.documentElement;

  function valid(t) { return t === 'light' || t === 'dark' ? t : null; }

  function read() {
    var t = null;
    try { t = valid(new URLSearchParams(location.search).get('theme')); } catch (e) { /* no URL API */ }
    if (!t) { try { t = valid(localStorage.getItem(KEY)); } catch (e) { /* storage blocked */ } }
    return t || 'light';
  }

  function apply(t) {
    if (t === 'dark') root.setAttribute('data-theme', 'dark');
    else root.removeAttribute('data-theme');
    var buttons = document.querySelectorAll('[data-theme-toggle] [data-theme-choice]');
    for (var i = 0; i < buttons.length; i++) {
      var on = buttons[i].getAttribute('data-theme-choice') === t;
      buttons[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  apply(read());

  document.addEventListener('DOMContentLoaded', function () {
    apply(read());
    document.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('[data-theme-toggle] [data-theme-choice]') : null;
      if (!btn) return;
      var next = valid(btn.getAttribute('data-theme-choice')) || 'light';
      try { localStorage.setItem(KEY, next); } catch (err) { /* storage blocked: applies for this page only */ }
      apply(next);
    });
  });
})();
