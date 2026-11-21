import type { QuadCorners } from '../utils/docalignerMath';

/**
 * IndexedDB persistence layer for wakes ("wakes-scanner-db").
 *
 * Stores two object stores:
 * 1. `pages`: Finalized, cropped ~2400px JPEG blobs ordered by a monotonic `order` field.
 * 2. `draftSource`: At most ONE bounded working photo (<=2600px) kept ONLY in IndexedDB
 *    (never in React state) so the user can tap "Adjust corners" on the post-save toast
 *    without keeping large raw image buffers in JS memory.
 */

const DB_NAME = 'wakes-scanner-db';
const DB_VERSION = 1;
const PAGES_STORE = 'pages';
const DRAFT_STORE = 'draftSource';
const DRAFT_KEY = 'latest';

export interface SavedPageRecord {
  id: string;
  order: number;
  blob: Blob;
  width: number;
  height: number;
  createdAt: number;
  confidence: number;
  corners: QuadCorners;
}

export interface DraftSourceRecord {
  key: string;
  targetPageId: string | null;
  blob: Blob;
  workingWidth: number;
  workingHeight: number;
  corners: QuadCorners;
  confidence: number;
  updatedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PAGES_STORE)) {
        const store = db.createObjectStore(PAGES_STORE, { keyPath: 'id' });
        store.createIndex('order', 'order', { unique: false });
      }
      if (!db.objectStoreNames.contains(DRAFT_STORE)) {
        db.createObjectStore(DRAFT_STORE, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      // Handle versionchange cleanly if another tab upgrades
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };

    request.onerror = () => {
      dbPromise = null;
      reject(request.error ?? new Error('Failed to open IndexedDB'));
    };
  });

  return dbPromise;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function reqPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

/**
 * Ask the browser for persistent storage so iOS Safari is less likely to evict saved pages
 * when disk space gets tight or after long background periods.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) {
    return false;
  }
  try {
    const already = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    if (already) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/**
 * Load all saved pages sorted by monotonic `order` ascending.
 */
export async function getAllPages(): Promise<SavedPageRecord[]> {
  const db = await openDb();
  const tx = db.transaction(PAGES_STORE, 'readonly');
  const store = tx.objectStore(PAGES_STORE);
  const all = await reqPromise(store.getAll() as IDBRequest<SavedPageRecord[]>);
  await txDone(tx);
  return all.sort((a, b) => a.order - b.order);
}

/**
 * Append a new processed page to the end of the book with a strictly higher `order` value.
 */
export async function addPage(
  page: Omit<SavedPageRecord, 'order'>
): Promise<SavedPageRecord> {
  const db = await openDb();
  const tx = db.transaction(PAGES_STORE, 'readwrite');
  const store = tx.objectStore(PAGES_STORE);
  const existing = await reqPromise(store.getAll() as IDBRequest<SavedPageRecord[]>);

  let maxOrder = 0;
  for (const item of existing) {
    if (item.order > maxOrder) maxOrder = item.order;
  }

  const record: SavedPageRecord = {
    ...page,
    order: maxOrder + 1,
  };
  store.put(record);
  await txDone(tx);
  return record;
}

/**
 * Replace the image blob, dimensions, and corners of an existing page (used after
 * the user taps "Adjust corners" on the post-save toast).
 */
export async function updatePageImage(
  id: string,
  updates: Pick<SavedPageRecord, 'blob' | 'width' | 'height' | 'corners' | 'confidence'>
): Promise<SavedPageRecord | null> {
  const db = await openDb();
  const tx = db.transaction(PAGES_STORE, 'readwrite');
  const store = tx.objectStore(PAGES_STORE);
  const existing = await reqPromise(store.get(id) as IDBRequest<SavedPageRecord | undefined>);
  if (!existing) {
    await txDone(tx);
    return null;
  }
  const updated: SavedPageRecord = {
    ...existing,
    ...updates,
  };
  store.put(updated);
  await txDone(tx);
  return updated;
}

/**
 * Delete a single page and normalize remaining `order` indices sequentially (1..N).
 */
export async function deletePage(id: string): Promise<SavedPageRecord[]> {
  const db = await openDb();
  const tx = db.transaction(PAGES_STORE, 'readwrite');
  const store = tx.objectStore(PAGES_STORE);
  store.delete(id);
  const remaining = await reqPromise(store.getAll() as IDBRequest<SavedPageRecord[]>);
  remaining.sort((a, b) => a.order - b.order);
  remaining.forEach((item, index) => {
    const nextOrder = index + 1;
    if (item.order !== nextOrder) {
      item.order = nextOrder;
      store.put(item);
    }
  });
  await txDone(tx);
  return remaining;
}

/**
 * Move a page up (`direction = -1`) or down (`direction = 1`) atomically inside one transaction.
 */
export async function movePage(
  id: string,
  direction: -1 | 1
): Promise<SavedPageRecord[]> {
  const db = await openDb();
  const tx = db.transaction(PAGES_STORE, 'readwrite');
  const store = tx.objectStore(PAGES_STORE);
  const all = await reqPromise(store.getAll() as IDBRequest<SavedPageRecord[]>);
  all.sort((a, b) => a.order - b.order);

  const idx = all.findIndex((p) => p.id === id);
  const targetIdx = idx + direction;
  if (idx === -1 || targetIdx < 0 || targetIdx >= all.length) {
    await txDone(tx);
    return all;
  }

  // Swap positions in array and re-assign clean sequential order values
  const temp = all[idx];
  all[idx] = all[targetIdx];
  all[targetIdx] = temp;

  all.forEach((item, i) => {
    item.order = i + 1;
    store.put(item);
  });

  await txDone(tx);
  return all;
}

/**
 * Save the single latest bounded working source strictly in IndexedDB (never React state).
 * Overwrites any previous draft so storage stays bounded to 1 photo.
 */
export async function saveDraftSource(
  draft: Omit<DraftSourceRecord, 'key' | 'updatedAt'>
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(DRAFT_STORE, 'readwrite');
  const store = tx.objectStore(DRAFT_STORE);
  const record: DraftSourceRecord = {
    ...draft,
    key: DRAFT_KEY,
    updatedAt: Date.now(),
  };
  store.put(record);
  await txDone(tx);
}

/**
 * Read back the single `draftSource` record only when the user asks to adjust corners
 * (or when low-confidence triggers manual review).
 */
export async function getDraftSource(): Promise<DraftSourceRecord | null> {
  const db = await openDb();
  const tx = db.transaction(DRAFT_STORE, 'readonly');
  const store = tx.objectStore(DRAFT_STORE);
  const item = await reqPromise(store.get(DRAFT_KEY) as IDBRequest<DraftSourceRecord | undefined>);
  await txDone(tx);
  return item ?? null;
}

/**
 * Clear ALL pages and the temporary draft source ("New Book / Clear All").
 * Never called automatically after PDF export.
 */
export async function clearAllBookData(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([PAGES_STORE, DRAFT_STORE], 'readwrite');
  tx.objectStore(PAGES_STORE).clear();
  tx.objectStore(DRAFT_STORE).clear();
  await txDone(tx);
}
