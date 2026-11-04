import { assertIsolationSupported } from '../config/defaults.js';
import { ErrorCode, JSONSQLiteError } from '../errors.js';
import { docKey } from '../storage/multiLock.js';
import type { Document, IsolationLevel } from '../types/index.js';
import type { DocumentStore } from '../storage/DocumentStore.js';

export interface WriteIntent {
  collection: string;
  id: string;
  op: 'insert' | 'update' | 'delete';
  baseVersion: number;
  after: Document | null;
}

interface SavepointMark {
  name: string;
  intentLength: number;
  docs: Map<string, Document[]>;
}

interface WriteTransaction {
  id: number;
  isolationLevel: 'READ_COMMITTED' | 'SERIALIZABLE';
  status: 'active' | 'committed' | 'aborted';
  touched: Set<string>;
  intents: WriteIntent[];
  reads: Map<string, number>;
  savepoints: SavepointMark[];
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

  constructor(
    private readonly store: DocumentStore,
    private readonly serializable = false,
  ) {}

  get active(): { id: number; touched: Set<string> } | null {
    if (!this.writeTx || this.writeTx.status !== 'active') return null;
    return { id: this.writeTx.id, touched: this.writeTx.touched };
  }

  begin(isolationLevel: IsolationLevel = 'READ_COMMITTED'): number {
    if (!(isolationLevel === 'SERIALIZABLE' && this.serializable)) {
      assertIsolationSupported(isolationLevel);
    }
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
      isolationLevel: isolationLevel === 'SERIALIZABLE' ? 'SERIALIZABLE' : 'READ_COMMITTED',
      status: 'active',
      touched: new Set(),
      intents: [],
      reads: new Map(),
      savepoints: [],
    };
    return id;
  }

  isolation(): 'READ_COMMITTED' | 'SERIALIZABLE' | null {
    if (!this.writeTx || this.writeTx.status !== 'active') return null;
    return this.writeTx.isolationLevel;
  }

  noteIntent(intent: WriteIntent): void {
    const tx = this.requireWrite();
    tx.intents.push({
      ...intent,
      after: intent.after ? { ...intent.after } : null,
    });
  }

  noteRead(collection: string, id: string, version: number): void {
    const tx = this.writeTx;
    if (!tx || tx.status !== 'active' || tx.isolationLevel !== 'SERIALIZABLE') return;
    const key = docKey(collection, id);
    if (!tx.reads.has(key)) tx.reads.set(key, version);
  }

  exportWrite(txId?: number): { intents: WriteIntent[]; reads: Map<string, number> } {
    const tx = this.requireWrite();
    if (txId !== undefined && tx.id !== txId) {
      throw new JSONSQLiteError(ErrorCode.TX_NOT_FOUND, `Transaction not found: ${txId}`);
    }
    return {
      intents: tx.intents.map((intent) => ({
        ...intent,
        after: intent.after ? { ...intent.after } : null,
      })),
      reads: new Map(tx.reads),
    };
  }

  finishCommitted(txId?: number): void {
    const tx = this.requireWrite();
    if (txId !== undefined && tx.id !== txId) {
      throw new JSONSQLiteError(ErrorCode.TX_NOT_FOUND, `Transaction not found: ${txId}`);
    }
    tx.status = 'committed';
    this.writeTx = null;
  }

  markSavepoint(name: string, docs: Map<string, Document[]>): void {
    const tx = this.requireWrite();
    if (tx.savepoints.some((mark) => mark.name === name)) {
      throw new JSONSQLiteError(ErrorCode.INVALID_CONFIG, `Savepoint already exists: ${name}`);
    }
    tx.savepoints.push({ name, intentLength: tx.intents.length, docs });
  }

  rollbackSavepoint(name: string): Map<string, Document[]> {
    const tx = this.requireWrite();
    const index = tx.savepoints.findIndex((mark) => mark.name === name);
    if (index < 0) {
      throw new JSONSQLiteError(ErrorCode.TX_NOT_FOUND, `Savepoint not found: ${name}`);
    }
    const mark = tx.savepoints[index]!;
    tx.intents.length = mark.intentLength;
    tx.savepoints.length = index;
    return mark.docs;
  }

  releaseSavepoint(name: string): void {
    const tx = this.requireWrite();
    const index = tx.savepoints.findIndex((mark) => mark.name === name);
    if (index < 0) {
      throw new JSONSQLiteError(ErrorCode.TX_NOT_FOUND, `Savepoint not found: ${name}`);
    }
    tx.savepoints.splice(index, 1);
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
