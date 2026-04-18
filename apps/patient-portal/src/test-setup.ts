import "@testing-library/jest-dom/vitest";

// Node 25 exposes a built-in `localStorage` that lacks standard Web Storage
// methods (getItem, setItem, removeItem, clear) when `--localstorage-file` is
// not configured. This shadows the jsdom-provided `window.localStorage`,
// causing "removeItem is not a function" errors. Replace it with a simple
// in-memory implementation so tests behave like a real browser.
const store = new Map<string, string>();

const localStorageMock: Storage = {
  getItem(key: string) {
    return store.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    store.set(key, String(value));
  },
  removeItem(key: string) {
    store.delete(key);
  },
  clear() {
    store.clear();
  },
  get length() {
    return store.size;
  },
  key(index: number) {
    return [...store.keys()][index] ?? null;
  },
};

Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  writable: true,
  configurable: true,
});
