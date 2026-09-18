// The work pane: the shell beside the conversation that holds whatever is
// being made or examined. Chat carries the discussion; this carries the thing.
//
// The shell owns open/close, which resource is active, sizing, focus and the
// narrow-screen mode. It owns no content: a resource kind registers a handler
// with WorkResources, and the handler is handed an already-authorised
// container and a small set of capabilities. A viewer cannot invent a
// privileged endpoint, and the shell cannot read a document.
//
// Three rules the rest of the app depends on:
//   · an automatic open never steals focus from the composer, and an explicit
//     one always moves focus to the resource's heading;
//   · a background event never replaces what a person is reading — it leaves
//     a quiet mark on the tab instead (WorkPane.mark);
//   · closing a tab closes a view, never a file.

const WorkResources = (() => {
  const handlers = new Map();
  return {
    /** A handler is { key, describe, mount, dispose? }. `mount` may be async. */
    register(kind, handler) { handlers.set(kind, handler); },
    get(kind) { return handlers.get(kind) || null; },
    keyOf(resource) {
      const handler = handlers.get(resource?.kind);
      return handler ? handler.key(resource) : null;
    },
  };
})();

const WorkPane = (() => {
  const MIN_CHAT = 340;
  const MIN_PANE = 420;
  const VISIBLE_TABS = 4;
  const VISIBLE_TABS_NARROW = 1;   // one work area, one legible label, the rest in the menu
  const DEFAULT_SPLIT = 0.55;

  const state = {
    tabs: [],            // { key, resource, label, kind, el, panel, marked, mounted, opener }
    activeKey: null,
    expanded: false,
    ratio: DEFAULT_SPLIT,
    narrow: false,
    suppressAuto: false, // set when a person closes the pane; cleared next turn
    prefsKey: 'kd.pane',
  };

  const el = {};
  let started = false;

  function cache() {
    el.workspace = document.querySelector('.workspace');
    el.centre = document.querySelector('.centre');
    el.rail = document.getElementById('sidebar');
    el.pane = document.getElementById('work-pane');
    el.resize = document.getElementById('pane-resize');
    el.tabs = document.getElementById('work-tabs');
    el.overflow = document.getElementById('work-overflow');
    el.overflowList = document.getElementById('work-overflow-list');
    el.panels = document.getElementById('work-panels');
    el.expand = document.getElementById('work-expand');
    el.close = document.getElementById('work-close');
    el.back = document.getElementById('work-back');
  }

  // ---- preferences: sizes only. Never a resource id, never content. ----

  function loadPrefs() {
    try {
      const raw = JSON.parse(localStorage.getItem(state.prefsKey) || '{}');
      if (typeof raw.ratio === 'number' && raw.ratio > 0.2 && raw.ratio < 0.85) state.ratio = raw.ratio;
      state.expanded = !!raw.expanded;
    } catch { /* storage unavailable: the defaults are fine */ }
  }

  function savePrefs() {
    try { localStorage.setItem(state.prefsKey, JSON.stringify({ ratio: state.ratio, expanded: state.expanded })); }
    catch { /* ignore */ }
  }

  /** Scope preferences to the signed-in workspace, so two orgs do not share a split. */
  function identify(orgId, userKey) {
    state.prefsKey = `kd.pane.${orgId || 'none'}.${userKey || 'none'}`;
    loadPrefs();
    layout();
  }

  // ---- layout ----
  //
  // The available width decides the mode, not a device label: the navigation
  // rail collapses before either main pane is squeezed, and when even that is
  // not enough the pane becomes a single work area with "Back to chat".

  function layout() {
    if (!el.pane) return;
    const open = state.tabs.length > 0;
    el.pane.hidden = !open;
    el.workspace.classList.toggle('has-work-pane', open);
    el.workspace.classList.toggle('work-expanded', open && state.expanded);
    if (!open) {
      el.workspace.classList.remove('rail-collapsed', 'work-narrow');
      state.narrow = false;
      el.resize.hidden = true;
      document.documentElement.style.removeProperty('--work-pane-width');
      return;
    }

    const viewport = document.documentElement.clientWidth || window.innerWidth || 1280;
    const railWidth = el.rail?.offsetWidth || 0;
    let available = viewport - railWidth;

    // Collapse the rail before squeezing either main pane.
    const collapseRail = available < MIN_CHAT + MIN_PANE && railWidth > 0;
    el.workspace.classList.toggle('rail-collapsed', collapseRail);
    if (collapseRail) available = viewport;

    state.narrow = available < MIN_CHAT + MIN_PANE;
    el.workspace.classList.toggle('work-narrow', state.narrow);
    if (el.back) el.back.hidden = !state.narrow;
    // A separator that cannot move anything is not a control: in the expanded
    // and single-area modes it leaves the tab order and the a11y tree too,
    // rather than only becoming invisible.
    el.resize.hidden = state.expanded || state.narrow;
    renderTabs();

    if (state.narrow || state.expanded) {
      document.documentElement.style.removeProperty('--work-pane-width');
      return;
    }
    const width = Math.round(Math.min(Math.max(available * state.ratio, MIN_PANE), available - MIN_CHAT));
    document.documentElement.style.setProperty('--work-pane-width', `${width}px`);
    el.resize.setAttribute('aria-valuenow', String(Math.round((width / available) * 100)));
  }

  function setRatio(next) {
    state.ratio = Math.min(Math.max(next, 0.25), 0.8);
    savePrefs();
    layout();
  }

  function startResize() {
    let dragging = false;
    const move = (clientX) => {
      const railWidth = el.workspace.classList.contains('rail-collapsed') ? 0 : (el.rail?.offsetWidth || 0);
      const available = (document.documentElement.clientWidth || window.innerWidth) - railWidth;
      const fromLeft = clientX - railWidth;
      setRatio((available - fromLeft) / available);
    };
    el.resize.addEventListener('pointerdown', (e) => {
      dragging = true;
      el.resize.setPointerCapture?.(e.pointerId);
      el.workspace.classList.add('resizing');
      e.preventDefault();
    });
    el.resize.addEventListener('pointermove', (e) => { if (dragging) move(e.clientX); });
    const stop = (e) => {
      if (!dragging) return;
      dragging = false;
      el.resize.releasePointerCapture?.(e.pointerId);
      el.workspace.classList.remove('resizing');
    };
    el.resize.addEventListener('pointerup', stop);
    el.resize.addEventListener('pointercancel', stop);
    // Keyboard: the separator is a real control, not a mouse affordance.
    el.resize.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.08 : 0.02;
      if (e.key === 'ArrowLeft') { setRatio(state.ratio + step); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { setRatio(state.ratio - step); e.preventDefault(); }
      else if (e.key === 'Home') { setRatio(0.8); e.preventDefault(); }
      else if (e.key === 'End') { setRatio(0.25); e.preventDefault(); }
      else if (e.key === 'Enter') { setRatio(DEFAULT_SPLIT); e.preventDefault(); }
    });
  }

  function start() {
    if (started) return;
    started = true;
    cache();
    if (!el.pane) return;
    loadPrefs();
    startResize();
    el.close.addEventListener('click', () => closeAll({ byUser: true }));
    el.back?.addEventListener('click', () => closeAll({ byUser: true }));
    el.expand.addEventListener('click', () => {
      state.expanded = !state.expanded;
      el.expand.setAttribute('aria-pressed', String(state.expanded));
      el.expand.title = state.expanded ? 'Restore the conversation' : 'Expand the work pane';
      savePrefs();
      layout();
      focusActive();
    });
    el.overflow.addEventListener('click', () => toggleOverflow());
    document.addEventListener('click', (e) => {
      if (!el.overflowList.hidden && !e.target.closest('.work-overflow-wrap')) toggleOverflow(false);
    });
    el.tabs.addEventListener('keydown', tabKeys);
    window.addEventListener('resize', layout);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !el.pane.hidden && el.pane.contains(document.activeElement)) closeAll({ byUser: true });
    });
    layout();
  }

  // ---- tabs ----

  function tabKeys(e) {
    const order = state.tabs.filter((t) => !t.el.hidden);
    const index = order.findIndex((t) => t.key === state.activeKey);
    if (index < 0) return;
    let next = null;
    if (e.key === 'ArrowRight') next = order[(index + 1) % order.length];
    else if (e.key === 'ArrowLeft') next = order[(index - 1 + order.length) % order.length];
    else if (e.key === 'Home') next = order[0];
    else if (e.key === 'End') next = order[order.length - 1];
    else if (e.key === 'Delete' || e.key === 'Backspace') { close(state.activeKey, { byUser: true }); e.preventDefault(); return; }
    if (!next) return;
    e.preventDefault();
    activate(next.key, { focus: true });
  }

  function toggleOverflow(force) {
    const show = force === undefined ? el.overflowList.hidden : force;
    el.overflowList.hidden = !show;
    el.overflow.setAttribute('aria-expanded', String(show));
    if (show) el.overflowList.querySelector('button')?.focus();
  }

  const visibleTabCount = () => (state.narrow ? VISIBLE_TABS_NARROW : VISIBLE_TABS);

  function renderTabs() {
    // The most recently used tabs stay visible; the rest move to the overflow
    // list, which is a real menu rather than a horizontal scroll nobody finds.
    // On a narrow screen four truncated labels say nothing, so the strip keeps
    // one and the menu keeps the rest.
    const hiddenTabs = [];
    state.tabs.forEach((tab, i) => {
      const visible = i < visibleTabCount() || tab.key === state.activeKey;
      tab.el.hidden = !visible;
      if (!visible) hiddenTabs.push(tab);
    });
    el.overflow.hidden = hiddenTabs.length === 0;
    el.overflowList.replaceChildren();
    for (const tab of hiddenTabs) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'work-overflow-item';
      item.setAttribute('role', 'menuitem');
      item.textContent = tab.label;
      item.addEventListener('click', () => { toggleOverflow(false); activate(tab.key, { focus: true }); });
      el.overflowList.appendChild(item);
    }
  }

  function makeTab(entry) {
    const tab = document.createElement('div');
    tab.className = 'work-tab';
    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'work-tab-label';
    label.setAttribute('role', 'tab');
    label.id = `work-tab-${cssId(entry.key)}`;
    label.setAttribute('aria-controls', `work-panel-${cssId(entry.key)}`);
    label.textContent = entry.label;
    label.title = entry.label;
    label.addEventListener('click', () => activate(entry.key, { focus: true }));
    const dot = document.createElement('span');
    dot.className = 'work-tab-mark';
    dot.hidden = true;
    const shut = document.createElement('button');
    shut.type = 'button';
    shut.className = 'work-tab-close';
    shut.setAttribute('aria-label', `Close ${entry.label}`);
    shut.textContent = '✕';
    shut.addEventListener('click', (e) => { e.stopPropagation(); close(entry.key, { byUser: true }); });
    tab.append(label, dot, shut);
    entry.labelEl = label;
    entry.markEl = dot;
    return tab;
  }

  const cssId = (key) => String(key).replace(/[^a-zA-Z0-9_-]/g, '_');

  function syncActive() {
    for (const tab of state.tabs) {
      const on = tab.key === state.activeKey;
      tab.el.classList.toggle('is-active', on);
      tab.labelEl.setAttribute('aria-selected', String(on));
      tab.labelEl.tabIndex = on ? 0 : -1;
      tab.panel.hidden = !on;
      if (on && tab.marked) mark(tab.key, null);
    }
  }

  function focusActive() {
    const tab = state.tabs.find((t) => t.key === state.activeKey);
    if (!tab) return;
    const heading = tab.panel.querySelector('[data-work-heading]') || tab.panel;
    heading.focus?.({ preventScroll: true });
  }

  // ---- the public surface ----

  /**
   * Open a resource, or bring it forward if it is already open.
   *
   * `reason: 'user'` is a person clicking; it always opens, always activates
   * and moves focus. `reason: 'auto'` is the app noticing something; it is
   * suppressed for the rest of a turn once a person closes the pane, it never
   * moves focus, and it never displaces a resource someone is already reading.
   */
  async function open(resource, { reason = 'user', opener = null, activateTab = true } = {}) {
    start();
    const handler = WorkResources.get(resource?.kind);
    if (!handler) return null;
    const key = handler.key(resource);
    const existing = state.tabs.find((t) => t.key === key);

    if (reason === 'auto') {
      if (state.suppressAuto && !existing) return null;
      // Something arriving in the background must not take the view away from
      // the person: mark the tab and leave them where they are.
      if (existing && state.activeKey !== key) { mark(key, 'updated'); return key; }
      if (!existing && state.activeKey) { /* a different resource is in front */ }
    }
    if (reason === 'user') state.suppressAuto = false;

    if (existing) {
      existing.resource = resource;
      if (activateTab || reason === 'user') activate(key, { focus: reason === 'user' });
      await mount(existing, { remount: true });
      return key;
    }

    const described = handler.describe(resource);
    const entry = {
      key, resource, kind: resource.kind, label: described.label,
      marked: null, opener: opener || document.activeElement,
    };
    entry.el = makeTab(entry);
    entry.panel = document.createElement('section');
    entry.panel.className = 'work-panel';
    entry.panel.id = `work-panel-${cssId(key)}`;
    entry.panel.setAttribute('role', 'tabpanel');
    entry.panel.setAttribute('aria-labelledby', entry.labelEl.id);
    entry.panel.hidden = true;

    // A transient utility view (profile) never stacks: it replaces its own
    // kind and leaves the work resources alone.
    if (handler.transient) {
      for (const tab of state.tabs.filter((t) => t.kind === resource.kind)) close(tab.key, {});
    }
    state.tabs.push(entry);
    el.tabs.appendChild(entry.el);
    el.panels.appendChild(entry.panel);
    renderTabs();

    const shouldActivate = activateTab && (reason === 'user' || !state.activeKey);
    if (shouldActivate) activate(key, { focus: reason === 'user' });
    else syncActive();
    layout();
    await mount(entry, {});
    if (reason === 'auto' && !shouldActivate) mark(key, 'new');
    return key;
  }

  async function mount(entry, { remount }) {
    const handler = WorkResources.get(entry.kind);
    if (!handler) return;
    if (remount && entry.mounted) { handler.dispose?.(entry.panel); entry.mounted = false; }
    if (entry.mounted) return;
    entry.mounted = true;
    entry.panel.replaceChildren();
    try {
      await handler.mount(entry.panel, entry.resource, {
        setLabel: (label) => setLabel(entry.key, label),
        close: () => close(entry.key, { byUser: true }),
        isActive: () => state.activeKey === entry.key,
      });
    } catch (err) {
      entry.panel.replaceChildren(errorBlock(err));
    }
  }

  function errorBlock(err) {
    const box = document.createElement('div');
    box.className = 'work-empty';
    box.tabIndex = -1;
    box.setAttribute('data-work-heading', '');
    box.textContent = `Could not open this. ${err?.message || ''}`.trim();
    return box;
  }

  function activate(key, { focus = false } = {}) {
    if (!state.tabs.some((t) => t.key === key)) return;
    state.activeKey = key;
    // Most-recently-used ordering keeps what someone is actually using visible.
    const index = state.tabs.findIndex((t) => t.key === key);
    if (index >= visibleTabCount()) {
      const [entry] = state.tabs.splice(index, 1);
      state.tabs.unshift(entry);
      el.tabs.prepend(entry.el);
    }
    renderTabs();
    syncActive();
    // A list brought back to the front is re-read rather than remembered.
    const panel = state.tabs.find((t) => t.key === key)?.panel;
    if (panel?._refreshOnActivate) panel._refresh?.();
    if (focus) focusActive();
  }

  function close(key, { byUser = false } = {}) {
    const index = state.tabs.findIndex((t) => t.key === key);
    if (index < 0) return;
    const [entry] = state.tabs.splice(index, 1);
    WorkResources.get(entry.kind)?.dispose?.(entry.panel);
    entry.el.remove();
    entry.panel.remove();
    if (state.activeKey === key) {
      state.activeKey = state.tabs[0]?.key || null;
      syncActive();
      if (state.tabs.length) focusActive();
    }
    renderTabs();
    layout();
    // Focus returns to whatever asked for this resource, not to nowhere.
    if (byUser && !state.tabs.length) {
      state.suppressAuto = true;
      const opener = entry.opener;
      if (opener && document.contains(opener)) opener.focus?.();
      else document.getElementById('input')?.focus();
    }
  }

  function closeAll({ byUser = false } = {}) {
    const opener = state.tabs[0]?.opener;
    for (const tab of [...state.tabs]) close(tab.key, {});
    if (byUser) {
      state.suppressAuto = true;
      if (opener && document.contains(opener)) opener.focus?.();
      else document.getElementById('input')?.focus();
    }
  }

  /** A quiet indication that something changed behind the person's back. */
  function mark(key, kind) {
    const tab = state.tabs.find((t) => t.key === key);
    if (!tab) return;
    tab.marked = kind;
    tab.markEl.hidden = !kind;
    tab.markEl.title = kind === 'new' ? 'New file' : 'New version';
    tab.labelEl.setAttribute('aria-describedby', kind ? tab.markEl.id || '' : '');
  }

  function setLabel(key, label) {
    const tab = state.tabs.find((t) => t.key === key);
    if (!tab || !label) return;
    tab.label = label;
    tab.labelEl.textContent = label;
    tab.labelEl.title = label;
    renderTabs();
  }

  /** A new conversation or a replayed one starts with an empty pane. */
  function reset() {
    start();
    for (const tab of [...state.tabs]) close(tab.key, {});
    state.suppressAuto = false;
    state.activeKey = null;
    layout();
  }

  /** A new turn re-enables automatic opening that a close suppressed. */
  function newTurn() { state.suppressAuto = false; }

  return {
    start, identify, open, close, closeAll, activate, reset, newTurn, mark, setLabel, layout,
    isOpen: () => state.tabs.length > 0,
    activeKey: () => state.activeKey,
    activeResource: () => state.tabs.find((t) => t.key === state.activeKey)?.resource || null,
    has: (key) => state.tabs.some((t) => t.key === key),
    openKeys: () => state.tabs.map((t) => t.key),
    _state: state,
  };
})();

if (typeof window !== 'undefined') {
  window.WorkPane = WorkPane;
  window.WorkResources = WorkResources;
}
