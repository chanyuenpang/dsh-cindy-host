/** Internal immutable Array view over a sealed prefix and small mutable-version suffix.
 * Array consumers (slice/map/iteration/JSON) retain their existing contract. Reading
 * a tail does not copy or enumerate the prefix; explicit full enumeration still does.
 * The owner must never mutate either input after publication.
 */
export function appendReadonlyRows(prefix, suffix) {
  if (!suffix.length) return prefix;
  const length = prefix.length + suffix.length;
  const indexOf = key => typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < length ? Number(key) : -1;
  const valueAt = index => index < prefix.length ? prefix[index] : suffix[index - prefix.length];
  return new Proxy([], {
    get(target, key, receiver) {
      if (key === 'length') return length;
      const index = indexOf(key);
      return index >= 0 ? valueAt(index) : Reflect.get(target, key, receiver);
    },
    has(target, key) { return indexOf(key) >= 0 || Reflect.has(target, key); },
    ownKeys() { return [...Array.from({ length }, (_, index) => String(index)), 'length']; },
    getOwnPropertyDescriptor(target, key) {
      if (key === 'length') return { value: length, writable: true, enumerable: false, configurable: false };
      const index = indexOf(key);
      return index >= 0 ? { value: valueAt(index), writable: false, enumerable: true, configurable: true }
        : Reflect.getOwnPropertyDescriptor(target, key);
    },
    set() { throw new TypeError('History snapshot rows are read-only'); },
    deleteProperty() { throw new TypeError('History snapshot rows are read-only'); },
    defineProperty() { throw new TypeError('History snapshot rows are read-only'); },
  });
}
