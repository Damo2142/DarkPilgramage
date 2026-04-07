/**
 * Panel Framework — Shared module for dashboard launcher and pop-out panel windows.
 * Provides: WebSocket connection, state management, event routing, layout persistence,
 * pop-out/dock-back logic, and panel registration.
 */

// ═══════════════════════════════════════════════════════════════
// PANEL REGISTRY
// ═══════════════════════════════════════════════════════════════

const PanelRegistry = {
  panels: {
    'panel-map':        { title: 'Map',              icon: '🗺️',  group: 'main' },
    'panel-hal':        { title: 'HAL',              icon: '🤖',  group: 'monitor1' },
    'panel-combat':     { title: 'Combat',           icon: '⚔️',  group: 'monitor1' },
    'panel-wounds':     { title: 'Wounds',           icon: '🩸',  group: 'monitor1' },
    'panel-spurt':      { title: 'Spurt Agent',      icon: '🦎',  group: 'monitor1' },
    'panel-npc-queue':  { title: 'NPC Dialogue',     icon: '💬',  group: 'monitor1' },
    'panel-players':    { title: 'Players',          icon: '👥',  group: 'monitor2' },
    'panel-equipment':  { title: 'Equipment',        icon: '🛡️',  group: 'monitor2' },
    'panel-cameras':    { title: 'Cameras',          icon: '📷',  group: 'monitor2' },
    'panel-dread':      { title: 'Dread',            icon: '😱',  group: 'monitor2' },
    'panel-ddb':        { title: 'DDB Sync',         icon: '🔄',  group: 'monitor3' },
    'panel-campaign':   { title: 'Campaign',         icon: '📜',  group: 'monitor3' },
    'panel-hooks':      { title: 'Future Hooks',     icon: '🪝',  group: 'monitor3' },
    'panel-lights':     { title: 'Map Lights',       icon: '💡',  group: 'monitor3' },
    'panel-walls':      { title: 'Map Walls',        icon: '🧱',  group: 'monitor3' },
    'panel-session':    { title: 'Session Controls',  icon: '🎬',  group: 'monitor3' },
    'panel-atmosphere': { title: 'Atmosphere',       icon: '🌙',  group: 'monitor3' },
  },

  get(id) { return this.panels[id] || null; },
  all() { return Object.entries(this.panels); },
  byGroup(group) { return Object.entries(this.panels).filter(([,p]) => p.group === group); }
};

// ═══════════════════════════════════════════════════════════════
// WEBSOCKET CONNECTION
// ═══════════════════════════════════════════════════════════════

const DashWS = {
  ws: null,
  state: {},
  _handlers: [],      // [ { event, fn } ] for targeted handlers
  _globalHandlers: [], // fn(msg) for catch-all handlers
  _connected: false,
  _reconnectTimer: null,

  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${proto}//${location.host}`);

    this.ws.onopen = () => {
      if (this._connected) { location.reload(); return; }
      this._connected = true;
      this._fireEvent('_ws:connected', {});
    };

    this.ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        this._dispatch(msg);
      } catch (err) {
        console.error('[PanelFW] Bad WS message:', err);
      }
    };

    this.ws.onclose = () => {
      this._fireEvent('_ws:disconnected', {});
      this._reconnectTimer = setTimeout(() => this.connect(), 5000);
    };
  },

  send(type, data = {}) {
    if (this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify({ type, ...data }));
    }
  },

  // Register handler for specific event type
  on(event, fn) {
    this._handlers.push({ event, fn });
  },

  // Register catch-all handler
  onAny(fn) {
    this._globalHandlers.push(fn);
  },

  _dispatch(msg) {
    const eventType = msg.type || msg.event;

    // Handle init specially — merge state
    if (eventType === 'init') {
      this.state = msg.state || {};
    }

    // State change tracking
    if (eventType === 'state:change' && msg.data) {
      _setNested(this.state, msg.data.path, msg.data.value);
    }

    // Fire targeted handlers
    for (const h of this._handlers) {
      if (h.event === eventType) {
        try { h.fn(msg); } catch (e) { console.error(`[PanelFW] Handler error for ${eventType}:`, e); }
      }
    }

    // Fire global handlers
    for (const fn of this._globalHandlers) {
      try { fn(msg); } catch (e) { console.error('[PanelFW] Global handler error:', e); }
    }
  },

  _fireEvent(type, data) {
    this._dispatch({ type, data });
  }
};

// ═══════════════════════════════════════════════════════════════
// LAYOUT PERSISTENCE
// ═══════════════════════════════════════════════════════════════

const Layout = {
  _data: { panels: {} },
  _saveTimer: null,

  async load() {
    try {
      const res = await fetch('/api/layout');
      if (res.ok) {
        const data = await res.json();
        this._data = data || { panels: {} };
      }
    } catch (e) {
      console.warn('[Layout] Could not load layout:', e.message);
    }
    return this._data;
  },

  async save() {
    try {
      await fetch('/api/layout/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this._data)
      });
    } catch (e) {
      console.warn('[Layout] Could not save layout:', e.message);
    }
  },

  // Debounced save
  scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.save(), 1000);
  },

  getPanelState(panelId) {
    return this._data.panels[panelId] || { popped: false };
  },

  setPanelState(panelId, state) {
    this._data.panels[panelId] = { ...(this._data.panels[panelId] || {}), ...state };
    this.scheduleSave();
  },

  getPoppedPanels() {
    return Object.entries(this._data.panels)
      .filter(([, s]) => s.popped)
      .map(([id, s]) => ({ id, ...s }));
  }
};

// ═══════════════════════════════════════════════════════════════
// POP-OUT MANAGER
// ═══════════════════════════════════════════════════════════════

const Popout = {
  _windows: {}, // panelId -> Window reference

  open(panelId) {
    if (this._windows[panelId] && !this._windows[panelId].closed) {
      this._windows[panelId].focus();
      return;
    }

    const info = PanelRegistry.get(panelId);
    if (!info) return;

    const saved = Layout.getPanelState(panelId);
    const w = saved.width || 600;
    const h = saved.height || 700;
    const x = saved.x || (100 + Object.keys(this._windows).length * 30);
    const y = saved.y || (100 + Object.keys(this._windows).length * 30);

    const features = `width=${w},height=${h},left=${x},top=${y},toolbar=no,menubar=no,scrollbars=no,resizable=yes`;
    const win = window.open(`/panel/${panelId}`, panelId, features);

    if (!win) {
      console.error('[Popout] Blocked — allow popups for this site');
      return;
    }

    this._windows[panelId] = win;
    Layout.setPanelState(panelId, { popped: true, x, y, width: w, height: h });

    // Track window position/size on close or move
    const checkInterval = setInterval(() => {
      if (win.closed) {
        clearInterval(checkInterval);
        delete this._windows[panelId];
        Layout.setPanelState(panelId, { popped: false });
        // Notify launcher to re-dock
        DashWS._fireEvent('_panel:docked', { panelId });
        return;
      }
      // Save position periodically
      try {
        const rect = {
          x: win.screenX, y: win.screenY,
          width: win.outerWidth, height: win.outerHeight
        };
        Layout.setPanelState(panelId, { popped: true, ...rect });
      } catch (e) { /* cross-origin or closed */ }
    }, 3000);

    // Notify launcher
    DashWS._fireEvent('_panel:popped', { panelId });
  },

  dock(panelId) {
    const win = this._windows[panelId];
    if (win && !win.closed) {
      win.close();
    }
    delete this._windows[panelId];
    Layout.setPanelState(panelId, { popped: false });
    DashWS._fireEvent('_panel:docked', { panelId });
  },

  isPopped(panelId) {
    return this._windows[panelId] && !this._windows[panelId].closed;
  },

  async restoreAll() {
    const popped = Layout.getPoppedPanels();
    for (const p of popped) {
      await new Promise(r => setTimeout(r, 300)); // stagger window opens
      this.open(p.id);
    }
  }
};

// ═══════════════════════════════════════════════════════════════
// UTILITY
// ═══════════════════════════════════════════════════════════════

function _setNested(obj, path, value) {
  const keys = path.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!current[keys[i]] || typeof current[keys[i]] !== 'object') {
      current[keys[i]] = {};
    }
    current = current[keys[i]];
  }
  current[keys[keys.length - 1]] = value;
}

function esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function $(id) { return document.getElementById(id); }
