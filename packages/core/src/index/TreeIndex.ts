import type { Document } from '../types/index.js';
import type { Index, IndexMeta, IndexSnapshot } from './types.js';

function fieldValue(doc: Document, field: string): unknown {
  if (!field.includes('.')) return doc[field];
  return field.split('.').reduce<unknown>((cur, p) => {
    if (cur && typeof cur === 'object') return (cur as Record<string, unknown>)[p];
    return undefined;
  }, doc);
}

function cmp(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return String(a).localeCompare(String(b));
}

interface Leaf {
  kind: 'leaf';
  keys: unknown[];
  ids: string[][];
  next: Leaf | null;
}

interface Internal {
  kind: 'internal';
  keys: unknown[];
  children: Node[];
}

type Node = Leaf | Internal;

interface Split {
  sep: unknown;
  right: Node;
}

function emptyLeaf(): Leaf {
  return { kind: 'leaf', keys: [], ids: [], next: null };
}

/**
 * B+Tree ordered index. `order` is the maximum key count in a node
 * (default 128). Leaves hold `key → _id[]` and are linked for ranges.
 * Search and range descent are O(log n) node visits, not a scan of every key.
 */
export class TreeIndex implements Index {
  private root: Node = emptyLeaf();
  /** Nodes entered by the last lookupEq or lookupRange. */
  nodeVisits = 0;

  constructor(
    readonly meta: IndexMeta,
    readonly order = 128,
  ) {
    if (!Number.isInteger(order) || order < 3) {
      throw new Error(`bTreeOrder must be an integer >= 3, got ${order}`);
    }
  }

  build(docs: Document[]): void {
    this.root = emptyLeaf();
    for (const doc of docs) this.insert(doc);
  }

  insert(doc: Document): void {
    const split = this.insertRec(this.root, fieldValue(doc, this.meta.field), doc._id);
    if (!split) return;
    this.root = {
      kind: 'internal',
      keys: [split.sep],
      children: [this.root, split.right],
    };
  }

  update(prev: Document | undefined, next: Document): void {
    if (prev) this.remove(prev);
    this.insert(next);
  }

  remove(doc: Document): void {
    const key = fieldValue(doc, this.meta.field);
    const leaf = this.findLeaf(key, false);
    const i = lowerBound(leaf.keys, key);
    if (i >= leaf.keys.length || cmp(leaf.keys[i], key) !== 0) return;
    const ids = leaf.ids[i]!;
    const pos = ids.indexOf(doc._id);
    if (pos >= 0) ids.splice(pos, 1);
    if (ids.length === 0) {
      leaf.keys.splice(i, 1);
      leaf.ids.splice(i, 1);
    }
  }

  lookupEq(value: unknown): string[] {
    this.nodeVisits = 0;
    const leaf = this.findLeaf(value, true);
    const i = lowerBound(leaf.keys, value);
    if (i < leaf.keys.length && cmp(leaf.keys[i], value) === 0) {
      return [...leaf.ids[i]!];
    }
    return [];
  }

  lookupRange(min?: unknown, max?: unknown): string[] {
    this.nodeVisits = 0;
    let leaf = min === undefined ? this.leftmost(true) : this.findLeaf(min, true);
    const out: string[] = [];
    const seen = new Set<Leaf>();
    while (!seen.has(leaf)) {
      seen.add(leaf);
      for (let i = 0; i < leaf.keys.length; i++) {
        const key = leaf.keys[i]!;
        if (min !== undefined && cmp(key, min) < 0) continue;
        if (max !== undefined && cmp(key, max) > 0) return out;
        out.push(...leaf.ids[i]!);
      }
      if (!leaf.next) break;
      leaf = leaf.next;
      this.nodeVisits += 1;
    }
    return out;
  }

  lookupText(): string[] {
    return [];
  }

  resetAccess(): void {
    this.nodeVisits = 0;
  }

  stats(): { keys: number; docs: number } {
    let keys = 0;
    let docs = 0;
    for (const leaf of this.leaves()) {
      keys += leaf.keys.length;
      for (const ids of leaf.ids) docs += ids.length;
    }
    return { keys, docs };
  }

  exportEntries(): IndexSnapshot {
    const entries: [string, string[]][] = [];
    const keys: unknown[] = [];
    for (const leaf of this.leaves()) {
      for (let i = 0; i < leaf.keys.length; i++) {
        const key = leaf.keys[i]!;
        keys.push(key);
        entries.push([JSON.stringify(key), [...leaf.ids[i]!]]);
      }
    }
    return { entries, keys };
  }

  importEntries(snapshot: IndexSnapshot): void {
    this.root = emptyLeaf();
    const pairs =
      snapshot.keys && snapshot.keys.length === snapshot.entries.length
        ? snapshot.entries.map((entry, i) => [snapshot.keys![i], entry[1]] as const)
        : snapshot.entries.map(
            ([encoded, ids]) => [JSON.parse(encoded) as unknown, ids] as const,
          );
    for (const [key, ids] of pairs) {
      for (const id of ids) this.insert(synthetic(this.meta.field, key, id));
    }
  }

  private insertRec(node: Node, key: unknown, id: string): Split | null {
    if (node.kind === 'leaf') {
      const i = lowerBound(node.keys, key);
      if (i < node.keys.length && cmp(node.keys[i], key) === 0) {
        if (!node.ids[i]!.includes(id)) node.ids[i]!.push(id);
        return null;
      }
      node.keys.splice(i, 0, key);
      node.ids.splice(i, 0, [id]);
      if (node.keys.length <= this.order) return null;
      return splitLeaf(node);
    }
    let childIndex = 0;
    while (childIndex < node.keys.length && cmp(key, node.keys[childIndex]!) >= 0) {
      childIndex += 1;
    }
    const split = this.insertRec(node.children[childIndex]!, key, id);
    if (!split) return null;
    node.keys.splice(childIndex, 0, split.sep);
    node.children.splice(childIndex + 1, 0, split.right);
    if (node.keys.length <= this.order) return null;
    return splitInternal(node);
  }

  private findLeaf(key: unknown, count: boolean): Leaf {
    let node = this.root;
    while (node.kind === 'internal') {
      if (count) this.nodeVisits += 1;
      let i = 0;
      while (i < node.keys.length && cmp(key, node.keys[i]!) >= 0) i += 1;
      node = node.children[i]!;
    }
    if (count) this.nodeVisits += 1;
    return node;
  }

  private leftmost(count: boolean): Leaf {
    let node = this.root;
    while (node.kind === 'internal') {
      if (count) this.nodeVisits += 1;
      node = node.children[0]!;
    }
    if (count) this.nodeVisits += 1;
    return node;
  }

  private leaves(): Leaf[] {
    const first = this.leftmost(false);
    const out: Leaf[] = [];
    const seen = new Set<Leaf>();
    let leaf: Leaf | null = first;
    while (leaf && !seen.has(leaf)) {
      seen.add(leaf);
      out.push(leaf);
      leaf = leaf.next;
    }
    return out;
  }
}

function splitLeaf(leaf: Leaf): Split {
  const mid = Math.ceil(leaf.keys.length / 2);
  const right: Leaf = {
    kind: 'leaf',
    keys: leaf.keys.splice(mid),
    ids: leaf.ids.splice(mid),
    next: leaf.next,
  };
  leaf.next = right;
  return { sep: right.keys[0]!, right };
}

function splitInternal(node: Internal): Split {
  const mid = Math.floor(node.keys.length / 2);
  const sep = node.keys[mid]!;
  const right: Internal = {
    kind: 'internal',
    keys: node.keys.slice(mid + 1),
    children: node.children.slice(mid + 1),
  };
  node.keys = node.keys.slice(0, mid);
  node.children = node.children.slice(0, mid + 1);
  return { sep, right };
}

function lowerBound(keys: unknown[], key: unknown): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cmp(keys[mid], key) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function synthetic(field: string, value: unknown, id: string): Document {
  const doc: Document = {
    _id: id,
    _version: 1,
    _createdAt: 0,
    _updatedAt: 0,
  };
  if (!field.includes('.')) {
    doc[field] = value;
    return doc;
  }
  const parts = field.split('.');
  let cur: Record<string, unknown> = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    const next: Record<string, unknown> = {};
    cur[parts[i]!] = next;
    cur = next;
  }
  cur[parts[parts.length - 1]!] = value;
  return doc;
}
