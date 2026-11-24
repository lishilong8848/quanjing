import type { PublicationPreview, PublicationSubmissionMode } from './api';

export type PublicationDraft = {
  link: string;
  files: File[];
  groupIds: string[];
  recipientText: string;
  preview: PublicationPreview | null;
  fieldEdits: Record<string, { name: string; value: string }>;
  schemaStale: boolean;
  pendingRequestId: string | null;
  pendingMode?: PublicationSubmissionMode;
};

type StoredDraft = Omit<PublicationDraft, 'files'> & {
  files: Array<{ blob: Blob; name: string; lastModified: number }>;
};

const STORE = 'drafts';
let database: Promise<IDBDatabase> | undefined;

function openDrafts() {
  if (!database) {
    database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('nantong-file-publication', 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); database = undefined; };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Draft storage is blocked'));
    }).catch(error => {
      database = undefined;
      throw error;
    });
  }
  return database;
}

function fromStorage(draft: StoredDraft | undefined): PublicationDraft | null {
  if (!draft) return null;
  return {
    ...draft,
    files: draft.files.map(file => new File([file.blob], file.name, { type: file.blob.type, lastModified: file.lastModified })),
  };
}

export async function readPublicationDraft(accountId: string): Promise<PublicationDraft | null> {
  const db = await openDrafts();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).get(accountId);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      try { resolve(fromStorage(request.result)); } catch (error) { reject(error); }
    };
  });
}

// A draft already being submitted can only be changed or removed by that same request.
export async function updatePublicationDraft(
  accountId: string, draft: PublicationDraft | null, expectedRequestId: string | null = null,
): Promise<{ saved: true } | { saved: false; draft: PublicationDraft | null }> {
  const db = await openDrafts();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    const read = store.get(accountId);
    let result: { saved: true } | { saved: false; draft: PublicationDraft | null } = { saved: true };
    transaction.onabort = () => reject(transaction.error);
    transaction.oncomplete = () => resolve(result);
    read.onsuccess = () => {
      const current = read.result as StoredDraft | undefined;
      if ((current?.pendingRequestId ?? null) !== expectedRequestId) {
        try { result = { saved: false, draft: fromStorage(current) }; } catch (error) { reject(error); }
        return;
      }
      if (draft) {
        // Keep the original filename and timestamp even in browsers that clone a file as a Blob.
        const stored: StoredDraft = {
          ...draft,
          files: draft.files.map(file => ({ blob: file.slice(0, file.size, file.type), name: file.name, lastModified: file.lastModified })),
        };
        store.put(stored, accountId);
      } else {
        store.delete(accountId);
      }
    };
  });
}
