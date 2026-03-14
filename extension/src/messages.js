// Shared message helpers used by both content_script.js and service_worker.js:
// buildDomSummary — serialises a page's DOM into a compact snapshot object,
// busyEvent — builds the busy-state change message sent from content script to SW.
export function buildDomSummary(documentLike, href) {
  const title = documentLike.title || '';
  const activeTag = documentLike.activeElement?.tagName || null;
  const activeId = documentLike.activeElement?.id || null;

  const actionable = Array.from(documentLike.querySelectorAll('a,button,input,select,textarea,[role="button"]'))
    .slice(0, 50)
    .map((el, index) => ({
      idx: index,
      tag: el.tagName,
      id: el.id || '',
      text: (el.innerText || el.value || '').toString().trim().slice(0, 120)
    }));

  return {
    type: 'dom.summary',
    ts: Date.now(),
    url: href,
    title,
    focus: { tag: activeTag, id: activeId },
    actionable
  };
}

export function busyEvent(busy) {
  return {
    type: 'busy.changed',
    ts: Date.now(),
    busy: Boolean(busy)
  };
}
