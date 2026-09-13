// Organization identity is deliberately limited to text, a color, and an
// embedded raster logo. Never accept remote URLs, SVG, HTML, or custom CSS.
export function normalizeBranding(input) {
  if (input === null) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Branding must be an object.');
  const result = {};
  if (input.welcome) {
    if (typeof input.welcome !== 'string' || input.welcome.trim().length > 180) throw new Error('Use a welcome message of 180 characters or fewer.');
    if (input.welcome.trim()) result.welcome = input.welcome.trim();
  }
  if (input.accent) {
    if (typeof input.accent !== 'string' || !/^#[0-9a-f]{6}$/i.test(input.accent)) throw new Error('Choose a six-digit hex accent color.');
    result.accent = input.accent.toLowerCase();
  }
  if (input.logo) {
    if (typeof input.logo !== 'string' || input.logo.length > 350000 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(input.logo)) throw new Error('Upload a PNG, JPEG, or WebP logo using the logo picker.');
    const bytes = Buffer.from(input.logo.split(',')[1], 'base64');
    if (bytes.length > 256 * 1024 || bytes.length < 45 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
      || bytes.subarray(12, 16).toString() !== 'IHDR' || bytes.readUInt32BE(8) !== 13
      || bytes.subarray(-8, -4).toString() !== 'IEND'
      || !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20)
      || bytes.readUInt32BE(16) > 512 || bytes.readUInt32BE(20) > 512) throw new Error('Use a logo up to 512 × 512 pixels and 256 KB after resizing.');
    result.logo = `data:image/png;base64,${bytes.toString('base64')}`;
  }
  return result;
}

// Only this explicitly public identity is exposed before sign-in.
export function publicIdentity(org) {
  return org ? { name: org.name, branding: org.branding || {} } : null;
}
