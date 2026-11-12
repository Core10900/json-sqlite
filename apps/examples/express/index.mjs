import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, createGraphqlHandler } from '@webofcat/jsonsqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const storagePath = path.join(__dirname, 'data');
const port = Number(process.env.PORT ?? 3100);

const db = await open({ storagePath, graphql: true });
const users = db.collection('users');
const app = express();
app.use(express.json());

app.post('/users', async (req, res) => {
  try {
    const doc = await users.insert(req.body ?? {});
    res.status(201).json({ doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/users/:id', async (req, res) => {
  try {
    const doc = await users.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'DOCUMENT_NOT_FOUND' });
    res.json({ doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/graphql', createGraphqlHandler(db));

app.listen(port, () => {
  console.log(`express example on http://127.0.0.1:${port}`);
});
