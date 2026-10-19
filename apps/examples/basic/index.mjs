import { open } from '@webofcat/jsonsqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const storagePath = path.join(__dirname, 'data');

const db = await open({ storagePath });

await db.insert('users', { name: '寒', age: 30 });
await db.insert('users', [
  { name: 'Alice', age: 22 },
  { name: 'Bob', age: 35 },
]);

const rows = await db.query({
  collection: 'users',
  filter: { age: { $gte: 25 } },
  orderBy: { age: 'desc' },
});

console.log('users age>=25:', rows);

await db.close();
console.log('done');
