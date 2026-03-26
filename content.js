(() => {
  "use strict";

  // =====================================================================
  // CONFIG (non-configurable internals)
  // =====================================================================

  const DEBOUNCE_MS = 800;
  const STATE_SYNC_MS = 500;
  const MUTATION_WINDOW_MS = 2000;
  const SPEAKING_THRESHOLD = 6;
  const AVATAR_COLORS = 8;
  const SETTINGS_KEY = "popcornSettings";

  // =====================================================================
  // SETTINGS (user-configurable, persisted via chrome.storage)
  // =====================================================================

  const DEFAULT_SETTINGS = {
    turnThresholdSec: 15,       // seconds of speaking to count as a "turn"
    autoShowPanel: false,        // auto-open panel when joining a meeting
    defaultView: "remaining",    // "remaining" or "chronological"
    fabPosition: { top: 16, left: 16 }, // remembered FAB position
    autoStartParticipants: 0,    // 0 = off, 3+ = auto-start when N participants
  };

  let settings = { ...DEFAULT_SETTINGS };

  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(SETTINGS_KEY, (result) => {
        if (result[SETTINGS_KEY]) {
          settings = { ...DEFAULT_SETTINGS, ...result[SETTINGS_KEY] };
        }
        resolve();
      });
    });
  }

  function saveSettings() {
    chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
  }

  function getTurnThresholdMs() {
    return settings.turnThresholdSec * 1000;
  }

  // =====================================================================
  // STATE
  // =====================================================================

  let state = {
    participants: [],
    meetingStart: Date.now(),
    activeSpeakerId: null,
  };

  let observer = null;
  let durationInterval = null;
  let pollForContainerInterval = null;
  let evaluateInterval = null;
  let timerInterval = null;
  let debounceTimer = null;
  let pendingSpeakerId = null;
  let currentView = "remaining";
  let collapsed = false;
  let settingsOpen = false;
  let panelVisible = false;
  let meetingActive = false;
  let tracking = false; // false = paused, true = actively tracking speakers
  let noTilesCount = 0;

  const classMutationTimestamps = new Map();
  const resolvedNames = new Map();

  // Shadow DOM references
  let hostEl = null;
  let shadowRoot = null;
  let panelEl = null;
  let participantListEl = null;
  let emptyStateEl = null;
  let timerEl = null;
  let toggleBtn = null;
  let collapseBtn = null;
  let startPauseBtn = null;

  function log(...args) {
    console.log("[PopcornStandup]", ...args);
  }

  // =====================================================================
  // HELPERS
  // =====================================================================

  function getInitials(name) {
    if (!name) return "?";
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0][0].toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  const NAME_BLOCKLIST = new Set([
    "reframe", "meet", "google meet", "chrome", "companion mode",
    "presentation", "screen", "you", "pin", "mute", "unmute",
    "more options", "more actions", "turn off", "turn on",
    "backgrounds and effects",
  ]);

  function isValidName(name) {
    if (!name) return false;
    if (name.startsWith("spaces/")) return false;
    if (name.length > 80) return false;
    if (!/[a-zA-Z]/.test(name)) return false;
    if (NAME_BLOCKLIST.has(name.toLowerCase().trim())) return false;
    return true;
  }

  function findOrCreateParticipant(id, name) {
    let p = state.participants.find((x) => x.id === id);
    if (!p) {
      p = {
        id,
        name: name || "Unknown",
        initials: getInitials(name || "Unknown"),
        status: "pending",
        firstSpoke: null,
        totalDuration: 0,
        speakCount: 0,
      };
      state.participants.push(p);
    }
    if (name && isValidName(name) && (p.name !== name || p.name === "Unknown")) {
      p.name = name;
      p.initials = getInitials(name);
    }
    return p;
  }

  function formatDuration(ms) {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function formatTime(timestamp) {
    if (!timestamp) return "";
    return new Date(timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function colorIndex(id) {
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      hash = (hash * 31 + id.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % AVATAR_COLORS;
  }

  // =====================================================================
  // NAME EXTRACTION
  // =====================================================================

  const MORE_OPTIONS_RE = /^More options for (.+)$/i;

  function extractNameFromTile(tile) {
    const pid = tile.getAttribute("data-participant-id");

    const allEls = tile.querySelectorAll("[aria-label]");
    for (const el of allEls) {
      const label = el.getAttribute("aria-label");
      const match = label && MORE_OPTIONS_RE.exec(label);
      if (match) {
        let name = match[1].replace(/\s*\(.*?\)\s*$/g, "").trim();
        if (name && isValidName(name)) {
          if (pid) resolvedNames.set(pid, name);
          return name;
        }
      }
    }

    if (pid && resolvedNames.has(pid)) {
      return resolvedNames.get(pid);
    }

    const selfName = tile.querySelector("[data-self-name]");
    if (selfName) {
      const text = selfName.getAttribute("data-self-name")?.trim();
      if (text && isValidName(text)) {
        if (pid) resolvedNames.set(pid, text);
        return text;
      }
    }

    const leafEls = tile.querySelectorAll("*");
    const candidates = [];
    for (const el of leafEls) {
      if (el.children.length > 0) continue;
      if (el.closest("button, [role='button'], [role='menu'], [role='toolbar']")) continue;
      const text = el.textContent?.trim();
      if (!text || text.length < 2 || text.length > 40) continue;
      if (!isValidName(text)) continue;
      const cs = window.getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const fontSize = parseFloat(cs.fontSize) || 0;
      let priority = 1;
      if (fontSize >= 11 && fontSize <= 16) priority = 5;
      if (text.split(/\s+/).length >= 2) priority += 3;
      candidates.push({ text, priority });
    }

    if (candidates.length > 0) {
      candidates.sort((a, b) => b.priority - a.priority);
      const name = candidates[0].text.replace(/\s*\(.*?\)\s*$/g, "").trim();
      if (name && pid) resolvedNames.set(pid, name);
      return name || null;
    }

    return null;
  }

  // =====================================================================
  // TRACKING START / PAUSE
  // =====================================================================

  function startTracking() {
    if (tracking) return;
    tracking = true;
    // Reset timer to now (standup starts now, not when call joined)
    state.meetingStart = Date.now();
    updateStartPauseBtn();
    render();
    log("Tracking started");
  }

  function pauseTracking() {
    if (!tracking) return;
    tracking = false;
    // Mark current speaker as done/pending
    if (state.activeSpeakerId) {
      const p = state.participants.find((x) => x.id === state.activeSpeakerId);
      if (p && p.status === "speaking") {
        p.status = p.totalDuration >= getTurnThresholdMs() ? "done" : "pending";
      }
      state.activeSpeakerId = null;
    }
    updateStartPauseBtn();
    render();
    log("Tracking paused");
  }

  function toggleTracking() {
    if (tracking) pauseTracking();
    else startTracking();
  }

  function updateStartPauseBtn() {
    if (!startPauseBtn) return;
    startPauseBtn.textContent = tracking ? "Pause" : "Start";
    startPauseBtn.className = tracking ? "btn btn-pause" : "btn btn-start";
  }

  function checkAutoStart() {
    if (tracking) return;
    const threshold = settings.autoStartParticipants;
    if (threshold <= 0) return;
    if (state.participants.length >= threshold) {
      startTracking();
      log("Auto-started: " + state.participants.length + " participants");
    }
  }

  // =====================================================================
  // SPEAKER DETECTION (mutation frequency analysis)
  // =====================================================================

  function getParticipantTiles() {
    return document.querySelectorAll("[data-participant-id]");
  }

  function getTileId(el) {
    let node = el;
    while (node && node !== document.body) {
      if (node.getAttribute && node.getAttribute("data-participant-id")) {
        return node.getAttribute("data-participant-id");
      }
      node = node.parentElement;
    }
    return null;
  }

  function recordClassMutation(mutation) {
    if (mutation.type !== "attributes" || mutation.attributeName !== "class") return;
    if (mutation.target.tagName !== "DIV") return;
    const pid = getTileId(mutation.target);
    if (!pid) return;
    const oldVal = mutation.oldValue || "";
    const newVal = mutation.target.getAttribute("class") || "";
    if (oldVal === newVal) return;
    if (!classMutationTimestamps.has(pid)) {
      classMutationTimestamps.set(pid, []);
    }
    classMutationTimestamps.get(pid).push(Date.now());
  }

  function evaluateSpeaker() {
    // Always discover participants (even when paused)
    const tiles = getParticipantTiles();
    tiles.forEach((tile) => {
      const id = tile.getAttribute("data-participant-id");
      if (!id) return;
      findOrCreateParticipant(id, extractNameFromTile(tile));
    });

    // Check auto-start
    checkAutoStart();

    // Only detect speaking when tracking is active
    if (!tracking) return;

    const now = Date.now();
    const cutoff = now - MUTATION_WINDOW_MS;
    let maxCount = 0;
    let speakerId = null;

    for (const [pid, timestamps] of classMutationTimestamps) {
      const recent = timestamps.filter((t) => t > cutoff);
      classMutationTimestamps.set(pid, recent);
      if (recent.length >= SPEAKING_THRESHOLD && recent.length > maxCount) {
        // Require mutations to span at least 800ms — filters out
        // short bursts from mic toggle / UI state changes
        const spread = recent[recent.length - 1] - recent[0];
        if (spread < 800) continue;
        maxCount = recent.length;
        speakerId = pid;
      }
    }

    debounceSpeakerChange(speakerId);
  }

  function debounceSpeakerChange(newSpeakerId) {
    if (newSpeakerId === pendingSpeakerId) return;
    pendingSpeakerId = newSpeakerId;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      applyActiveSpeaker(pendingSpeakerId);
    }, DEBOUNCE_MS);
  }

  function applyActiveSpeaker(speakerId) {
    const prevId = state.activeSpeakerId;
    if (prevId === speakerId) return;

    if (prevId) {
      const prev = state.participants.find((p) => p.id === prevId);
      if (prev && prev.status === "speaking") {
        prev.status = prev.totalDuration >= getTurnThresholdMs() ? "done" : "pending";
      }
    }

    state.activeSpeakerId = speakerId;

    if (speakerId) {
      const p = findOrCreateParticipant(speakerId, null);
      if (p.firstSpoke === null) p.firstSpoke = Date.now();
      p.status = "speaking";
      p.speakCount++;
      log("Speaker:", p.name);
    } else {
      log("No active speaker");
    }

    render();
  }

  function tickDurations() {
    if (!tracking) {
      render(); // still render to update participant list
      return;
    }
    state.participants.forEach((p) => {
      if (p.status === "speaking") {
        p.totalDuration += STATE_SYNC_MS;
      }
    });
    render();
  }

  // =====================================================================
  // MEET OBSERVER
  // =====================================================================

  function startObserver() {
    const tile = document.querySelector("[data-participant-id]");
    if (!tile) return false;

    let container = tile;
    for (let i = 0; i < 6 && container.parentElement; i++) {
      container = container.parentElement;
    }

    if (observer) observer.disconnect();

    observer = new MutationObserver((mutations) => {
      for (const m of mutations) recordClassMutation(m);
    });

    observer.observe(container, {
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ["class"],
      childList: true,
      subtree: true,
    });

    log("Observer started, tracking", getParticipantTiles().length, "tiles");
    return true;
  }

  // =====================================================================
  // FLOATING BUTTON (always visible when in a meeting)
  // =====================================================================

  let fabEl = null;

  function injectFab() {
    if (document.getElementById("popcorn-standup-fab")) return;

    fabEl = document.createElement("div");
    fabEl.id = "popcorn-standup-fab";
    fabEl.style.cssText = [
      "all: initial",
      "position: fixed",
      "z-index: 999998",
      "top: " + settings.fabPosition.top + "px",
      "left: " + settings.fabPosition.left + "px",
      "width: 44px",
      "height: 44px",
      "border-radius: 50%",
      "background: #fbbc04",
      "box-shadow: 0 2px 8px rgba(0,0,0,0.3)",
      "cursor: grab",
      "display: flex",
      "align-items: center",
      "justify-content: center",
      "font-size: 22px",
      "line-height: 1",
      "user-select: none",
      "transition: transform 0.15s, box-shadow 0.15s",
    ].join("; ") + ";";
    fabEl.textContent = "\uD83C\uDF7F"; // popcorn emoji
    fabEl.title = "Toggle Popcorn Meet (drag to move)";

    fabEl.addEventListener("mouseenter", () => {
      if (!fabDragging) {
        fabEl.style.transform = "scale(1.1)";
        fabEl.style.boxShadow = "0 4px 12px rgba(0,0,0,0.35)";
      }
    });
    fabEl.addEventListener("mouseleave", () => {
      if (!fabDragging) {
        fabEl.style.transform = "";
        fabEl.style.boxShadow = "0 2px 8px rgba(0,0,0,0.3)";
      }
    });

    // Drag + click handling: only toggle if it wasn't a drag
    let fabDragging = false;
    let fabMoved = false;
    let fabStartX, fabStartY, fabOrigLeft, fabOrigTop;

    fabEl.addEventListener("mousedown", (e) => {
      fabDragging = true;
      fabMoved = false;
      fabStartX = e.clientX;
      fabStartY = e.clientY;
      const rect = fabEl.getBoundingClientRect();
      fabOrigLeft = rect.left;
      fabOrigTop = rect.top;
      fabEl.style.cursor = "grabbing";
      fabEl.style.transition = "box-shadow 0.15s";
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!fabDragging) return;
      const dx = e.clientX - fabStartX;
      const dy = e.clientY - fabStartY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) fabMoved = true;
      fabEl.style.left = (fabOrigLeft + dx) + "px";
      fabEl.style.top = (fabOrigTop + dy) + "px";
      // Clear any initial positioning that uses right/bottom
      fabEl.style.right = "auto";
      fabEl.style.bottom = "auto";
    });

    document.addEventListener("mouseup", () => {
      if (!fabDragging) return;
      fabDragging = false;
      fabEl.style.cursor = "grab";
      fabEl.style.transition = "transform 0.15s, box-shadow 0.15s";
      fabEl.style.transform = "";
      fabEl.style.boxShadow = "0 2px 8px rgba(0,0,0,0.3)";
      if (!fabMoved) {
        togglePanel();
      } else {
        // Save FAB position
        const rect = fabEl.getBoundingClientRect();
        settings.fabPosition = { top: Math.round(rect.top), left: Math.round(rect.left) };
        saveSettings();
      }
    });

    document.body.appendChild(fabEl);
  }

  function removeFab() {
    if (fabEl) {
      fabEl.remove();
      fabEl = null;
    }
  }

  // =====================================================================
  // PANEL UI — injection & rendering
  // =====================================================================

  function showPanel() {
    if (!hostEl) return;
    hostEl.style.display = "";
    panelVisible = true;
  }

  function hidePanel() {
    if (!hostEl) return;
    hostEl.style.display = "none";
    panelVisible = false;
  }

  function togglePanel() {
    if (!hostEl) {
      injectPanel();
      showPanel();
      return;
    }
    if (panelVisible) {
      hidePanel();
    } else {
      showPanel();
    }
  }

  function removePanel() {
    if (hostEl) {
      hostEl.remove();
      hostEl = null;
    }
    shadowRoot = null;
    panelEl = null;
    participantListEl = null;
    emptyStateEl = null;
    timerEl = null;
    toggleBtn = null;
    collapseBtn = null;
    panelVisible = false;
    clearInterval(timerInterval);
    timerInterval = null;
  }

  function injectPanel() {
    if (document.getElementById("popcorn-standup-root")) return;

    hostEl = document.createElement("div");
    hostEl.id = "popcorn-standup-root";
    hostEl.style.cssText =
      "all: initial; position: fixed; z-index: 999999; top: 68px; left: 16px; font-size: 14px; display: none;";
    document.body.appendChild(hostEl);

    shadowRoot = hostEl.attachShadow({ mode: "closed" });

    // Load CSS
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = chrome.runtime.getURL("panel.css");
    shadowRoot.appendChild(link);

    // Build panel HTML
    panelEl = document.createElement("div");
    panelEl.className = "panel";
    // Apply saved default view
    currentView = settings.defaultView;

    panelEl.innerHTML = `
      <header class="header">
        <div class="header-top">
          <span class="title">Popcorn Meet</span>
          <div class="header-right">
            <span class="timer" id="ps-timer">00:00</span>
            <button class="btn-icon" id="ps-settings-btn" title="Settings">&#x2699;</button>
            <button class="btn-icon" id="ps-collapse" title="Collapse">&#x2015;</button>
          </div>
        </div>
        <div class="header-actions">
          <button class="btn btn-start" id="ps-start-pause">Start</button>
          <button class="btn btn-random" id="ps-random" title="Pick a random person to start">&#x1F3B2; Pick</button>
          <button class="btn btn-toggle${currentView === "chronological" ? " active" : ""}" id="ps-toggle">${currentView === "remaining" ? "Chronological" : "Remaining"}</button>
          <button class="btn btn-reset" id="ps-reset">Reset</button>
        </div>
        <div class="random-pick" id="ps-random-result" style="display:none;">
          <span class="random-pick-label">First up:</span>
          <span class="random-pick-name" id="ps-random-name"></span>
        </div>
      </header>
      <div class="settings-panel" id="ps-settings" style="display:none;">
        <div class="settings-row">
          <label class="settings-label" for="ps-threshold">Turn threshold</label>
          <div class="settings-control">
            <input type="range" id="ps-threshold" min="3" max="60" step="1" value="${settings.turnThresholdSec}">
            <span class="settings-value" id="ps-threshold-val">${settings.turnThresholdSec}s</span>
          </div>
        </div>
        <div class="settings-row">
          <label class="settings-label">Auto-show panel</label>
          <label class="settings-toggle">
            <input type="checkbox" id="ps-autoshow" ${settings.autoShowPanel ? "checked" : ""}>
            <span class="settings-toggle-track"></span>
          </label>
        </div>
        <div class="settings-row">
          <label class="settings-label">Default view</label>
          <select class="settings-select" id="ps-default-view">
            <option value="remaining" ${settings.defaultView === "remaining" ? "selected" : ""}>Remaining</option>
            <option value="chronological" ${settings.defaultView === "chronological" ? "selected" : ""}>Chronological</option>
          </select>
        </div>
        <div class="settings-row">
          <label class="settings-label">Auto-start at</label>
          <select class="settings-select" id="ps-autostart">
            <option value="0" ${settings.autoStartParticipants === 0 ? "selected" : ""}>Off</option>
            <option value="3" ${settings.autoStartParticipants === 3 ? "selected" : ""}>3+ people</option>
            <option value="4" ${settings.autoStartParticipants === 4 ? "selected" : ""}>4+ people</option>
            <option value="5" ${settings.autoStartParticipants === 5 ? "selected" : ""}>5+ people</option>
            <option value="6" ${settings.autoStartParticipants === 6 ? "selected" : ""}>6+ people</option>
            <option value="8" ${settings.autoStartParticipants === 8 ? "selected" : ""}>8+ people</option>
            <option value="10" ${settings.autoStartParticipants === 10 ? "selected" : ""}>10+ people</option>
          </select>
        </div>
      </div>
      <div class="panel-body" id="ps-body">
        <div class="empty-state" id="ps-empty">
          <p>Waiting for participants...</p>
          <p class="hint">Join a Meet call and start speaking.</p>
        </div>
      </div>
    `;
    shadowRoot.appendChild(panelEl);

    // Cache refs
    timerEl = shadowRoot.getElementById("ps-timer");
    participantListEl = shadowRoot.getElementById("ps-body");
    emptyStateEl = shadowRoot.getElementById("ps-empty");
    toggleBtn = shadowRoot.getElementById("ps-toggle");
    collapseBtn = shadowRoot.getElementById("ps-collapse");
    const resetBtn = shadowRoot.getElementById("ps-reset");
    startPauseBtn = shadowRoot.getElementById("ps-start-pause");
    const settingsBtn = shadowRoot.getElementById("ps-settings-btn");
    const settingsPanel = shadowRoot.getElementById("ps-settings");
    const thresholdInput = shadowRoot.getElementById("ps-threshold");
    const thresholdVal = shadowRoot.getElementById("ps-threshold-val");
    const autoshowInput = shadowRoot.getElementById("ps-autoshow");
    const defaultViewInput = shadowRoot.getElementById("ps-default-view");
    const autostartInput = shadowRoot.getElementById("ps-autostart");
    const randomBtn = shadowRoot.getElementById("ps-random");
    const randomResult = shadowRoot.getElementById("ps-random-result");
    const randomName = shadowRoot.getElementById("ps-random-name");

    // --- Events ---

    startPauseBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleTracking();
    });

    randomBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const pool = state.participants.filter((p) => p.status === "pending");
      if (pool.length === 0) return;
      const picked = pool[Math.floor(Math.random() * pool.length)];
      randomName.textContent = picked.name;
      randomResult.style.display = "";
    });

    toggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      currentView = currentView === "remaining" ? "chronological" : "remaining";
      toggleBtn.textContent = currentView === "remaining" ? "Chronological" : "Remaining";
      toggleBtn.classList.toggle("active", currentView === "chronological");
      render();
    });

    resetBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      tracking = false;
      state = { participants: [], meetingStart: Date.now(), activeSpeakerId: null };
      classMutationTimestamps.clear();
      resolvedNames.clear();
      const tiles = getParticipantTiles();
      tiles.forEach((tile) => {
        const id = tile.getAttribute("data-participant-id");
        if (id) findOrCreateParticipant(id, extractNameFromTile(tile));
      });
      updateStartPauseBtn();
      randomResult.style.display = "none";
      render();
    });

    collapseBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      collapsed = !collapsed;
      panelEl.classList.toggle("collapsed", collapsed);
      collapseBtn.innerHTML = collapsed ? "&#x25A1;" : "&#x2015;";
      collapseBtn.title = collapsed ? "Expand" : "Collapse";
    });

    settingsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      settingsOpen = !settingsOpen;
      settingsPanel.style.display = settingsOpen ? "" : "none";
      settingsBtn.classList.toggle("active", settingsOpen);
    });

    thresholdInput.addEventListener("input", (e) => {
      e.stopPropagation();
      const val = parseInt(thresholdInput.value);
      thresholdVal.textContent = val + "s";
      settings.turnThresholdSec = val;
      saveSettings();
    });

    autoshowInput.addEventListener("change", (e) => {
      e.stopPropagation();
      settings.autoShowPanel = autoshowInput.checked;
      saveSettings();
    });

    defaultViewInput.addEventListener("change", (e) => {
      e.stopPropagation();
      settings.defaultView = defaultViewInput.value;
      saveSettings();
    });

    autostartInput.addEventListener("change", (e) => {
      e.stopPropagation();
      settings.autoStartParticipants = parseInt(autostartInput.value);
      saveSettings();
    });

    // --- Drag to reposition ---
    setupDrag(hostEl, shadowRoot.querySelector(".header"));

    // Timer
    timerInterval = setInterval(updateTimer, 1000);
    updateTimer();
  }

  function setupDrag(host, handle) {
    let dragging = false;
    let startX, startY, startLeft, startTop;

    handle.addEventListener("mousedown", (e) => {
      // Don't drag if clicking a button
      if (e.target.closest("button")) return;
      dragging = true;
      const rect = host.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      // Switch from bottom/right to top/left positioning
      host.style.bottom = "auto";
      host.style.right = "auto";
      host.style.left = startLeft + "px";
      host.style.top = startTop + "px";
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      host.style.left = (startLeft + dx) + "px";
      host.style.top = (startTop + dy) + "px";
    });

    document.addEventListener("mouseup", () => {
      dragging = false;
    });
  }

  function updateTimer() {
    if (!timerEl) return;
    timerEl.textContent = formatDuration(Date.now() - state.meetingStart);
  }

  // =====================================================================
  // RENDERING
  // =====================================================================

  function createParticipantEl(p, opts = {}) {
    const div = document.createElement("div");
    div.className = `participant${p.status === "speaking" ? " speaking" : ""}`;

    const avatar = document.createElement("div");
    avatar.className = `avatar avatar-color-${colorIndex(p.id)}${p.status === "speaking" ? " speaking" : ""}`;
    avatar.textContent = p.initials;
    div.appendChild(avatar);

    const info = document.createElement("div");
    info.className = "participant-info";

    const name = document.createElement("div");
    name.className = "participant-name";
    name.textContent = p.name;
    info.appendChild(name);

    const meta = document.createElement("div");
    meta.className = "participant-meta";
    if (opts.showOrder && p.firstSpoke) {
      meta.textContent = formatTime(p.firstSpoke);
    } else if (p.totalDuration > 0) {
      meta.textContent = formatDuration(p.totalDuration);
    } else {
      meta.textContent = "Hasn't spoken";
    }
    info.appendChild(meta);
    div.appendChild(info);

    if (opts.orderNum) {
      const num = document.createElement("div");
      num.className = "order-num";
      num.textContent = opts.orderNum;
      div.appendChild(num);
    }

    // Turn progress
    if (p.totalDuration > 0 || p.status === "speaking") {
      const progress = document.createElement("div");
      const ratio = Math.min(p.totalDuration / getTurnThresholdMs(), 1);
      const met = ratio >= 1;
      progress.className = `turn-progress${met ? " met" : ""}`;

      const counter = document.createElement("span");
      counter.className = "turn-counter";
      counter.textContent = formatDuration(p.totalDuration);
      progress.appendChild(counter);

      const bar = document.createElement("div");
      bar.className = "turn-bar";
      const fill = document.createElement("div");
      fill.className = `turn-bar-fill${met ? " met" : ""}`;
      fill.style.width = `${Math.round(ratio * 100)}%`;
      bar.appendChild(fill);
      progress.appendChild(bar);
      div.appendChild(progress);
    } else {
      const spacer = document.createElement("div");
      spacer.className = "turn-progress";
      div.appendChild(spacer);
    }

    const badge = document.createElement("span");
    badge.className = `badge badge-${p.status}`;
    badge.textContent = p.status === "speaking" ? "Speaking" : p.status === "done" ? "Done" : "Pending";
    div.appendChild(badge);

    return div;
  }

  function render() {
    if (!participantListEl) return;

    updateTimer();

    if (state.participants.length === 0) {
      participantListEl.innerHTML = "";
      participantListEl.appendChild(emptyStateEl);
      emptyStateEl.style.display = "";
      return;
    }

    emptyStateEl.style.display = "none";

    const frag = currentView === "chronological" ? renderChronological() : renderRemaining();
    participantListEl.innerHTML = "";
    participantListEl.appendChild(frag);
  }

  function renderRemaining() {
    const speaking = state.participants.filter((p) => p.status === "speaking");
    const pending = state.participants.filter((p) => p.status === "pending");
    const done = state.participants
      .filter((p) => p.status === "done")
      .sort((a, b) => (a.firstSpoke || 0) - (b.firstSpoke || 0));

    const frag = document.createDocumentFragment();

    if (speaking.length) {
      frag.appendChild(sectionLabel("Speaking now"));
      speaking.forEach((p) => frag.appendChild(createParticipantEl(p)));
    }
    if (pending.length) {
      frag.appendChild(sectionLabel(`Pending (${pending.length})`));
      pending.forEach((p) => frag.appendChild(createParticipantEl(p)));
    }
    if (done.length) {
      frag.appendChild(sectionLabel(`Done (${done.length})`));
      done.forEach((p) => frag.appendChild(createParticipantEl(p)));
    }

    return frag;
  }

  function renderChronological() {
    const spoken = state.participants
      .filter((p) => p.firstSpoke !== null)
      .sort((a, b) => a.firstSpoke - b.firstSpoke);
    const notSpoken = state.participants.filter((p) => p.firstSpoke === null);

    const frag = document.createDocumentFragment();

    if (spoken.length) {
      frag.appendChild(sectionLabel("Speaking order"));
      spoken.forEach((p, i) =>
        frag.appendChild(createParticipantEl(p, { showOrder: true, orderNum: i + 1 }))
      );
    }
    if (notSpoken.length) {
      frag.appendChild(sectionLabel(`Haven't spoken (${notSpoken.length})`));
      notSpoken.forEach((p) => frag.appendChild(createParticipantEl(p)));
    }

    return frag;
  }

  function sectionLabel(text) {
    const el = document.createElement("div");
    el.className = "section-label";
    el.textContent = text;
    return el;
  }

  // =====================================================================
  // LIFECYCLE
  // =====================================================================

  function cleanup() {
    if (observer) observer.disconnect();
    observer = null;
    clearInterval(durationInterval);
    clearInterval(pollForContainerInterval);
    clearInterval(evaluateInterval);
    clearTimeout(debounceTimer);
    durationInterval = null;
    pollForContainerInterval = null;
    evaluateInterval = null;
    removePanel();
    removeFab();
    meetingActive = false;
  }

  function checkMeetingEnded() {
    const tiles = getParticipantTiles();
    if (tiles.length === 0 && meetingActive) {
      noTilesCount++;
      // Wait a few consecutive checks before declaring meeting ended
      // (tiles may briefly disappear during layout changes)
      if (noTilesCount >= 3) {
        log("Meeting ended — cleaning up");
        cleanup(); // removes panel + fab
        // Resume polling in case user joins another meeting
        pollForContainerInterval = setInterval(init, 3000);
      }
    } else if (tiles.length > 0) {
      noTilesCount = 0;
    }
  }

  function init() {
    if (startObserver()) {
      if (pollForContainerInterval) {
        clearInterval(pollForContainerInterval);
        pollForContainerInterval = null;
      }
      meetingActive = true;
      noTilesCount = 0;
      injectFab();
      injectPanel();
      // Auto-show if setting enabled
      if (settings.autoShowPanel) {
        showPanel();
      }
      // Initial scan
      const tiles = getParticipantTiles();
      tiles.forEach((tile) => {
        const id = tile.getAttribute("data-participant-id");
        if (id) findOrCreateParticipant(id, extractNameFromTile(tile));
      });
      render();
      return true;
    }
    return false;
  }

  // Listen for toggle from background script (extension icon click)
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "TOGGLE_PANEL") {
      togglePanel();
      sendResponse({ visible: panelVisible });
      return true;
    }
  });

  // Load settings first, then start
  loadSettings().then(() => {
    pollForContainerInterval = setInterval(init, 3000);
    init();

    evaluateInterval = setInterval(() => {
      evaluateSpeaker();
      checkMeetingEnded();
    }, STATE_SYNC_MS);

    durationInterval = setInterval(() => {
      tickDurations();
    }, STATE_SYNC_MS);

    log("Content script loaded (click popcorn button to show panel)");
  });

  window.addEventListener("beforeunload", cleanup);
})();
