// Demo video page: chapter buttons seek the video.
import { initThemeToggle, showVersion, showSiteNotice } from './ui.js';

const $ = (id) => document.getElementById(id);
initThemeToggle($('theme-toggle'));
showVersion($('version'));
showSiteNotice();

const video = $('demo-video');
for (const button of document.querySelectorAll('#chapters button[data-t]')) {
  button.addEventListener('click', () => {
    video.currentTime = Number(button.dataset.t);
    video.play().catch(() => { /* autoplay can be refused; the position is set either way */ });
    video.focus();
  });
}
