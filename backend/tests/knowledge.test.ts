import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import {
  app,
  auth,
  createTicket,
  createUser,
  migrateTestDatabase,
  resetDatabase,
  type TestUser,
} from './helpers';
import { closePool, query } from '../src/db/pool';
import { chunkArticle, indexArticle, retrieve } from '../src/modules/knowledge/knowledge.service';
import { embed, EMBEDDING_DIMENSIONS } from '../src/services/embeddings';
import { DeterministicEmbeddingProvider } from '../src/services/embeddings/deterministic.provider';

const REFUND_ARTICLE = {
  title: 'Refund timelines and how to track a refund',
  body:
    'When a refund is approved it is sent to your bank the same working day.\n\n' +
    'Most refunds appear within 5 to 7 working days. Card refunds can take up to 10 working days.\n\n' +
    'If a refund has not arrived after 10 working days, ask for the refund reference and raise a trace request.',
};

const CRASH_ARTICLE = {
  title: 'Fixing app crashes on the checkout screen',
  body:
    'Checkout crashes are usually caused by an outdated app version or a corrupt local cache.\n\n' +
    'Ask the customer to update the app. Version 4.2 and above contains the checkout stability fix.\n\n' +
    'If it persists, clear the app cache from device settings and sign in again.',
};

describe('Embeddings (unit)', () => {
  const provider = new DeterministicEmbeddingProvider();

  it('produces vectors of the stored column width', async () => {
    const [v] = await provider.embed(['a refund has not arrived']);
    expect(v).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  it('is deterministic — the same text always gives the same vector', async () => {
    const [a] = await provider.embed(['my payment was deducted twice']);
    const [b] = await provider.embed(['my payment was deducted twice']);
    expect(a).toEqual(b);
  });

  it('returns unit vectors, so similarity does not favour long passages', async () => {
    const [v] = await provider.embed(['a much longer passage of text about refunds and payments']);
    const magnitude = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(magnitude).toBeCloseTo(1, 5);
  });

  it('scores overlapping text higher than unrelated text', async () => {
    const [q, related, unrelated] = await provider.embed([
      'refund has not arrived',
      'the refund will arrive within working days',
      'update the app to fix checkout crashes',
    ]);
    const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
    expect(dot(q, related)).toBeGreaterThan(dot(q, unrelated));
  });

  it('reports itself as non-semantic, so quality claims stay honest', async () => {
    expect(provider.semantic).toBe(false);
  });

  it('handles an empty batch without calling the provider', async () => {
    const outcome = await embed([]);
    expect(outcome.vectors).toEqual([]);
  });
});

describe('Chunking (unit)', () => {
  it('keeps a short article as a single chunk', () => {
    const chunks = chunkArticle('Title', 'One short paragraph about refunds.');
    expect(chunks).toHaveLength(1);
  });

  it('splits a long article into several chunks', () => {
    const body = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} about the returns process, repeated to add length.`).join('\n\n');
    const chunks = chunkArticle('Returns', body);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('prefixes every chunk with the title so orphan passages remain findable', () => {
    const body = Array.from({ length: 10 }, () => 'Wait three to five working days before escalating this.').join('\n\n');
    const chunks = chunkArticle('Refund timelines', body);
    expect(chunks.every((c) => c.startsWith('Refund timelines'))).toBe(true);
  });

  it('produces no blank chunks', () => {
    const chunks = chunkArticle('T', 'Para one.\n\n\n\nPara two.\n\n   \n\nPara three.');
    expect(chunks.every((c) => c.trim().length > 0)).toBe(true);
  });
});

describe('Knowledge base and retrieval (integration)', () => {
  let admin: TestUser;
  let agent: TestUser;
  let customer: TestUser;

  beforeAll(async () => {
    await migrateTestDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
    admin = await createUser('ADMIN', 'admin@example.com', 'System Admin');
    agent = await createUser('AGENT', 'priya@example.com', 'Priya Nair');
    customer = await createUser('CUSTOMER', 'rohan@example.com', 'Rohan Menon');
  });

  afterAll(async () => {
    await closePool();
  });

  const createArticle = (article = REFUND_ARTICLE) =>
    request(app).post('/api/knowledge').set(auth(admin)).send(article);

  it('creates an article and indexes it in the same request', async () => {
    const response = await createArticle();

    expect(response.status).toBe(201);
    expect(response.body.data.chunkCount).toBeGreaterThan(0);

    const chunks = await query<{ embedding: string | null }>(
      'SELECT embedding FROM kb_chunks WHERE article_id = $1',
      [response.body.data.id]
    );
    expect(chunks.length).toBeGreaterThan(0);
    // Every chunk must be embedded, or it is invisible to vector retrieval.
    expect(chunks.every((c) => c.embedding !== null)).toBe(true);
  });

  it('retrieves the relevant article for a query', async () => {
    await createArticle(REFUND_ARTICLE);
    await createArticle(CRASH_ARTICLE);

    const outcome = await retrieve('my refund has not arrived after two weeks', 3);

    expect(outcome.chunks.length).toBeGreaterThan(0);
    expect(outcome.chunks[0].articleTitle).toContain('Refund');
  });

  it('retrieves the other article for an unrelated query', async () => {
    await createArticle(REFUND_ARTICLE);
    await createArticle(CRASH_ARTICLE);

    const outcome = await retrieve('the app crashes on the checkout screen', 3);
    expect(outcome.chunks[0].articleTitle).toContain('crashes');
  });

  it('re-indexes when the body changes, so the index cannot go stale', async () => {
    const created = await createArticle();
    const before = await query('SELECT id FROM kb_chunks WHERE article_id = $1', [
      created.body.data.id,
    ]);

    await request(app)
      .patch(`/api/knowledge/${created.body.data.id}`)
      .set(auth(admin))
      .send({ body: 'Completely different content about delivery tracking and courier trace requests.' });

    const after = await query<{ content: string }>(
      'SELECT content FROM kb_chunks WHERE article_id = $1',
      [created.body.data.id]
    );
    expect(after.length).toBeGreaterThan(0);
    expect(after[0].content).toContain('courier');
    // Old chunk rows must be gone, not merely added to.
    expect(after.map((r) => r.content).join()).not.toContain('working days');
    expect(before.length).toBeGreaterThan(0);
  });

  it('excludes unpublished articles from retrieval', async () => {
    const created = await createArticle();
    await request(app)
      .patch(`/api/knowledge/${created.body.data.id}`)
      .set(auth(admin))
      .send({ isPublished: false });

    const outcome = await retrieve('refund has not arrived', 3);
    expect(outcome.chunks).toHaveLength(0);
  });

  it('deletes chunks when the article is deleted', async () => {
    const created = await createArticle();
    await request(app).delete(`/api/knowledge/${created.body.data.id}`).set(auth(admin));

    const chunks = await query('SELECT id FROM kb_chunks WHERE article_id = $1', [
      created.body.data.id,
    ]);
    expect(chunks).toHaveLength(0);
  });

  it('returns no results rather than failing when the base is empty', async () => {
    const outcome = await retrieve('anything at all', 3);
    expect(outcome.chunks).toEqual([]);
  });

  describe('authorization', () => {
    it('refuses article creation to an agent', async () => {
      const response = await request(app).post('/api/knowledge').set(auth(agent)).send(REFUND_ARTICLE);
      expect(response.status).toBe(403);
    });

    it('refuses the knowledge base entirely to a customer', async () => {
      const response = await request(app).get('/api/knowledge').set(auth(customer));
      expect(response.status).toBe(403);
    });

    it('refuses search to a customer', async () => {
      const response = await request(app)
        .post('/api/knowledge/search')
        .set(auth(customer))
        .send({ query: 'refund' });
      expect(response.status).toBe(403);
    });

    it('lets an agent read and search but not author', async () => {
      await createArticle();
      const read = await request(app).get('/api/knowledge').set(auth(agent));
      expect(read.status).toBe(200);

      const search = await request(app)
        .post('/api/knowledge/search')
        .set(auth(agent))
        .send({ query: 'refund timelines' });
      expect(search.status).toBe(200);
      expect(search.body.data.results.length).toBeGreaterThan(0);
    });
  });

  describe('grounded answers (RAG)', () => {
    it('answers from the knowledge base and cites its source', async () => {
      await createArticle(REFUND_ARTICLE);
      const ticket = await createTicket(
        customer,
        'Refund not credited after two weeks',
        'I returned my order two weeks ago and the refund has not arrived yet.'
      );

      const response = await request(app)
        .post(`/api/ai/tickets/${ticket.id}/grounded-answer`)
        .set(auth(agent));

      expect(response.status).toBe(200);
      expect(response.body.data.answer).toBeTruthy();
      expect(response.body.data.sources.length).toBeGreaterThan(0);
      expect(response.body.data.sources[0].title).toContain('Refund');
      expect(response.body.data.notice).toContain('Verify');
    });

    it('reports insufficient rather than inventing an answer when nothing is indexed', async () => {
      const ticket = await createTicket(
        customer,
        'Question about something undocumented',
        'How do I change the colour of my account avatar to purple?'
      );

      const response = await request(app)
        .post(`/api/ai/tickets/${ticket.id}/grounded-answer`)
        .set(auth(agent));

      expect(response.status).toBe(200);
      expect(response.body.data.insufficient).toBe(true);
      expect(response.body.data.sources).toEqual([]);
    });

    it('records the retrieval for later evaluation', async () => {
      await createArticle();
      const ticket = await createTicket(customer, 'Refund missing', 'My refund has not arrived at all.');

      await request(app).post(`/api/ai/tickets/${ticket.id}/grounded-answer`).set(auth(agent));

      const rows = await query<{ query_text: string }>(
        'SELECT query_text FROM kb_retrievals WHERE ticket_id = $1',
        [ticket.id]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].query_text).toContain('Refund missing');
    });

    it('refuses the grounded-answer endpoint to a customer', async () => {
      const ticket = await createTicket(customer);
      const response = await request(app)
        .post(`/api/ai/tickets/${ticket.id}/grounded-answer`)
        .set(auth(customer));
      expect(response.status).toBe(403);
    });
  });

  it('reports vector search as NOT a lexical fallback, even on the offline embedder', async () => {
    await createArticle();
    const outcome = await retrieve('refund has not arrived', 3);

    // Vector search ran (chunks are embedded), so this must be false. The bug
    // being pinned here set it from the embedder's own fallback flag.
    expect(outcome.usedLexicalFallback).toBe(false);
    expect(outcome.embeddingUsedFallback).toBe(true);
    expect(outcome.model).toBe('deterministic-lexical');
  });

  it('reports the lexical path honestly when nothing is embedded', async () => {
    // Insert an article but strip its embeddings so only full-text can serve.
    const created = await createArticle();
    await query('UPDATE kb_chunks SET embedding = NULL WHERE article_id = $1', [created.body.data.id]);

    const outcome = await retrieve('refund working days', 3);
    expect(outcome.usedLexicalFallback).toBe(true);
    expect(outcome.model).toBe('postgres-fts');
  });

  it('routes /status/embeddings to the status handler, not the :id handler', async () => {
    const response = await request(app).get('/api/knowledge/status/embeddings').set(auth(admin));
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveProperty('dimensions');
  });

  it('returns 404 for a non-UUID article id', async () => {
    const response = await request(app).get('/api/knowledge/not-a-uuid').set(auth(admin));
    expect(response.status).toBe(404);
  });

  it('stores grounded answers under their own suggestion kind', async () => {
    await createArticle();
    const ticket = await createTicket(customer, 'Refund missing', 'My refund has not arrived at all.');
    await request(app).post(`/api/ai/tickets/${ticket.id}/grounded-answer`).set(auth(agent));

    const rows = await query<{ kind: string }>(
      'SELECT kind::TEXT FROM ai_suggestions WHERE ticket_id = $1',
      [ticket.id]
    );
    expect(rows.map((r) => r.kind)).toContain('GROUNDED_ANSWER');
    expect(rows.map((r) => r.kind)).not.toContain('RESOLUTION_STEPS');
  });

  it('reports embedding status to an admin', async () => {
    await createArticle();
    const response = await request(app).get('/api/knowledge/status/embeddings').set(auth(admin));

    expect(response.status).toBe(200);
    expect(response.body.data.dimensions).toBe(EMBEDDING_DIMENSIONS);
    expect(response.body.data.embeddedChunks).toBeGreaterThan(0);
    // The offline provider must never be reported as semantic.
    expect(response.body.data.semantic).toBe(false);
  });
});
