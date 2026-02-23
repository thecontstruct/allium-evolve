# Plan Delta — SMS Q&A with Knowledge Base

**Author:** Plan Delta (AI-generated)
**Date:** 2026-02-22
**Status:** Draft

---

## 1. Architecture Decisions

### 1.1 Vector Database — Qdrant

**Choice:** Qdrant (self-hosted for dev, Qdrant Cloud for production)

**Justification:**
- The existing stack runs MySQL 8.4, which has no native vector search capability. A dedicated vector DB is required.
- Qdrant runs as a Docker container, fitting cleanly into the existing Docker Compose local dev setup (`DockerCompose` external entity already manages postgres, MinIO, and Cloud SQL Proxy services).
- Qdrant Cloud is a managed offering that avoids self-hosting operational burden in production, analogous to how the project uses Cloud SQL rather than self-managed MySQL.
- Alternative considered: **Pinecone** — fully managed and simpler, but vendor lock-in and no local dev option without mocking. **Vertex AI Vector Search** — GCP-native but has high minimum cost and complex provisioning for an early-stage feature.

**Configuration:**
- Local dev: Qdrant container in Docker Compose on port 6333/6334
- Production: Qdrant Cloud cluster (GCP region matching existing Cloud SQL)
- Single collection `knowledge_base_chunks` with `tenant_id` payload filter for multi-tenant isolation
- Note: per-tenant collections are an option at scale if query volume or isolation requirements demand it

### 1.2 Embedding Model — Gemini text-embedding-004

**Choice:** Google `text-embedding-004` via existing `@google/generative-ai` SDK

**Justification:**
- The `@google/generative-ai` package (`^0.21.0`) is already a dependency in `packages/sms`. The embedding API is available from the same SDK — no new dependency.
- 768-dimensional vectors, strong multilingual support
- Consistent with using Gemini for classification (gemini-2.5-flash)

### 1.3 Document Processing — Server-side extraction

**Choice:** Synchronous processing on upload confirmation, with async fallback via Cloud Tasks for large documents.

**Libraries:**
- **PDF:** `pdf-parse` (lightweight, well-maintained)
- **DOCX:** `mammoth` (clean text extraction, no binary dependencies)
- **TXT:** Native `Buffer.toString('utf-8')`

**Chunking strategy:**
- Fixed-size chunks of ~500 tokens with 50-token overlap
- Preserve paragraph boundaries where possible
- Each chunk stored as a row in MySQL (`kbChunk`) with its vector ID in Qdrant

**Justification:**
- Synchronous processing is acceptable for typical knowledge base documents (< 10MB). The signed URL upload pattern already handles large file transfer to storage — only the text extraction and embedding step runs server-side.
- Cloud Tasks provides an async path for documents that exceed a configurable size threshold (e.g., > 5MB), avoiding API timeout. This is GCP-native and requires no new infrastructure (no Redis, no BullMQ).

### 1.4 Conversation Management — TTL-based threading

**Choice:** Conversation threads with a configurable inactivity timeout (default: 30 minutes)

**Mechanism:**
- When a message arrives from a contact at a location, look for an active `qaConversation` where `lastActivityAt` is within the TTL window.
- If found, the LLM classifier receives the recent conversation history as context to determine if the message is a follow-up question, follow-up feedback, or unrelated.
- If no active conversation exists, the message is classified without conversation context (feedback or new question).
- Conversation is closed explicitly when the TTL expires (lazy close on next message) or when the contact sends a message classified as pure feedback.

### 1.5 Feature Gating

Q&A capability is **opt-in per tenant** via a configuration flag on the `smsLocationConfig` table. This ensures:
- Existing feedback-only tenants are unaffected
- Q&A can be enabled incrementally per location
- Rollback is a config change, not a code deployment

---

## 2. Database Schema Changes

All new tables follow existing conventions: `bigint` auto-increment PKs, `tenantId` FK with CASCADE delete, `camelCase` column names, `timestamp` audit columns.

### 2.1 New Tables

#### `kbDocument` — Knowledge Base Document

```typescript
export const kbDocument = mysqlTable("kb_document", {
  id: bigint("id", { mode: "bigint" }).primaryKey().autoincrement(),
  tenantId: bigint("tenant_id", { mode: "bigint" })
    .notNull()
    .references(() => tenant.id, { onDelete: "cascade" }),
  filename: varchar("filename", { length: 255 }).notNull(),
  originalFilename: varchar("original_filename", { length: 255 }).notNull(),
  contentType: varchar("content_type", { length: 100 }).notNull(),
  fileSize: int("file_size").notNull(),
  storagePath: varchar("storage_path", { length: 500 }).notNull(),
  status: mysqlEnum("status", ["processing", "indexed", "failed"])
    .notNull()
    .default("processing"),
  chunkCount: int("chunk_count").notNull().default(0),
  errorMessage: text("error_message"),
  uploadedBy: bigint("uploaded_by", { mode: "bigint" })
    .references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
}, (table) => [
  index("kb_doc_tenant_idx").on(table.tenantId),
  index("kb_doc_status_idx").on(table.tenantId, table.status),
]);
```

#### `kbChunk` — Knowledge Base Chunk (metadata; vectors in Qdrant)

```typescript
export const kbChunk = mysqlTable("kb_chunk", {
  id: bigint("id", { mode: "bigint" }).primaryKey().autoincrement(),
  tenantId: bigint("tenant_id", { mode: "bigint" })
    .notNull()
    .references(() => tenant.id, { onDelete: "cascade" }),
  documentId: bigint("document_id", { mode: "bigint" })
    .notNull()
    .references(() => kbDocument.id, { onDelete: "cascade" }),
  chunkIndex: int("chunk_index").notNull(),
  content: text("content").notNull(),
  vectorId: varchar("vector_id", { length: 100 }).notNull(),
  tokenCount: int("token_count"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("kb_chunk_tenant_idx").on(table.tenantId),
  index("kb_chunk_doc_idx").on(table.documentId),
  uniqueIndex("kb_chunk_vector_idx").on(table.vectorId),
]);
```

#### `qaConversation` — Q&A Conversation Thread

```typescript
export const qaConversation = mysqlTable("qa_conversation", {
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
  status: mysqlEnum("status", ["active", "closed"]).notNull().default("active"),
  messageCount: int("message_count").notNull().default(0),
  lastActivityAt: timestamp("last_activity_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("qa_conv_tenant_idx").on(table.tenantId),
  index("qa_conv_contact_idx").on(table.contactId, table.status),
  index("qa_conv_location_idx").on(table.locationId),
]);
```

#### `qaInteraction` — Individual Q&A Exchange (audit record)

```typescript
export const qaInteraction = mysqlTable("qa_interaction", {
  id: bigint("id", { mode: "bigint" }).primaryKey().autoincrement(),
  tenantId: bigint("tenant_id", { mode: "bigint" })
    .notNull()
    .references(() => tenant.id, { onDelete: "cascade" }),
  conversationId: bigint("conversation_id", { mode: "bigint" })
    .notNull()
    .references(() => qaConversation.id, { onDelete: "cascade" }),
  questionMessageId: bigint("question_message_id", { mode: "bigint" })
    .notNull()
    .references(() => smsMessage.id, { onDelete: "cascade" }),
  answerMessageId: bigint("answer_message_id", { mode: "bigint" })
    .references(() => smsMessage.id, { onDelete: "set null" }),
  questionText: text("question_text").notNull(),
  answerText: text("answer_text"),
  answerStatus: mysqlEnum("answer_status", ["answered", "unanswered", "error"])
    .notNull(),
  searchQuery: text("search_query"),
  searchResultCount: int("search_result_count"),
  confidenceScore: decimal("confidence_score", { precision: 3, scale: 2 }),
  responseTimeMs: int("response_time_ms"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("qa_int_tenant_idx").on(table.tenantId),
  index("qa_int_conv_idx").on(table.conversationId),
  index("qa_int_status_idx").on(table.tenantId, table.answerStatus),
  index("qa_int_created_idx").on(table.tenantId, table.createdAt),
]);
```

#### `qaSource` — Links answers to source chunks (audit trail)

```typescript
export const qaSource = mysqlTable("qa_source", {
  id: bigint("id", { mode: "bigint" }).primaryKey().autoincrement(),
  interactionId: bigint("interaction_id", { mode: "bigint" })
    .notNull()
    .references(() => qaInteraction.id, { onDelete: "cascade" }),
  documentId: bigint("document_id", { mode: "bigint" })
    .notNull()
    .references(() => kbDocument.id, { onDelete: "cascade" }),
  chunkId: bigint("chunk_id", { mode: "bigint" })
    .notNull()
    .references(() => kbChunk.id, { onDelete: "cascade" }),
  relevanceScore: decimal("relevance_score", { precision: 5, scale: 4 }),
  chunkContent: text("chunk_content").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("qa_src_interaction_idx").on(table.interactionId),
  index("qa_src_doc_idx").on(table.documentId),
]);
```

### 2.2 Modifications to Existing Tables

#### `smsLocationConfig` — Add Q&A feature flag

```typescript
// New column
qaEnabled: boolean("qa_enabled").notNull().default(false),
```

This is a nullable-safe addition. Existing rows default to `false` (Q&A disabled). Admins enable Q&A per location.

#### `smsMessage` — Add message type classification

```typescript
// New column
messageType: mysqlEnum("message_type", [
  "feedback",
  "question",
  "follow_up_question",
  "follow_up_feedback",
]).default("feedback"),
```

Nullable with default `"feedback"` — all existing messages continue to work. New messages get the classified type.

#### `smsMessage` — Add conversation FK (nullable)

```typescript
// New column
conversationId: bigint("conversation_id", { mode: "bigint" })
  .references(() => qaConversation.id, { onDelete: "set null" }),
```

Only populated for messages that are part of a Q&A conversation.

### 2.3 Indexes Summary

Key query patterns and the indexes supporting them:
- List documents by tenant + status → `kb_doc_status_idx`
- Find chunks by document → `kb_chunk_doc_idx`
- Find active conversation for contact → `qa_conv_contact_idx` (contactId, status)
- List interactions by date range + tenant → `qa_int_created_idx`
- Filter interactions by answer status → `qa_int_status_idx`
- Trace sources for an interaction → `qa_src_interaction_idx`

### 2.4 Migration

Generate via existing `drizzle-kit generate` workflow. This produces a single migration file adding:
- 5 new tables
- 3 new columns on existing tables
- All indexes

Non-breaking: all new columns have defaults or are nullable. No data backfill required.

---

## 3. New Packages/Modules

### 3.1 `packages/knowledge-base/` — New Package

**Purpose:** Encapsulates all knowledge base domain logic: document processing, vector storage, embeddings, semantic search, and RAG answer generation.

**Structure:**
```
packages/knowledge-base/
├── package.json
├── tsconfig.json
├── index.ts                     # Public exports
├── lib/
│   ├── document-processor.ts    # Text extraction from PDF/DOCX/TXT
│   ├── chunker.ts               # Text chunking with overlap
│   ├── embeddings.ts            # Gemini embedding generation
│   ├── vector-store.ts          # Qdrant client wrapper
│   ├── semantic-search.ts       # Search pipeline (embed query → search Qdrant → return chunks)
│   ├── rag-pipeline.ts          # Full RAG: search → build prompt → generate answer
│   └── types.ts                 # Shared types
├── __tests__/
│   ├── document-processor.test.ts
│   ├── chunker.test.ts
│   ├── embeddings.test.ts
│   ├── vector-store.test.ts
│   ├── semantic-search.test.ts
│   └── rag-pipeline.test.ts
```

**Dependencies:**
- `@google/generative-ai` (already in workspace — embedding API)
- `@qdrant/js-client-rest` (new — Qdrant REST client)
- `pdf-parse` (new — PDF text extraction)
- `mammoth` (new — DOCX text extraction)
- `@repo/database` (internal — schema types and queries)

**Key exports:**
- `processDocument(file: Buffer, contentType: string): Promise<string>` — extract text
- `chunkText(text: string, options?: ChunkOptions): TextChunk[]` — split into chunks
- `generateEmbedding(text: string): Promise<number[]>` — single embedding
- `generateEmbeddings(texts: string[]): Promise<number[][]>` — batch embeddings
- `indexDocument(tenantId: bigint, documentId: bigint, chunks: TextChunk[]): Promise<void>` — embed + store in Qdrant + create kbChunk rows
- `removeDocument(tenantId: bigint, documentId: bigint): Promise<void>` — delete vectors + chunk rows
- `searchKnowledgeBase(tenantId: bigint, query: string, topK?: number): Promise<SearchResult[]>` — semantic search
- `generateAnswer(tenantId: bigint, question: string, conversationHistory?: ConversationTurn[]): Promise<AnswerResult>` — full RAG pipeline

### 3.2 `packages/sms/lib/message-classifier.ts` — New Module (existing package)

**Purpose:** First-pass message type classification. Extends the existing Gemini client pattern.

**Behavior:**
- Receives message body + optional conversation history
- Returns `{ messageType: "feedback" | "question" | "follow_up_question" | "follow_up_feedback", confidence: number }`
- Uses Gemini 2.5 Flash (same model as feedback classification) with a purpose-built prompt
- 5-second timeout with fallback to `"feedback"` (safe default — preserves existing behavior)
- Same retry and safety settings as existing `classifyFeedback`

### 3.3 `packages/api/modules/knowledge-base/` — New API Module

**Purpose:** Admin API endpoints for knowledge base management.

**Structure:**
```
packages/api/modules/knowledge-base/
├── procedures/
│   ├── upload-url.ts        # Generate signed upload URL
│   ├── register-document.ts # Register uploaded document, trigger processing
│   ├── list-documents.ts    # Paginated document list
│   ├── get-document.ts      # Document detail
│   ├── delete-document.ts   # Delete with cascade
│   └── document-status.ts   # Processing status polling
├── router.ts                # Route definitions
└── schemas.ts               # Zod input/output schemas
```

### 3.4 `packages/api/modules/qa/` — New API Module

**Purpose:** Admin API endpoints for Q&A reporting and analytics.

**Structure:**
```
packages/api/modules/qa/
├── procedures/
│   ├── metrics.ts           # Dashboard aggregate metrics
│   ├── list-interactions.ts # Paginated interaction list with filters
│   ├── get-interaction.ts   # Interaction detail with sources
│   └── export.ts            # CSV export with filter preservation
├── router.ts
└── schemas.ts
```

### 3.5 Admin UI Pages (existing `apps/web/` package)

```
apps/web/app/(saas)/app/(account)/admin/
├── knowledge-base/
│   ├── page.tsx                 # Document list + upload
│   └── _components/
│       ├── DocumentList.tsx
│       ├── DocumentUploadDialog.tsx
│       ├── DocumentStatusBadge.tsx
│       └── DeleteDocumentDialog.tsx
├── qa/
│   ├── page.tsx                 # Q&A dashboard + interaction list
│   ├── [id]/
│   │   └── page.tsx             # Interaction detail
│   └── _components/
│       ├── QAMetricsCards.tsx
│       ├── QAInteractionList.tsx
│       ├── QAInteractionDetail.tsx
│       ├── QAFilterBar.tsx
│       └── QASourceList.tsx
```

---

## 4. API Endpoints

All endpoints use `adminProcedure` (authentication + admin/owner role required) and resolve tenant via `getEffectiveTenantFromContext`. Input validation via Zod schemas.

### 4.1 Knowledge Base Management

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/admin/knowledge-base/upload-url` | Generate signed upload URL for direct client upload | admin |
| POST | `/admin/knowledge-base/documents` | Register uploaded document, trigger processing pipeline | admin |
| GET | `/admin/knowledge-base/documents` | List documents (paginated, filterable by status) | admin |
| GET | `/admin/knowledge-base/documents/:id` | Document detail with chunk count, status | admin |
| DELETE | `/admin/knowledge-base/documents/:id` | Delete document (cascades: MySQL chunks, Qdrant vectors, storage file) | admin |
| GET | `/admin/knowledge-base/documents/:id/status` | Poll processing status (for upload progress UI) | admin |

**POST `/admin/knowledge-base/upload-url`**
```typescript
// Input
z.object({
  filename: z.string().min(1).max(255),
  contentType: z.enum([
    "application/pdf",
    "text/plain",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ]),
  fileSize: z.number().int().positive().max(20_000_000), // 20MB max
})

// Output
z.object({
  uploadUrl: z.string().url(),
  storagePath: z.string(),
  expiresAt: z.string().datetime(),
})
```

**POST `/admin/knowledge-base/documents`**
```typescript
// Input
z.object({
  filename: z.string(),
  originalFilename: z.string(),
  contentType: z.string(),
  fileSize: z.number(),
  storagePath: z.string(),
})

// Output
z.object({
  id: z.string(),
  status: z.enum(["processing", "indexed", "failed"]),
})
```

Processing is initiated synchronously. For documents under the size threshold, text extraction, chunking, and indexing happen within the request. For larger documents, a Cloud Tasks job is enqueued and the response returns `status: "processing"`.

**GET `/admin/knowledge-base/documents`**
```typescript
// Input (query params)
z.object({
  status: z.enum(["processing", "indexed", "failed"]).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
})

// Output
z.object({
  documents: z.array(documentSchema),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
})
```

**DELETE `/admin/knowledge-base/documents/:id`**

Cascade delete in a transaction:
1. Delete Qdrant vectors (by document_id filter)
2. Delete `kbChunk` rows
3. Delete storage object
4. Delete `kbDocument` row

Returns `{ success: boolean }`.

### 4.2 Q&A Reports

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/admin/qa/metrics` | Aggregate Q&A metrics | admin |
| GET | `/admin/qa/interactions` | Paginated interaction list with filters | admin |
| GET | `/admin/qa/interactions/:id` | Interaction detail with sources and conversation | admin |
| GET | `/admin/qa/export` | CSV export with active filters | admin |

**GET `/admin/qa/metrics`**
```typescript
// Input (query params)
z.object({
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  locationId: z.coerce.bigint().optional(),
})

// Output
z.object({
  totalQuestions: z.number(),
  answeredCount: z.number(),
  unansweredCount: z.number(),
  errorCount: z.number(),
  answerRate: z.number(),        // percentage
  unansweredRate: z.number(),    // percentage
  avgResponseTimeMs: z.number(),
  avgConfidence: z.number(),
})
```

**GET `/admin/qa/interactions`**
```typescript
// Input
z.object({
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  locationId: z.coerce.bigint().optional(),
  answerStatus: z.enum(["answered", "unanswered", "error"]).optional(),
  searchText: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
})

// Output
z.object({
  interactions: z.array(interactionSummarySchema),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
})
```

**GET `/admin/qa/interactions/:id`**
```typescript
// Output
z.object({
  interaction: interactionDetailSchema,
  sources: z.array(sourceSchema),
  conversation: z.array(conversationTurnSchema),
})
```

**GET `/admin/qa/export`**
Same filter inputs as `interactions`. Returns CSV with headers:
`Date, Location, Phone (masked), Question, Answer, Status, Confidence, Response Time (ms), Sources Used`

---

## 5. SMS Flow Changes

### 5.1 Modified Webhook Processing Flow

The webhook handler at `packages/api/modules/sms/procedures/twilio-webhook.ts` is restructured to branch after message creation:

```
Current flow:
  validate → idempotency → location → contact → keywords → rate limit →
  [transaction: upsert contact → create smsMessage → classify feedback → create smsFeedback] →
  generate response → send SMS

New flow:
  validate → idempotency → location → contact → keywords → rate limit →
  [transaction: upsert contact → create smsMessage] →
  check Q&A enabled (smsLocationConfig.qaEnabled) →
  ├── Q&A disabled: existing feedback path (classify → smsFeedback → response)
  └── Q&A enabled:
      ├── resolve conversation context (active qaConversation within TTL?)
      ├── classify message type (feedback | question | follow_up_question | follow_up_feedback)
      ├── update smsMessage.messageType
      └── branch on type:
          ├── "feedback": existing feedback path
          ├── "follow_up_feedback": feedback path + link to conversation
          ├── "question": Q&A path (new conversation if needed)
          └── "follow_up_question": Q&A path (existing conversation)
```

### 5.2 Q&A Processing Path (new)

```
Q&A path:
  1. Create or resume qaConversation
  2. Build conversation history (last N turns from qaConversation)
  3. Call RAG pipeline:
     a. Generate embedding for question (+ conversation context)
     b. Semantic search against tenant's knowledge base (top-K chunks)
     c. If no relevant results (below similarity threshold):
        → answerStatus = "unanswered"
        → Send "I couldn't find relevant information" SMS
     d. If results found:
        → Build LLM prompt with retrieved chunks as context
        → Generate answer (Gemini 2.5 Flash)
        → answerStatus = "answered"
        → Send answer SMS
  4. Create qaInteraction record
  5. Create qaSource records for each chunk used
  6. Update qaConversation.lastActivityAt and messageCount
  7. Create outbound smsMessage record for the answer SMS
```

### 5.3 Message Classifier Prompt Design

The classifier prompt includes:
- The incoming message text
- Whether the contact has an active conversation (boolean + recent turns if yes)
- The tenant/location context
- Clear definitions of each message type with examples

```
System: You classify incoming SMS messages. Given the message and conversation
context, determine the message type.

Types:
- "feedback": The sender is providing feedback, a complaint, suggestion, or
  comment about a product, service, or experience. No question is being asked.
- "question": The sender is asking a question seeking information or help.
  There is no prior Q&A conversation context.
- "follow_up_question": The sender is asking a follow-up question related to
  a previous Q&A exchange. Prior conversation context is provided.
- "follow_up_feedback": The sender is providing feedback about an answer they
  previously received. Prior conversation context is provided.

{conversation_context_block}

Message: "{message_body}"

Respond with JSON: { "messageType": "...", "confidence": 0.0-1.0 }
```

### 5.4 Existing SMS Types Extension

Add to `packages/sms/types.ts`:

```typescript
export type SmsMessageType =
  | "feedback"
  | "question"
  | "follow_up_question"
  | "follow_up_feedback";

export interface SmsMessageClassification {
  messageType: SmsMessageType;
  confidence: number;
}
```

---

## 6. UI Components

### 6.1 Knowledge Base Management — `/admin/knowledge-base`

**DocumentList (page.tsx + DocumentList.tsx)**
- Server component page that fetches initial document list
- Client component `DocumentList` with:
  - Table: filename, type icon, size (formatted), status badge, upload date, uploader name, actions column
  - Status filter dropdown (All, Processing, Indexed, Failed)
  - Pagination (matching existing feedback list pattern)
  - "Upload Document" button in header

**DocumentUploadDialog.tsx**
- Radix UI Dialog triggered by upload button
- File input accepting `.pdf, .txt, .docx`
- Client-side validation: file size (max 20MB), file type
- Upload flow:
  1. Request signed URL from API
  2. Upload directly to storage via signed URL (with progress bar)
  3. POST to register document endpoint
  4. Close dialog, refresh list
- Error handling with user-friendly messages

**DocumentStatusBadge.tsx**
- "Processing" — spinner + amber text
- "Indexed" — checkmark + green text
- "Failed" — X icon + red text with hover tooltip showing error message

**DeleteDocumentDialog.tsx**
- Radix UI AlertDialog with confirmation
- Shows document name and warns about irreversibility
- Calls DELETE endpoint on confirm

### 6.2 Q&A Reports — `/admin/qa`

**QAMetricsCards.tsx**
- 4-card grid layout (matching existing feedback metrics pattern):
  - Total Questions (count)
  - Answer Rate (percentage with trend indicator)
  - Unanswered Rate (percentage, highlighted if above threshold)
  - Avg Response Time (formatted as seconds)

**QAFilterBar.tsx**
- URL state management via `nuqs` (matching existing feedback filter pattern)
- Filters: Date range picker, Location selector, Answer status dropdown
- Filter state synced to URL for shareable/bookmarkable views

**QAInteractionList.tsx**
- Table: date, location, question (truncated), answer status badge, confidence, response time
- Clickable rows → navigate to detail view
- Visual highlighting for unanswered interactions (amber styling matching `FeedbackHighlightRule` pattern)
- Pagination
- Export button in header

**QAInteractionDetail.tsx (detail page: `/admin/qa/[id]`)**
- Conversation thread view (chat-bubble layout):
  - Inbound question (left-aligned)
  - Outbound answer (right-aligned)
  - Follow-up exchanges in sequence
- Metadata panel:
  - Confidence score
  - Response time
  - Answer status
  - Timestamp
- Source panel:
  - List of knowledge base documents/chunks used
  - Relevance score per source
  - Expandable chunk content preview
  - Link to source document in knowledge base

**QASourceList.tsx**
- Reusable component showing sources for an interaction
- Document name, chunk excerpt, relevance score bar
- Clicking document name navigates to KB document detail

---

## 7. Integration Points

### 7.1 SMS Flow (packages/sms ↔ packages/knowledge-base)

The webhook handler imports from `@repo/knowledge-base` to call `generateAnswer()`. The knowledge base package is a pure domain library — it does not know about SMS or Twilio. The webhook handler orchestrates:
- Calling the message classifier
- Calling the RAG pipeline
- Sending the SMS response
- Creating audit records

### 7.2 Auth / Multi-Tenancy

- All KB and QA endpoints use `adminProcedure` + `getEffectiveTenantFromContext`
- All database queries include `tenantId` parameter (matching existing query patterns)
- Qdrant searches filter by `tenant_id` payload field — no cross-tenant data leakage
- Document storage paths are tenant-scoped: `{bucket}/kb/{tenantId}/{documentId}/{filename}`

### 7.3 Storage (packages/storage)

- Document upload uses the existing signed URL pattern from `packages/storage`
- New storage path prefix: `kb/` (alongside existing paths like avatar uploads)
- Document deletion must clean up the storage object (via existing provider abstraction)
- CORS config on the KB storage bucket (or same bucket, separate path prefix)

### 7.4 AI (packages/ai)

- Embedding generation wraps the same `@google/generative-ai` SDK
- Answer generation uses Gemini 2.5 Flash (same model as classification)
- The RAG prompt is carefully constructed to constrain answers to knowledge base content only

### 7.5 Existing Feedback System

The feedback system is **untouched** for messages classified as "feedback" or "follow_up_feedback". The `smsFeedback` table, classification logic, and admin feedback UI continue to work identically. Follow-up feedback additionally gets a reference to the conversation it relates to (via `smsMessage.conversationId`).

---

## 8. Edge Cases and Error Handling

### 8.1 No Knowledge Base Documents

**Scenario:** Q&A is enabled for a location, but the tenant has no indexed documents.
**Handling:** Before entering the RAG pipeline, check if the tenant has any `kbDocument` with `status = "indexed"`. If not, fall back to feedback classification. This avoids unnecessary embedding generation and search calls.

### 8.2 No Relevant Answer Found

**Scenario:** Semantic search returns results, but all below the similarity threshold (e.g., < 0.65).
**Handling:** Record the interaction as `answerStatus: "unanswered"`, send a response like: *"I'm sorry, I don't have enough information to answer that question. Your message has been forwarded as feedback."* Then classify and record as feedback too, so it's actionable.

### 8.3 Document Processing Failures

**Scenario:** PDF is corrupt, DOCX is password-protected, file is empty.
**Handling:**
- Catch extraction errors, set `kbDocument.status = "failed"` with `errorMessage`
- Admin sees the failure in the document list with the error message
- Admin can delete and re-upload
- No partial chunks are created — processing is all-or-nothing within a transaction

### 8.4 Conversation Context Window

**Scenario:** A conversation has many turns, exceeding the LLM context window.
**Handling:** Only include the most recent N turns (suggest N=5) in the conversation context sent to both the classifier and the RAG pipeline. Older turns are still stored in the database for audit purposes.

### 8.5 SMS Character Limits

**Scenario:** LLM generates an answer longer than reasonable SMS length.
**Handling:**
- Instruct the LLM in the system prompt to keep answers under 300 characters
- If the answer exceeds 480 characters (3 SMS segments), truncate with "..." and append a note: *"For more detail, contact us at [location phone/email]."*
- Track `numSegments` on the outbound `smsMessage` record for cost monitoring

### 8.6 Rate Limiting for Q&A

**Scenario:** A contact sends many questions rapidly.
**Handling:** Use the existing sliding window rate limiter (`checkRateLimit`). Q&A messages count toward the same rate limit as feedback. If rate limited, respond with the existing rate limit message — do not process the Q&A. Consider: separate, lower Q&A rate limits may be warranted if LLM costs are a concern (open question).

### 8.7 Vector Store Unavailability

**Scenario:** Qdrant is down or unreachable.
**Handling:** Fall back to feedback classification path. Log the error with context. The message is not lost — it's recorded as a feedback item. Consider adding a `qaFallbackToFeedback` flag on the interaction for later reprocessing.

### 8.8 Concurrent Document Deletion During Search

**Scenario:** Admin deletes a document while a Q&A search is using its chunks.
**Handling:** The `qaSource.chunkContent` field stores a snapshot of the chunk text at answer time. Even if the source document/chunk is later deleted, the audit trail preserves what content was used. The FK on `qaSource.chunkId` uses `CASCADE` delete, but the snapshot text persists.

Wait — that's contradictory. If the chunk is deleted and the FK cascades, the `qaSource` row is also deleted. **Correction:** Change `qaSource.chunkId` FK to `SET NULL` instead of `CASCADE`, and make the column nullable. This preserves the audit record even after document deletion. The `chunkContent` snapshot provides the actual content. Update the schema:

```typescript
chunkId: bigint("chunk_id", { mode: "bigint" })
  .references(() => kbChunk.id, { onDelete: "set null" }),
```

### 8.9 Embedding API Failures

**Scenario:** Gemini embedding API returns an error or times out during document indexing.
**Handling:** Retry with exponential backoff (3 attempts, matching existing Gemini client pattern). If all retries fail, set `kbDocument.status = "failed"` with the error message. No partial indexing — chunks are only committed to Qdrant and MySQL after all embeddings succeed.

### 8.10 Tenant Data Isolation in Qdrant

**Scenario:** A Qdrant query accidentally returns chunks from another tenant.
**Handling:** All Qdrant queries include a mandatory `must` filter on `tenant_id`. The `searchKnowledgeBase` function enforces this at the API level — `tenant_id` is not optional. Additionally, document deletion removes all vectors for that document using a `document_id` + `tenant_id` filter.

---

## 9. Migration Strategy

### Phase 1: Schema + Infrastructure (non-breaking)
1. Add new tables via Drizzle migration
2. Add new columns to existing tables (nullable/defaulted — non-breaking)
3. Add Qdrant to Docker Compose for local dev
4. Provision Qdrant Cloud for staging/production
5. Create Qdrant collection with schema

### Phase 2: Knowledge Base Backend (no SMS flow changes)
1. Implement `packages/knowledge-base/` package
2. Implement KB API endpoints (`packages/api/modules/knowledge-base/`)
3. Deploy — admins can upload documents, but Q&A is not yet active

### Phase 3: Knowledge Base Admin UI
1. Build KB management pages
2. Deploy — admins can manage documents through the UI
3. Tenants begin populating their knowledge bases

### Phase 4: Q&A Pipeline (behind feature flag)
1. Implement message classifier
2. Implement Q&A processing path in webhook handler
3. Gate behind `smsLocationConfig.qaEnabled = false` (default)
4. Deploy — existing behavior unchanged

### Phase 5: Q&A Activation + Reporting
1. Build Q&A reporting endpoints and UI
2. Enable Q&A for a pilot tenant/location
3. Monitor metrics, tune similarity thresholds, adjust prompts
4. Gradual rollout to additional tenants

### Rollback Plan
- **Phase 4 rollback:** Set `qaEnabled = false` on affected locations. All messages revert to feedback classification. No code deployment needed.
- **Phase 2-3 rollback:** KB tables and Qdrant data are independent. Removing the feature only requires disabling the Q&A flag.
- **Data preservation:** All existing `smsFeedback` records are untouched. Messages classified as questions during pilot still have their `smsMessage` records.

---

## 10. Open Questions

1. **Q&A feature gating granularity** — Per-tenant, per-location, or both? Current plan assumes per-location via `smsLocationConfig.qaEnabled`. Should there be a tenant-level kill switch too?

2. **Conversation timeout duration** — Proposed default: 30 minutes. Should this be configurable per tenant? Per location? Or a global system default?

3. **Document size limits** — Proposed: 20MB max per file. Is this sufficient for the expected document types? Should there be a per-tenant total storage quota?

4. **Maximum documents per tenant** — Should there be a limit? If so, what's the expected knowledge base size?

5. **Answer citation in SMS** — Should the SMS answer include a reference to the source document name? This adds length but improves transparency. Example: *"Based on our policy guide: ..."*

6. **Q&A rate limiting** — Should Q&A have separate (possibly lower) rate limits than feedback, given higher per-message cost (embedding + LLM generation)?

7. **Unanswered question escalation** — When a question can't be answered, should it be silently recorded, forwarded as feedback, or trigger a notification to an admin?

8. **Human-in-the-loop review** — Should there be an option for admins to review/approve answers before they're sent? This adds latency but reduces risk for sensitive domains.

9. **Supported languages** — The embedding model and Gemini support multiple languages. Should the system explicitly handle non-English questions, or is English-only acceptable for the initial release?

10. **Vector search tuning** — Similarity threshold for "relevant" results (proposed: 0.65), top-K results to retrieve (proposed: 5), chunk size (proposed: 500 tokens). These should be validated with real data during pilot.

11. **Qdrant hosting model** — Qdrant Cloud vs. self-hosted on GCE/GKE. Cloud is simpler but adds a vendor dependency. Self-hosted gives more control but requires operational investment.

12. **Document versioning** — If an admin uploads an updated version of the same document, should it replace the existing one or create a new record? Current plan: new record (admin deletes old one manually).

---

## 11. Implementation Sequence

```
Phase 1: Foundation                           ~1 week
├── 1.1 Database schema migration              │ no dependencies
├── 1.2 Qdrant Docker Compose setup            │ no dependencies
├── 1.3 Qdrant Cloud provisioning (staging)    │ no dependencies
└── 1.4 packages/knowledge-base/ scaffolding   │ no dependencies

Phase 2: Knowledge Base Core                  ~2 weeks
├── 2.1 Document processor (PDF/DOCX/TXT)      │ depends on 1.4
├── 2.2 Text chunker                           │ depends on 1.4
├── 2.3 Embedding client                       │ depends on 1.4
├── 2.4 Vector store client (Qdrant)           │ depends on 1.2, 1.4
├── 2.5 Semantic search pipeline               │ depends on 2.3, 2.4
├── 2.6 Database queries (kbDocument, kbChunk)  │ depends on 1.1
└── 2.7 Unit + integration tests               │ depends on 2.1-2.6

Phase 3: KB API + Admin UI                    ~1.5 weeks
├── 3.1 KB API endpoints                       │ depends on 2.1-2.6
├── 3.2 Document upload flow (signed URL)       │ depends on 3.1
├── 3.3 KB management admin pages               │ depends on 3.1
└── 3.4 KB e2e tests                            │ depends on 3.3

Phase 4: Q&A Pipeline                        ~2 weeks
├── 4.1 Message type classifier                 │ depends on 1.1
├── 4.2 RAG pipeline (search → prompt → answer) │ depends on 2.5
├── 4.3 Conversation management logic           │ depends on 1.1
├── 4.4 Webhook handler refactor                │ depends on 4.1, 4.2, 4.3
├── 4.5 Q&A audit trail (qaInteraction, qaSource)│ depends on 4.4
├── 4.6 qaEnabled feature flag on location config│ depends on 1.1
└── 4.7 SMS flow integration tests              │ depends on 4.4

Phase 5: Reporting + Polish                   ~1.5 weeks
├── 5.1 Q&A metrics API endpoint                │ depends on 4.5
├── 5.2 Q&A interaction list/detail endpoints    │ depends on 4.5
├── 5.3 Q&A export endpoint                     │ depends on 5.2
├── 5.4 Q&A admin dashboard pages               │ depends on 5.1, 5.2
├── 5.5 Q&A detail page with source display     │ depends on 5.2
└── 5.6 URL state management for Q&A filters    │ depends on 5.4

Phase 6: Pilot + Tuning                      ~1 week
├── 6.1 Enable for pilot tenant/location        │ depends on 5.*
├── 6.2 Monitor metrics, tune thresholds        │ depends on 6.1
├── 6.3 Prompt refinement based on real data    │ depends on 6.1
└── 6.4 Gradual rollout                         │ depends on 6.2, 6.3
```

**Critical path:** 1.1 → 2.3/2.4 → 2.5 → 4.2 → 4.4 → 4.5 → 5.1-5.5

**Parallelizable:**
- Phase 1 tasks are all independent
- Phase 2: document processor (2.1-2.2) and vector store (2.3-2.4) can proceed in parallel
- Phase 3 (KB UI) and Phase 4.1 (classifier) can start concurrently
- Phase 5 (reporting) can begin as soon as Phase 4.5 (audit trail) is complete

**Estimated total:** ~8-9 weeks for a single developer, ~5-6 weeks with two developers working in parallel on KB/UI and Q&A pipeline tracks.
