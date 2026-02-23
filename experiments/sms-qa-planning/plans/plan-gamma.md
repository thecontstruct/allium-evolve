# Implementation Plan: SMS Q&A with Knowledge Base

**Date:** 2026-02-22
**Status:** Draft — Pending stakeholder review on open questions

---

## 1. Architecture Decisions

### 1.1 Vector Search: Cloud SQL for MySQL with Vector Embeddings via Application-Level ANN

**Choice:** Store embeddings in MySQL alongside relational data; perform approximate nearest-neighbor search at the application layer using a library like `hnswlib-node`.

**Justification:**
- The codebase is already running MySQL 8.4 via Cloud SQL. Adding a separate vector database service (Qdrant, Pinecone, Weaviate) introduces operational overhead — a new Docker Compose service for local dev, a new managed service in production, new credentials in Secret Manager, new health checks, a new failure domain.
- For an MVP knowledge base expected to hold hundreds to low-thousands of documents per tenant, an in-process ANN index built from database-stored embeddings is sufficient. Load the index on service start (or lazily per-tenant), rebuild on document changes.
- If scale demands exceed this approach (>50k chunks per tenant, sub-10ms latency requirements), migrate to a dedicated vector service. The embedding generation and search interfaces are abstracted behind a `VectorSearchProvider`, making this a swap-not-rewrite.

**Trade-off acknowledged:** This approach requires in-memory index management. For Cloud Run (stateless containers), the index must be rebuilt on cold start. Mitigation: serialize the HNSW index to GCS and load from there — rebuild only when documents change (tracked via a version counter on the tenant).

**Alternative considered:** Qdrant (Docker locally, Qdrant Cloud in prod). Cleanest vector search option but introduces a third data store alongside MySQL and GCS. Acceptable if the in-memory approach proves insufficient.

### 1.2 Embedding Model: Google text-embedding-004

**Choice:** `text-embedding-004` from Google's Generative AI API via the existing `@google/generative-ai` SDK.

**Justification:**
- Same vendor, same billing, same SDK as the existing Gemini-based AI features.
- 768-dimensional vectors; strong multilingual performance.
- Task-type parameter (`RETRIEVAL_DOCUMENT` for indexing, `RETRIEVAL_QUERY` for search) improves relevance without extra engineering.
- No new dependency or API key required.

### 1.3 Document Processing: Synchronous with Status Tracking

**Choice:** Process documents synchronously in the API request handler for small documents (<5MB). For larger files, process asynchronously using a lightweight Cloud Run Jobs invocation or a scheduled poller.

**Justification:**
- No message queue infrastructure exists in the codebase (no Redis, BullMQ, Pub/Sub integration).
- Admin document uploads are low-frequency, low-concurrency operations.
- The `knowledgeBaseDocument.status` field provides visibility. Processing a 50-page PDF takes 5–15 seconds — acceptable for a synchronous admin action with a progress indicator.
- Escape hatch: if processing time exceeds acceptable thresholds, trigger a Cloud Run Job for the heavy lifting and poll status.

### 1.4 Message Classification: Extended Single-Stage Classification

**Choice:** Extend the existing AI classification infrastructure to handle a 5-class taxonomy: `feedback`, `question`, `follow_up_feedback`, `follow_up_question`, `keyword_response`. The classifier receives conversation history when available.

**Justification:**
- The existing classification flow (SMS received → AI classify → route) is well-established. A two-stage pipeline doubles LLM latency and cost per message. A single classification call with enriched context (recent conversation history) can distinguish all five message types.
- The classifier already handles structured JSON output with confidence scoring. Extending the response schema is lower-risk than building a separate intent classifier with its own retry/timeout/fallback logic.
- The existing `classifyFeedback()` function is preserved as a second-pass enrichment for messages classified as feedback (adding category, urgency, target). It is NOT modified — it continues to receive already-classified feedback messages.

**Fallback:** On classification failure or low-confidence (<0.5), default to `feedback` — preserving existing behavior with zero regression risk.

### 1.5 Conversation Session Management

**Choice:** Implicit sessions keyed on `(contactId, locationId)` with a configurable inactivity timeout (default 30 minutes). Sessions are database-tracked, not in-memory.

**Justification:**
- SMS has no session concept. We infer conversations from the same sender texting the same location number within a time window.
- Database-tracked sessions survive Cloud Run cold starts and scaling events.
- Bounded conversation history (last 5 exchanges) prevents unbounded token growth in classification/RAG prompts.

### 1.6 Document Parsing

| Format | Library | Rationale |
|--------|---------|-----------|
| PDF | `pdf-parse` | Mature, handles text-based PDFs. Returns empty for scanned/image PDFs — detected and surfaced as processing error. |
| DOCX | `mammoth` | Extracts text content, strips formatting. Ideal for RAG chunking input. |
| TXT | Native `fs.readFile` | No library needed. |

### 1.7 Text Chunking Strategy

Recursive character-level splitting: default 1000 characters per chunk, 200 character overlap, paragraph boundary preservation. These defaults are configurable via environment variables.

Chunks are stored in MySQL with their ordinal position (`chunkIndex`) for deterministic reconstruction. The corresponding embedding vector is stored alongside in a binary column (BLOB) OR fetched from the in-memory HNSW index at query time.

---

## 2. Database Schema Changes

All tables follow existing conventions: `bigint` auto-increment PKs, `tenantId` FK with `onDelete: cascade`, `createdAt`/`updatedAt` timestamps, camelCase column names via Drizzle's `mysqlTable`.

### 2.1 New Tables

#### `knowledge_base_document`

```typescript
export const knowledgeBaseDocument = mysqlTable("knowledge_base_document", {
  id: bigint("id", { mode: "bigint" }).primaryKey().autoincrement(),
  tenantId: bigint("tenant_id", { mode: "bigint" })
    .notNull()
    .references(() => tenant.id, { onDelete: "cascade" }),
  originalFilename: varchar("original_filename", { length: 512 }).notNull(),
  mimeType: varchar("mime_type", { length: 128 }).notNull(),
  fileSize: int("file_size").notNull(),
  storagePath: varchar("storage_path", { length: 1024 }).notNull(),
  status: mysqlEnum("status", ["pending", "processing", "indexed", "failed"])
    .notNull()
    .default("pending"),
  chunkCount: int("chunk_count").notNull().default(0),
  errorMessage: text("error_message"),
  uploadedBy: bigint("uploaded_by", { mode: "bigint" })
    .notNull()
    .references(() => user.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("idx_kb_doc_tenant_status").on(table.tenantId, table.status),
  index("idx_kb_doc_tenant_created").on(table.tenantId, table.createdAt),
]);
```

#### `knowledge_base_chunk`

```typescript
export const knowledgeBaseChunk = mysqlTable("knowledge_base_chunk", {
  id: bigint("id", { mode: "bigint" }).primaryKey().autoincrement(),
  tenantId: bigint("tenant_id", { mode: "bigint" })
    .notNull()
    .references(() => tenant.id, { onDelete: "cascade" }),
  documentId: bigint("document_id", { mode: "bigint" })
    .notNull()
    .references(() => knowledgeBaseDocument.id, { onDelete: "cascade" }),
  chunkIndex: int("chunk_index").notNull(),
  content: text("content").notNull(),
  tokenCount: int("token_count"),
  embedding: blob("embedding"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_kb_chunk_document").on(table.documentId),
  index("idx_kb_chunk_tenant").on(table.tenantId),
]);
```

#### `qa_conversation`

```typescript
export const qaConversation = mysqlTable("qa_conversation", {
  id: bigint("id", { mode: "bigint" }).primaryKey().autoincrement(),
  tenantId: bigint("tenant_id", { mode: "bigint" })
    .notNull()
    .references(() => tenant.id, { onDelete: "cascade" }),
  locationId: bigint("location_id", { mode: "bigint" })
    .notNull()
    .references(() => location.id, { onDelete: "cascade" }),
  contactId: bigint("contact_id", { mode: "bigint" }).notNull(),
  status: mysqlEnum("status", ["active", "expired", "closed"])
    .notNull()
    .default("active"),
  interactionCount: int("interaction_count").notNull().default(0),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  lastActivityAt: timestamp("last_activity_at").defaultNow().notNull(),
}, (table) => [
  index("idx_qa_conv_contact_location").on(table.contactId, table.locationId, table.lastActivityAt),
  index("idx_qa_conv_tenant").on(table.tenantId),
  index("idx_qa_conv_status").on(table.tenantId, table.status),
]);
```

#### `qa_interaction`

```typescript
export const qaInteraction = mysqlTable("qa_interaction", {
  id: bigint("id", { mode: "bigint" }).primaryKey().autoincrement(),
  tenantId: bigint("tenant_id", { mode: "bigint" })
    .notNull()
    .references(() => tenant.id, { onDelete: "cascade" }),
  conversationId: bigint("conversation_id", { mode: "bigint" })
    .notNull()
    .references(() => qaConversation.id, { onDelete: "cascade" }),
  locationId: bigint("location_id", { mode: "bigint" })
    .notNull()
    .references(() => location.id, { onDelete: "cascade" }),
  questionMessageId: bigint("question_message_id", { mode: "bigint" }).notNull(),
  answerMessageId: bigint("answer_message_id", { mode: "bigint" }),
  questionText: text("question_text").notNull(),
  answerText: text("answer_text"),
  answerStatus: mysqlEnum("answer_status", [
    "pending", "answered", "no_relevant_content", "error"
  ]).notNull().default("pending"),
  isFollowUp: boolean("is_follow_up").notNull().default(false),
  classificationConfidence: decimal("classification_confidence", { precision: 3, scale: 2 }),
  topSimilarityScore: decimal("top_similarity_score", { precision: 5, scale: 4 }),
  searchDurationMs: int("search_duration_ms"),
  generationDurationMs: int("generation_duration_ms"),
  totalDurationMs: int("total_duration_ms"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_qa_interaction_conversation").on(table.conversationId),
  index("idx_qa_interaction_tenant_created").on(table.tenantId, table.createdAt),
  index("idx_qa_interaction_location").on(table.locationId),
  index("idx_qa_interaction_status").on(table.tenantId, table.answerStatus),
]);
```

#### `qa_interaction_source`

```typescript
export const qaInteractionSource = mysqlTable("qa_interaction_source", {
  id: bigint("id", { mode: "bigint" }).primaryKey().autoincrement(),
  interactionId: bigint("interaction_id", { mode: "bigint" })
    .notNull()
    .references(() => qaInteraction.id, { onDelete: "cascade" }),
  documentId: bigint("document_id", { mode: "bigint" })
    .notNull()
    .references(() => knowledgeBaseDocument.id, { onDelete: "cascade" }),
  chunkId: bigint("chunk_id", { mode: "bigint" })
    .notNull()
    .references(() => knowledgeBaseChunk.id, { onDelete: "cascade" }),
  similarityScore: decimal("similarity_score", { precision: 5, scale: 4 }).notNull(),
  chunkContentSnapshot: text("chunk_content_snapshot").notNull(),
  rankPosition: int("rank_position").notNull(),
}, (table) => [
  index("idx_qa_source_interaction").on(table.interactionId),
  index("idx_qa_source_document").on(table.documentId),
]);
```

### 2.2 Modifications to Existing Tables

**`smsMessage`** — Add message type classification:

```typescript
messageType: mysqlEnum("message_type", [
  "feedback", "question", "follow_up_question", "follow_up_feedback", "qa_answer", "system"
]).notNull().default("feedback"),
```

This is a new nullable-initially column. Migration sets default for existing rows to `"feedback"`. Then alter to `NOT NULL DEFAULT 'feedback'`.

**`smsLocationConfig`** — Add Q&A configuration:

```typescript
qaEnabled: boolean("qa_enabled").notNull().default(false),
qaSessionTimeoutMinutes: int("qa_session_timeout_minutes").notNull().default(30),
```

### 2.3 Migration Strategy

Single additive migration: `XXXX_add_qa_knowledge_base.sql`

- All new tables are CREATE TABLE (no impact on existing data)
- Existing table changes are additive columns with defaults (safe for zero-downtime deploy)
- Generated via `drizzle-kit generate` from updated schema definitions
- No data backfill required — existing SMS messages get `messageType = 'feedback'` via default

---

## 3. Package Structure

### 3.1 New Package: `packages/knowledge-base/`

```
packages/knowledge-base/
├── package.json
├── tsconfig.json
├── index.ts              # Public API exports
├── types.ts              # Shared types
├── config.ts             # KB configuration (chunk size, overlap, thresholds)
├── lib/
│   ├── document-parser.ts    # PDF/DOCX/TXT extraction
│   ├── chunker.ts            # Text chunking with overlap
│   ├── embeddings.ts         # Google text-embedding-004 wrapper
│   ├── vector-search.ts      # HNSW-based similarity search
│   ├── index-manager.ts      # HNSW index lifecycle (build, serialize, load)
│   ├── processor.ts          # Document processing pipeline (parse → chunk → embed → index)
│   └── rag-generator.ts      # RAG answer generation with source attribution
└── __tests__/
    ├── document-parser.test.ts
    ├── chunker.test.ts
    ├── embeddings.test.ts
    ├── vector-search.test.ts
    └── processor.test.ts
```

**Dependencies:** `@google/generative-ai`, `hnswlib-node`, `pdf-parse`, `mammoth`

**Exports:** `processDocument`, `deleteDocumentVectors`, `searchKnowledgeBase`, `generateAnswer`, `rebuildTenantIndex`

### 3.2 Extensions to Existing Packages

**`packages/sms/`:**
- New: `lib/message-classifier.ts` — extended classification with conversation context
- Modified: `lib/webhook-handler.ts` — add Q&A branch after classification

**`packages/ai/`:**
- New: `lib/qa-prompt.ts` — RAG system/user prompt templates
- New: `lib/classification-prompt.ts` — extended classification prompt (if not co-located in sms package)

**`packages/api/modules/admin/procedures/`:**
- New: `knowledge-base.ts` — KB CRUD + processing triggers
- New: `qa-reports.ts` — Q&A metrics, interaction list, export

**`packages/database/drizzle/queries/`:**
- New: `knowledge-base.ts` — document CRUD, chunk queries
- New: `qa-conversation.ts` — session management queries
- New: `qa-interaction.ts` — interaction recording and retrieval
- New: `qa-reports.ts` — aggregation queries for dashboard metrics

---

## 4. API Endpoints

### 4.1 Knowledge Base Management (Admin)

All endpoints use `adminProcedure` — tenant-scoped, requires admin/owner role.

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/admin/knowledge-base/upload-url` | Generate signed upload URL + create document record |
| `POST` | `/admin/knowledge-base/documents/:id/process` | Trigger document processing after upload confirmation |
| `GET` | `/admin/knowledge-base/documents` | Paginated document list with status filter |
| `GET` | `/admin/knowledge-base/documents/:id` | Document detail with chunk count and error info |
| `DELETE` | `/admin/knowledge-base/documents/:id` | Delete document, chunks, and vectors |
| `GET` | `/admin/knowledge-base/documents/:id/status` | Lightweight status polling endpoint |

**Upload flow:**
1. Client requests signed upload URL with filename + content type
2. Server creates `knowledgeBaseDocument` record (status: `pending`), generates signed GCS URL
3. Client uploads directly to GCS
4. Client calls `/process` to trigger parsing → chunking → embedding → indexing
5. Client polls `/status` for progress

### 4.2 Q&A Reports (Admin)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/admin/qa/metrics` | Dashboard metrics (total questions, answer rate, avg response time, etc.) |
| `GET` | `/admin/qa/interactions` | Paginated interaction list with filters (date range, location, answer status, search) |
| `GET` | `/admin/qa/interactions/:id` | Interaction detail with source documents, similarity scores, full audit trail |
| `GET` | `/admin/qa/export` | CSV export with active filters |

**Metrics endpoint response shape:**
```typescript
{
  totalQuestions: number;
  answeredCount: number;
  noAnswerCount: number;
  errorCount: number;
  answerRate: number;         // answered / total
  avgResponseTimeMs: number;
  avgSimilarityScore: number;
  questionsByDay: { date: string; count: number }[];
}
```

### 4.3 Q&A Configuration

| Method | Path | Purpose |
|--------|------|---------|
| `PATCH` | `/admin/locations/:id/qa-config` | Toggle `qaEnabled`, update `qaSessionTimeoutMinutes` |

---

## 5. SMS Webhook Flow Changes

### 5.1 Current Flow (Unchanged Steps)

```
1. Receive Twilio webhook POST
2. Validate Twilio signature
3. Parse payload (From, To, Body, MessageSid)
4. Resolve tenant from phone number
5. Resolve location from phone number
6. Rate limit check
```

### 5.2 New Branching (After Step 6)

```
7.  Check smsLocationConfig.qaEnabled for this location
8.  IF qaEnabled:
      a. Load recent conversation context (contactId + locationId, last 30 min)
      b. Call extended classifier with conversation context
         → Returns: { type, confidence }
      c. SWITCH on type:
         - "feedback" | "follow_up_feedback":
             → Existing classifyFeedback() flow (no change)
             → If follow_up_feedback, link to most recent qaInteraction if exists
         - "question" | "follow_up_question":
             → Create/extend qaConversation
             → Semantic search against tenant knowledge base
             → If no relevant results (below threshold):
                 → Record interaction as "no_relevant_content"
                 → Send "no information available" SMS
             → Else:
                 → RAG: generate answer from top-K chunks + conversation context
                 → Record qaInteraction with sources
                 → Send answer SMS
                 → Update conversation lastActivityAt
    ELSE:
      → Existing flow unchanged (steps 7+ from current implementation)
```

### 5.3 Critical Constraints

1. **Zero behavioral change when `qaEnabled = false`** — the entire Q&A branch is unreachable.
2. **Classification failure fallback:** default to `"feedback"` — no new failure modes.
3. **Q&A processing failure:** send error message to user, record interaction with `status: "error"`. Do NOT re-route to feedback pipeline.
4. **LLM and search calls execute OUTSIDE any MySQL transaction** to avoid long-held locks.
5. **Twilio SID-based idempotency:** if a message has already been processed (duplicate webhook), skip.

### 5.4 RAG Answer Generation

- System prompt strictly constrains answers to provided context only
- If the model cannot answer from context, it returns a standardized "I don't have information on that" response
- Answer target: ≤300 characters (SMS efficiency); hard truncate at 450 characters
- Include up to top 5 chunks as context, ordered by similarity score
- For follow-up questions, include the last 3 Q&A pairs as conversation context

---

## 6. Admin UI Components

### 6.1 Knowledge Base Management

**Route:** `apps/web/app/(saas)/app/(account)/admin/knowledge-base/page.tsx`

**Components:**
- `KnowledgeBaseDocumentList` — table with columns: filename, type, size, status badge, uploaded by, upload date, actions
- `DocumentUploadDialog` — file picker (accept: .pdf, .txt, .docx), max size validation (client-side), drag-and-drop
- `DocumentStatusBadge` — color-coded: pending (gray), processing (blue/spinning), indexed (green), failed (red)
- `DocumentDeleteConfirmation` — confirmation dialog with document name
- `ProcessingProgress` — polling-based status indicator shown after upload confirmation

**Empty state:** Prominent upload CTA with supported format list.

**Error state:** Failed documents show error message with "Delete and re-upload" guidance.

### 6.2 Q&A Reports Dashboard

**Route:** `apps/web/app/(saas)/app/(account)/admin/qa/page.tsx`

**Components:**
- `QAMetricsCards` — total questions, answer rate (%), unanswered rate (%), avg response time
- `QAActivityChart` — questions per day (bar chart, last 30 days default)
- `QAInteractionList` — filterable table: date, question preview, answer status, response time, location
- `QAInteractionDetail` — full question/answer text, source documents with similarity scores, timing breakdown
- `QAExportButton` — CSV export with active filters applied

**Filters (URL-persisted via nuqs):**
- Date range picker (default: last 30 days)
- Location selector (tenant-scoped)
- Answer status (all, answered, no answer, error)
- Search text (question content)

### 6.3 Q&A Location Configuration

**Integrated into existing location settings:** Add a "Q&A" section to the location detail/edit page with:
- Toggle: "Enable Q&A for this location"
- Session timeout setting (minutes)
- Warning if KB is empty when enabling

### 6.4 Navigation

Add to admin sidebar:
- **"Knowledge Base"** — under new "Q&A" group
- **"Q&A Reports"** — under new "Q&A" group

---

## 7. Integration Points

### 7.1 Multi-Tenancy

- Every new table includes `tenantId` FK with CASCADE delete
- All queries include tenant filter (enforced at the query layer, not just API)
- Vector search results filtered by tenant (in-memory index is per-tenant)
- Document storage paths are tenant-prefixed: `kb/{tenantId}/{documentId}/{filename}`

### 7.2 Authentication & Authorization

- All admin endpoints use existing `adminProcedure` — no new auth patterns
- No new roles required. admin/owner can manage KB and view reports
- Q&A interactions visible to admin/owner roles only

### 7.3 Storage

- Document uploads use the existing storage abstraction (`packages/storage/`)
- GCS in production, MinIO in local dev — no changes to the storage provider pattern
- New bucket: `{projectSlug}-kb-{environment}` for knowledge base documents
- Signed upload URLs use existing `generateSignedUploadURL` with content-type enforcement

### 7.4 Existing SMS Flow

- Additive branch — zero changes to the feedback classification path
- `classifyFeedback()` is called only for messages already classified as feedback
- SMS response sending uses existing Twilio client infrastructure

### 7.5 PII Handling

- Phone numbers are NOT stored in Q&A interaction records (referenced via contactId FK)
- Q&A report views show masked phone numbers consistent with feedback dashboard
- Audit logs reference entity IDs, not PII directly

---

## 8. Edge Cases and Error Handling

### 8.1 Knowledge Base States

| Scenario | Behavior |
|----------|----------|
| **Empty KB, Q&A enabled** | All questions get `no_relevant_content`. Admin UI shows warning banner. |
| **KB processing in progress** | Only indexed documents are searchable. Partially-processed documents excluded. |
| **Document fails processing** | Status set to `failed` with error message. Admin can delete and re-upload. |
| **Document deleted while referenced** | Soft consideration: `qaInteractionSource.chunkContentSnapshot` preserves audit trail content even after source document/chunk deletion. |
| **All documents deleted** | Functionally equivalent to empty KB. |

### 8.2 SMS Processing Edge Cases

| Scenario | Behavior |
|----------|----------|
| **Classification failure** | Default to `feedback` — zero regression risk. |
| **Low classification confidence** | Threshold: 0.5. Below → default to `feedback`. Log for monitoring. |
| **Search returns no results above threshold** | Record as `no_relevant_content`. Send "I don't have information about that" SMS. |
| **RAG generation failure** | Record as `error`. Send "I'm having trouble answering right now" SMS. Do NOT retry. |
| **Extremely long question** | Truncate to 2000 chars before embedding. Log original length. |
| **Duplicate webhook (same MessageSid)** | Idempotent — check if MessageSid already processed, skip if so. |
| **Rapid sequential messages** | Process sequentially per contact. Second message may become follow-up. |

### 8.3 Conversation Management

| Scenario | Behavior |
|----------|----------|
| **Session timeout exceeded** | New conversation created. Old conversation marked `expired`. |
| **Excessive follow-ups** | Cap at 10 interactions per conversation. After limit, start new conversation. |
| **Same user, different location** | Separate conversations per location. |
| **Conversation context window** | Last 5 Q&A pairs included in RAG context. |

### 8.4 Infrastructure Failures

| Scenario | Behavior |
|----------|----------|
| **Embedding API unavailable** | Document processing: retry 3x with backoff, then mark `failed`. Q&A: record as `error`. |
| **GCS unavailable during upload** | Signed URL generation fails. Client-side error. |
| **HNSW index build failure** | Log error. Serve requests from direct embedding comparison (slow fallback). |
| **Cold start index load** | Lazy-load per tenant on first Q&A request. Cache in-process. Cloud Run min-instances=1 for production to reduce cold starts. |

### 8.5 SMS Length Management

- RAG prompt instructs model to keep answers under 300 characters
- Application-level hard truncation at 450 characters with "..." suffix
- If answer exceeds 160 chars (single SMS segment), accept multi-segment — Twilio handles concatenation
- Monitor average answer length in metrics dashboard

---

## 9. Configuration

### 9.1 New Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `KB_CHUNK_SIZE` | No | `1000` | Characters per text chunk |
| `KB_CHUNK_OVERLAP` | No | `200` | Character overlap between chunks |
| `KB_SEARCH_TOP_K` | No | `5` | Number of chunks to retrieve |
| `KB_SIMILARITY_THRESHOLD` | No | `0.70` | Minimum similarity score to include chunk |
| `QA_SESSION_TIMEOUT_MS` | No | `1800000` | Session inactivity timeout (30 min) |
| `QA_MAX_ANSWER_CHARS` | No | `450` | Hard maximum SMS answer length |
| `QA_MAX_CONVERSATION_INTERACTIONS` | No | `10` | Max interactions per conversation |
| `QA_CLASSIFICATION_CONFIDENCE_THRESHOLD` | No | `0.50` | Below this → default to feedback |

### 9.2 New GCS Bucket

Bucket: `{projectSlug}-kb-{environment}` (follows existing naming pattern from storage config)

CORS configured via existing `setup-buckets` CLI command — extend the deployment config `storageBuckets` array.

### 9.3 Secret Manager

No new secrets required. Embedding API uses the same API key as existing Gemini integration.

---

## 10. Deployment Considerations

### 10.1 Infrastructure Changes

- New GCS bucket for KB document storage (via existing `setup-buckets` command)
- New storage permissions for Cloud Run service account (via existing `grant-permissions` command)
- Schema migration (additive, zero-downtime safe)
- `hnswlib-node` has native dependencies — ensure Docker build includes build tools (already present for `mysql2`)

### 10.2 Rollout Strategy

**Phase 0: Infrastructure** — Run schema migration, create GCS bucket, deploy code with `qaEnabled` defaulting to false everywhere. Zero behavioral change.

**Phase 1: Internal testing** — Enable Q&A on a single test location. Upload test documents. Validate end-to-end flow.

**Phase 2: Gradual rollout** — Enable per-location via admin UI. Admins control their own rollout.

**Rollback:** Set `qaEnabled = false` on all locations for immediate behavioral revert. Code can be rolled back independently — the schema is additive and doesn't break the existing flow.

### 10.3 Monitoring

- Log all Q&A interactions with timing metrics
- Alert on error rate > 10% for Q&A interactions
- Alert on average response time > 10s
- Dashboard metrics provide operational visibility

---

## 11. Open Questions Requiring Stakeholder Input

1. **KB scope: tenant-level or location-level?** — The spec says "per-tenant knowledge base." Should different locations within a tenant have different knowledge bases, or is one shared KB per tenant sufficient? Current plan assumes tenant-level.

2. **Q&A rate limiting** — Should Q&A have a separate rate limit from feedback? Q&A is more expensive (embedding + LLM generation per message). If so, what limit?

3. **"No answer" escalation** — When the system can't answer a question, should anyone be notified? Or is the metrics dashboard sufficient?

4. **Source citations in SMS** — Should the SMS answer include the document name it was sourced from? ("Based on [Employee Handbook]...") Adds transparency but consumes SMS characters.

5. **Maximum KB size per tenant** — Document count limit? Total storage limit? This affects the viability of the in-memory HNSW approach.

6. **Document update workflow** — If an admin needs to update a document, is delete-and-reupload acceptable? Or do we need versioning (upload new version, old chunks replaced)?

7. **Follow-up feedback attribution** — When someone sends feedback about an answer they received, should this be linked to the Q&A interaction? Or treated as standard feedback?

8. **Supported languages** — Is this English-only? The embedding model supports multilingual, but the RAG prompt and classification may need tuning for other languages.

9. **LLM cost visibility** — Should per-tenant LLM usage (tokens consumed) be tracked and surfaced in admin reports?

10. **Store manager access** — Can store managers view Q&A reports for their location, or is this admin-only? The feedback dashboard is available to store managers.

---

## 12. Implementation Sequence

### Phase 1: Foundation (5–6 days)

**Goal:** Schema, core packages, document processing pipeline

1. Add schema definitions for all new tables (`knowledge_base_document`, `knowledge_base_chunk`, `qa_conversation`, `qa_interaction`, `qa_interaction_source`)
2. Add `messageType` column to `smsMessage`, `qaEnabled` + `qaSessionTimeoutMinutes` to `smsLocationConfig`
3. Generate and run migration
4. Create `packages/knowledge-base/` package scaffolding
5. Implement `document-parser.ts` (PDF, DOCX, TXT extraction)
6. Implement `chunker.ts` (recursive character splitting)
7. Implement `embeddings.ts` (Google text-embedding-004 wrapper)
8. Implement `vector-search.ts` and `index-manager.ts` (HNSW index build/search/serialize)
9. Implement `processor.ts` (orchestration: parse → chunk → embed → store)
10. Write database query modules: `knowledge-base.ts`, `qa-conversation.ts`, `qa-interaction.ts`
11. Unit tests for parser, chunker, embeddings, search

### Phase 2: KB Admin (4–5 days)

**Goal:** Admins can upload, view, and delete KB documents

1. Extend deployment config with KB storage bucket
2. Implement admin API: `upload-url`, `process`, `list`, `detail`, `delete`, `status`
3. Implement signed upload URL generation for KB documents
4. Build KB admin UI: document list, upload dialog, status badges, delete confirmation
5. Add "Knowledge Base" to admin sidebar navigation
6. Integration tests for KB API endpoints

### Phase 3: Q&A Core (5–6 days)

**Goal:** SMS Q&A end-to-end flow operational

1. Implement extended message classifier (5-class taxonomy with conversation context)
2. Implement `rag-generator.ts` (answer generation with source attribution)
3. Implement conversation session management (create/find/expire sessions)
4. Modify SMS webhook handler: add Q&A branch after classification
5. Implement Q&A response SMS sending
6. Record `qaInteraction` and `qaInteractionSource` entries
7. Add Q&A location configuration (`qaEnabled` toggle) to location admin page
8. Integration tests for full SMS → classify → search → answer → SMS flow
9. Edge case handling: empty KB, low confidence, classification failure, generation failure

### Phase 4: Reporting (3–4 days)

**Goal:** Admin Q&A visibility and export

1. Implement Q&A metrics aggregation queries
2. Implement admin API: `metrics`, `interactions` (list), `interactions/:id` (detail), `export`
3. Build Q&A reports UI: metrics cards, interaction list, interaction detail, export button
4. Add URL-persisted filters via nuqs (date range, location, status, search)
5. Add "Q&A Reports" to admin sidebar navigation

### Phase 5: Hardening (2–3 days)

**Goal:** Production readiness

1. PII audit — ensure phone numbers are not leaked in Q&A logs or reports
2. Performance testing — document processing throughput, search latency
3. SMS length validation and truncation testing
4. Cold start optimization — index serialization to GCS, lazy load
5. Error handling review — all failure paths send appropriate user messages and log correctly
6. Documentation — update API docs, add KB management guide

---

**Total estimated effort: 19–24 developer-days**

Parallelizable: Phase 2 (KB Admin) and Phase 3 (Q&A Core) can run concurrently once Phase 1 is complete. With 2 developers, critical path is approximately 3 weeks.

**Critical path:** Schema → Knowledge Base Package → Webhook Integration → Reporting
