import { assertIsolationSupported } from '../config/defaults.js';
import { ErrorCode, JSONSQLiteError } from '../errors.js';
import type { Document, IsolationLevel } from '../types/index.js';
import type { DocumentStore } from '../storage/DocumentStore.js';

interface WriteTransaction {
  id: number;
  isolationLevel: 'READ_COMMITTED';
  status: 'active' | 'committed' | 'aborted';
  touched: Set<string>;
}

export type CommitResult =
  | { kind: 'snapshot'; touched: string[] }
  | { kind: 'write'; touched: string[] };

/**
 * One write transaction (READ_COMMITTED) plus any number of
 * REPEATABLE_READ snapshots. Snapshots do not see commits after begin.
 * Write transactions are not nested. Snapshots are read-only.
 */
export class TransactionManager {
  private nextId = 1;
  private writeTx: WriteTransaction | null = null;
  private readonly snapshots = new Map<number, Map<string, Map<string, Document>>>();

  constructor(private readonly store: DocumentStore) {}

  get active(): { id: number; touched: Set<string> } | null {
    if (!this.writeTx || this.writeTx.status !== 'active') return null;
    return { id: this.writeTx.id, touched: this.writeTx.touched };
  }

  begin(isolationLevel: IsolationLevel = 'READ_COMMITTED'): number {
    assertIsolationSupported(isolationLevel);
    if (isolationLevel === 'REPEATABLE_READ') {
      const id = this.nextId++;
      this.snapshots.set(id, new Map());
      return id;
    }
    if (this.writeTx?.status === 'active') {
      throw new JSONSQLiteError(
        ErrorCode.TX_NESTED,
        'Nested write transactions are not supported',
      );
    }
    const id = this.nextId++;
    this.writeTx = {
      id,
      isolationLevel: 'READ_COMMITTED',
      status: 'active',
      touched: new Set(),
    };
    return id;
  }

  captureSnapshot(
    id: number,
    collections: Map<string, Map<string, Document>>,
  ): void {
    if (!this.snapshots.has(id)) {
      throw new JSONSQLiteError(ErrorCode.TX_NOT_FOUND, `Transaction not found: ${id}`);
    }
    this.snapshots.set(id, collections);
  }

  isSnapshot(id: number): boolean {
    return this.snapshots.has(id);
  }

  snapshotDocs(id: number, collection: string): Document[] {
    const snap = this.snapshots.get(id);
    if (!snap) {
      throw new JSONSQLiteError(ErrorCode.TX_NOT_FOUND, `Transaction not found: ${id}`);
    }
    const map = snap.get(collection);
    if (!map) return [];
    return [...map.values()].map((d) => ({ ...d }));
  }

  snapshotGet(id: number, collection: string, docId: string): Document | undefined {
    const snap = this.snapshots.get(id);
    if (!snap) {
      throw new JSONSQLiteError(ErrorCode.TX_NOT_FOUND, `Transaction not found: ${id}`);
    }
    const doc = snap.get(collection)?.get(docId);
    return doc ? { ...doc } : undefined;
  }

  async touch(collection: string): Promise<void> {
    const tx = this.requireWrite();
    if (tx.touched.has(collection)) return;
    await this.store.ensureLoaded(collection);
    tx.touched.add(collection);
  }

  async commit(txId?: number): Promise<CommitResult> {
    if (txId !== undefined && this.snapshots.has(txId)) {
      this.snapshots.delete(txId);
      return { kind: 'snapshot', touched: [] };
    }
    const tx = this.requireWrite();
    if (txId !== undefined && tx.id !== txId) {
      throw new JSONSQLiteError(ErrorCode.TX_NOT_FOUND, `Transaction not found: ${txId}`);
    }
    const touched = [...tx.touched];
    await this.store.commitCollections(touched);
    tx.status = 'committed';
    this.writeTx = null;
    return { kind: 'write', touched };
  }

  async rollback(txId?: number): Promise<void> {
    if (txId !== undefined && this.snapshots.has(txId)) {
      this.snapshots.delete(txId);
      return;
    }
    if (!this.writeTx || this.writeTx.status !== 'active') {
      if (txId !== undefined) {
        throw new JSONSQLiteError(ErrorCode.TX_NOT_FOUND, `Transaction not found: ${txId}`);
      }
      return;
    }
    const tx = this.writeTx;
    if (txId !== undefined && tx.id !== txId) {
      throw new JSONSQLiteError(ErrorCode.TX_NOT_FOUND, `Transaction not found: ${txId}`);
    }
    for (const name of tx.touched) {
      await this.store.reloadFromDisk(name);
    }
    tx.status = 'aborted';
    this.writeTx = null;
  }

  private requireWrite(): WriteTransaction {
    if (!this.writeTx || this.writeTx.status !== 'active') {
      throw new JSONSQLiteError(ErrorCode.TX_NOT_FOUND, 'No active transaction');
    }
    return this.writeTx;
  }
}
