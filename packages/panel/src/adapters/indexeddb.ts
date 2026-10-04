import { applyFindOptions, COLLECTIONS, type CollectionName, type FindOptions, type Store } from '../ports';

/**
 * Terminal: IndexedDB store for the standalone browser demo.
 * This is NOT the production path. The shop server (SQLite) is. Transactions here are pass-through,
 * so a browser crash mid-instruction can leave a partial change.
 */
export function createIndexedDbStore(dbName = 'cake-pos'): Store {
  let dbPromise: Promise<IDBDatabase> | null = null;

  const open = () =>
    (dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName, 3);
      req.onupgradeneeded = () => {
        for (const c of COLLECTIONS) {
          if (!req.result.objectStoreNames.contains(c)) req.result.createObjectStore(c, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));

  const run = async <T>(c: CollectionName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(c, mode).objectStore(c));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  };

  const list = <T extends { id: string }>(c: CollectionName) => run<T[]>(c, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);

  return {
    get: <T extends { id: string }>(c: CollectionName, id: string) => run<T | undefined>(c, 'readonly', (s) => s.get(id) as IDBRequest<T | undefined>),
    put: async (c, record) => {
      await run(c, 'readwrite', (s) => s.put(JSON.parse(JSON.stringify(record))));
    },
    delete: async (c, id) => {
      await run(c, 'readwrite', (s) => s.delete(id));
    },
    list,
    find: async <T extends { id: string }>(c: CollectionName, options?: FindOptions) => applyFindOptions(await list<T>(c), options),
    transaction: (fn) => fn(),
  };
}
