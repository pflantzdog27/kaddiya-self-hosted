// The next step the model offers for the composer (see "The next step" in
// prompts/system.md). The model ends its final reply with one line that
// begins with NEXT_MARKER; the console never shows that line. It is held
// back while streaming so it does not flash in the bubble, stripped from the
// stored message, and sent to the browser as its own `suggest` event, where
// it becomes the composer's placeholder and Tab puts it in the box.
//
// It is text for the person to send or ignore. Nothing runs from it.

export const NEXT_MARKER = 'NEXT>>';
const MAX_NEXT_CHARS = 160;

function markerLine(line) {
  const t = line.trim();
  return t.startsWith(NEXT_MARKER) ? t.slice(NEXT_MARKER.length).trim() : null;
}

/** Split a reply into what the user reads and the suggested next step, if its last line carries one. */
export function splitNextStep(text) {
  const s = String(text ?? '');
  const trimmed = s.replace(/\s+$/, '');
  const cut = trimmed.lastIndexOf('\n');
  const last = trimmed.slice(cut + 1);
  const next = markerLine(last);
  if (next === null) return { text: s, next: null };
  return {
    text: cut < 0 ? '' : trimmed.slice(0, cut).replace(/\s+$/, ''),
    next: next ? next.slice(0, MAX_NEXT_CHARS) : null,
  };
}

/**
 * Wraps `emit` for one streamed response: passes text through as it arrives,
 * except a trailing line that is (or may still become) the marker line, which
 * waits until the response ends. `end()` returns the next step, or null.
 */
export function nextStepStream(emit) {
  let held = '';
  const send = (delta) => { if (delta) emit('text', { delta }); };
  return {
    push(delta) {
      held += delta;
      // Trailing whitespace is always held: invisible in markdown, and it is
      // the gap before the marker line when one follows.
      const wsStart = held.search(/\s*$/);
      const body = held.slice(0, wsStart);
      const cut = body.lastIndexOf('\n');
      const tail = body.slice(cut + 1).trimStart();
      const couldBeMarker = tail.length > 0 && (tail.startsWith(NEXT_MARKER) || NEXT_MARKER.startsWith(tail));
      let keepFrom = wsStart;
      if (couldBeMarker) {
        const before = held.slice(0, cut + 1);
        const gap = before.search(/\s+$/);
        keepFrom = gap < 0 ? before.length : gap;
      }
      send(held.slice(0, keepFrom));
      held = held.slice(keepFrom);
    },
    end() {
      const { text, next } = splitNextStep(held);
      held = '';
      send(text);
      return next;
    },
  };
}

/** Remove the marker line from the text blocks of a finished assistant message, in place. */
export function stripNextStep(content) {
  if (!Array.isArray(content)) return null;
  let found = null;
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i];
    if (block?.type !== 'text') continue;
    const { text, next } = splitNextStep(block.text);
    if (next !== null || text !== block.text) { block.text = text; found = next; }
    break;
  }
  return found;
}
