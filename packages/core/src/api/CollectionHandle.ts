import type { JSONSQLite } from '../engine/JSONSQLite.js';
import type { Document, FilterCondition, JsonQuery } from '../types/index.js';

/**
 * Thin handle bound to a collection/table name.
 * Delegates to the owning JSONSQLite instance.
 */
export class CollectionHandle {
  constructor(
    private readonly db: JSONSQLite,
    private readonly name: string,
  ) {}

  get collectionName(): string {
    return this.name;
  }

  insert(
    data: Record<string, unknown> | Record<string, unknown>[],
  ): Promise<Document | Document[]> {
    return this.db.insert(this.name, data);
  }

  find(filter?: FilterCondition): Promise<Document[]> {
    const query: JsonQuery = { collection: this.name };
    if (filter !== undefined) query.filter = filter;
    return this.db.query(query);
  }

  findById(id: string): Promise<Document | null> {
    return this.db.findById(this.name, id);
  }

  update(id: string, patch: Record<string, unknown>): Promise<Document> {
    return this.db.update(this.name, id, patch);
  }

  delete(id: string): Promise<boolean> {
    return this.db.delete(this.name, id);
  }
}
