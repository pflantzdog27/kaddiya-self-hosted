// A small DOM stand-in for the browser scripts, enough to mount a viewer and
// then ask what it built. It is deliberately not a browser: the point is to
// assert structure and, above all, that nothing reached innerHTML except the
// one renderer whose whole job is escaping. The real browser check runs
// separately, under the real CSP.

/** A Set that also answers the DOMTokenList methods layout code calls. */
function tokenList(initial = []) {
  const set = new Set(initial);
  set.contains = (c) => set.has(c);
  set.remove = (...cs) => cs.forEach((c) => set.delete(c));
  set.toggle = (c, force) => {
    const on = force === undefined ? !set.has(c) : !!force;
    if (on) set.add(c); else set.delete(c);
    return on;
  };
  return set;
}

class FakeNode {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.classList = tokenList();
    this._text = '';
    this._html = null;
    this.style = { setProperty() {}, removeProperty() {} };
    this.dataset = {};
    this.hidden = false;
    this._width = 0;
  }
  // Layout code asks elements how wide they are; a test can answer.
  get offsetWidth() { return typeof this._width === 'function' ? this._width() : this._width; }
  set offsetWidth(v) { this._width = v; }
  get className() { return [...this.classList].join(' '); }
  set className(v) { this.classList = tokenList(String(v).split(/\s+/).filter(Boolean)); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() {
    if (this._text) return this._text;
    return this.children.map((c) => c.textContent).join('');
  }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html ?? ''; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  removeAttribute(k) { delete this.attributes[k]; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  append(...kids) { for (const k of kids) this.appendChild(k); }
  prepend(k) { k.parentNode = this; this.children.unshift(k); }
  insertBefore(node, ref) {
    const i = this.children.indexOf(ref);
    node.parentNode = this;
    this.children.splice(i < 0 ? this.children.length : i, 0, node);
    return node;
  }
  replaceChildren(...kids) { this.children = []; this._text = ''; this._html = null; this.append(...kids); }
  remove() {
    const i = this.parentNode?.children.indexOf(this) ?? -1;
    if (i >= 0) this.parentNode.children.splice(i, 1);
  }
  addEventListener(type, fn) { (this._listeners ||= {})[type] = fn; }
  removeEventListener() {}
  focus() { this.focused = true; }
  click() { this._listeners?.click?.({ stopPropagation() {}, preventDefault() {}, currentTarget: this }); }
  closest() { return null; }
  /** Every node under here, self included, in document order. */
  walk() { return [this, ...this.children.flatMap((c) => c.walk())]; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const matches = (n) => {
      if (sel.startsWith('.')) return n.classList.has(sel.slice(1));
      return n.tagName === sel.toUpperCase();
    };
    return this.walk().slice(1).filter(matches);
  }
  get tags() { return this.walk().map((n) => n.tagName); }
  /** Anything that was handed raw HTML rather than text. */
  get htmlNodes() { return this.walk().filter((n) => n._html !== null); }
}

export function makeDocument() {
  const body = new FakeNode('body');
  body.hasAttribute = () => true;      // keeps app.js init() from running
  const byId = new Map();
  return {
    body,
    createElement: (tag) => new FakeNode(tag),
    createRange: () => ({ selectNodeContents() {} }),
    // Stable per id, so the scripts' module-level element lookups behave the
    // way they do in a page rather than handing back a new node each time.
    getElementById(id) {
      if (!byId.has(id)) {
        const node = new FakeNode('div');
        node.id = id;
        byId.set(id, node);
      }
      return byId.get(id);
    },
    querySelector: () => new FakeNode('div'),
    querySelectorAll: () => [],
    addEventListener() {},
    documentElement: new FakeNode('html'),
    contains: () => true,
    activeElement: null,
  };
}

export { FakeNode };
