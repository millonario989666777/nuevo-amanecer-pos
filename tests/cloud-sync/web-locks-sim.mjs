// Faithful-enough Web Locks (exclusive only) for node:vm harnesses:
// - ifAvailable: callback(null) when the name is held (never queues);
// - otherwise waiters queue FIFO until release;
// - signal: a queued request rejects with AbortError when aborted.
export function webLocks() {
  const held = new Map(); // name -> queue of waiters
  const stats = { granted: 0, unavailable: 0, aborted: 0 };
  function release(name) {
    const queue = held.get(name);
    const next = queue && queue.shift();
    if (next) next(); else held.delete(name);
  }
  async function run(name, callback) {
    stats.granted++;
    try { return await callback({ name, mode: 'exclusive' }); } finally { release(name); }
  }
  return {
    stats,
    held: (name) => held.has(name),
    request(name, options, callback) {
      if (typeof options === 'function') { callback = options; options = {}; }
      options = options || {};
      if (!held.has(name)) { held.set(name, []); return run(name, callback); }
      if (options.ifAvailable) { stats.unavailable++; return Promise.resolve().then(() => callback(null)); }
      return new Promise((resolve, reject) => {
        const signal = options.signal;
        const grant = () => { if (signal) signal.removeEventListener('abort', onAbort); run(name, callback).then(resolve, reject); };
        const onAbort = () => {
          const queue = held.get(name); const at = queue ? queue.indexOf(grant) : -1;
          if (at !== -1) queue.splice(at, 1);
          stats.aborted++;
          const error = new Error('The request was aborted.'); error.name = 'AbortError'; reject(error);
        };
        if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
        held.get(name).push(grant);
      });
    },
  };
}
