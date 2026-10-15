// IndexedDB key/value store. DB "bayt", store "kv". The service worker reads the
// key "token" from here, so do not rename it.
let _db: Promise<IDBDatabase> | undefined;

function idb(): Promise<IDBDatabase> {
  if (_db) return _db;
  _db = new Promise((res, rej) => {
    const r = indexedDB.open("bayt", 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore("kv");
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => {
      _db = undefined;
      rej(r.error);
    };
  });
  return _db;
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return idb().then(
    (db) =>
      new Promise<T | undefined>((res, rej) => {
        const t = db.transaction("kv", mode);
        const req = fn(t.objectStore("kv"));
        t.oncomplete = () => res(req ? req.result : undefined);
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error);
      }),
  );
}

export const kvGet = <T = unknown>(k: string): Promise<T | undefined> => tx<T>("readonly", (s) => s.get(k) as IDBRequest<T>);
export const kvSet = (k: string, v: unknown): Promise<void> => tx("readwrite", (s) => { s.put(v, k); }).then(() => undefined);
export const kvDel = (k: string): Promise<void> => tx("readwrite", (s) => { s.delete(k); }).then(() => undefined);

/** Delete every key starting with `prefix` (string keys only). */
export const kvDelPrefix = (prefix: string): Promise<void> =>
  tx("readwrite", (s) => {
    s.delete(IDBKeyRange.bound(prefix, prefix + "\uffff"));
  }).then(() => undefined);
