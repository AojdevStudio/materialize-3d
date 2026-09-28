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

// Polyfill DOMMatrix for test environments (needed by pdfjs-dist via pi-web-ui)
if (typeof globalThis.DOMMatrix === 'undefined') {
  globalThis.DOMMatrix = class DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
    m11 = 1; m12 = 0; m13 = 0; m14 = 0
    m21 = 0; m22 = 1; m23 = 0; m24 = 0
    m31 = 0; m32 = 0; m33 = 1; m34 = 0
    m41 = 0; m42 = 0; m43 = 0; m44 = 1
    is2D = true
    isIdentity = true
    inverse() { return new DOMMatrix() }
    multiply() { return new DOMMatrix() }
    scale() { return new DOMMatrix() }
    translate() { return new DOMMatrix() }
    transformPoint() { return { x: 0, y: 0, z: 0, w: 1 } }
  } as any
}
