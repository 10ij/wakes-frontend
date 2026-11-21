import type { QuadCorners } from '../utils/docalignerMath';

/**
 * IndexedDB persistence layer for wakes ("wakes-scanner-db").
 *
 * Architecture note (iOS WebKit safety):
 * We store page metadata (`pages`) and JPEG binary blobs (`pageBlobs`) in separate
 * object stores. That way, deleting or reordering pages only updates tiny metadata
 * records and NEVER re-puts existing `Blob` handles in the same transaction (which
 * avoids an iOS WebKit bug that can invalidate Blob reads after re-put).
 */

const DB_NAME = 'wakes-scanner-db';
const DB_VERSION = 2;
const PAGES_STORE = 'pages';
const BLOBS_STORE = 'pageBlobs';
const DRAFT_STORE = 'draftSource';
const DRAFT_KEY = 'latest';

export interface PageMetaRecord {
  id: string;
  order: number;
  width: number;
  height: number;
  createdAt: number;
  confidence: number;
  corners: QuadCorners;
}

export interface SavedPageRecord extends PageMetaRecord {
  blob: Blob;
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

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = request.transaction;

      if (!db.objectStoreNames.contains(PAGES_STORE)) {
        const store = db.createObjectStore(PAGES_STORE, { keyPath: 'id' });
        store.createIndex('order', 'order', { unique: false });
      }
      if (!db.objectStoreNames.contains(BLOBS_STORE)) {
        db.createObjectStore(BLOBS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(DRAFT_STORE)) {
        db.createObjectStore(DRAFT_STORE, { keyPath: 'key' });
      }

      // Migrate v1 inline blobs out into `pageBlobs` cleanly
      if (event.oldVersion > 0 && event.oldVersion < 2 && tx) {
        const metaStore = tx.objectStore(PAGES_STORE);
        const blobStore = tx.objectStore(BLOBS_STORE);
        const getReq = metaStore.getAll();
        getReq.onsuccess = () => {
          const rows = (getReq.result || []) as Array<PageMetaRecord & { blob?: Blob }>;
          for (const row of rows) {
            if (row.blob) {
              blobStore.put({ id: row.id, blob: row.blob });
              const { blob: _removed, ...metaOnly } = row;
              metaStore.put(metaOnly);
            }
          }
        };
      }
    };

    request.onsuccess = () => {
      const db = request.result;
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
 * Ask the browser for persistent storage so iOS Safari is less likely to evict saved pages.
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
  const tx = db.transaction([PAGES_STORE, BLOBS_STORE], 'readonly');
  const metaStore = tx.objectStore(PAGES_STORE);
  const blobStore = tx.objectStore(BLOBS_STORE);

  const [metas, blobEntries] = await Promise.all([
    reqPromise(metaStore.getAll() as IDBRequest<Array<PageMetaRecord & { blob?: Blob }>>),
    reqPromise(blobStore.getAll() as IDBRequest<Array<{ id: string; blob: Blob }>>),
  ]);
  await txDone(tx);

  const blobMap = new Map<string, Blob>();
  for (const entry of blobEntries) {
    blobMap.set(entry.id, entry.blob);
  }

  const combined: SavedPageRecord[] = [];
  for (const m of metas) {
    const blob = blobMap.get(m.id) ?? m.blob;
    if (!blob) continue;
    combined.push({
      id: m.id,
      order: m.order,
      width: m.width,
      height: m.height,
      createdAt: m.createdAt,
      confidence: m.confidence,
      corners: m.corners,
      blob,
    });
  }

  return combined.sort((a, b) => a.order - b.order);
}

/**
 * Append a new processed page to the end of the book with a strictly higher `order` value.
 */
export async function addPage(
  page: Omit<SavedPageRecord, 'order'>
): Promise<SavedPageRecord> {
  const db = await openDb();
  const tx = db.transaction([PAGES_STORE, BLOBS_STORE], 'readwrite');
  const metaStore = tx.objectStore(PAGES_STORE);
  const blobStore = tx.objectStore(BLOBS_STORE);

  const existing = await reqPromise(metaStore.getAll() as IDBRequest<PageMetaRecord[]>);
  let maxOrder = 0;
  for (const item of existing) {
    if (item.order > maxOrder) maxOrder = item.order;
  }

  const { blob, ...meta } = page;
  const metaRecord: PageMetaRecord = {
    ...meta,
    order: maxOrder + 1,
  };

  metaStore.put(metaRecord);
  blobStore.put({ id: page.id, blob });
  await txDone(tx);

  return { ...metaRecord, blob };
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
  const tx = db.transaction([PAGES_STORE, BLOBS_STORE], 'readwrite');
  const metaStore = tx.objectStore(PAGES_STORE);
  const blobStore = tx.objectStore(BLOBS_STORE);

  const existing = await reqPromise(metaStore.get(id) as IDBRequest<PageMetaRecord | undefined>);
  if (!existing) {
    await txDone(tx);
    return null;
  }

  const updatedMeta: PageMetaRecord = {
    ...existing,
    width: updates.width,
    height: updates.height,
    corners: updates.corners,
    confidence: updates.confidence,
  };

  metaStore.put(updatedMeta);
  blobStore.put({ id, blob: updates.blob });
  await txDone(tx);

  return { ...updatedMeta, blob: updates.blob };
}

/**
 * Delete a single page and normalize remaining `order` indices sequentially (1..N)
 * without touching existing page blobs.
 */
export async function deletePage(id: string): Promise<PageMetaRecord[]> {
  const db = await openDb();
  const tx = db.transaction([PAGES_STORE, BLOBS_STORE], 'readwrite');
  const metaStore = tx.objectStore(PAGES_STORE);
  const blobStore = tx.objectStore(BLOBS_STORE);

  metaStore.delete(id);
  blobStore.delete(id);

  const remaining = await reqPromise(metaStore.getAll() as IDBRequest<PageMetaRecord[]>);
  remaining.sort((a, b) => a.order - b.order);
  remaining.forEach((item, index) => {
    const nextOrder = index + 1;
    if (item.order !== nextOrder) {
      item.order = nextOrder;
      metaStore.put(item);
    }
  });

  await txDone(tx);
  return remaining;
}

/**
 * Move a page up (`direction = -1`) or down (`direction = 1`) atomically inside one transaction,
 * updating only metadata order indices without touching blobs.
 */
export async function movePage(
  id: string,
  direction: -1 | 1
): Promise<PageMetaRecord[]> {
  const db = await openDb();
  const tx = db.transaction(PAGES_STORE, 'readwrite');
  const metaStore = tx.objectStore(PAGES_STORE);

  const all = await reqPromise(metaStore.getAll() as IDBRequest<PageMetaRecord[]>);
  all.sort((a, b) => a.order - b.order);

  const idx = all.findIndex((p) => p.id === id);
  const targetIdx = idx + direction;
  if (idx === -1 || targetIdx < 0 || targetIdx >= all.length) {
    await txDone(tx);
    return all;
  }

  const temp = all[idx];
  all[idx] = all[targetIdx];
  all[targetIdx] = temp;

  all.forEach((item, i) => {
    item.order = i + 1;
    metaStore.put(item);
  });

  await txDone(tx);
  return all;
}

/**
 * Save the single latest bounded working source strictly in IndexedDB (never React state).
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
 * Read back the single `draftSource` record only when the user asks to adjust corners.
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
 * Clear ALL pages, blobs, and draft source ("New Book / Clear All").
 */
export async function clearAllBookData(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([PAGES_STORE, BLOBS_STORE, DRAFT_STORE], 'readwrite');
  tx.objectStore(PAGES_STORE).clear();
  tx.objectStore(BLOBS_STORE).clear();
  tx.objectStore(DRAFT_STORE).clear();
  await txDone(tx);
}
