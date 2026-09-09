// The next step the model offers for the composer: the marker line never
// reaches the transcript, even when the stream cuts it mid-token.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitNextStep, nextStepStream, stripNextStep, NEXT_MARKER } from '../server/nextstep.js';

test('splitNextStep takes the marker off the last line only', () => {
  assert.deepEqual(splitNextStep('Two open P1s.\n\nNEXT>> Open INC0010023\n'), { text: 'Two open P1s.', next: 'Open INC0010023' });
  assert.deepEqual(splitNextStep('No marker here.'), { text: 'No marker here.', next: null });
  assert.deepEqual(splitNextStep('NEXT>> mentioned early\nthen prose'), { text: 'NEXT>> mentioned early\nthen prose', next: null });
  assert.deepEqual(splitNextStep('  NEXT>>   '), { text: '', next: null });
  assert.deepEqual(splitNextStep('Done.\n  NEXT>> Prove the capture with sn_update_set_contents'), { text: 'Done.', next: 'Prove the capture with sn_update_set_contents' });
});

function collect() {
  const out = [];
  const s = nextStepStream((event, data) => { assert.equal(event, 'text'); out.push(data.delta); });
  return { s, text: () => out.join('') };
}

test('a streamed reply holds back the marker line however it is chunked', () => {
  const reply = 'Three incidents are open.\n\nThe oldest is INC0010023.\n\nNEXT>> Open INC0010023 and summarize the journal';
  for (const size of [1, 2, 3, 5, 7, 11, 1000]) {
    const { s, text } = collect();
    for (let i = 0; i < reply.length; i += size) s.push(reply.slice(i, i + size));
    const next = s.end();
    assert.equal(next, 'Open INC0010023 and summarize the journal', `chunk ${size}`);
    assert.equal(text(), 'Three incidents are open.\n\nThe oldest is INC0010023.', `chunk ${size}`);
  }
});

test('text that merely starts like the marker is released once it diverges', () => {
  const { s, text } = collect();
  for (const d of ['NE', 'W field', ' added.\nNEX', 'Tflix is not the marker.']) s.push(d);
  assert.equal(s.end(), null);
  assert.equal(text(), 'NEW field added.\nNEXTflix is not the marker.');
});

test('a reply with no marker streams through unchanged', () => {
  const { s, text } = collect();
  s.push('Nothing to add.');
  assert.equal(s.end(), null);
  assert.equal(text(), 'Nothing to add.');
});

test('stripNextStep edits the stored assistant message in place', () => {
  const content = [{ type: 'tool_use', id: 'x' }, { type: 'text', text: `Reply.\n\n${NEXT_MARKER} Check the docs for update set scope` }];
  assert.equal(stripNextStep(content), 'Check the docs for update set scope');
  assert.equal(content[1].text, 'Reply.');
  assert.equal(stripNextStep([{ type: 'text', text: 'plain' }]), null);
});
