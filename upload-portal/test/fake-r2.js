// A tiny in-memory stand-in for Cloudflare R2, enough for the tests.
export class FakeR2 {
  constructor() { this.store = new Map(); }
  async put(key, value, opts = {}) {
    let bytes;
    if (typeof value === "string") bytes = new TextEncoder().encode(value);
    else bytes = new Uint8Array(value);
    this.store.set(key, { bytes, opts });
  }
  async get(key) {
    const o = this.store.get(key);
    if (!o) return null;
    return {
      json: async () => JSON.parse(new TextDecoder().decode(o.bytes)),
      arrayBuffer: async () => o.bytes.buffer.slice(o.bytes.byteOffset, o.bytes.byteOffset + o.bytes.length),
      body: o.bytes,
    };
  }
  async delete(keys) { for (const k of [].concat(keys)) this.store.delete(k); }
  async list({ prefix = "", delimiter } = {}) {
    const objects = [];
    const prefixes = new Set();
    for (const [k, o] of [...this.store].sort()) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      if (delimiter && rest.includes(delimiter)) prefixes.add(prefix + rest.slice(0, rest.indexOf(delimiter) + 1));
      else objects.push({ key: k, size: o.bytes.length });
    }
    return { objects, delimitedPrefixes: [...prefixes], truncated: false };
  }
}
