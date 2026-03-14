// Message helpers for the content script ↔ service worker protocol.
// busyEvent — builds the busy-state change message sent from content_script to SW,
// which the SW translates into a firmware state.set command.

export function busyEvent(busy) {
  return {
    type: 'busy.changed',
    ts: Date.now(),
    busy: Boolean(busy)
  };
}
