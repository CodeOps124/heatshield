// Loaded synchronously in <head> so the saved theme applies before first paint (no flash).
// Storage can be unavailable (private mode, blocked site data) — the OS setting still works.
(function () {
  try {
    var saved = localStorage.getItem('heatshield-theme');
    if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
  } catch (e) {
    /* ignore */
  }
})();
