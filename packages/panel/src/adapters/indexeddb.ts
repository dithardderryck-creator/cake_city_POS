import { COLLECTIONS, type CollectionName, type Store } from '../ports';

/**
 * Terminal: IndexedDB store for the browser. Each collection is an object store keyed by `id`.
 * Known limitation: intents that write several records are not wrapped in one transaction yet.
 */
export function createIndexedDbStore(dbName = 'cake-pos'): Store {
  let dbPromise: Promise<IDBDatabase> | null = null;

  const open = () =>
    (dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        for (const c of COLLECTIONS) {
          if (!req.result.objectStoreNames.contains(c)) req.result.createObjectStore(c, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));

  const run = async <T>(
    c: CollectionName,
    mode: IDBTransactionMode,
    fn: (s: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(c, mode).objectStore(c));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  };

  return {
    get: <T extends { id: string }>(c: CollectionName, id: string) =>
      run<T | undefined>(c, 'readonly', (s) => s.get(id) as IDBRequest<T | undefined>),
    put: async (c, record) => {
      await run(c, 'readwrite', (s) => s.put(JSON.parse(JSON.stringify(record))));
    },
    list: <T extends { id: string }>(c: CollectionName) =>
      run<T[]>(c, 'readonly', (s) => s.getAll() as IDBRequest<T[]>),
  };
}
