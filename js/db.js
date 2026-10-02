/* Track storage: metadata + audio blobs in IndexedDB, with an in-memory fallback
   (e.g. private browsing modes where IndexedDB is unavailable). */
const Store = (() => {
  const DB_NAME = 'neumorph-music';
  const DB_VERSION = 1;
  let db = null;
  const mem = { tracks: new Map(), files: new Map() };

  const request = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  const complete = (tx) => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });

  async function open() {
    try {
      if (!('indexedDB' in window)) throw new Error('IndexedDB not supported');
      db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains('tracks')) d.createObjectStore('tracks', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      console.warn('IndexedDB unavailable, tracks will only live in memory.', err);
      db = null;
    }
    return !!db;
  }

  async function all() {
    if (!db) return [...mem.tracks.values()];
    return request(db.transaction('tracks').objectStore('tracks').getAll());
  }

  async function add(meta, blob) {
    if (!db) { mem.tracks.set(meta.id, meta); mem.files.set(meta.id, blob); return; }
    const tx = db.transaction(['tracks', 'files'], 'readwrite');
    tx.objectStore('files').put(blob, meta.id);
    tx.objectStore('tracks').put(meta);
    return complete(tx);
  }

  async function update(meta) {
    if (!db) { mem.tracks.set(meta.id, meta); return; }
    const tx = db.transaction('tracks', 'readwrite');
    tx.objectStore('tracks').put(meta);
    return complete(tx);
  }

  async function file(id) {
    if (!db) return mem.files.get(id) || null;
    return (await request(db.transaction('files').objectStore('files').get(id))) || null;
  }

  async function remove(id) {
    if (!db) { mem.tracks.delete(id); mem.files.delete(id); return; }
    const tx = db.transaction(['tracks', 'files'], 'readwrite');
    tx.objectStore('tracks').delete(id);
    tx.objectStore('files').delete(id);
    return complete(tx);
  }

  async function clear() {
    if (!db) { mem.tracks.clear(); mem.files.clear(); return; }
    const tx = db.transaction(['tracks', 'files'], 'readwrite');
    tx.objectStore('tracks').clear();
    tx.objectStore('files').clear();
    return complete(tx);
  }

  return {
    open, all, add, update, file, remove, clear,
    get persistent() { return !!db; },
  };
})();
