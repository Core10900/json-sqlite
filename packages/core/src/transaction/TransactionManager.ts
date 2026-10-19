import { coerceIsolation } from '../config/defaults.js';
import { ErrorCode, JSONSQLiteError } from '../errors.js';
import type { Document, IsolationLevel } from '../types/index.js';
import type { DocumentStore } from '../storage/DocumentStore.js';

interface TxSnapshot {
  collections: Map<string, Map<string, Document>>;
}

interface Transaction {
  id: number;
  isolationLevel: IsolationLevel;
  status: 'active' | 'committed' | 'aborted';
  touched: Set<string>;
  snapshot: TxSnapshot;
}

/**
 * Single-level transactions (no nesting in v1).
 * Active tx buffers mutations in memory; commit persists; rollback restores snapshot.
 */
export class TransactionManager {
  private nextId = 1;
  private current: Transaction | null = null;

  constructor(private readonly store: DocumentStore) {}

  get active(): { id: number; touched: Set<string> } | null {
    if (!this.current || this.current.status !== 'active') return null;
    return { id: this.current.id, touched: this.current.touched };
  }

  begin(isolationLevel: IsolationLevel = 'READ_COMMITTED'): number {
    if (this.current?.status === 'active') {
      throw new JSONSQLiteError(
        ErrorCode.TX_NESTED,
        'Nested transactions are not supported in v1',
      );
    }
    const effective = coerceIsolation(isolationLevel);
    if (effective !== isolationLevel) {
      console.warn(
        `[jsonsqlite] isolation ${isolationLevel} is not implemented; using READ_COMMITTED`,
      );
    }
    const id = this.nextId++;
    this.current = {
      id,
      isolationLevel: effective,
      status: 'active',
      touched: new Set(),
      snapshot: { collections: new Map() },
    };
    return id;
  }

  /** Call before mutating a collection inside a transaction */
  async touch(collection: string): Promise<void> {
    const tx = this.requireActive();
    if (tx.touched.has(collection)) return;
    await this.store.ensureLoaded(collection);
    const docs = this.store.getAll(collection);
    const map = new Map<string, Document>();
    for (const d of docs) map.set(d._id, { ...d });
    tx.snapshot.collections.set(collection, map);
    tx.touched.add(collection);
  }

  async commit(txId?: number): Promise<void> {
    const tx = this.requireActive();
    if (txId !== undefined && tx.id !== txId) {
      throw new JSONSQLiteError(ErrorCode.TX_NOT_FOUND, `Transaction not found: ${txId}`);
    }
    await this.store.commitCollections([...tx.touched]);
    tx.status = 'committed';
    this.current = null;
  }

  async rollback(txId?: number): Promise<void> {
    if (!this.current || this.current.status !== 'active') {
      if (txId !== undefined) {
        throw new JSONSQLiteError(ErrorCode.TX_NOT_FOUND, `Transaction not found: ${txId}`);
      }
      return;
    }
    const tx = this.current;
    if (txId !== undefined && tx.id !== txId) {
      throw new JSONSQLiteError(ErrorCode.TX_NOT_FOUND, `Transaction not found: ${txId}`);
    }
    this.store.restoreSnapshot(tx.snapshot.collections);
    tx.status = 'aborted';
    this.current = null;
  }

  private requireActive(): Transaction {
    if (!this.current || this.current.status !== 'active') {
      throw new JSONSQLiteError(ErrorCode.TX_NOT_FOUND, 'No active transaction');
    }
    return this.current;
  }
}
