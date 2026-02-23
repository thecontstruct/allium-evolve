# Plan Beta — SMS Q&A with Knowledge Base

**Author:** AI Planning Agent
**Date:** 2026-02-22
**Status:** Draft

---

## Table of Contents

1. [Architecture Decisions](#1-architecture-decisions)
2. [Database Schema Changes](#2-database-schema-changes)
3. [New Packages/Modules](#3-new-packagesmodules)
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

### 1.1 Vector Database — Qdrant

**Choice:** Qdrant (self-hosted via Docker Compose for local dev, Cloud Run or Compute Engine for production)

**Justification:**
- The existing stack runs MySQL 8.4, which has no native vector search capability. pgvector is PostgreSQL-only and irrelevant here.
- Qdrant is open-source, has a first-class REST/gRPC API, and a well-maintained Node.js client (`@qdrant/js-client-rest`).
- Fits the existing Docker Compose local development model (MinIO, MySQL already run as containers).
- Can deploy as a single Cloud Run service or Compute Engine instance with persistent disk for production.
- Lightweight enough for the expected knowledge base sizes (tenant-managed document collections, not billions of vectors).

**Alternatives considered:**
- **Pinecone (managed):** Lower operational burden but introduces a non-GCP external dependency, vendor lock-in, and a per-tenant namespace management concern. Cost scales per-pod regardless of usage.
- **Vertex AI Vector Search:** Deeply integrated with GCP but designed for massive-scale use cases, has a complex setup (index endpoints, deployed indexes), and the Node.js SDK ergonomics are weaker. Overkill for document-scale knowledge bases.
- **ChromaDB:** Simpler but less mature in production deployments, limited filtering capabilities per-collection.
- **MySQL JSON column with application-side cosine similarity:** Would work for very small knowledge bases but is O(n) per query with no index. Unacceptable beyond a few hundred documents per tenant.

### 1.2 Embedding Model — Gemini Embeddings

**Choice:** `text-embedding-004` via the existing `@google/generative-ai` SDK

**Justification:**
- Already have `@google/generative-ai` as a dependency in `packages/sms` and `packages/ai`.
- `text-embedding-004` produces 768-dimensional embeddings, well-suited for semantic search.
- No new API keys or billing accounts required — reuses existing Gemini API quota.
- Consistent provider for both classification (gemini-2.5-flash) and embedding generation.

**Alternative considered:**
- **OpenAI `text-embedding-3-small`:** Already have OpenAI SDK v6.6.0 in the stack. Would work, but adds a second AI provider dependency to the SMS flow. Gemini embeddings keep the entire Q&A pipeline on a single provider.

### 1.3 Document Processing — Server-side Extraction

**Choice:** Extract text server-side using `pdf-parse` (PDF), `mammoth` (DOCX), and raw `fs` (TXT), then chunk and embed.

**Justification:**
- These are lightweight, pure-JS libraries with no native dependencies — compatible with Cloud Run's container model.
- Document processing is an infrequent admin operation (uploads), not a hot path.
- Processing happens asynchronously after upload, with status tracking.

**Chunking strategy:** Fixed-size chunks of ~500 tokens with ~50-token overlap. Chunk boundaries respect paragraph/sentence breaks where possible. Each chunk stores its source document ID and character offset range for auditability.

### 1.4 Conversation Context — Database-backed Thread Tracking

**Choice:** Track conversation threads via a `qaConversation` table linked to `smsContact`, with a configurable inactivity timeout (default: 30 minutes) that closes a conversation context.

**Justification:**
- SMS is inherently stateless per-message. Conversation context must be reconstructed from stored state.
- A database-backed approach fits the existing pattern (all SMS state is in MySQL).
- The inactivity timeout prevents stale context from producing confused answers hours or days later.
- Alternative (Redis-based session) adds infrastructure for a feature that doesn't need sub-millisecond latency.

### 1.5 LLM Answer Generation — Gemini with RAG

**Choice:** `gemini-2.5-flash` with a structured RAG prompt that includes retrieved knowledge base chunks as context.

**Justification:**
- Same model already used for feedback classification — proven integration, timeout/retry handling exists.
- The prompt will be structured to constrain answers to ONLY the provided context (no hallucination from training data).
- Fast enough for SMS response latency expectations (target: <5s total including search + generation).

---

## 2. Database Schema Changes

All new tables follow existing conventions: `bigint` auto-increment PKs, `tenantId` FK with `CASCADE` delete, `createdAt`/`updatedAt` timestamps, camelCase column naming.

### 2.1 New Tables

#### `qaKnowledgeDocument`

```typescript
export const qaKnowledgeDocument = mysqlTable("qa_knowledge_document", {
  id: bigint("id", { mode: "bigint" }).primaryKey().autoincrement(),
  tenantId: bigint("tenantId", { mode: "bigint" })
    .notNull()
    .references(() => tenant.id, { onDelete: "cascade" }),
  filename: varchar("filename", { length: 255 }).notNull(),
  originalFilename: varchar("originalFilename", { length: 255 }).notNull(),
  mimeType: varchar("mimeType", { length: 100 }).notNull(),
  fileSize: int("fileSize").notNull(), // bytes
  storagePath: varchar("storagePath", { length: 512 }).notNull(),
  storageBucket: varchar("storageBucket", { length: 255 }).notNull(),
  status: mysqlEnum("status", [
    "uploading",
    "processing",
    "chunking",
    "embedding",
    "indexed",
    "failed",
  ]).notNull().default("uploading"),
  errorMessage: text("errorMessage"),
  chunkCount: int("chunkCount").default(0),
  uploadedBy: bigint("uploadedBy", { mode: "bigint" })
    .references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => [
  index("idx_qa_doc_tenant").on(table.tenantId),
  index("idx_qa_doc_status").on(table.tenantId, table.status),
]);
```

#### `qaDocumentChunk`

```typescript
export const qaDocumentChunk = mysqlTable("qa_document_chunk", {
  id: bigint("id", { mode: "bigint" }).primaryKey().autoincrement(),
  tenantId: bigint("tenantId", { mode: "bigint" })
    .notNull()
    .references(() => tenant.id, { onDelete: "cascade" }),
  documentId: bigint("documentId", { mode: "bigint" })
    .notNull()
    .references(() => qaKnowledgeDocument.id, { onDelete: "cascade" }),
  chunkIndex: int("chunkIndex").notNull(),
  content: text("content").notNull(),
  charOffsetStart: int("charOffsetStart").notNull(),
  charOffsetEnd: int("charOffsetEnd").notNull(),
  tokenCount: int("tokenCount"),
  qdrantPointId: varchar("qdrantPointId", { length: 64 }), // UUID of vector in Qdrant
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_qa_chunk_doc").on(table.documentId),
  index("idx_qa_chunk_tenant").on(table.tenantId),
]);
```

#### `qaConversation`

```typescript
export const qaConversation = mysqlTable("qa_conversation", {
  id: bigint("id", { mode: "bigint" }).primaryKey().autoincrement(),
  tenantId: bigint("tenantId", { mode: "bigint" })
    .notNull()
    .references(() => tenant.id, { onDelete: "cascade" }),
  locationId: bigint("locationId", { mode: "bigint" })
    .notNull()
    .references(() => location.id, { onDelete: "cascade" }),
  contactId: bigint("contactId", { mode: "bigint" })
    .notNull()
    .references(() => smsContact.id, { onDelete: "cascade" }),
  status: mysqlEnum("status", ["active", "closed"]).notNull().default("active"),
  startedAt: timestamp("startedAt").defaultNow().notNull(),
  lastActivityAt: timestamp("lastActivityAt").defaultNow().notNull(),
  closedAt: timestamp("closedAt"),
  turnCount: int("turnCount").default(0).notNull(),
}, (table) => [
  index("idx_qa_conv_contact").on(table.contactId, table.status),
  index("idx_qa_conv_tenant").on(table.tenantId),
  index("idx_qa_conv_location").on(table.locationId),
]);
```

#### `qaInteraction`

The core audit record linking a question to its search, answer, and sources.

```typescript
export const qaInteraction = mysqlTable("qa_interaction", {
  id: bigint("id", { mode: "bigint" }).primaryKey().autoincrement(),
  tenantId: bigint("tenantId", { mode: "bigint" })
    .notNull()
    .references(() => tenant.id, { onDelete: "cascade" }),
  locationId: bigint("locationId", { mode: "bigint" })
    .notNull()
    .references(() => location.id, { onDelete: "cascade" }),
  conversationId: bigint("conversationId", { mode: "bigint" })
    .notNull()
    .references(() => qaConversation.id, { onDelete: "cascade" }),
  contactId: bigint("contactId", { mode: "bigint" })
    .notNull()
    .references(() => smsContact.id, { onDelete: "cascade" }),
  inboundMessageId: bigint("inboundMessageId", { mode: "bigint" })
    .notNull()
    .references(() => smsMessage.id, { onDelete: "cascade" }),
  outboundMessageId: bigint("outboundMessageId", { mode: "bigint" })
    .references(() => smsMessage.id, { onDelete: "set null" }),
  questionText: text("questionText").notNull(),
  answerText: text("answerText"),
  answerStatus: mysqlEnum("answerStatus", [
    "pending",
    "answered",
    "no_answer",
    "error",
  ]).notNull().default("pending"),
  searchQuery: text("searchQuery"), // the embedding query (may differ from raw question)
  searchResultCount: int("searchResultCount"),
  llmModel: varchar("llmModel", { length: 100 }),
  llmPromptTokens: int("llmPromptTokens"),
  llmCompletionTokens: int("llmCompletionTokens"),
  llmLatencyMs: int("llmLatencyMs"),
  searchLatencyMs: int("searchLatencyMs"),
  totalLatencyMs: int("totalLatencyMs"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_qa_int_tenant").on(table.tenantId),
  index("idx_qa_int_conv").on(table.conversationId),
  index("idx_qa_int_location").on(table.locationId),
  index("idx_qa_int_status").on(table.tenantId, table.answerStatus),
  index("idx_qa_int_created").on(table.tenantId, table.createdAt),
]);
```

#### `qaInteractionSource`

Links each interaction to the specific document chunks that contributed to the answer.

```typescript
export const qaInteractionSource = mysqlTable("qa_interaction_source", {
  id: bigint("id", { mode: "bigint" }).primaryKey().autoincrement(),
  interactionId: bigint("interactionId", { mode: "bigint" })
    .notNull()
    .references(() => qaInteraction.id, { onDelete: "cascade" }),
  chunkId: bigint("chunkId", { mode: "bigint" })
    .notNull()
    .references(() => qaDocumentChunk.id, { onDelete: "cascade" }),
  documentId: bigint("documentId", { mode: "bigint" })
    .notNull()
    .references(() => qaKnowledgeDocument.id, { onDelete: "cascade" }),
  similarityScore: decimal("similarityScore", { precision: 5, scale: 4 }).notNull(),
  rankPosition: int("rankPosition").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_qa_src_interaction").on(table.interactionId),
  index("idx_qa_src_document").on(table.documentId),
]);
```

### 2.2 Modifications to Existing Tables

**No modifications to existing tables.** The Q&A feature connects to the existing schema via foreign keys to `tenant`, `location`, `smsContact`, and `smsMessage`. This is intentional — the existing feedback flow remains completely untouched at the data layer.

### 2.3 Qdrant Collections

Per-tenant isolation is achieved via Qdrant collection naming: `kb_{tenantId}`.

Each collection:
- Vector dimension: 768 (text-embedding-004)
- Distance metric: Cosine
- Payload fields: `documentId` (bigint), `chunkId` (bigint), `chunkIndex` (int), `content` (string, for display)

Tenant isolation at the Qdrant level is enforced by always scoping operations to the tenant's collection. No cross-tenant queries are possible by construction.

---

## 3. New Packages/Modules

### 3.1 `packages/knowledge-base/` (New Package)

Core knowledge base operations, decoupled from HTTP/SMS concerns.

```
packages/knowledge-base/
├── index.ts                    # Public exports
├── package.json
├── lib/
│   ├── embeddings.ts           # Gemini embedding generation (single + batch)
│   ├── chunker.ts              # Text chunking with overlap + boundary detection
│   ├── document-processor.ts   # Text extraction from PDF/DOCX/TXT
│   ├── vector-store.ts         # Qdrant client wrapper (CRUD, search, collection management)
│   ├── rag-pipeline.ts         # Orchestrates: embed query → search → build context → generate answer
│   └── conversation-manager.ts # Conversation lifecycle (create, extend, close, timeout detection)
└── types.ts                    # Shared types for the knowledge base domain
```

**Dependencies:** `@qdrant/js-client-rest`, `@google/generative-ai` (already in monorepo), `pdf-parse`, `mammoth`

### 3.2 `packages/api/modules/qa/` (New API Module)

API procedures for Q&A admin operations.

```
packages/api/modules/qa/
├── index.ts                        # Module registration / router export
├── procedures/
│   ├── knowledge-base.ts           # Document CRUD, upload initiation, status
│   ├── qa-interactions.ts          # Q&A interaction queries, detail views
│   ├── qa-metrics.ts               # Aggregated Q&A metrics / dashboard data
│   └── qa-export.ts                # CSV export of Q&A interactions
└── schemas/
    ├── knowledge-base.schema.ts    # Zod schemas for KB endpoints
    ├── qa-interactions.schema.ts   # Zod schemas for interaction queries
    └── qa-metrics.schema.ts        # Zod schemas for metrics endpoints
```

### 3.3 `packages/database/drizzle/queries/qa/` (New Query Directory)

Database query functions following existing patterns.

```
packages/database/drizzle/queries/qa/
├── knowledge-documents.ts      # CRUD for qaKnowledgeDocument
├── document-chunks.ts          # CRUD for qaDocumentChunk
├── conversations.ts            # Conversation lifecycle queries
├── interactions.ts             # qaInteraction + qaInteractionSource queries
└── metrics.ts                  # Aggregation queries for Q&A dashboard
```

### 3.4 Extensions to Existing Packages

#### `packages/sms/` — New Exports

- `classifyMessageIntent(body: string, conversationContext?: ConversationContext): Promise<MessageIntentClassification>` — The enhanced classifier that distinguishes feedback vs. question vs. follow-up.
- `MessageIntent` type: `"feedback" | "new_question" | "follow_up_question" | "follow_up_feedback"`

#### `packages/sms/lib/gemini-client.ts` — Extended

Add a new function (not modify the existing `classifyFeedback`) for intent classification. The existing function remains unchanged for backward compatibility.

#### `packages/storage/` — No Changes Required

Document uploads use the existing storage abstraction. Documents are stored in a dedicated bucket path prefix: `knowledge-base/{tenantId}/{documentId}/{filename}`.

---

## 4. API Endpoints

All endpoints are tenant-scoped via `adminProcedure` + `getEffectiveTenantFromContext`. Authentication and authorization follow the existing pattern.

### 4.1 Knowledge Base Management

#### `POST /admin/qa/knowledge-base/upload-url`

Request a signed upload URL for a document. The client uploads directly to GCS/MinIO.

```typescript
// Input
{
  filename: string,        // "policy-manual.pdf"
  mimeType: string,        // "application/pdf"
  fileSize: number,        // bytes
}

// Output
{
  uploadUrl: string,       // Signed URL for PUT upload
  documentId: bigint,      // Pre-created document record ID
  storagePath: string,     // The object path in the bucket
}
```

#### `POST /admin/qa/knowledge-base/{documentId}/process`

Trigger document processing after upload completes. This kicks off the async pipeline: extract → chunk → embed → index.

```typescript
// Input
{ documentId: bigint }

// Output
{ status: "processing" }
```

#### `GET /admin/qa/knowledge-base`

List documents with pagination and filtering.

```typescript
// Query params
{
  status?: "uploading" | "processing" | "chunking" | "embedding" | "indexed" | "failed",
  page?: number,
  pageSize?: number,       // default: 20
}

// Output
{
  documents: Array<{
    id: bigint,
    originalFilename: string,
    mimeType: string,
    fileSize: number,
    status: string,
    chunkCount: number,
    uploadedBy: { id: bigint, name: string } | null,
    createdAt: string,
    updatedAt: string,
  }>,
  total: number,
  page: number,
  pageSize: number,
}
```

#### `GET /admin/qa/knowledge-base/{documentId}`

Document detail including chunk count and processing status.

#### `DELETE /admin/qa/knowledge-base/{documentId}`

Delete a document, its chunks, embeddings from Qdrant, and the file from storage. Returns 409 if the document is currently being processed.

```typescript
// Output
{ deleted: true }
```

### 4.2 Q&A Interactions

#### `GET /admin/qa/interactions`

Paginated list of Q&A interactions with filtering.

```typescript
// Query params
{
  answerStatus?: "pending" | "answered" | "no_answer" | "error",
  locationId?: bigint,
  dateFrom?: string,       // ISO date
  dateTo?: string,         // ISO date
  searchText?: string,     // Full-text search on questionText/answerText
  page?: number,
  pageSize?: number,
}

// Output
{
  interactions: Array<{
    id: bigint,
    questionText: string,
    answerText: string | null,
    answerStatus: string,
    contactPhone: string,  // Masked per existing PII compliance
    locationName: string,
    sourceCount: number,
    totalLatencyMs: number | null,
    createdAt: string,
  }>,
  total: number,
  page: number,
  pageSize: number,
}
```

#### `GET /admin/qa/interactions/{interactionId}`

Full interaction detail with audit trail.

```typescript
// Output
{
  interaction: {
    id: bigint,
    questionText: string,
    answerText: string | null,
    answerStatus: string,
    searchQuery: string | null,
    searchResultCount: number | null,
    llmModel: string | null,
    llmPromptTokens: number | null,
    llmCompletionTokens: number | null,
    llmLatencyMs: number | null,
    searchLatencyMs: number | null,
    totalLatencyMs: number | null,
    createdAt: string,
    conversation: {
      id: bigint,
      turnCount: number,
      startedAt: string,
      status: string,
    },
    contact: {
      phoneNumber: string, // Masked
      messageCount: number,
    },
    location: {
      id: bigint,
      name: string,
    },
    sources: Array<{
      documentFilename: string,
      chunkContent: string,    // The actual text chunk used
      similarityScore: number,
      rankPosition: number,
    }>,
    inboundMessage: {
      id: bigint,
      body: string,
      createdAt: string,
    },
    outboundMessage: {
      id: bigint,
      body: string,
      status: string,
      createdAt: string,
    } | null,
  }
}
```

### 4.3 Q&A Metrics

#### `GET /admin/qa/metrics`

Aggregated metrics for the Q&A dashboard.

```typescript
// Query params
{
  dateFrom?: string,
  dateTo?: string,
  locationId?: bigint,
}

// Output
{
  totalQuestions: number,
  answeredCount: number,
  noAnswerCount: number,
  errorCount: number,
  answerRate: number,            // answeredCount / totalQuestions
  unansweredRate: number,        // noAnswerCount / totalQuestions
  avgResponseTimeMs: number,     // average totalLatencyMs for answered
  p95ResponseTimeMs: number,
  totalDocuments: number,
  totalChunks: number,
  questionsOverTime: Array<{     // bucketed by day
    date: string,
    count: number,
    answeredCount: number,
    noAnswerCount: number,
  }>,
}
```

### 4.4 Q&A Export

#### `GET /admin/qa/export`

CSV export of Q&A interactions, preserving active filters (same pattern as feedback export).

```typescript
// Query params — same as GET /admin/qa/interactions (minus pagination)
// Output — CSV file download with headers:
// Date, Question, Answer, Status, Location, Response Time (ms), Sources Used
```

---

## 5. SMS Flow Changes

### 5.1 Enhanced Message Classification

The most significant change to the existing flow is in the webhook handler. Currently, every inbound message is classified as feedback. The new flow adds an intent classification step **before** the feedback classification.

#### New Intent Classification Function

Located in `packages/sms/lib/gemini-client.ts` as a new export (existing `classifyFeedback` is unchanged):

```typescript
export type MessageIntent =
  | "feedback"
  | "new_question"
  | "follow_up_question"
  | "follow_up_feedback";

export interface MessageIntentClassification {
  intent: MessageIntent;
  confidence: number;
  reasoning: string; // Brief explanation for audit
}

export async function classifyMessageIntent(
  messageBody: string,
  conversationContext?: {
    lastAnswer: string;
    lastQuestion: string;
    turnCount: number;
  },
): Promise<MessageIntentClassification>;
```

The Gemini prompt includes:
- The current message body
- If an active conversation exists: the last question/answer pair and turn count
- Clear instructions to distinguish between questions (seeking information) and feedback (expressing opinion/experience)
- Fallback: `{ intent: "feedback", confidence: 0.5 }` — preserves existing behavior on failure

#### Timeout and retry: Same 5s timeout + 3 retries with exponential backoff as existing classification.

### 5.2 Modified Webhook Handler Flow

The existing handler at `packages/api/modules/sms/procedures/twilio-webhook.ts` is modified as follows. Steps 1-6 remain identical. The change is in step 7 onward:

```
Existing flow (steps 1-6 unchanged):
  1. Validate Twilio signature
  2. Idempotency check
  3. Location lookup
  4. Contact management
  5. Keyword handling (STOP/START/HELP)
  6. Rate limiting

NEW branching point (replaces step 7's direct feedback classification):

  7a. Check for active Q&A conversation for this contact+location
  7b. Classify message intent (feedback | question | follow-up)
  
  Branch A — intent is "feedback" or "follow_up_feedback":
    7c. Database transaction (existing):
        - Upsert contact
        - Create smsMessage record
        - Classify feedback via existing classifyFeedback()
        - Create smsFeedback record
        - If follow_up_feedback with active conversation:
            Close the conversation (set status = "closed")
    7d. Generate and send response (existing)

  Branch B — intent is "new_question" or "follow_up_question":
    7c. Database transaction:
        - Upsert contact
        - Create smsMessage record
        - Create or extend qaConversation
        - Check tenant has indexed knowledge base documents (if none, send "no KB" response)
    7d. RAG pipeline (outside transaction):
        - Embed the question
        - Search tenant's Qdrant collection (top-k=5)
        - If no results above similarity threshold → "no answer" response
        - Build LLM prompt with retrieved chunks + conversation context
        - Generate answer via Gemini
    7e. Record qaInteraction + qaInteractionSource records
    7f. Send answer SMS
    7g. Update qaConversation.lastActivityAt and increment turnCount
```

### 5.3 Conversation Lifecycle

- **Creation:** First question from a contact at a location creates a `qaConversation`.
- **Extension:** Subsequent questions within the timeout window reuse the same conversation.
- **Timeout:** If `lastActivityAt` is >30 minutes ago, the conversation is considered closed. A new question starts a new conversation.
- **Explicit close:** A feedback message following a Q&A interaction closes the active conversation.
- **Context window:** The RAG prompt includes up to the last 3 question/answer pairs from the active conversation for follow-up coherence.

### 5.4 SMS Response Templates

New response templates in `packages/sms/lib/response-generator.ts`:

```typescript
export const QA_NO_KNOWLEDGE_BASE = 
  "Sorry, we don't have a knowledge base set up for this location yet. Your message has been recorded as feedback.";

export const QA_NO_ANSWER_FOUND = 
  "I wasn't able to find an answer to your question in our knowledge base. Your question has been noted and we'll work on adding this information.";

export const QA_ERROR_FALLBACK = 
  "Sorry, I'm having trouble looking that up right now. Please try again later or contact us directly.";

// Answer responses are dynamically generated by the LLM
// They are capped at 1600 characters (one SMS segment limit consideration)
```

---

## 6. UI Components

### 6.1 New Admin Pages

All pages live under `apps/web/app/(saas)/app/(account)/admin/` following existing conventions.

#### Knowledge Base Management

```
apps/web/app/(saas)/app/(account)/admin/knowledge-base/
├── page.tsx                    # Document list view (server component)
├── components/
│   ├── DocumentList.tsx        # Client: filterable/sortable document table
│   ├── DocumentUpload.tsx      # Client: drag-and-drop upload with progress
│   ├── DocumentStatusBadge.tsx # Status indicator (processing, indexed, failed)
│   ├── DeleteDocumentDialog.tsx # Radix AlertDialog confirmation
│   └── EmptyKnowledgeBase.tsx  # Empty state with upload CTA
```

#### Q&A Reports

```
apps/web/app/(saas)/app/(account)/admin/qa/
├── page.tsx                    # Q&A dashboard (server component)
├── [interactionId]/
│   └── page.tsx                # Interaction detail view
├── components/
│   ├── QAMetricCards.tsx       # Summary metric cards (questions, answer rate, etc.)
│   ├── QAActivityChart.tsx     # Time series chart of Q&A activity
│   ├── QAInteractionList.tsx   # Client: paginated interaction table with filters
│   ├── QAInteractionDetail.tsx # Full audit trail view for a single interaction
│   ├── QAFilters.tsx           # Filter controls (date, location, status)
│   ├── QASourcesList.tsx       # List of source documents/chunks for an answer
│   └── QAExportButton.tsx      # CSV export triggering with current filters
```

### 6.2 Navigation Updates

Add two new entries to the admin sidebar navigation:
- "Knowledge Base" — links to `/admin/knowledge-base`
- "Q&A Reports" — links to `/admin/qa`

These should appear as a logical group (e.g., under a "Q&A" section heading) after the existing "Feedback" navigation item.

### 6.3 Component Patterns

- **URL state management:** nuqs `useQueryState` for all filter controls (same pattern as feedback filters).
- **File upload:** Direct-to-storage upload using signed URLs from the API. The client:
  1. Requests a signed URL via `POST /admin/qa/knowledge-base/upload-url`
  2. PUTs the file directly to GCS/MinIO
  3. Calls `POST /admin/qa/knowledge-base/{documentId}/process` to trigger indexing
  4. Polls or uses a status endpoint to track processing progress
- **Empty states:** Meaningful empty states for both knowledge base (no documents uploaded) and Q&A reports (no interactions yet).
- **Loading states:** Skeleton loaders for metric cards and table rows.
- **Error states:** Toast notifications for upload/delete failures, inline error messages for processing failures.

### 6.4 Styling

Follow existing Tailwind CSS + Radix UI patterns. Use the same table, card, filter, and pagination components visible in the feedback UI. No new design system components should be needed — compose from existing primitives.

---

## 7. Integration Points

### 7.1 Multi-Tenancy

Every Q&A operation is tenant-scoped:
- **Database:** All new tables have `tenantId` FK with cascade delete. All queries filter by `tenantId`.
- **Qdrant:** Per-tenant collections (`kb_{tenantId}`). Collection is created on first document upload. Collection is deleted when tenant is deleted (cascade).
- **Storage:** Documents stored under `knowledge-base/{tenantId}/` prefix. Tenant deletion cascades to storage cleanup.
- **API:** All endpoints resolve tenant from session via `getEffectiveTenantFromContext`.

### 7.2 Authentication / Authorization

- Knowledge base management (upload, delete): `requireAdmin()` — same as existing feedback management.
- Q&A reports (view interactions, metrics, export): `requireAdmin()` — read-only admin operations.
- SMS Q&A processing: No auth required (Twilio webhook, validated by signature).

### 7.3 Existing SMS Flow

- The `smsMessage` table continues to record ALL messages (both feedback and Q&A).
- Q&A messages create `smsMessage` records with the same direction/status tracking.
- The `smsFeedback` table is NOT used for Q&A interactions. Feedback and Q&A are distinct data paths.
- If intent classification falls back to "feedback" on error, the existing feedback pipeline handles it exactly as before — zero behavior change for the fallback case.

### 7.4 Storage Package

- Document uploads use the existing `packages/storage/` abstraction.
- A new bucket path prefix is used: `knowledge-base/{tenantId}/{documentId}/{filename}`.
- No new buckets required — reuses the existing application bucket with path-based separation.
- CORS is already configured for direct uploads.

### 7.5 AI Package

- Embedding generation and RAG answer generation are added to `packages/knowledge-base/`, not `packages/ai/`.
- They import from `@google/generative-ai` directly (same as `packages/sms`).
- If the project wants to centralize all AI operations later, this can be refactored into `packages/ai/`, but introducing that coupling now would mean Q&A changes touch the shared AI package that feedback also depends on — unnecessary risk.

### 7.6 Rate Limiting

The existing SMS rate limit (5 msgs / 10 min sliding window) applies equally to Q&A interactions. A question counts as one message against the limit. This prevents abuse of the Q&A system.

Additional Q&A-specific consideration: The RAG pipeline is more expensive (LLM generation + vector search) than feedback classification. If cost becomes a concern, a separate Q&A-specific rate limit could be added per-tenant. **This is deferred to post-MVP but the architecture supports it via a new rate limit event type.**

---

## 8. Edge Cases and Error Handling

### 8.1 No Knowledge Base Configured

**Scenario:** A question is detected but the tenant has no indexed documents.

**Handling:** Detect by checking `qaKnowledgeDocument` count for tenant where `status = "indexed"`. If zero, send the `QA_NO_KNOWLEDGE_BASE` response and record the interaction with `answerStatus: "no_answer"`. **Also** fall through to create a `smsFeedback` record so the question text isn't lost — it's captured as medium/store feedback.

### 8.2 No Relevant Answer Found

**Scenario:** Vector search returns results but all similarity scores are below the threshold (e.g., <0.65).

**Handling:** Send `QA_NO_ANSWER_FOUND` response. Record interaction with `answerStatus: "no_answer"`, preserving the search results and scores in the audit trail so admins can see what the system found and adjust the threshold or upload better documents.

### 8.3 Document Processing Failures

**Scenario:** PDF extraction fails (corrupted file, password-protected, scanned image PDF).

**Handling:**
- Set document status to `"failed"` with a descriptive `errorMessage`.
- Do NOT create partial chunks — the document is either fully indexed or not indexed at all.
- Admin UI shows the failure with the error message and a "Retry" option (re-triggers processing).
- No partial embeddings in Qdrant for failed documents.

### 8.4 Qdrant Unavailability

**Scenario:** Qdrant is down or unreachable during a Q&A request.

**Handling:**
- The RAG pipeline has a 3-second timeout for Qdrant search.
- On failure, fall back to treating the message as feedback (existing behavior).
- Record the interaction with `answerStatus: "error"` and the error details.
- Send `QA_ERROR_FALLBACK` response.
- Alert monitoring (existing fallback monitoring pattern from Gemini client).

### 8.5 Conversation Context Staleness

**Scenario:** A customer sends a follow-up question 2 hours after their last message.

**Handling:** The conversation timeout (30 min default) has elapsed. The conversation is treated as closed. A new `qaConversation` is created. The message is classified without conversation context, so it will likely be classified as `new_question` rather than `follow_up_question`.

### 8.6 Concurrent Document Operations

**Scenario:** Admin deletes a document while it's being processed/indexed.

**Handling:** The deletion endpoint checks `status`. If status is `processing`, `chunking`, or `embedding`, return HTTP 409 with a message to wait for processing to complete. The admin can retry deletion after processing finishes or fails.

### 8.7 SMS Length Constraints

**Scenario:** LLM-generated answer exceeds SMS segment limits.

**Handling:** Truncate generated answers to 1500 characters (leaving room for attribution footer). If truncated, append "..." to indicate the answer was shortened. The full answer is always stored in `qaInteraction.answerText` regardless of what was sent via SMS.

### 8.8 Tenant Deletion Cascade

**Scenario:** A tenant is deleted.

**Handling:** MySQL cascade deletes handle all `qa*` table records. Additionally, a cleanup job must:
1. Delete the tenant's Qdrant collection (`kb_{tenantId}`)
2. Delete the tenant's documents from storage (`knowledge-base/{tenantId}/`)

This should be implemented as a post-delete hook or event handler, not inline in the delete transaction.

### 8.9 Ambiguous Message Intent

**Scenario:** The intent classifier returns low confidence (e.g., <0.6) on whether a message is feedback or a question.

**Handling:** Default to `"feedback"` (preserving existing behavior). Record the classification confidence in a log. Over time, these ambiguous cases can be reviewed to improve the classification prompt. The key principle: **when uncertain, fall back to existing behavior**.

---

## 9. Migration Strategy

### 9.1 Phased Rollout

The feature should be deployed in phases to minimize risk to the existing feedback system:

**Phase 1 — Schema + Knowledge Base (no SMS changes)**
1. Run database migration to create all new tables.
2. Deploy the knowledge base admin UI and API.
3. Admins can upload and manage documents.
4. No changes to SMS processing — feedback flow is untouched.

**Phase 2 — Q&A Processing (feature-flagged)**
1. Add intent classification to the webhook handler behind a per-tenant feature flag.
2. The flag is stored in a new column on `smsLocationConfig`: `qaEnabled: boolean, default false`.
3. When `qaEnabled = false` (default), all messages take the existing feedback path — zero behavior change.
4. When `qaEnabled = true`, messages go through intent classification first.
5. Admins enable Q&A per-location after uploading knowledge base documents.

**Phase 3 — Q&A Reports UI**
1. Deploy the Q&A reports dashboard.
2. This is read-only and additive — no risk to existing functionality.

**Phase 4 — Remove Feature Flag**
1. After validation with pilot tenants, the feature flag can be made default-on for locations with indexed knowledge base documents.

### 9.2 Database Migration

Single migration file containing all new table definitions. No modifications to existing tables (except the optional `qaEnabled` column on `smsLocationConfig`).

Migration is backward-compatible: the new tables exist but are unused until Phase 2 code is deployed.

### 9.3 Qdrant Deployment

- **Local dev:** Add Qdrant to `docker-compose.yml` as a new service (port 6333).
- **Production:** Deploy Qdrant as a separate Cloud Run service with a persistent volume, or use a Compute Engine instance with SSD. Decision depends on expected scale (see Open Questions).

### 9.4 Rollback Plan

- **Phase 1 rollback:** Drop new tables. No impact on existing functionality.
- **Phase 2 rollback:** Set `qaEnabled = false` for all locations. The webhook handler reverts to pure feedback classification. Q&A data remains in the database for analysis but no new Q&A interactions occur.
- **Phase 3 rollback:** Remove Q&A report routes. Navigation links disappear. No data loss.

---

## 10. Open Questions

### 10.1 Qdrant Production Hosting

**Question:** Should Qdrant run on Cloud Run (stateless, needs external persistent storage), Compute Engine (stateful, simpler persistence), or Qdrant Cloud (managed)?

**Considerations:** Cloud Run has a max volume size of 10 GB and restarts containers. Compute Engine is simpler for a persistent vector store but requires VM management. Qdrant Cloud is zero-ops but adds a third-party dependency.

**Recommendation:** Start with Compute Engine (e2-medium with SSD) for simplicity. Migrate to Qdrant Cloud later if operational burden justifies it.

### 10.2 Embedding Dimensions and Model

**Question:** Should we use Gemini `text-embedding-004` (768d) or OpenAI `text-embedding-3-small` (1536d, configurable)? Higher dimensions generally improve retrieval quality but increase storage and search cost.

**Recommendation:** Gemini `text-embedding-004` to stay single-provider. Revisit if retrieval quality is insufficient.

### 10.3 Per-Location vs. Per-Tenant Knowledge Base

**Question:** Should the knowledge base be per-tenant (shared across all locations) or per-location (each location has its own documents)?

**Considerations:** Per-tenant is simpler and covers the common case (company-wide FAQ). Per-location allows store-specific information but dramatically increases management complexity.

**Recommendation:** Start with per-tenant. Add optional location-scoping later by adding a nullable `locationId` to `qaKnowledgeDocument` and filtering at search time.

### 10.4 Answer Length for SMS

**Question:** What's the acceptable answer length? A single SMS segment is 160 characters (GSM-7) or 70 (UCS-2/emoji). Multi-segment messages cost more and may be received out of order on some carriers.

**Recommendation:** Target 2-3 SMS segments (~320-480 characters) for answers. Add a system prompt constraint to the LLM to keep answers concise. Store the full answer in the database regardless.

### 10.5 Cost Controls

**Question:** Should there be tenant-level cost controls (max questions/month, max documents, max total storage)?

**Recommendation:** Defer hard limits to post-MVP. Instrument metrics now (tracked via `qaInteraction` records and `qaKnowledgeDocument` sizes) so limits can be enforced later with full visibility.

### 10.6 Document Format Support Scope

**Question:** Should we support additional formats beyond PDF, TXT, DOCX? (e.g., HTML, Markdown, CSV, spreadsheets)

**Recommendation:** MVP supports PDF, TXT, DOCX only. TXT is the catch-all for simple formats. The document processor is designed with a strategy pattern so new extractors can be added without architectural changes.

### 10.7 Conversation Context Depth

**Question:** How many previous turns should be included in the RAG prompt for follow-up questions? More context improves coherence but increases token cost and latency.

**Recommendation:** Include the last 3 turns (question + answer pairs). This balances context quality with cost. Make it configurable at the tenant level if needed later.

---

## 11. Implementation Sequence

### Sprint 1 — Foundation (est. 2 weeks)

| # | Task | Dependencies | Notes |
|---|------|-------------|-------|
| 1.1 | Database schema migration (all new tables) | None | Single migration, all tables |
| 1.2 | `packages/knowledge-base/` scaffolding + types | None | Package setup, no logic yet |
| 1.3 | Document processor (PDF, DOCX, TXT extraction) | 1.2 | Unit testable in isolation |
| 1.4 | Text chunker with overlap and boundary detection | 1.2 | Unit testable, pure function |
| 1.5 | Gemini embedding generation wrapper | 1.2 | Thin wrapper over existing SDK |
| 1.6 | Qdrant client wrapper (collection CRUD, upsert, search) | 1.2 | Integration testable with local Qdrant |
| 1.7 | Add Qdrant to docker-compose.yml | None | Local dev infrastructure |
| 1.8 | Database query functions for new tables | 1.1 | Follow existing query patterns |

### Sprint 2 — Knowledge Base Admin (est. 2 weeks)

| # | Task | Dependencies | Notes |
|---|------|-------------|-------|
| 2.1 | API: upload-url endpoint | 1.1, 1.8 | Signed URL + document record creation |
| 2.2 | API: process endpoint (async pipeline) | 1.3, 1.4, 1.5, 1.6, 2.1 | Orchestrates extract → chunk → embed → index |
| 2.3 | API: document list, detail, delete endpoints | 1.8 | Standard CRUD following existing patterns |
| 2.4 | UI: Knowledge base page + DocumentList component | 2.3 | Server component + client table |
| 2.5 | UI: DocumentUpload component (drag-and-drop) | 2.1 | Direct-to-storage upload |
| 2.6 | UI: Document status tracking + delete dialog | 2.3, 2.4 | Real-time status polling |
| 2.7 | Admin navigation updates | None | Add KB link to sidebar |

### Sprint 3 — Q&A SMS Flow (est. 2 weeks)

| # | Task | Dependencies | Notes |
|---|------|-------------|-------|
| 3.1 | Intent classifier (`classifyMessageIntent`) | None | New Gemini prompt, unit testable |
| 3.2 | Conversation manager (create, extend, timeout) | 1.8 | Database-backed lifecycle |
| 3.3 | RAG pipeline (search → context → generate) | 1.5, 1.6, 3.2 | Core Q&A orchestration |
| 3.4 | `qaEnabled` flag on smsLocationConfig | 1.1 | Schema migration for feature flag |
| 3.5 | Webhook handler modifications | 3.1, 3.2, 3.3, 3.4 | Branch on intent, feature-flagged |
| 3.6 | Audit trail recording (qaInteraction + sources) | 1.8, 3.3 | Every interaction fully recorded |
| 3.7 | Q&A-specific SMS response templates | None | Static templates for edge cases |
| 3.8 | End-to-end integration testing | 3.1-3.7 | Full flow: SMS → classify → RAG → respond |

### Sprint 4 — Q&A Reports + Polish (est. 1.5 weeks)

| # | Task | Dependencies | Notes |
|---|------|-------------|-------|
| 4.1 | API: Q&A metrics endpoint | 1.8 | Aggregation queries |
| 4.2 | API: Q&A interaction list + detail endpoints | 1.8 | Paginated with filters |
| 4.3 | API: Q&A export endpoint | 1.8 | CSV export following feedback pattern |
| 4.4 | UI: Q&A dashboard page + metric cards | 4.1 | Server component with client islands |
| 4.5 | UI: Q&A interaction list with filters | 4.2 | nuqs URL state management |
| 4.6 | UI: Q&A interaction detail with audit trail | 4.2 | Sources, latency, conversation context |
| 4.7 | UI: Q&A export button | 4.3 | Same pattern as feedback export |
| 4.8 | Admin navigation: Q&A Reports link | None | Sidebar update |
| 4.9 | Qdrant production deployment setup | None | Compute Engine or Cloud Run |

### Critical Path

```
1.1 (schema) → 1.8 (queries) → 2.1-2.3 (API) → 2.4-2.6 (UI)
                                                    ↓
1.3-1.6 (KB core) → 2.2 (process pipeline)      3.1-3.3 (SMS flow)
                                                    ↓
                                                 3.5 (webhook changes)
                                                    ↓
                                                 4.1-4.7 (reports)
```

Sprint 3 (SMS flow changes) is the highest-risk sprint. It modifies the production webhook handler. All other sprints are additive with no risk to existing functionality.

---

## Appendix: Key Design Principles

1. **Fallback to existing behavior:** Any failure in the Q&A path defaults to treating the message as feedback. The existing system is the safety net.
2. **Tenant isolation by construction:** Per-tenant Qdrant collections, tenantId on all tables, tenant-scoped queries. No cross-tenant data leakage is possible without bypassing the data access layer.
3. **Full auditability:** Every step (question received, search performed, chunks retrieved, answer generated, SMS sent) is recorded with timestamps and identifiers. The `qaInteraction` + `qaInteractionSource` tables provide a complete chain of custody.
4. **Additive, not modifying:** New tables, new API modules, new UI pages. The existing feedback schema, API, and UI are untouched. The only modification to existing code is the webhook handler, which is feature-flagged.
5. **Same patterns, new domain:** Every new component follows the conventions established in the existing codebase — Drizzle schema style, query function patterns, API procedure structure, UI component organization, and error handling approaches.
