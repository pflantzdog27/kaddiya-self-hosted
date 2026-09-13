// Shared identity and editor. User text only enters textContent; logos are
// embedded PNGs. Color properties are set through CSSOM under the strict CSP.
window.KaddiyaBranding = (() => {
  const defaultTitle = document.title;
  function ink(color) {
    const rgb = color.slice(1).match(/../g).map(v => {
      const n = parseInt(v, 16) / 255;
      return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4;
    });
    const luminance = .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
    return luminance > .179 ? '#000000' : '#ffffff';
  }
  function paint(target, identity) {
    const brand = identity?.branding || {};
    const name = identity?.name || '';
    for (const el of target.querySelectorAll('[data-workspace-name]')) el.textContent = name;
    for (const el of target.querySelectorAll('[data-workspace-identity]')) el.hidden = !name;
    for (const el of target.querySelectorAll('[data-workspace-welcome]')) {
      el.textContent = brand.welcome || ''; el.hidden = !brand.welcome;
    }
    for (const el of target.querySelectorAll('[data-workspace-logo]')) {
      const logo = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(brand.logo || '') ? brand.logo : '';
      el.hidden = !logo;
      if (logo) { el.src = logo; el.alt = `${name} logo`; }
      else el.removeAttribute('src');
    }
    const root = target === document ? document.documentElement : target;
    const color = /^#[a-f0-9]{6}$/i.test(brand.accent || '') ? brand.accent : '';
    root.classList.toggle('branding-active', !!color);
    if (color) {
      root.style.setProperty('--brand-accent', color);
      root.style.setProperty('--brand-ink', ink(color));
    } else {
      if (target === document) {
        root.style.removeProperty('--brand-accent'); root.style.removeProperty('--brand-ink');
      } else {
        root.style.setProperty('--brand-accent', 'var(--text)');
        root.style.setProperty('--brand-ink', 'var(--ground)');
      }
    }
  }
  function apply(identity) {
    // Editors own their preview and never repaint the page until a save succeeds.
    paint(document, identity);
    document.title = identity?.name ? `${identity.name} · ${defaultTitle}` : defaultTitle;
  }
  function editor(container, nameInput) {
    const get = id => container.querySelector(`[data-brand-${id}]`);
    let logo = '';
    let dirty = false;
    let reading = false;
    let generation = 0;
    function value() {
      if (reading) throw new Error('Wait for the logo to finish loading.');
      return { logo, accent: get('custom').checked ? get('accent').value : '', welcome: get('welcome').value.trim() };
    }
    function preview() {
      get('accent').disabled = !get('custom').checked;
      get('remove').hidden = !logo;
      paint(get('preview'), { name: nameInput.value.trim() || 'Your workspace', branding: {
        logo, accent: get('custom').checked ? get('accent').value : '', welcome: get('welcome').value.trim(),
      } });
    }
    function load(brand = {}) {
      generation++; reading = false; dirty = false; logo = brand.logo || '';
      get('custom').checked = !!brand.accent;
      get('accent').value = brand.accent || '#315bce';
      get('welcome').value = brand.welcome || '';
      get('file').value = ''; get('status').textContent = ''; preview();
    }
    container.addEventListener('input', () => { dirty = true; preview(); });
    nameInput.addEventListener('input', preview);
    get('remove').addEventListener('click', () => { generation++; dirty = true; reading = false; logo = ''; get('file').value = ''; get('status').textContent = ''; preview(); });
    get('reset').addEventListener('click', () => { load(); dirty = true; });
    get('file').addEventListener('change', async () => {
      const file = get('file').files[0];
      if (!file) return;
      dirty = true;
      const current = ++generation;
      reading = true; get('status').textContent = 'Preparing logo…';
      try {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) throw new Error('Choose a PNG, JPEG, or WebP image under 2 MB.');
        const bitmap = await createImageBitmap(file);
        try {
          const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(bitmap.width * scale));
          canvas.height = Math.max(1, Math.round(bitmap.height * scale));
          canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          const png = canvas.toDataURL('image/png');
          if (png.length > 349550) throw new Error('This logo is too detailed. Choose a smaller or simpler image.');
          if (current !== generation) return;
          logo = png; get('status').textContent = 'Logo ready. Save to apply it.';
        } finally { bitmap.close(); }
      } catch (err) { if (current === generation) get('status').textContent = err.message || 'Could not read that image.'; }
      finally { if (current === generation) { reading = false; get('file').value = ''; preview(); } }
    });
    load();
    return { value, load, preview, changed: () => dirty };
  }
  if (!document.querySelector('[data-brand-editor]')) {
    fetch('/api/config').then(r => r.ok ? r.json() : null).then(data => { if (data?.workspace) apply(data.workspace); }).catch(() => {});
  }
  return { apply, editor };
})();
