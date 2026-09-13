import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBranding, publicIdentity } from '../server/branding.js';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=';
test('branding accepts embedded PNGs and plain text, with a closed public shape', () => {
  assert.deepEqual(normalizeBranding({ logo: png, accent: '#AABBCC', welcome: '  Hello team  ', css: 'evil' }), { logo: png, accent: '#aabbcc', welcome: 'Hello team' });
  assert.deepEqual(publicIdentity({ name: 'Example', branding: {}, dek_wrapped: 'private', model_connections: ['private'] }), { name: 'Example', branding: {} });
  assert.deepEqual(normalizeBranding(null), {});
  assert.deepEqual(normalizeBranding({}), {});
});
test('branding rejects remote loads, executable formats, CSS injection, and oversized values', () => {
  for (const logo of ['https://evil.test/a.png', 'data:image/svg+xml;base64,PHN2Zy8+', 'data:image/png;base64,PHN2Zy8+', png + 'x'.repeat(350000)]) assert.throws(() => normalizeBranding({ logo }));
  for (const accent of ['red', '#123', '#123456; background:url(https://evil.test)', {}]) assert.throws(() => normalizeBranding({ accent }));
  assert.throws(() => normalizeBranding({ welcome: 'x'.repeat(181) }));
  assert.throws(() => normalizeBranding([]));
  const huge = Buffer.from(png.split(',')[1], 'base64'); huge.writeUInt32BE(100000, 16);
  assert.throws(() => normalizeBranding({ logo: 'data:image/png;base64,' + huge.toString('base64') }));
});
