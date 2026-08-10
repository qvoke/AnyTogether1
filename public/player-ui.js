/**
 * Custom video.js-inspired controls for the synchronized Hls.js player.
 */

// Player elements
const video = document.getElementById('player');
const shell = video?.closest('.player-shell') || video?.parentElement;

const UI = {
  controls: null,
  playBtn: null,
  progressBar: null,
  progressFill: null,
  progressHandle: null,
  bufferFill: null,
  currentTime: null,
  duration: null,
  volumeBtn: null,
  volumeBar: null,
  volumeFill: null,
  skipBackBtn: null,
  skipForwardBtn: null,
  settingsBtn: null,
  fullscreenBtn: null,
  centerSpinner: null,
  centerOverlay: null,
  settingsPanel: document.getElementById('playerSettingsPanel'),
  qualityIndicator: document.getElementById('qualityIndicator'),
  qiRequested: document.getElementById('qiRequested'),
  qiActive: document.getElementById('qiActive')
};

let _isDragging = false;
let _isVolumeDragging = false;
let _menuOpen = false;
let _pendingSeekPosition = null;

// Transient play and pause indicators
let _actionIconTimer = null;

// Control creation
function createControls() {
  if (UI.controls || !shell || !video) return;

  const div = document.createElement('div');
  div.className = 'custom-player-controls';
  div.innerHTML = `
    <div class="controls-left">
      <button class="ctrl-btn play-btn" title="Play/Pause">
        <svg viewBox="0 0 24 24" width="20" height="20"><polygon points="6,4 20,12 6,20" fill="currentColor"/></svg>
      </button>
      <button class="ctrl-btn skip-btn skip-back-btn" title="Back 5 seconds"><span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8a8 8 0 1 1-1 7M5 4v4h4"/></svg></span></button>
      <button class="ctrl-btn skip-btn skip-forward-btn" title="Forward 5 seconds"><span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 8a8 8 0 1 0 1 7M19 4v4h-4"/></svg></span></button>
      <div class="volume-container">
        <button class="ctrl-btn volume-btn" title="Mute">
          <svg viewBox="0 0 24 24" width="20" height="20">
            <path d="M11 5L6 9H2v6h4l5 4V5z" fill="currentColor"/>
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" stroke="currentColor" stroke-width="2" fill="none"/>
          </svg>
        </button>
        <div class="volume-bar"><div class="volume-fill"></div></div>
      </div>
      <div class="time-display">
        <span class="current-time">00:00</span>
        <span class="time-sep">/</span>
        <span class="duration">00:00</span>
      </div>
    </div>
    <div class="controls-center">
      <div class="progress-container">
        <div class="progress-bar">
          <div class="buffer-fill"></div>
          <div class="progress-fill"></div>
          <div class="progress-handle"></div>
        </div>
      </div>
    </div>
    <div class="controls-right">
      <button class="ctrl-btn cc-btn" title="Closed captions"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="4" width="19" height="16" rx="2"/><text x="12" y="15.2" text-anchor="middle">CC</text></svg></button>
      <button class="ctrl-btn settings-btn" title="Settings">
        <svg viewBox="0 0 24 24" width="20" height="20">
          <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" fill="none" stroke="currentColor" stroke-width="2"/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" fill="none" stroke="currentColor" stroke-width="2"/>
        </svg>
      </button>
      <button class="ctrl-btn fullscreen-btn" title="Fullscreen">
        <svg viewBox="0 0 24 24" width="20" height="20">
          <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" fill="none" stroke="currentColor" stroke-width="2"/>
        </svg>
      </button>
    </div>
  `;
  shell.appendChild(div);
  UI.controls = div;

  UI.playBtn = div.querySelector('.play-btn');
  UI.progressBar = div.querySelector('.progress-bar');
  UI.progressFill = div.querySelector('.progress-fill');
  UI.progressHandle = div.querySelector('.progress-handle');
  UI.bufferFill = div.querySelector('.buffer-fill');
  UI.currentTime = div.querySelector('.current-time');
  UI.duration = div.querySelector('.duration');
  UI.volumeBtn = div.querySelector('.volume-btn');
  UI.volumeBar = div.querySelector('.volume-bar');
  UI.volumeFill = div.querySelector('.volume-fill');
  UI.skipBackBtn = div.querySelector('.skip-back-btn');
  UI.skipForwardBtn = div.querySelector('.skip-forward-btn');
  UI.settingsBtn = div.querySelector('.settings-btn');
  UI.fullscreenBtn = div.querySelector('.fullscreen-btn');

  // The spinner remains independent from browser-native controls.
  const spinner = document.createElement('div');
  spinner.className = 'player-center-spinner';
  spinner.innerHTML = `<svg viewBox="0 0 50 50" width="40" height="40"><circle cx="25" cy="25" r="20" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="4" stroke-dasharray="100" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 25 25" to="360 25 25" dur="1s" repeatCount="indefinite"/></circle></svg>`;
  shell.appendChild(spinner);
  UI.centerSpinner = spinner;

  // This overlay keeps transient feedback above the video surface.
  const overlay = document.createElement('div');
  overlay.className = 'player-center-overlay';
  overlay.innerHTML = `<div class="center-icon"></div>`;
  shell.appendChild(overlay);
  UI.centerOverlay = overlay;

  bindEvents();
}

// Control events
function bindEvents() {
  if (!video) return;

  // Play/Pause
  UI.playBtn.addEventListener('click', () => {
    if (video.paused) {
      window.anyTogetherSyncBridge?.play();
      showCenterIcon('play');
    } else {
      window.anyTogetherSyncBridge?.pause();
      showCenterIcon('pause');
    }
  });

  // Clicking the video follows the same authoritative command path as the button.
  video.addEventListener('click', () => {
    if (video.paused) {
      window.anyTogetherSyncBridge?.play();
      showCenterIcon('play');
    } else {
      window.anyTogetherSyncBridge?.pause();
      showCenterIcon('pause');
    }
  });

  // Progress bar drag
  UI.progressBar.addEventListener('mousedown', (e) => {
    _isDragging = true;
    previewSeekFromMouse(e);
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', onEnd);
  });
  function onDrag(e) { if (_isDragging) { previewSeekFromMouse(e); UI.progressBar.classList.add('seeking'); } }
  function onEnd() {
    _isDragging = false;
    UI.progressBar.classList.remove('seeking');
    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('mouseup', onEnd);
    const position = _pendingSeekPosition;
    _pendingSeekPosition = null;
    if (Number.isFinite(position)) window.anyTogetherSyncBridge?.seek(position);
  }
  function previewSeekFromMouse(e) {
    const rect = UI.progressBar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    // Immediate visual feedback prevents a delayed media event from making the control feel stuck.
    setProgressVisual(pct);
    _pendingSeekPosition = video.duration ? pct * video.duration : null;
  }

  // Volume
  UI.volumeBar.addEventListener('mousedown', (e) => {
    _isVolumeDragging = true;
    volFromMouse(e);
    document.addEventListener('mousemove', onVolDrag);
    document.addEventListener('mouseup', onVolEnd);
  });
  function onVolDrag(e) { if (_isVolumeDragging) volFromMouse(e); }
  function onVolEnd() { _isVolumeDragging = false; document.removeEventListener('mousemove', onVolDrag); document.removeEventListener('mouseup', onVolEnd); }
  function volFromMouse(e) {
    const rect = UI.volumeBar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    video.volume = pct;
    video.muted = pct === 0;
  }
  UI.volumeBtn.addEventListener('click', () => {
    video.muted = !video.muted;
    updateVolumeIcon();
  });

  UI.skipBackBtn.addEventListener('click', () => {
    window.anyTogetherSyncBridge?.seek(Math.max(0, (video.currentTime || 0) - 5));
  });
  UI.skipForwardBtn.addEventListener('click', () => {
    const duration = Number.isFinite(video.duration) ? video.duration : Infinity;
    window.anyTogetherSyncBridge?.seek(Math.min(duration, (video.currentTime || 0) + 5));
  });

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || isEditableTarget(event.target)) {
      return;
    }
    if (event.code === 'Space') {
      event.preventDefault();
      if (video.paused) {
        window.anyTogetherSyncBridge?.play();
      } else {
        window.anyTogetherSyncBridge?.pause();
      }
    } else if (event.code === 'ArrowLeft') {
      event.preventDefault();
      window.anyTogetherSyncBridge?.seek(Math.max(0, (video.currentTime || 0) - 5));
    } else if (event.code === 'ArrowRight') {
      event.preventDefault();
      const duration = Number.isFinite(video.duration) ? video.duration : Infinity;
      window.anyTogetherSyncBridge?.seek(Math.min(duration, (video.currentTime || 0) + 5));
    }
  });

  // Settings
  UI.settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (window.toggleSettingsPanel) {
      window.toggleSettingsPanel();
    }
  });

  // Fullscreen
  UI.fullscreenBtn.addEventListener('click', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      shell.requestFullscreen().catch(() => {
        video.requestFullscreen().catch(() => {});
      });
    }
  });

  // Video events
  video.addEventListener('timeupdate', updateTime);
  video.addEventListener('loadedmetadata', () => {
    updateTime();
    // A source change must not display timing information from the previous media.
    setProgressVisual(0);
    if (UI.currentTime) UI.currentTime.textContent = '00:00';
  });
  video.addEventListener('durationchange', () => {
    updateTime();
    // Duration changes can arrive before the source change event in Chromium.
    setProgressVisual(0);
  });
  video.addEventListener('timeupdate', updateProgress);
  video.addEventListener('progress', updateBuffer);
  video.addEventListener('volumechange', () => { updateVolume(); updateVolumeIcon(); });
  video.addEventListener('play', updatePlayBtn);
  video.addEventListener('pause', updatePlayBtn);

  // Spinner: show when waiting, hide when playing
  video.addEventListener('waiting', () => {
    if (UI.centerSpinner) UI.centerSpinner.classList.add('visible');
  });
  video.addEventListener('canplay', () => {
    if (UI.centerSpinner) UI.centerSpinner.classList.remove('visible');
  });
  video.addEventListener('playing', () => {
    if (UI.centerSpinner) UI.centerSpinner.classList.remove('visible');
  });

  // Fullscreen change
  document.addEventListener('fullscreenchange', onFullscreenChange);

  // Dismiss settings when focus moves outside the player controls.
  document.addEventListener('click', (e) => {
    if (_menuOpen && !e.target.closest('.quality-menu-overlay') && !e.target.closest('.settings-btn')) {
      closeMenu();
    }
    const panel = document.getElementById('playerSettingsPanel');
    if (panel && panel.classList.contains('is-open') &&
        !e.target.closest('.player-settings-panel') && !e.target.closest('.settings-btn')) {
      panel.classList.remove('is-open');
    }
  });
}

function isEditableTarget(target) {
  return target instanceof HTMLElement && (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  );
}

// Transient center indicator
function showCenterIcon(type) {
  if (!UI.centerOverlay) return;
  const iconEl = UI.centerOverlay.querySelector('.center-icon');
  if (!iconEl) return;

  if (type === 'play') {
    iconEl.innerHTML = '<svg viewBox="0 0 24 24" width="48" height="48"><polygon points="6,3 22,12 6,21" fill="rgba(255,255,255,0.85)"/></svg>';
  } else {
    iconEl.innerHTML = '<svg viewBox="0 0 24 24" width="48" height="48"><rect x="6" y="4" width="4" height="16" fill="rgba(255,255,255,0.85)"/><rect x="14" y="4" width="4" height="16" fill="rgba(255,255,255,0.85)"/></svg>';
  }

  UI.centerOverlay.classList.add('visible');

  if (_actionIconTimer) clearTimeout(_actionIconTimer);
  _actionIconTimer = setTimeout(() => {
    UI.centerOverlay.classList.remove('visible');
    _actionIconTimer = null;
  }, 500);
}

// Immediate progress rendering
function setProgressVisual(pct) {
  if (!UI.progressFill || !UI.progressHandle) return;
  const wpct = Math.min(100, pct * 100);
  UI.progressFill.style.width = `${wpct}%`;
  UI.progressHandle.style.left = `${wpct}%`;
}

// Player rendering
function updateTime() {
  if (!video) return;
  const cur = fmt(video.currentTime || 0);
  const dur = fmt(video.duration || 0);
  if (UI.currentTime) UI.currentTime.textContent = cur;
  if (UI.duration) UI.duration.textContent = dur;
}

function updateProgress() {
  if (_isDragging || !video || !video.duration || !UI.progressFill || !UI.progressHandle) return;
  const pct = Math.min(100, (video.currentTime / video.duration) * 100);
  UI.progressFill.style.width = `${pct}%`;
  UI.progressHandle.style.left = `${pct}%`;

  // Preserve the requested handle position while the media pipeline resolves a seek.
}

function updateBuffer() {
  if (!video || !video.duration || !UI.bufferFill) return;
  // Only the contiguous buffered range is useful for the compact progress display.
  try {
    const b = video.buffered;
    if (b.length > 0) {
      const end = b.end(b.length - 1);
      const pct = Math.min(100, (end / video.duration) * 100);
      UI.bufferFill.style.width = `${pct}%`;
    }
  } catch(e) {}
}

function updateVolume() {
  if (!UI.volumeFill) return;
  UI.volumeFill.style.width = `${video.muted ? 0 : video.volume * 100}%`;
}

function updateVolumeIcon() {
  if (!UI.volumeBtn) return;
  const isMuted = video.muted || video.volume === 0;
  UI.volumeBtn.innerHTML = isMuted
    ? '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M11 5L6 9H2v6h4l5 4V5z" fill="currentColor"/><line x1="23" y1="9" x2="17" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="17" y1="9" x2="23" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
    : '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M11 5L6 9H2v6h4l5 4V5z" fill="currentColor"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" stroke="currentColor" stroke-width="2" fill="none"/></svg>';
}

function updatePlayBtn() {
  if (!UI.playBtn) return;
  UI.playBtn.innerHTML = video.paused
    ? '<svg viewBox="0 0 24 24" width="20" height="20"><polygon points="6,4 20,12 6,20" fill="currentColor"/></svg>'
    : '<svg viewBox="0 0 24 24" width="20" height="20"><rect x="6" y="4" width="4" height="16" fill="currentColor"/><rect x="14" y="4" width="4" height="16" fill="currentColor"/></svg>';
}

// The playback engine calls this after replacing a source.
window.__updatePlayButton = updatePlayBtn;

// Quality switches preserve position through the playback engine.

function onFullscreenChange() {
  if (!shell) return;
  shell.classList.toggle('is-fullscreen', !!document.fullscreenElement);
  updateTime();
}

function fmt(s) {
  if (!Number.isFinite(s) || s < 0) return '00:00';
  const sec = Math.floor(s);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const ss = String(sec % 60).padStart(2, '0');
  if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${ss}`;
  return `${String(m).padStart(2, '0')}:${ss}`;
}

// The settings panel remains owned by the existing interface module.

// Initialization
let _initDone = false;
function initOnce() {
  if (_initDone) return;
  _initDone = true;
  setTimeout(createControls, 100);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initOnce);
} else {
  initOnce();
}
