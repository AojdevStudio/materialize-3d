// Polyfill ResizeObserver for test environments (needed by @react-three/fiber)
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    callback: ResizeObserverCallback
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}


// jsdom has no Element.scrollTo (needed by assistant-ui's thread auto-scroll)
if (typeof Element !== 'undefined' && !Element.prototype.scrollTo) {
  Element.prototype.scrollTo = function scrollTo() {}
}

// jsdom parses its default stylesheet on the first getComputedStyle in each
// test file, 0.3 to 0.7 s of CPU. Role queries call it, so pay it here, outside
// any test's timeout, where host load cannot turn it into a timeout (#113).
if (typeof window !== 'undefined') {
  window.getComputedStyle(document.body)
}
