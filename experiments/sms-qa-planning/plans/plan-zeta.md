# Plan Zeta — SMS Q&A with Knowledge Base

**Author:** Phil Mahncke  
**Date:** 2026-02-22  
**Status:** Draft  

---

## Table of Contents

1. [Architecture Decisions](#1-architecture-decisions)
2. [Database Schema Changes](#2-database-schema-changes)
3. [New Packages and Modules](#3-new-packages-and-modules)
4. [API Endpoints](#4-api-endpoints)
5. [SMS Flow Changes](#5-sms-flow-changes)
6. [UI Components](#6-ui-components)
7. [Integration Points](#7-integration-points)
8. [Edge Cases and Error Handling](#8-edge-cases-and-error-handling)
9. [Migration Strategy](#9-migration-strategy)
10. [Open Questions](#10-open-questions)
11. [Implementation Sequence](#11-implementation-sequence)

---

## 1. Architecture Decisions

### 1.1 Vector Database — Qdrant Cloud

**Choice:** Qdrant Cloud (managed) with `@qdrant/js-client-rest` SDK.

**Rationale:**
- The existing database is MySQL 8.4 on Cloud SQL. MySQL 8.4 has no native vector search support, and Cloud SQL does not support vector extensions. Embedding vector search into the relational layer is not viable without a database engine change.
- Qdrant provides native multi-tenancy support via collection payload filtering (filter by `tenantId`), aligning with the existing tenant isolation model.
- The Node.js SDK is well-maintained and TypeScript-native.
- Qdrant Cloud provides a managed offering that avoids self-hosting operational burden. If GCP-native hosting becomes a requirement, Qdrant can be deployed on GKE.
- Pinecone or Vertex AI Vector Search are viable alternatives. Pinecone has a simpler API but introduces vendor coupling outside GCP. Vertex AI Vector Search is GCP-native but operationally heavier for the expected document scale (hundreds to low thousands per tenant, not millions).

**Trade-off acknowledged:** Adding Qdrant introduces a new infrastructure dependency outside the existing GCP-only stack. This is the primary cost. The alternative (AlloyDB with pgvector) would stay GCP-native but requires migrating or adding a PostgreSQL instance alongside the existing MySQL — a larger scope change.

**Configuration:**
- One Qdrant collection per environment (dev, staging, prod), not per tenant.
- Tenant isolation via mandatory `tenantId` payload filter on every query.
- Collection name pattern: `{projectSlug}-{environment}-knowledge-base`

### 1.2 Embedding Model — Google `text-embedding-004`

**Choice:** Google's `text-embedding-004` via the existing `@google/generative-ai` SDK.

**Rationale:**
- The `@google/generative-ai` package (^0.21.0) is already a dependency in `packages/sms`. The embedding API is available through the same SDK — no new dependency required.
- 768-dimensional embeddings with strong multilingual support.
- Aligns with the existing Gemini integration for classification, keeping the AI vendor surface area minimal.

### 1.3 Document Processing — Lightweight Node.js Libraries

**Choice:** `pdf-parse` for PDF, `mammoth` for DOCX, native `fs` for TXT.

**Rationale:**
- These are well-established, lightweight Node.js libraries. No external services or container-based processing needed.
- Document processing happens server-side as a background task after upload. The storage package already provides signed URL upload infrastructure — documents land in GCS/MinIO, then a processing pipeline reads and chunks them.
- If processing needs scale significantly (e.g., OCR for scanned PDFs), this can be upgraded to Google Document AI later. That's out of scope for the initial implementation.

### 1.4 Conversation Management — Time-Windowed Sessions

**Choice:** Implicit conversation sessions based on contact + location + time window.

**Rationale:**
- SMS is inherently sessionless. Conversations must be inferred from message proximity.
- A conversation is defined as a sequence of messages from the same contact to the same location phone number within a configurable inactivity window (default: 2 hours).
- The conversation entity stores the running context needed for follow-up classification and multi-turn Q&A.
- No explicit "start session" or "end session" — the system creates a new conversation when no active conversation exists for the contact/location pair, and resumes an existing one when a message arrives within the window.
- The 2-hour window is a tenant-level configuration with a sensible default.

### 1.5 LLM for Answer Generation — Gemini 2.5 Flash

**Choice:** Same Gemini 2.5 Flash model used for classification, with a separate configuration profile.

**Rationale:**
- Keeps the AI vendor surface area to one provider.
- Answer generation requires a different prompt profile: longer timeout (15s vs 5s), structured RAG prompt template, and different safety settings.
- A separate function in `packages/ai` (or `packages/sms/lib`) encapsulates the RAG generation prompt, distinct from the existing classification prompt.

### 1.6 Chunking Strategy — Fixed-Size with Overlap

**Choice:** ~500 token chunks with ~50 token overlap, split on sentence boundaries where possible.

**Rationale:**
- Balances retrieval precision with context completeness.
- Sentence-boundary splitting reduces mid-sentence cuts that degrade retrieval quality.
- Chunk size is configurable per tenant to allow tuning.

---

## 2. Database Schema Changes

All new tables follow existing conventions: bigint auto-increment PKs, `tenantId` FK with CASCADE, camelCase column names, `createdAt`/`updatedAt` timestamps.

### 2.1 New Tables

#### `smsConversation`

Tracks implicit conversation sessions between a contact and a location.

```typescript
export const smsConversation = mysqlTable("sms_conversation", {
  id: bigint("id", { mode: "bigint" }).primaryKey().autoincrement(),
  tenantId: bigint("tenant_id", { mode: "bigint" })
    .notNull()
    .references(() => tenant.id, { onDelete: "cascade" }),
  locationId: bigint("location_id", { mode: "bigint" })
    .notNull()
    .references(() => location.id, { onDelete: "cascade" }),
  contactId: bigint("contact_id", { mode: "bigint" })
    .notNull()
    .references(() => smsContact.id, { onDelete: "cascade" }),
  status: mysqlEnum("status", ["active", "expired"]).notNull().default("active"),
  messageCount: int("message_count").notNull().default(0),
  lastMessageAt: timestamp("last_message_at").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_conversation_contact_location").on(table.contactId, table.locationId, table.status),
  index("idx_conversation_tenant").on(table.tenantId),
]);
```

#### `knowledgeBaseDocument`

Tracks documents uploaded to the per-tenant knowledge base.

```typescript
export const knowledgeBaseDocument = mysqlTable("knowledge_base_document", {
  id: bigint("id", { mode: "bigint" }).primaryKey().autoincrement(),
  tenantId: bigint("tenant_id", { mode: "bigint" })
    .notNull()
    .references(() => tenant.id, { onDelete: "cascade" }),
  filename: varchar("filename", { length: 500 }).notNull(),
  fileType: mysqlEnum("file_type", ["pdf", "txt", "docx"]).notNull(),
  fileSize: int("file_size").notNull(),
  storagePath: varchar("storage_path", { length: 1000 }).notNull(),
  storageBucket: varchar("storage_bucket", { length: 255 }).notNull(),
  status: mysqlEnum("status", ["uploaded", "processing", "indexed", "failed"])
    .notNull()
    .default("uploaded"),
  chunkCount: int("chunk_count").default(0),
  errorMessage: text("error_message"),
  uploadedBy: bigint("uploaded_by", { mode: "bigint" })
    .references(() => user.id, { onDelete: "set null" }),
  processedAt: timestamp("processed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
}, (table) => [
  index("idx_kb_doc_tenant").on(table.tenantId),
  index("idx_kb_doc_tenant_status").on(table.tenantId, table.status),
]);
```

#### `knowledgeBaseChunk`

Tracks individual chunks extracted from documents, with references to vector DB point IDs.

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
  tokenCount: int("token_count").notNull(),
  vectorId: varchar("vector_id", { length: 100 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_kb_chunk_document").on(table.documentId),
  index("idx_kb_chunk_tenant").on(table.tenantId),
  index("idx_kb_chunk_vector_id").on(table.vectorId),
]);
```

#### `qaInteraction`

Core audit table for Q&A interactions. One row per question-answer cycle.

```typescript
export const qaInteraction = mysqlTable("qa_interaction", {
  id: bigint("id", { mode: "bigint" }).primaryKey().autoincrement(),
  tenantId: bigint("tenant_id", { mode: "bigint" })
    .notNull()
    .references(() => tenant.id, { onDelete: "cascade" }),
  locationId: bigint("location_id", { mode: "bigint" })
    .notNull()
    .references(() => location.id, { onDelete: "cascade" }),
  conversationId: bigint("conversation_id", { mode: "bigint" })
    .notNull()
    .references(() => smsConversation.id, { onDelete: "cascade" }),
  inboundMessageId: bigint("inbound_message_id", { mode: "bigint" })
    .notNull()
    .references(() => smsMessage.id, { onDelete: "cascade" }),
  outboundMessageId: bigint("outbound_message_id", { mode: "bigint" })
    .references(() => smsMessage.id, { onDelete: "set null" }),
  questionText: text("question_text").notNull(),
  answerText: text("answer_text"),
  answerStatus: mysqlEnum("answer_status", [
    "searching", "generating", "answered", "no_answer", "failed"
  ]).notNull().default("searching"),
  searchQuery: text("search_query"),
  searchResultCount: int("search_result_count"),
  topRelevanceScore: decimal("top_relevance_score", { precision: 5, scale: 4 }),
  llmModel: varchar("llm_model", { length: 100 }),
  llmPromptTokens: int("llm_prompt_tokens"),
  llmCompletionTokens: int("llm_completion_tokens"),
  responseTimeMs: int("response_time_ms"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  answeredAt: timestamp("answered_at"),
}, (table) => [
  index("idx_qa_tenant").on(table.tenantId),
  index("idx_qa_tenant_location").on(table.tenantId, table.locationId),
  index("idx_qa_conversation").on(table.conversationId),
  index("idx_qa_answer_status").on(table.tenantId, table.answerStatus),
  index("idx_qa_created_at").on(table.tenantId, table.createdAt),
]);
```

#### `qaSourceCitation`

Links Q&A interactions to the specific knowledge base chunks that contributed to the answer.

```typescript
export const qaSourceCitation = mysqlTable("qa_source_citation", {
  id: bigint("id", { mode: "bigint" }).primaryKey().autoincrement(),
  interactionId: bigint("interaction_id", { mode: "bigint" })
    .notNull()
    .references(() => qaInteraction.id, { onDelete: "cascade" }),
  chunkId: bigint("chunk_id", { mode: "bigint" })
    .notNull()
    .references(() => knowledgeBaseChunk.id, { onDelete: "cascade" }),
  documentId: bigint("document_id", { mode: "bigint" })
    .notNull()
    .references(() => knowledgeBaseDocument.id, { onDelete: "cascade" }),
  relevanceScore: decimal("relevance_score", { precision: 5, scale: 4 }).notNull(),
  chunkContent: text("chunk_content").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_citation_interaction").on(table.interactionId),
  index("idx_citation_document").on(table.documentId),
]);
```

### 2.2 Modifications to Existing Tables

#### `smsMessage` — Add `conversationId` and `messageIntent`

```typescript
// Add to existing smsMessage table definition:
conversationId: bigint("conversation_id", { mode: "bigint" })
  .references(() => smsConversation.id, { onDelete: "set null" }),
messageIntent: mysqlEnum("message_intent", [
  "feedback", "question", "follow_up_feedback", "follow_up_question", "keyword", "unknown"
]),
```

The `messageIntent` column is nullable to maintain backward compatibility — existing rows will have `null`, which the application treats as `"feedback"` (the legacy default).

#### `smsLocationConfig` — Add `qaEnabled` and `conversationTimeoutMinutes`

```typescript
// Add to existing smsLocationConfig table definition:
qaEnabled: boolean("qa_enabled").notNull().default(false),
conversationTimeoutMinutes: int("conversation_timeout_minutes").notNull().default(120),
```

`qaEnabled` is a per-location toggle so Q&A can be rolled out incrementally. When `false`, all messages are routed through the existing feedback-only pipeline — no intent classification occurs.

### 2.3 Indexes and Migrations

Generate via `drizzle-kit generate` following the existing migration workflow. The migration will:

1. Create 5 new tables with indexes.
2. ALTER `sms_message` to add two nullable columns.
3. ALTER `sms_location_config` to add two columns with defaults.

No data migration needed — all new columns are nullable or have defaults.

---

## 3. New Packages and Modules

### 3.1 `packages/knowledge-base/` — New Package

Knowledge base management: document processing, chunking, embedding, vector search.

```
packages/knowledge-base/
├── index.ts                    # Public exports
├── package.json
├── lib/
│   ├── chunker.ts              # Text chunking with sentence-boundary splitting
│   ├── embeddings.ts           # Embedding generation via text-embedding-004
│   ├── vector-store.ts         # Qdrant client wrapper (CRUD, search, tenant-scoped)
│   ├── document-processor.ts   # Extract text from PDF/DOCX/TXT
│   ├── rag-generator.ts        # RAG answer generation (prompt template + Gemini call)
│   └── types.ts                # Shared types
├── config.ts                   # Qdrant connection config, embedding model config
└── __tests__/
    ├── chunker.test.ts
    ├── embeddings.test.ts
    ├── vector-store.test.ts
    ├── document-processor.test.ts
    └── rag-generator.test.ts
```

**Dependencies:** `@qdrant/js-client-rest`, `pdf-parse`, `mammoth`, `@google/generative-ai` (workspace peer)

### 3.2 `packages/api/modules/admin/procedures/knowledge-base/` — Admin API Procedures

```
packages/api/modules/admin/procedures/knowledge-base/
├── upload-document.ts          # Initiate document upload (returns signed URL)
├── list-documents.ts           # Paginated document list with metadata
├── get-document.ts             # Single document detail
├── delete-document.ts          # Soft delete with vector cleanup
├── process-document.ts         # Trigger processing (called after upload completes)
└── index.ts                    # Route registration
```

### 3.3 `packages/api/modules/admin/procedures/qa/` — Q&A Admin Procedures

```
packages/api/modules/admin/procedures/qa/
├── list-interactions.ts        # Paginated Q&A interaction list with filters
├── get-interaction.ts          # Single interaction with full audit trail + citations
├── get-metrics.ts              # Aggregated Q&A metrics
├── export-interactions.ts      # CSV export with filters
└── index.ts                    # Route registration
```

### 3.4 `packages/database/drizzle/queries/knowledge-base.ts`

Tenant-scoped query functions for knowledge base tables:
- `insertDocument`, `updateDocumentStatus`, `getDocumentsByTenant`, `getDocumentById`, `deleteDocument`
- `insertChunks`, `getChunksByDocument`, `deleteChunksByDocument`

### 3.5 `packages/database/drizzle/queries/qa.ts`

Tenant-scoped query functions for Q&A tables:
- `insertQaInteraction`, `updateQaInteraction`, `getQaInteractions`, `getQaInteractionById`
- `insertSourceCitations`, `getSourceCitationsByInteraction`
- `getQaMetrics` (aggregations for dashboard)

### 3.6 `packages/database/drizzle/queries/conversation.ts`

Conversation management queries:
- `findActiveConversation` (by contactId + locationId where `expiresAt > now()`)
- `createConversation`, `updateConversationLastMessage`, `expireConversation`
- `getConversationMessages` (recent messages for context window)

### 3.7 Additions to Existing `packages/sms/`

```
packages/sms/lib/
├── intent-classifier.ts        # New: classify message intent (feedback|question|follow-up-*)
├── conversation-manager.ts     # New: conversation session resolution and context building
```

New exports from `packages/sms/index.ts`:
- `classifyIntent` — returns `{ intent: MessageIntent, confidence: number }`
- `resolveConversation` — finds or creates conversation, returns conversation context

---

## 4. API Endpoints

All endpoints use `adminProcedure` (authenticated + admin role) and resolve tenant via `getEffectiveTenantFromContext`. Input validation via Zod schemas.

### 4.1 Knowledge Base Management

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/admin/knowledge-base/upload` | Generate signed upload URL + create document record | Admin |
| POST | `/admin/knowledge-base/{id}/process` | Trigger document processing after upload | Admin |
| GET | `/admin/knowledge-base` | List documents (paginated, filterable by status) | Admin |
| GET | `/admin/knowledge-base/{id}` | Document detail with chunk count, processing status | Admin |
| DELETE | `/admin/knowledge-base/{id}` | Delete document, chunks, and vector embeddings | Admin |

#### POST `/admin/knowledge-base/upload`

```typescript
// Input
z.object({
  filename: z.string().min(1).max(500),
  fileType: z.enum(["pdf", "txt", "docx"]),
  fileSize: z.number().int().positive().max(50_000_000), // 50MB limit
  contentType: z.string(),
})

// Output
z.object({
  documentId: z.bigint(),
  uploadUrl: z.string().url(), // Signed GCS/MinIO URL
  storagePath: z.string(),
})
```

**Flow:**
1. Validate file type and size.
2. Generate storage path: `knowledge-base/{tenantId}/{documentId}/{filename}`.
3. Create `knowledgeBaseDocument` record with status `"uploaded"`.
4. Generate signed upload URL via existing storage package.
5. Return URL and document ID for client-side upload.

#### POST `/admin/knowledge-base/{id}/process`

```typescript
// Input
z.object({ documentId: z.bigint() })

// Output
z.object({ status: z.literal("processing") })
```

**Flow:**
1. Verify document exists and belongs to tenant.
2. Verify document status is `"uploaded"` (idempotency: reject if already `"processing"` or `"indexed"`).
3. Set status to `"processing"`.
4. Dispatch async processing (see §5.3).

The processing itself runs asynchronously. The client polls the document status via GET until it reaches `"indexed"` or `"failed"`.

#### GET `/admin/knowledge-base`

```typescript
// Input (query params)
z.object({
  status: z.enum(["uploaded", "processing", "indexed", "failed"]).optional(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(20),
})

// Output
z.object({
  documents: z.array(documentSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
})
```

#### DELETE `/admin/knowledge-base/{id}`

```typescript
// Input
z.object({ documentId: z.bigint() })
```

**Flow:**
1. Delete vectors from Qdrant (filter by `documentId` + `tenantId`).
2. Delete `knowledgeBaseChunk` rows.
3. Delete file from GCS/MinIO.
4. Delete `knowledgeBaseDocument` row.
5. Wrap in a try/catch — partial failures log warnings but don't leave orphaned DB records. The DB delete is the last step so vector/storage orphans are preferred over DB orphans (vector/storage orphans are harmless; DB records referencing deleted vectors would cause search errors).

### 4.2 Q&A Reports

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/admin/qa/interactions` | Paginated Q&A interactions with filters | Admin |
| GET | `/admin/qa/interactions/{id}` | Full interaction detail with audit trail | Admin |
| GET | `/admin/qa/metrics` | Aggregated Q&A metrics | Admin |
| GET | `/admin/qa/export` | CSV export with filters | Admin |

#### GET `/admin/qa/interactions`

```typescript
// Input (query params)
z.object({
  locationId: z.bigint().optional(),
  answerStatus: z.enum(["answered", "no_answer", "failed"]).optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  searchText: z.string().optional(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(20),
})
```

#### GET `/admin/qa/metrics`

```typescript
// Input (query params)
z.object({
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  locationId: z.bigint().optional(),
})

// Output
z.object({
  totalQuestions: z.number(),
  answeredCount: z.number(),
  noAnswerCount: z.number(),
  failedCount: z.number(),
  answerRate: z.number(), // 0.0–1.0
  avgResponseTimeMs: z.number(),
  questionsByDay: z.array(z.object({
    date: z.string(),
    count: z.number(),
  })),
})
```

### 4.3 Location Config — Q&A Toggle

Extend the existing location config admin procedures:

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| PATCH | `/admin/locations/{id}/qa-config` | Toggle Q&A enabled, set timeout | Admin |

```typescript
// Input
z.object({
  qaEnabled: z.boolean().optional(),
  conversationTimeoutMinutes: z.number().int().min(15).max(1440).optional(),
})
```

---

## 5. SMS Flow Changes

### 5.1 Revised Webhook Handler Flow

The existing webhook handler at `packages/api/modules/sms/procedures/twilio-webhook.ts` (371 lines) is modified to insert a branching point after contact management and before classification.

**Current flow (simplified):**
```
Validate → Idempotency → Location Lookup → Contact Upsert → Keywords →
Rate Limit → [Transaction: Contact, Message, Classify, Feedback] → Response SMS
```

**New flow:**
```
Validate → Idempotency → Location Lookup → Contact Upsert → Keywords →
Rate Limit → Resolve Conversation →
  IF qaEnabled:
    Classify Intent →
      CASE feedback:          existing feedback pipeline (unchanged)
      CASE question:          Q&A pipeline
      CASE follow_up_feedback: existing feedback pipeline (with conversationId)
      CASE follow_up_question: Q&A pipeline (with conversation context)
  ELSE:
    existing feedback pipeline (unchanged, qaEnabled=false is the default)
→ Response SMS
```

The key structural change: a new `routeByIntent` function wraps the existing classification logic and the new Q&A logic. The existing feedback path is **not modified** — it is called as-is when intent is feedback.

### 5.2 Intent Classification

New function in `packages/sms/lib/intent-classifier.ts`:

```typescript
export type MessageIntent =
  | "feedback"
  | "question"
  | "follow_up_feedback"
  | "follow_up_question";

export interface IntentClassificationResult {
  intent: MessageIntent;
  confidence: number;
}

export async function classifyIntent(
  messageBody: string,
  conversationHistory: ConversationMessage[] | null,
): Promise<IntentClassificationResult>
```

**Prompt design:**
- System prompt instructs the model to classify the message as one of the four intents.
- If `conversationHistory` is provided, it's included in the prompt so the model can distinguish follow-ups from new messages.
- If `conversationHistory` is null or empty, only `"feedback"` or `"question"` are valid outputs (no follow-ups without prior context).
- Same sanitization and safety settings as existing `classifyFeedback`.
- 5-second timeout with fallback to `"feedback"` (safe default — preserves existing behavior).

### 5.3 Q&A Pipeline

When intent is `"question"` or `"follow_up_question"`, the Q&A pipeline executes:

```
1. Create qaInteraction record (status: "searching")
2. Generate embedding for the question text
3. Search Qdrant (tenantId filter, top-k=5)
4. IF no results above relevance threshold (0.65):
     → Update qaInteraction (status: "no_answer")
     → Send "no answer" SMS response
5. ELSE:
     → Record source citations
     → Update qaInteraction (status: "generating")
     → Build RAG prompt with retrieved chunks + conversation context
     → Call Gemini for answer generation (15s timeout)
     → Update qaInteraction (status: "answered", answerText, token counts, timing)
     → Send answer SMS response
6. On any failure:
     → Update qaInteraction (status: "failed")
     → Send fallback SMS ("We're having trouble answering right now. Please try again later.")
```

### 5.4 Document Processing Pipeline

Triggered by the `/admin/knowledge-base/{id}/process` endpoint. Runs asynchronously via a fire-and-forget async function (not a separate job queue — see Open Questions §10.5).

```
1. Download file from GCS/MinIO
2. Extract text (pdf-parse | mammoth | fs.readFile)
3. Chunk text (500 tokens, 50 overlap, sentence boundaries)
4. Generate embeddings for all chunks (batched, 20 chunks per API call)
5. Upsert vectors to Qdrant with payload: { tenantId, documentId, chunkIndex }
6. Insert knowledgeBaseChunk rows
7. Update knowledgeBaseDocument: status="indexed", chunkCount, processedAt
8. On failure at any step:
     → Update knowledgeBaseDocument: status="failed", errorMessage
     → Clean up any partial Qdrant upserts
```

### 5.5 Conversation Context for Follow-ups

When the intent is `"follow_up_question"`, the RAG prompt includes:
- The last N messages from the conversation (configurable, default 4).
- The previous Q&A interaction's answer text (if it was a follow-up to a Q&A).
- This provides the LLM with conversational context to interpret references like "What about the return policy?" after asking "How do I exchange an item?"

The conversation context is retrieved via `getConversationMessages` and included in the RAG prompt's system message.

---

## 6. UI Components

### 6.1 Knowledge Base Management Page

**Location:** `apps/web/app/(saas)/app/(account)/admin/knowledge-base/page.tsx`

Components:

#### `KnowledgeBaseList` (client component)
- Document table with columns: Filename, Type, Size, Status, Uploaded By, Upload Date, Actions
- Status badge with color coding: processing (blue/spinner), indexed (green), failed (red), uploaded (gray)
- Upload button opens `DocumentUploadDialog`
- Delete button with confirmation dialog
- Polling for documents in "processing" status (5-second interval)
- Pagination (reuse existing pagination pattern from feedback list)

#### `DocumentUploadDialog` (client component)
- File picker restricted to .pdf, .txt, .docx
- File size validation (client-side, max 50MB)
- Upload flow:
  1. Call `/admin/knowledge-base/upload` to get signed URL
  2. PUT file directly to signed URL (client-side upload)
  3. Call `/admin/knowledge-base/{id}/process` to trigger processing
  4. Close dialog, document appears in list with "processing" status

#### `DocumentStatusBadge` (server component)
- Renders status with appropriate color and optional spinner for "processing"

### 6.2 Q&A Reports Page

**Location:** `apps/web/app/(saas)/app/(account)/admin/qa/page.tsx`

Components:

#### `QaMetricsSummary` (server component)
- Cards: Total Questions, Answer Rate (%), Unanswered Rate (%), Avg Response Time
- Sparkline or simple chart for questions-per-day trend

#### `QaInteractionList` (client component)
- Table columns: Date, Location, Question (truncated), Answer Status, Response Time, Actions
- Filters via nuqs (consistent with existing feedback filter pattern):
  - Location selector
  - Answer status (all | answered | no_answer | failed)
  - Date range picker
- Answer status badge with color coding
- Click row → navigate to detail view
- Export button (CSV)

#### `QaInteractionDetail` — Detail Page

**Location:** `apps/web/app/(saas)/app/(account)/admin/qa/[id]/page.tsx`

- Full question text
- Full answer text (or "No answer" / "Failed" indicator)
- Conversation context (previous messages in the conversation)
- Source citations: list of documents/chunks used, with relevance scores
- Timing breakdown: search time, generation time, total response time
- Token usage (prompt + completion)
- Link to the contact's conversation history

### 6.3 Location Config — Q&A Toggle

Extend the existing location settings UI to include:
- "Enable Q&A" toggle switch
- "Conversation Timeout" number input (minutes, shown when Q&A is enabled)

This belongs in the existing location config editing interface, not a separate page.

### 6.4 Navigation

Add to the admin sidebar:
- "Knowledge Base" link → `/admin/knowledge-base`
- "Q&A Reports" link → `/admin/qa`

Both under a new "Q&A" section in the sidebar, below the existing "Feedback" section.

---

## 7. Integration Points

### 7.1 Multi-Tenancy

Every new entity (document, chunk, conversation, interaction, citation) includes `tenantId` with CASCADE delete. Every query function requires `tenantId` as the first parameter. Qdrant queries include a mandatory `tenantId` filter — there is no code path that searches across tenants.

The Qdrant vector store wrapper enforces this at the API level:

```typescript
async function searchKnowledgeBase(
  tenantId: bigint, // required, always first param
  query: string,
  topK: number = 5,
): Promise<SearchResult[]>
```

### 7.2 Auth and Authorization

- All admin endpoints use `adminProcedure` → `requireAdmin()` middleware.
- Document upload, deletion, and Q&A config changes require admin role.
- Q&A reports viewing requires admin role (consistent with existing feedback reports).
- No new roles or permissions are introduced — the existing `owner | admin` check from `requireAdmin()` is sufficient.

### 7.3 Storage

- Document files stored via the existing storage abstraction (`packages/storage/`).
- New bucket or path prefix: `knowledge-base/{tenantId}/{documentId}/{filename}`.
- Signed URL generation for upload uses existing `generateSignedUploadURL` pattern with content-type awareness.
- Document download for processing uses server-side storage client (not signed URLs).

### 7.4 Existing SMS Flow

- The existing feedback pipeline is **wrapped, not modified**. When `qaEnabled` is false (the default), the webhook handler behaves identically to today.
- When `qaEnabled` is true, the intent classifier runs first. If intent is `"feedback"` or `"follow_up_feedback"`, the existing `classifyFeedback` function is called exactly as before.
- The `smsMessage` record creation is unchanged — it just gains two new nullable columns (`conversationId`, `messageIntent`).

### 7.5 Existing AI Integration

- Intent classification reuses the Gemini client infrastructure (retries, timeout, safety settings, input sanitization) from `packages/sms/lib/gemini-client.ts`.
- Embedding generation uses the same `@google/generative-ai` SDK.
- RAG answer generation is a new function but follows the same error handling patterns.

### 7.6 PII Compliance

- The existing `maskPhoneNumber` function is used in all logging related to Q&A interactions.
- Question text and answer text are stored in the database (required for audit trail) but are never logged in full — only truncated previews in debug logs.
- Knowledge base content is tenant-owned — admins upload it, so it's not PII-sensitive in the SMS sense. However, if documents contain PII, that's the tenant's responsibility.

---

## 8. Edge Cases and Error Handling

### 8.1 No Relevant Answer Found

When vector search returns no results above the relevance threshold (0.65):
- Record `qaInteraction.answerStatus = "no_answer"` with `searchResultCount = 0`.
- Send a configurable SMS: *"I wasn't able to find an answer to your question. A team member will follow up with you."*
- The "no answer" message is a constant in the SMS package, similar to `HELP_MESSAGE`.

### 8.2 Document Processing Failures

- If text extraction fails (corrupted PDF, password-protected file), set document status to `"failed"` with a descriptive `errorMessage`.
- If embedding generation fails mid-batch, clean up any partially upserted vectors from Qdrant, set status to `"failed"`.
- Admins can delete and re-upload failed documents. There is no automatic retry for processing — it's admin-initiated.

### 8.3 Conversation Context Staleness

- Conversations expire after the configured timeout (default 2 hours). After expiry, a new message starts a fresh conversation.
- The `expiresAt` timestamp is recalculated on every new message in the conversation (`lastMessageAt + timeoutMinutes`).
- If the conversation has expired between the time of lookup and the time of processing (race condition window is <1 second in practice), treat as a new conversation.

### 8.4 Rate Limiting for Q&A

The existing rate limiter (5 msgs / 10 min sliding window) applies to all inbound messages including questions. Q&A does not get a separate rate limit — a question counts as a message. This prevents abuse of the Q&A feature.

If rate limiting becomes a concern specifically for Q&A (e.g., expensive Qdrant queries), a separate Q&A-specific rate limit can be added later. For now, the existing limit is sufficient.

### 8.5 Answer Generation Timeout

RAG answer generation uses a 15-second timeout (3x the classification timeout). If the timeout fires:
- Log the timeout with context.
- Set `qaInteraction.answerStatus = "failed"`.
- Send fallback SMS: *"I'm having trouble getting you an answer right now. Please try again in a few minutes."*

### 8.6 Empty Knowledge Base

If a tenant has Q&A enabled but no indexed documents:
- The vector search returns 0 results.
- This routes through the "no answer" path (§8.1).
- Consider adding a warning in the admin UI when Q&A is enabled but no documents are indexed.

### 8.7 Document Deletion While Q&A In Progress

If an admin deletes a document while a Q&A interaction is being processed:
- The chunks may have already been retrieved from Qdrant. The answer generation proceeds with whatever context was retrieved.
- The `qaSourceCitation` records reference the now-deleted `documentId`. The FK uses CASCADE, so the citation rows are deleted along with the document. This means the audit trail for that specific interaction loses its source citations.
- **Mitigation:** The `qaSourceCitation.chunkContent` column stores a snapshot of the chunk text at query time, so the audit trail preserves *what* content was used even if the source document is later deleted.

### 8.8 Concurrent Message Processing

Two messages from the same contact arriving nearly simultaneously could both try to create a conversation. The `findActiveConversation` → `createConversation` sequence uses a database transaction with a unique constraint on `(contactId, locationId, status='active')` to prevent duplicate active conversations. The second transaction will find the conversation created by the first.

### 8.9 SMS Character Limits

SMS has a 160-character limit per segment. LLM-generated answers may exceed this. Twilio handles multi-segment concatenation transparently, but long answers cost more and may be truncated on some carriers. The RAG prompt instructs the LLM to keep answers concise (under 300 characters). If the generated answer exceeds 480 characters (3 SMS segments), it's truncated with "..." and the full answer is stored in the database.

---

## 9. Migration Strategy

### 9.1 Phased Rollout

**Phase 1 — Schema + Backend (no user-facing changes)**
1. Run database migration to create new tables and add new columns.
2. Deploy `packages/knowledge-base` and new query modules.
3. Deploy updated webhook handler with the feature gated behind `qaEnabled` (default: false).
4. All existing functionality is completely unchanged — no tenant sees any difference.

**Phase 2 — Admin UI**
1. Deploy knowledge base management page.
2. Deploy Q&A reports page (initially empty — no data yet).
3. Deploy location config Q&A toggle.
4. Admins can now upload documents and enable Q&A per-location, but no tenant has it enabled yet.

**Phase 3 — Pilot Activation**
1. Enable Q&A for a single pilot location on a single tenant.
2. Monitor: intent classification accuracy, answer quality, response times, error rates.
3. Iterate on prompts, relevance threshold, and timeout values based on real data.

**Phase 4 — Gradual Expansion**
1. Enable Q&A for additional locations/tenants based on pilot results.
2. The per-location `qaEnabled` toggle gives fine-grained control.

### 9.2 Backward Compatibility

- `smsMessage.messageIntent` is nullable — existing rows have `null`, treated as `"feedback"`.
- `smsMessage.conversationId` is nullable — existing messages have no conversation.
- `smsLocationConfig.qaEnabled` defaults to `false` — existing locations are unaffected.
- The webhook handler's existing path is untouched when `qaEnabled` is false.
- No changes to existing API endpoint signatures or response shapes.

### 9.3 Rollback Plan

- If Q&A causes issues: set `qaEnabled = false` on affected locations. Immediate effect — next inbound message routes through the existing feedback-only pipeline.
- The schema changes are additive (new tables, new nullable columns). They don't need to be rolled back even if the feature is disabled.
- Qdrant is an independent service — it can be left idle without cost impact (Qdrant Cloud charges by storage, which is negligible for an unused collection).

---

## 10. Open Questions

### 10.1 Vector Database Selection — Final Approval

Qdrant Cloud is recommended. Alternatives: Pinecone (simpler API, outside GCP), Vertex AI Vector Search (GCP-native, more ops overhead). Need stakeholder input on:
- Acceptable vendor dependencies outside GCP?
- Budget constraints for the vector DB managed service?
- Data residency requirements that might constrain vendor choice?

### 10.2 Document Size and Count Limits

The plan assumes 50MB per document and no hard limit on document count per tenant. Should there be:
- A per-tenant document count limit?
- A per-tenant total storage quota?
- Restrictions on document content (e.g., no executable files masquerading as PDFs)?

### 10.3 "No Answer" Escalation

When the system can't answer a question, the plan sends a generic "no answer" message. Should there be:
- An escalation path (e.g., notify an admin or store manager)?
- A way for the customer to request human follow-up via the same SMS thread?
- Integration with an existing ticketing system?

### 10.4 Answer Quality Feedback Loop

Should customers be able to rate answers (e.g., "Was this helpful? Reply Y or N")? This would:
- Add a feedback step after Q&A answers.
- Provide signal for knowledge base improvement.
- Increase per-interaction SMS costs.
- Complicate the conversation flow (the rating reply itself needs to not be classified as a new question).

### 10.5 Background Processing Architecture

Document processing is fire-and-forget async in this plan. For production robustness, consider:
- A proper job queue (Cloud Tasks, BullMQ, or Pub/Sub) for document processing.
- Retry logic for transient embedding API failures.
- Dead letter handling for permanently failed documents.

The initial implementation uses async functions. If processing reliability becomes an issue, upgrading to Cloud Tasks is the recommended next step and is called out here as a known trade-off.

### 10.6 Conversation Timeout Value

The default conversation timeout is 2 hours. This is a guess. Should this be:
- Validated with real user behavior data?
- Different for Q&A vs. feedback conversations?
- Time-of-day aware (e.g., shorter during business hours, longer overnight)?

### 10.7 Multi-Language Support

The plan assumes English-language knowledge bases and questions. If multi-language is needed:
- `text-embedding-004` supports multilingual embeddings natively.
- RAG prompts would need language detection and language-appropriate response generation.
- This is additive and can be layered on later without architectural changes.

### 10.8 Cost Monitoring

Each Q&A interaction involves:
- One embedding API call (~$0.00002 per query)
- One Qdrant search (included in managed plan)
- One Gemini API call (~$0.0001–0.001 depending on context size)
- One outbound SMS (~$0.0075)

Should there be per-tenant cost tracking or spending limits for Q&A?

---

## 11. Implementation Sequence

### Sprint 1 — Foundation (est. 1–2 weeks)

| # | Task | Dependencies | Files |
|---|------|-------------|-------|
| 1.1 | Database schema: new tables + column additions | None | `packages/database/drizzle/schema/mysql.ts` |
| 1.2 | Generate and apply migration | 1.1 | `packages/database/drizzle/migrations/` |
| 1.3 | Query functions: conversation, knowledge base, Q&A | 1.2 | `packages/database/drizzle/queries/{conversation,knowledge-base,qa}.ts` |
| 1.4 | Qdrant client wrapper + config | None (parallel with 1.1) | `packages/knowledge-base/lib/vector-store.ts`, `packages/knowledge-base/config.ts` |
| 1.5 | Embedding generation module | None (parallel with 1.1) | `packages/knowledge-base/lib/embeddings.ts` |
| 1.6 | Text chunker | None (parallel with 1.1) | `packages/knowledge-base/lib/chunker.ts` |

### Sprint 2 — Document Processing + Knowledge Base API (est. 1–2 weeks)

| # | Task | Dependencies | Files |
|---|------|-------------|-------|
| 2.1 | Document processor (PDF/DOCX/TXT extraction) | 1.6 | `packages/knowledge-base/lib/document-processor.ts` |
| 2.2 | Document processing pipeline (extract → chunk → embed → store) | 1.3, 1.4, 1.5, 2.1 | `packages/knowledge-base/lib/document-processor.ts` |
| 2.3 | Admin API: document upload, list, get, delete, process | 1.3, 2.2 | `packages/api/modules/admin/procedures/knowledge-base/` |
| 2.4 | Admin UI: Knowledge Base management page | 2.3 | `apps/web/app/.../admin/knowledge-base/page.tsx` |
| 2.5 | Tests: chunker, embeddings, vector store, document processor | 2.2 | `packages/knowledge-base/__tests__/` |

### Sprint 3 — SMS Q&A Pipeline (est. 1–2 weeks)

| # | Task | Dependencies | Files |
|---|------|-------------|-------|
| 3.1 | Intent classifier | 1.3 | `packages/sms/lib/intent-classifier.ts` |
| 3.2 | Conversation manager (resolve/create/update) | 1.3 | `packages/sms/lib/conversation-manager.ts` |
| 3.3 | RAG answer generator | 1.4, 1.5 | `packages/knowledge-base/lib/rag-generator.ts` |
| 3.4 | Webhook handler modification (intent routing, Q&A pipeline) | 3.1, 3.2, 3.3 | `packages/api/modules/sms/procedures/twilio-webhook.ts` |
| 3.5 | Location config: qaEnabled toggle API | 1.2 | `packages/api/modules/admin/procedures/` |
| 3.6 | Tests: intent classifier, conversation manager, webhook integration | 3.4 | `packages/sms/__tests__/`, `packages/api/__tests__/` |

### Sprint 4 — Q&A Reports + Polish (est. 1 week)

| # | Task | Dependencies | Files |
|---|------|-------------|-------|
| 4.1 | Admin API: Q&A interactions list, detail, metrics, export | 1.3 | `packages/api/modules/admin/procedures/qa/` |
| 4.2 | Admin UI: Q&A reports page + detail view | 4.1 | `apps/web/app/.../admin/qa/page.tsx`, `apps/web/app/.../admin/qa/[id]/page.tsx` |
| 4.3 | Admin UI: Location config Q&A toggle | 3.5 | `apps/web/app/.../admin/locations/` |
| 4.4 | Admin sidebar navigation updates | 4.2 | `apps/web/app/.../admin/` layout component |
| 4.5 | End-to-end testing | 4.2 | Playwright tests |

### Sprint 5 — Pilot + Iterate (est. 1 week)

| # | Task | Dependencies | Files |
|---|------|-------------|-------|
| 5.1 | Pilot tenant setup (upload documents, enable Q&A on 1 location) | 4.* | Operational |
| 5.2 | Monitor metrics: classification accuracy, answer quality, latency | 5.1 | Dashboard review |
| 5.3 | Iterate: prompt tuning, relevance threshold, timeout values | 5.2 | Config changes |
| 5.4 | Documentation: operator runbook for knowledge base management | 5.1 | Docs |

---

## Appendix A — New Type Definitions

```typescript
// packages/sms/types.ts additions

export type MessageIntent =
  | "feedback"
  | "question"
  | "follow_up_feedback"
  | "follow_up_question";

export interface IntentClassificationResult {
  intent: MessageIntent;
  confidence: number;
}

export interface ConversationContext {
  conversationId: bigint;
  recentMessages: Array<{
    direction: "inbound" | "outbound";
    body: string;
    createdAt: Date;
    messageIntent?: MessageIntent;
  }>;
  lastQaInteraction?: {
    questionText: string;
    answerText: string | null;
    answerStatus: string;
  };
}
```

```typescript
// packages/knowledge-base/lib/types.ts

export interface ChunkResult {
  content: string;
  chunkIndex: number;
  tokenCount: number;
}

export interface SearchResult {
  chunkId: string;
  documentId: bigint;
  content: string;
  score: number;
}

export interface RagGenerationResult {
  answer: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  sources: SearchResult[];
}

export interface DocumentProcessingResult {
  documentId: bigint;
  chunkCount: number;
  status: "indexed" | "failed";
  errorMessage?: string;
}
```

## Appendix B — Environment Configuration Additions

```
# .env additions for knowledge-base feature
QDRANT_URL=http://localhost:6333          # Local dev (Docker)
QDRANT_API_KEY=                           # Empty for local, set for Qdrant Cloud
QDRANT_COLLECTION_PREFIX=tempo            # Collection naming prefix

# Qdrant Cloud (staging/prod) — managed via Secret Manager
# Secret: {project_slug}_{environment}_qdrant_url
# Secret: {project_slug}_{environment}_qdrant_api_key
```

Local development uses a Qdrant Docker container added to the existing `docker-compose.yml`:

```yaml
qdrant:
  image: qdrant/qdrant:v1.13.2
  ports:
    - "6333:6333"
    - "6334:6334"
  volumes:
    - qdrant_data:/qdrant/storage
```

## Appendix C — Qdrant Collection Schema

```typescript
// Vector collection configuration
{
  collectionName: `${projectSlug}-${environment}-knowledge-base`,
  vectorSize: 768,  // text-embedding-004 output dimension
  distance: "Cosine",
  payloadSchema: {
    tenantId: "integer",
    documentId: "integer",
    chunkIndex: "integer",
  },
  payloadIndexes: [
    { field: "tenantId", type: "integer" },   // mandatory filter
    { field: "documentId", type: "integer" },  // for document deletion
  ],
}
```
