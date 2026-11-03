// Consolidate compatible emitted blocks without rewriting instructions. Their
// import/type layouts are identical and they call only imported functions.
// No guest bytes leave the Worker. Table indices stay stable across packing.
(() => {
  const pending = new Map(),
    entries = new Map();
  const batch = 32;
  const leb = (value) => {
    const bytes = [];
    do {
      const low = value & 127;
      value >>>= 7;
      bytes.push(low | (value ? 128 : 0));
    } while (value);
    return bytes;
  };
  const read = (bytes, cursor) => {
    let value = 0,
      shift = 0;
    while (cursor.at < bytes.length && shift < 35) {
      const v = bytes[cursor.at++];
      value |= (v & 127) << shift;
      if (!(v & 128)) return value >>> 0;
      shift += 7;
    }
    throw new Error('Invalid generated Wasm integer');
  };
  const split = (bytes) => {
    const sections = new Map(),
      cursor = { at: 8 };
    while (cursor.at < bytes.length) {
      const id = bytes[cursor.at++],
        length = read(bytes, cursor);
      if (cursor.at + length > bytes.length)
        throw new Error('Invalid generated Wasm section');
      if (id) sections.set(id, bytes.slice(cursor.at, cursor.at + length));
      cursor.at += length;
    }
    // Restrict packing to the board emitter's single-function modules. Other
    // sections can contain function indices and must not be silently remapped.
    if ([...sections.keys()].some((id) => ![1, 2, 3, 7, 10].includes(id)))
      return null;
    const functions = sections.get(3),
      exports = sections.get(7),
      code = sections.get(10);
    if (!functions || functions[0] !== 1 || !exports || !code || code[0] !== 1)
      return null;
    if (
      exports[0] !== 1 ||
      exports[1] !== 1 ||
      exports[2] !== 102 ||
      exports[3] !== 0
    )
      return null;
    const index = read(exports, { at: 4 });
    const key = [1, 2, 3]
      .map((id) => Array.from(sections.get(id) ?? []).join(','))
      .join('/');
    return { key, sections, index, body: code.slice(1) };
  };
  const pack = (layout, bodies) => {
    const bytes = [0, 97, 115, 109, 1, 0, 0, 0];
    const section = (id, payload) => {
      bytes.push(id, ...leb(payload.length));
      // Avoid argument-count limits for large generated code sections.
      for (const byte of payload) bytes.push(byte);
    };
    section(1, layout.sections.get(1));
    section(2, layout.sections.get(2));
    const types = leb(bodies.length),
      exports = leb(bodies.length),
      code = leb(bodies.length);
    for (let i = 0; i < bodies.length; i++) {
      types.push(...layout.sections.get(3).slice(1));
      const name = Array.from(`f${i}`, (c) => c.charCodeAt(0));
      exports.push(...leb(name.length), ...name, 0, ...leb(layout.index + i));
      for (const byte of bodies[i]) code.push(byte);
    }
    section(3, types);
    section(7, exports);
    section(10, code);
    return new Uint8Array(bytes);
  };
  const retired = (entry) => {
    if (!--entry.owner.references) Module.dynarmicWasmStats.liveModules--;
  };
  Module.xhleCompileBlock = (bytes, imports) => {
    const st = Module.dynarmicWasmStats;
    const layout = split(bytes),
      group = layout ? pending.get(layout.key) : undefined;
    const combine = group && group.entries.length >= batch - 1;
    const source = combine
      ? pack(layout, [...group.entries.map((e) => e.body), layout.body])
      : bytes;
    const t0 = performance.now();
    const mod = new WebAssembly.Module(source);
    const t1 = performance.now();
    const instance = new WebAssembly.Instance(mod, imports);
    const t2 = performance.now();
    const owner = { references: combine ? group.entries.length + 1 : 1 };
    st.liveModules = (st.liveModules || 0) + 1;
    st.peakLiveModules = Math.max(st.peakLiveModules || 0, st.liveModules);
    let fn;
    if (combine) {
      group.entries.forEach((entry, i) => {
        retired(entry);
        removeFunction(entry.slot);
        const slot = addFunction(instance.exports[`f${i}`], 'iii');
        if (slot !== entry.slot)
          throw new Error('JIT function slot changed while packing');
        entry.owner = owner;
        entry.body = null;
        entry.group = null;
      });
      fn = addFunction(instance.exports[`f${group.entries.length}`], 'iii');
      entries.set(fn, { slot: fn, owner, group: null, body: null });
      pending.delete(layout.key);
      st.packedModules = (st.packedModules || 0) + 1;
    } else {
      fn = addFunction(instance.exports.f, 'iii');
      const entry = { slot: fn, owner, group: null, body: null };
      entries.set(fn, entry);
      if (layout) {
        const current = group ?? { key: layout.key, entries: [] };
        if (!group) pending.set(layout.key, current);
        entry.group = current;
        entry.body = layout.body;
        current.entries.push(entry);
      }
    }
    return {
      fn,
      compileMs: t1 - t0,
      instMs: t2 - t1,
      tableMs: performance.now() - t2,
    };
  };
  Module.xhleReleaseBlock = (fn) => {
    const entry = entries.get(fn);
    if (entry) {
      retired(entry);
      if (entry.group) {
        const group = entry.group;
        group.entries.splice(group.entries.indexOf(entry), 1);
        if (!group.entries.length) pending.delete(group.key);
      }
      entries.delete(fn);
    }
    removeFunction(fn);
  };
})();
