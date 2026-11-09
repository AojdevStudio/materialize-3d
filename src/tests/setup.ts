// jsdom has no ResizeObserver (the studio's ModelView uses it)
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

// jsdom parses its default stylesheet on the first getComputedStyle in each
// test file, 0.3 to 0.7 s of CPU. Role queries call it, so pay it here, outside
// any test's timeout, where host load cannot turn it into a timeout (#113).
if (typeof window !== 'undefined') {
  window.getComputedStyle(document.body)
}

// Node 25 and newer has its own localStorage. Without --localstorage-file it stays undefined and hides jsdom's, so
// tests get an in-memory one.
if (typeof window !== 'undefined' && window.localStorage === undefined) {
  const items = new Map<string, string>()
  const storage: Storage = {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  }
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
}
