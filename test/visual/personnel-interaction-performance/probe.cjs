module.exports = function installProbe() {
  const rows = []; let active;
  window.__uiFeedback = {
    rows,
    arm(description) { if (active && !active.complete) throw Error('Previous sample unfinished'); active = { ...description, events: [], domMs: null, rafMs: null, complete: false }; rows.push(active); },
  };
  function ready(row) {
    const element = document.querySelector('[data-feedback-target]'); if (!element) return false;
    if (row.kind === 'checkbox') return element.getAttribute('aria-checked') === row.expected;
    if (row.kind === 'tab') { const panel = document.getElementById(element.getAttribute('aria-controls')); return element.getAttribute('aria-selected') === 'true' && panel && panel.getBoundingClientRect().height > 0 && getComputedStyle(panel).display !== 'none'; }
    return element.disabled && element.textContent.includes(row.expected);
  }
  for (const type of ['pointerdown', 'pointerup', 'click']) document.addEventListener(type, event => {
    const row = active, target = event.target.closest('[data-feedback-target]'); if (!row || row.complete || !target) return;
    row.events.push({ type, trusted: event.isTrusted, at: performance.now() });
    if (type !== 'pointerdown' || row.start !== undefined) return;
    row.start = performance.now();
    const check = () => { if (row.domMs === null && ready(row)) row.domMs = performance.now() - row.start; };
    const observer = new MutationObserver(check); observer.observe(document.documentElement, { attributes: true, childList: true, subtree: true, characterData: true }); queueMicrotask(check);
    const frame = () => {
      check();
      if (row.domMs !== null && ready(row) && row.events.some(event => event.type === 'click')) { row.rafMs = performance.now() - row.start; row.complete = true; observer.disconnect(); }
      else if (performance.now() - row.start > 1500) { row.complete = true; row.error = 'Feedback missing after 1500ms'; observer.disconnect(); }
      else requestAnimationFrame(frame);
    }; requestAnimationFrame(frame);
  }, true);
};
