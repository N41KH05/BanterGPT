// Tiny event emitter that works in both Node and the browser,
// so the engine can run on a server or directly in a visitor's tab.

export class Emitter {
  #handlers = new Map();

  on(type, fn) {
    if (!this.#handlers.has(type)) this.#handlers.set(type, new Set());
    this.#handlers.get(type).add(fn);
    return this;
  }

  off(type, fn) {
    this.#handlers.get(type)?.delete(fn);
    return this;
  }

  emit(type, data) {
    for (const fn of this.#handlers.get(type) || []) fn(data);
  }
}
