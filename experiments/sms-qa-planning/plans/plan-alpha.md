# Implementation Plan: SMS Q&A with Knowledge Base

**Date:** 2026-02-21  
**Author:** Plan Alpha  
**Status:** Draft — Pending stakeholder review of open questions

---

## 1. Architecture Decisions

### 1.1 Vector Database — Qdrant

**Choice:** Qdrant (self-hosted via Docker locally, Qdrant Cloud for production)

**Justification:**
- MySQL 8.4 lacks native vector search. Adding pgvector would require introducing PostgreSQL — a disruptive infrastructure change with no other justification.
- Qdrant has a maintained Node.js client (`@qdrant/js-client-rest`) and is well-suited to the existing Docker-based local dev workflow (mirrors the MinIO pattern in `packages/storage/`).
- Qdrant Cloud provides a managed production tier, avoiding operational burden on a small team.
- Alternative considered: **Pinecone** — fully managed, zero ops, but introduces a new vendor relationship and higher cost floor for a feature that may start with low volume. **Vertex AI Vector Search** — stays in the Google ecosystem alongside Gemini, but ties infrastructure tighter to GCP and has a higher minimum cost. Worth revisiting either if Qdrant operational overhead becomes a concern.

**Tenant isolation strategy:** One Qdrant collection per tenant, named `kb_t{tenantId}`. Hard isolation — no metadata filtering needed, simple to delete on tenant removal or KB wipe. If tenant count exceeds ~1000, migrate to a shared-collection-with-payload-filtering approach. The `vector-store.ts` abstraction layer makes this a contained change.

### 1.2 Embedding Model — Google text-embedding-004

**Choice:** `text-embedding-004` via `@google/generative-ai` (already a dependency)

**Justification:**
- Same SDK, same API key, same billing as the existing Gemini integration — zero new vendor dependencies.
- 768-dimensional embeddings with strong multilingual performance.
- Alternative: OpenAI `text-embedding-3-small` performs comparably but adds a vendor. Not worth it when we're already in the Google ecosystem.

### 1.3 Document Processing — In-process with status tracking

**Choice:** Synchronous processing behind a status-tracked pipeline. No job queue for initial implementation.

**Justification:**
- No message queue infrastructure exists in the codebase (no Redis, no BullMQ). Introducing one for a single low-frequency admin operation is premature.
- Document uploads are admin-initiated, infrequent, and typically fast (FAQs, policy docs, manuals — usually <1MB, processing in seconds not minutes).
- The `knowledgeBaseDocument.status` field provides tracking. A polling endpoint gives the admin visibility into processing state.
- **Upgrade path:** If processing volume grows or we add OCR for scanned PDFs, introduce BullMQ + Redis. Processing logic in `packages/knowledge-base/lib/processor.ts` is already isolated — wrapping it in a queue consumer is a mechanical change.

**Processing pipeline:**
1. Admin uploads file to storage via signed URL
2. Admin calls `POST /admin/knowledge-base/documents` to register the document
3. Server sets status to `processing`, begins: parse → chunk → embed → index in Qdrant
4. On success: status → `indexed`, `chunkCount` updated
5. On failure: status → `failed`, `errorMessage` populated

### 1.4 Conversation Session Management — Time-windowed implicit sessions

**Choice:** Implicit sessions keyed on `(contactId, locationId)` with a configurable inactivity timeout (default: 30 minutes).

**Justification:**
- SMS has no native session concept — timing-based inference is the only viable approach.
- 30 minutes balances between holding useful context and avoiding stale context polluting new conversations.
- Sessions are lazy-created on the first question from a contact and expired by checking `lastActivityAt` on each new message.
- Conversation history for RAG prompts is bounded to the last 5 Q&A pairs within the session window to control token usage and LLM cost.

### 1.5 Message Classification — Two-stage pipeline

**Choice:** Separate intent classification from domain-specific processing:

1. **Stage 1 — Intent classification** (new): `feedback` | `question` | `follow_up_feedback` | `follow_up_question`
2. **Stage 2 — Domain processing:**
   - `feedback` / `follow_up_feedback` → existing `classifyFeedback()` pipeline (category + target)
   - `question` / `follow_up_question` → Q&A pipeline (search → RAG → respond)

**Justification:**
- Preserves the production-tested `classifyFeedback` function untouched — no regression risk to the core feedback feature.
- Intent classification is a focused 4-class problem with higher confidence than a combined taxonomy would be.
- Follow-up detection requires conversation context that the current classifier doesn't have — keeping concerns separate makes each LLM prompt simpler and more reliable.
- **Fallback:** If intent classification fails (timeout, error, low confidence below 0.4), default to `feedback`. This preserves existing behavior — the system degrades gracefully to what it does today.

**Intent classification context window:** The classifier receives the incoming message plus the last 3 messages in the conversation (if any) to detect follow-up intent. No conversation context → can only be `feedback` or `question`.

### 1.6 Document Parsing Libraries

| Format | Library | Notes |
|--------|---------|-------|
| PDF | `pdf-parse` | Handles most text-based PDFs. Returns empty text for scanned/image PDFs — we detect this (text length below threshold) and set status to `failed` with a descriptive error. |
| DOCX | `mammoth` | Extracts text with basic structural markers. Strips formatting, which is desirable for chunking. |
| TXT | Native `fs` | No library needed. UTF-8 assumed; detect encoding issues and fail gracefully. |

### 1.7 Chunking Strategy

Recursive character splitting:
- Default chunk size: 1000 characters
- Default overlap: 200 characters
- Paragraph boundaries respected where possible (split on `\n\n` first, then `\n`, then sentence boundaries, then character limit)
- Each chunk gets a metadata header prepended before embedding: `[Source: {fileName}, Section {chunkIndex + 1}/{totalChunks}]`

This is a well-understood, robust approach for mixed document types. Configurable via environment variables for tuning.

### 1.8 RAG Generation Strategy

- Model: `gemini-2.5-flash` (same as existing classification)
- System prompt enforces grounding: answers MUST be derived from provided context only
- Top-K retrieval: 5 chunks (configurable)
- Minimum similarity threshold: 0.65 (below this, chunks are discarded)
- If zero chunks pass the threshold → `no_relevant_content` response
- Answer length constrained to 450 characters (SMS segment awareness — 2-3 segments max)
- Temperature: 0.2 (low creativity, high faithfulness to context)
- For follow-up questions: inject prior Q&A pairs into the prompt as conversation history

---

## 2. Database Schema Changes

All new tables follow existing conventions: `bigint` auto-increment PKs, `tenantId` FK with CASCADE, `createdAt`/`updatedAt` timestamps where appropriate.

### 2.1 New Tables

```typescript
// packages/database/drizzle/schema/mysql.ts

export const knowledgeBaseDocument = mysqlTable("knowledge_base_document", {
  id: bigint("id", { mode: "bigint" }).primaryKey().autoincrement(),
  tenantId: bigint("tenant_id", { mode: "bigint" })
    .notNull()
    .references(() => tenant.id, { onDelete: "cascade" }),
  fileName: varchar("file_name", { length: 512 }).notNull(),
  fileType: mysqlEnum("file_type", ["pdf", "txt", "docx"]).notNull(),
  fileSize: int("file_size").notNull(), // bytes
  storagePath: varchar("storage_path", { length: 1024 }).notNull(),
  status: mysqlEnum("status", ["pending", "processing", "indexed", "failed"])
    .notNull()
    .default("pending"),
  chunkCount: int("chunk_count").default(0),
  errorMessage: text("error_message"),
  uploadedBy: bigint("uploaded_by", { mode: "bigint" })
    .notNull()
    .references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

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
  qdrantPointId: varchar("qdrant_point_id", { length: 64 }), // UUID of vector in Qdrant
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

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
  startedAt: timestamp("started_at").defaultNow().notNull(),
  lastActivityAt: timestamp("last_activity_at").defaultNow().notNull(),
  interactionCount: int("interaction_count").notNull().default(0),
  status: mysqlEnum("status", ["active", "expired", "closed"])
    .notNull()
    .default("active"),
});

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
  questionMessageId: bigint("question_message_id", { mode: "bigint" })
    .notNull()
    .references(() => smsMessage.id, { onDelete: "cascade" }),
  answerMessageId: bigint("answer_message_id", { mode: "bigint" })
    .references(() => smsMessage.id, { onDelete: "set null" }),
  questionText: text("question_text").notNull(),
  answerText: text("answer_text"),
  answerStatus: mysqlEnum("answer_status", [
    "answered",
    "no_relevant_content",
    "error",
  ]).notNull(),
  isFollowUp: boolean("is_follow_up").notNull().default(false),
  intentClassification: mysqlEnum("intent_classification", [
    "question",
    "follow_up_question",
  ]).notNull(),
  intentConfidence: decimal("intent_confidence", { precision: 3, scale: 2 }),
  searchScoreMax: decimal("search_score_max", { precision: 5, scale: 4 }),
  searchDurationMs: int("search_duration_ms"),
  generationDurationMs: int("generation_duration_ms"),
  totalDurationMs: int("total_duration_ms"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const qaInteractionSource = mysqlTable("qa_interaction_source", {
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
  similarityScore: decimal("similarity_score", { precision: 5, scale: 4 }).notNull(),
  chunkContentSnapshot: text("chunk_content_snapshot").notNull(), // snapshot at query time for audit immutability
});
```

### 2.2 Modifications to Existing Tables

**`smsMessage`** — Add message type discriminator:

```typescript
messageType: mysqlEnum("message_type", ["feedback", "qa_question", "qa_answer", "system"])
  .notNull()
  .default("feedback"),
```

Default `"feedback"` preserves backward compatibility for all existing rows with no migration backfill needed.

**`smsLocationConfig`** — Add Q&A toggle:

```typescript
qaEnabled: boolean("qa_enabled").notNull().default(false),
qaSessionTimeoutMs: int("qa_session_timeout_ms").default(1800000), // 30 min, per-location override
```

The per-location `qaEnabled` flag is the feature gate. All Q&A logic is behind this check — `false` means the webhook behaves identically to today.

### 2.3 Indexes

```typescript
// Knowledge base
index("idx_kb_doc_tenant_status").on(knowledgeBaseDocument.tenantId, knowledgeBaseDocument.status),
index("idx_kb_chunk_document").on(knowledgeBaseChunk.documentId),
index("idx_kb_chunk_tenant").on(knowledgeBaseChunk.tenantId),

// Conversation session lookup (hot path on every inbound SMS when Q&A is enabled)
index("idx_qa_conv_contact_location_activity").on(
  qaConversation.contactId,
  qaConversation.locationId,
  qaConversation.lastActivityAt,
),
index("idx_qa_conv_tenant_status").on(qaConversation.tenantId, qaConversation.status),

// Interactions (reporting queries)
index("idx_qa_interaction_conversation").on(qaInteraction.conversationId),
index("idx_qa_interaction_tenant_created").on(qaInteraction.tenantId, qaInteraction.createdAt),
index("idx_qa_interaction_location_created").on(qaInteraction.locationId, qaInteraction.createdAt),
index("idx_qa_interaction_answer_status").on(qaInteraction.tenantId, qaInteraction.answerStatus),

// Sources (audit trail joins)
index("idx_qa_source_interaction").on(qaInteractionSource.interactionId),
index("idx_qa_source_document").on(qaInteractionSource.documentId),
```

### 2.4 Migration

Single migration file generated via `drizzle-kit generate`:

`packages/database/drizzle/migrations/XXXX_add_qa_knowledge_base.sql`

The migration is **additive only**:
- 5 new tables
- 2 new columns on existing tables (both nullable or defaulted)
- No column drops, renames, or type changes
- Safe for zero-downtime deployment — no existing queries are affected

---

## 3. New Packages/Modules

### 3.1 `packages/knowledge-base/` — New package

This is the core domain logic for document management and RAG, independent of the API transport layer.

```
packages/knowledge-base/
├── package.json
├── tsconfig.json
├── index.ts                 # Public API exports
├── types.ts                 # Shared types
├── config.ts                # Configuration (env vars, defaults)
├── lib/
│   ├── document-parser.ts   # PDF/DOCX/TXT → plain text extraction
│   ├── chunker.ts           # Text → chunks with metadata
│   ├── embeddings.ts        # Text → vectors via text-embedding-004
│   ├── vector-store.ts      # Qdrant CRUD abstraction (tenant-scoped collections)
│   ├── search.ts            # Semantic search: query → ranked chunks
│   ├── rag.ts               # RAG pipeline: question + context → answer
│   └── processor.ts         # Orchestrator: upload → parse → chunk → embed → index
```

**package.json dependencies:**
- `@google/generative-ai` (workspace dependency, already in packages/sms)
- `@qdrant/js-client-rest`
- `pdf-parse`
- `mammoth`
- `uuid` (for Qdrant point IDs)

### 3.2 Extensions to Existing Packages

**`packages/sms/lib/intent-classifier.ts`** — New file. Exports `classifyIntent()` function that:
- Takes the incoming message body + optional conversation history
- Calls Gemini 2.5 Flash with a 4-class intent prompt
- Returns `{ intent: "feedback" | "question" | "follow_up_feedback" | "follow_up_question", confidence: number }`
- Has the same timeout/retry/fallback pattern as the existing `classifyFeedback()`
- Fallback: `{ intent: "feedback", confidence: 0.5 }` (safe default — existing behavior)

**`packages/sms/types.ts`** — Extend with:
```typescript
export type SmsIntent = "feedback" | "question" | "follow_up_feedback" | "follow_up_question";

export interface SmsIntentClassification {
  intent: SmsIntent;
  confidence: number;
}
```

**`packages/database/drizzle/queries/knowledge-base.ts`** — New file. Query functions:
- `insertDocument(tenantId, data)`, `getDocuments(tenantId, filters)`, `getDocumentById(tenantId, id)`
- `updateDocumentStatus(id, status, errorMessage?)`, `deleteDocument(tenantId, id)`
- `insertChunks(tenantId, documentId, chunks[])`, `getChunksByDocument(documentId)`
- `deleteChunksByDocument(documentId)`

**`packages/database/drizzle/queries/qa.ts`** — New file. Query functions:
- `findOrCreateConversation(tenantId, locationId, contactId, timeoutMs)`
- `expireConversation(conversationId)`
- `getConversationHistory(conversationId, limit)`
- `insertInteraction(data)`, `insertInteractionSources(interactionId, sources[])`
- `getInteractions(tenantId, filters)`, `getInteractionById(tenantId, id)`
- `getInteractionWithSources(tenantId, id)` — joins through to document names
- `getQaMetrics(tenantId, filters)` — aggregated dashboard metrics

**`packages/api/modules/admin/procedures/knowledge-base.ts`** — New file. Admin endpoints for KB management.

**`packages/api/modules/admin/procedures/qa-reports.ts`** — New file. Admin endpoints for Q&A reporting.

---

## 4. API Endpoints

All endpoints use `adminProcedure` (requires authentication + admin/owner role) and resolve tenant via `getEffectiveTenantFromContext`. Input validation via Zod.

### 4.1 Knowledge Base Management

**`POST /admin/knowledge-base/upload-url`**

Request:
```typescript
z.object({
  fileName: z.string().min(1).max(512),
  fileType: z.enum(["pdf", "txt", "docx"]),
  fileSize: z.number().int().positive().max(20_000_000), // 20MB limit
})
```

Response:
```typescript
{ uploadUrl: string; storagePath: string; documentId: bigint }
```

Flow: Creates a `knowledgeBaseDocument` record in `pending` status, generates a signed upload URL via `packages/storage`, returns both. The client uploads directly to storage, then calls the process endpoint.

**`POST /admin/knowledge-base/documents/:id/process`**

Request: `z.object({ id: z.coerce.bigint() })`

Response: `{ status: "processing" }`

Flow: Validates document exists and is in `pending` status. Sets status to `processing`. Begins the parse → chunk → embed → index pipeline. Returns immediately — client polls status.

**`GET /admin/knowledge-base/documents`**

Request (query params):
```typescript
z.object({
  status: z.enum(["pending", "processing", "indexed", "failed"]).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.enum(["createdAt", "fileName", "fileSize"]).default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
})
```

Response:
```typescript
{
  documents: Array<{
    id: bigint; fileName: string; fileType: string; fileSize: number;
    status: string; chunkCount: number; errorMessage: string | null;
    uploadedBy: { id: bigint; name: string }; createdAt: Date; updatedAt: Date;
  }>;
  total: number;
  page: number;
  pageSize: number;
}
```

**`GET /admin/knowledge-base/documents/:id`**

Response: Full document detail including chunk count, processing status, uploader info.

**`DELETE /admin/knowledge-base/documents/:id`**

Flow:
1. Delete vectors from Qdrant (by point IDs from `knowledgeBaseChunk` records)
2. Delete file from storage
3. Delete `knowledgeBaseChunk` rows (or rely on CASCADE)
4. Delete `knowledgeBaseDocument` row
5. Operations 1-2 are best-effort — if they fail, still delete the DB records and log the orphaned resources for cleanup

**`GET /admin/knowledge-base/documents/:id/status`**

Lightweight polling endpoint. Returns only `{ status, chunkCount, errorMessage }`.

### 4.2 Q&A Reports

**`GET /admin/qa/metrics`**

Request (query params):
```typescript
z.object({
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  locationId: z.coerce.bigint().optional(),
})
```

Response:
```typescript
{
  totalQuestions: number;
  answeredCount: number;
  noContentCount: number;
  errorCount: number;
  answerRate: number;        // answered / total as decimal
  avgResponseTimeMs: number;
  avgSearchScoreMax: number;
  questionsPerDay: Array<{ date: string; count: number }>;
}
```

**`GET /admin/qa/interactions`**

Request (query params):
```typescript
z.object({
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  locationId: z.coerce.bigint().optional(),
  answerStatus: z.enum(["answered", "no_relevant_content", "error"]).optional(),
  isFollowUp: z.coerce.boolean().optional(),
  searchText: z.string().optional(), // searches questionText
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.enum(["createdAt", "totalDurationMs"]).default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
})
```

Response: Paginated list with question text (truncated), answer status, location name, timestamps, duration.

**`GET /admin/qa/interactions/:id`**

Response: Full interaction detail including:
- Question text, answer text, all timing metrics
- Conversation context (other interactions in the same conversation)
- Source documents used: document name, chunk content snapshot, similarity score
- Linked SMS messages (inbound question, outbound answer)

**`GET /admin/qa/export`**

Mirrors active filters from the interactions list. Returns CSV with columns: date, location, question, answer, status, follow-up, response time, source documents.

### 4.3 Location Q&A Configuration

**`PATCH /admin/locations/:id/qa-config`**

Request:
```typescript
z.object({
  qaEnabled: z.boolean().optional(),
  qaSessionTimeoutMs: z.number().int().positive().max(7_200_000).optional(), // max 2 hours
})
```

This uses the existing location admin patterns. Could be added to the existing location update endpoint if one exists, or as a standalone endpoint.

---

## 5. SMS Flow Changes

### 5.1 Modified Webhook Handler Flow

The existing handler in `packages/api/modules/sms/procedures/twilio-webhook.ts` gets a branching point after step 6 (rate limiting). Changes are structured to minimize diff on the existing code.

```
Steps 1-6:   [UNCHANGED — signature validation, idempotency, location lookup,
              contact management, keyword handling, rate limiting]

Step 7:      Load smsLocationConfig for this location
             → Check qaEnabled flag

Step 8:      IF qaEnabled:
               Load conversation context:
                 - Find active qaConversation for (contactId, locationId)
                   where lastActivityAt > (now - sessionTimeoutMs)
                 - If found, load last 3 message pairs from qaInteraction
               Classify intent via classifyIntent(messageBody, conversationHistory)
             ELSE:
               intent = { intent: "feedback", confidence: 1.0 }

Step 9:      Database transaction — BRANCH on intent:

             BRANCH A (feedback | follow_up_feedback):
               → Existing flow unchanged:
                 Upsert contact → check opt-out → create smsMessage (type: "feedback")
                 → classifyFeedback → create smsFeedback record

             BRANCH B (question | follow_up_question):
               → Upsert contact → check opt-out → create smsMessage (type: "qa_question")
               → Find or create qaConversation
               → Semantic search against tenant KB (packages/knowledge-base)
               → If results above threshold: RAG generate answer
               → If no results: set answerStatus = "no_relevant_content"
               → Create qaInteraction record
               → Create qaInteractionSource records (one per retrieved chunk)
               → Update qaConversation (lastActivityAt, interactionCount)

Step 10:     Generate response SMS:
             - BRANCH A: existing generateResponse()
             - BRANCH B: LLM answer text, or "I don't have information about that" message

Step 11:     Send SMS, create outbound smsMessage record
             - BRANCH B: update qaInteraction.answerMessageId

Step 12:     [UNCHANGED — error handling, extended for Q&A branch]
```

### 5.2 Implementation Strategy for Webhook Changes

Rather than heavily modifying the 371-line webhook handler inline, extract the Q&A branch into a separate function:

```typescript
// packages/api/modules/sms/procedures/qa-handler.ts
export async function handleQaQuestion(params: {
  tenantId: bigint;
  locationId: bigint;
  contactId: bigint;
  messageBody: string;
  intent: SmsIntentClassification;
  conversationContext: QaConversationContext | null;
  inboundMessageId: bigint;
  db: DatabaseTransaction;
}): Promise<{ answerText: string; interactionId: bigint }>
```

The webhook handler calls this function when the intent is `question` or `follow_up_question`. This keeps the webhook handler's diff small and the Q&A logic testable in isolation.

### 5.3 Key Behavioral Constraints

- `qaEnabled === false` → zero change in behavior, zero additional latency (no intent classification call)
- Intent classification failure → default to `feedback` (existing behavior preserved)
- Q&A pipeline failure (Qdrant down, Gemini error) → send apologetic fallback SMS, record interaction with `error` status, log for monitoring. Do NOT reclassify as feedback — the user asked a question.
- Rate limiting applies uniformly to both feedback and Q&A messages (existing sliding window)

---

## 6. UI Components

### 6.1 Knowledge Base Management

**Route:** `apps/web/app/(saas)/app/(account)/admin/knowledge-base/page.tsx`

**Components:**

- **`KnowledgeBaseList`** — Server component, paginated table of documents
  - Columns: File name, Type, Size (formatted), Status (badge), Chunks, Uploaded by, Upload date
  - Status badges: `pending` (gray), `processing` (blue/animated), `indexed` (green), `failed` (red)
  - Actions column: Delete button (with confirmation dialog)
  - Empty state: Illustration + "Upload your first document to get started"

- **`DocumentUploadDialog`** — Client component, triggered by "Upload Document" button
  - File picker with drag-and-drop (accepts .pdf, .txt, .docx)
  - File size validation (client-side, max 20MB)
  - Upload flow: get signed URL → upload to storage → call process endpoint
  - Progress states: uploading → processing → complete/failed
  - Close returns to list with refreshed data

- **`DocumentStatusPoller`** — Client component, rendered for documents in `processing` status
  - Polls `GET /admin/knowledge-base/documents/:id/status` every 3 seconds
  - Stops on terminal status (`indexed` or `failed`)
  - Updates badge in-place via React state

- **`DeleteDocumentDialog`** — Client component, confirmation dialog
  - Shows document name, warns that this removes the document from the knowledge base
  - "Delete" button with loading state

**URL state (nuqs):** `status` filter, `page`, `sortBy`, `sortOrder` — matching existing feedback list patterns.

### 6.2 Q&A Reports

**Route:** `apps/web/app/(saas)/app/(account)/admin/qa/page.tsx`

**Components:**

- **`QaMetricsCards`** — Server component, top-of-page summary
  - Cards: Total Questions, Answer Rate (%), Unanswered, Avg Response Time
  - Styled consistently with existing feedback metrics

- **`QuestionsPerDayChart`** — Client component, bar chart (lightweight chart library or Radix-compatible)
  - Date range driven by filters
  - Stacked bars: answered (green) vs. unanswered (amber) vs. error (red)

- **`QaInteractionList`** — Server component, paginated table
  - Columns: Date, Location, Question (truncated), Status (badge), Follow-up?, Response time
  - Row click → detail view
  - Filters: date range, location, answer status, follow-up toggle, search text
  - URL state managed via nuqs

- **`QaExportButton`** — Client component, triggers CSV download preserving active filters

**Route:** `apps/web/app/(saas)/app/(account)/admin/qa/[id]/page.tsx`

- **`QaInteractionDetail`** — Server component
  - Question and answer text in chat-bubble style layout
  - Audit timeline: question received → search performed (duration) → answer generated (duration) → SMS sent
  - Source documents section: list of chunks used with document name, similarity score, chunk text preview
  - Conversation context: other interactions in the same session (linked)
  - Metadata: intent classification, confidence, all timing metrics

### 6.3 Location Settings Extension

Add a "Q&A Settings" section to the existing location admin page (if one exists) or to `smsLocationConfig` management:
- Toggle: "Enable Q&A for this location"
- Session timeout input (with sensible min/max)
- Warning if KB has zero indexed documents when enabling

### 6.4 Navigation

Add to the admin sidebar:
```
Feedback        (existing)
──────────────
Knowledge Base  (new)
Q&A Reports     (new)
```

Group "Knowledge Base" and "Q&A Reports" under a "Q&A" section header if the sidebar supports grouping, or as flat items below the existing feedback item.

---

## 7. Integration Points

### 7.1 Multi-tenancy

- Every new database table has `tenantId` with CASCADE delete.
- All query functions accept and filter by `tenantId` — no cross-tenant data leakage.
- Qdrant collections are named `kb_t{tenantId}` — hard tenant isolation at the vector DB level.
- Document storage paths are namespaced: `knowledge-base/{tenantId}/{documentId}/{fileName}`.

### 7.2 Authentication & Authorization

- All admin endpoints use `adminProcedure` — requires authenticated user with admin or owner role.
- No new roles needed. Document uploads are admin-only; Q&A interactions happen via SMS (no auth on inbound SMS — protected by Twilio signature validation).
- `uploadedBy` field on documents provides an audit trail of which admin uploaded what.

### 7.3 Storage (packages/storage/)

- Extend with a `knowledge-base` bucket/prefix.
- Add content-type validation for upload URLs: only `application/pdf`, `text/plain`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`.
- Maximum file size enforced both in signed URL generation (GCS/S3 content-length condition) and in the API validation layer.

### 7.4 Existing SMS Flow

- The feedback path is completely unchanged when `qaEnabled === false`.
- When `qaEnabled === true`, the only addition before the branch point is the intent classification call (~200-500ms). If this call fails, the feedback path runs as before.
- The `smsMessage` table gets a new `messageType` column, defaulting to `"feedback"` — backward compatible for all existing queries and the feedback admin UI.

### 7.5 PII Compliance

- Phone numbers remain masked in all logs (existing `maskPhoneNumber` used throughout).
- Knowledge base documents may contain PII — this is the tenant's responsibility, but consider adding a warning in the upload UI.
- Q&A interaction records store question/answer text — this is necessary for audit. Ensure these are covered by the same data retention and deletion policies as `smsFeedback`.

### 7.6 AI Package (packages/ai/)

- If the existing `packages/ai/` package has shared Gemini client configuration, the intent classifier and RAG generator should use it for consistency (API key management, safety settings).
- If `packages/ai/` is thin or unused, the `packages/sms/` Gemini client pattern can be replicated in `packages/knowledge-base/`.

---

## 8. Edge Cases and Error Handling

### 8.1 No Relevant Knowledge Base Content

- When semantic search returns zero chunks above the similarity threshold (0.65), respond with a configurable "no information" message: *"I'm sorry, I don't have information about that. Your message has been noted and a team member may follow up."*
- Record as `answerStatus: "no_relevant_content"` for reporting.
- Do NOT hallucinate an answer. The RAG prompt must instruct the model: "If the provided context does not contain relevant information, respond with exactly: [no_answer_token]" — which the application code detects and replaces with the friendly message.

### 8.2 Empty Knowledge Base

- If a tenant has `qaEnabled === true` but zero indexed documents, every question gets `no_relevant_content`.
- Show a warning banner in the admin UI: "Q&A is enabled for [N] locations but your knowledge base has no indexed documents."
- Consider: should we allow enabling Q&A on a location with an empty KB? Probably yes (admin may be preparing), but surface the warning.

### 8.3 Document Processing Failures

- **Scanned/image PDF:** `pdf-parse` returns empty or near-empty text. Detect via character count threshold (<50 chars). Set status to `failed` with message: "Document appears to be scanned/image-based. Only text-based PDFs are supported."
- **Corrupted file:** Parser throws. Catch, set `failed` with generic message.
- **Qdrant unavailable during indexing:** Retry 3 times with exponential backoff. If all fail, set `failed`. Chunks are already in the DB — a "reprocess" endpoint could re-index them without re-parsing.
- **Partial indexing failure:** If some chunks index but others fail, set status to `failed` and clean up all chunks from Qdrant for that document. Don't leave partial indexes — it creates inconsistency between MySQL chunk records and Qdrant vectors.

### 8.4 Vector DB Unavailability at Query Time

- Retry once with a 2-second timeout.
- If still unavailable: send fallback SMS ("I'm unable to look that up right now. Please try again shortly."), record interaction with `error` status.
- Log at ERROR level for monitoring/alerting.

### 8.5 Conversation Context Management

- **Session timeout:** If `lastActivityAt` is older than `sessionTimeoutMs`, expire the conversation and start a new one.
- **Max interactions per session:** Cap at 10 interactions. After that, expire and create a new session. Prevents unbounded context growth.
- **Conversation history for RAG:** Include last 5 Q&A pairs max. Older context is dropped.
- **Cross-location:** A contact texting different locations has separate conversations (keyed on `contactId + locationId`).
- **Contact texts during processing:** If a second message arrives while the first is still being processed (RAG pipeline), the second message gets its own interaction. Both reference the same conversation. The order may not be strictly sequential — this is acceptable for SMS.

### 8.6 SMS Length Constraints

- Standard SMS segments: 160 chars (GSM-7) or 70 chars (UCS-2 for Unicode).
- Target answer length: ≤450 characters (~3 SMS segments, reasonable for a concise answer).
- RAG prompt includes: "Keep your answer concise, under 400 characters."
- Hard truncation at 450 characters with "..." appended if the model exceeds the limit.
- Multi-segment messages are handled by Twilio transparently.

### 8.7 Rate Limiting

- The existing sliding window rate limit (5 messages / 10 minutes) applies to all inbound messages regardless of type.
- Q&A questions are more expensive (LLM call + vector search + LLM generation) than feedback classification. If cost is a concern, consider a separate, tighter Q&A rate limit (e.g., 3 questions / 10 minutes) — flagged as an open question.

### 8.8 Prompt Injection via SMS

- The existing `classifyFeedback` has input sanitization. Apply the same sanitization to the intent classifier and RAG prompt.
- The RAG prompt is structured so user input is in a clearly delimited block — the model is instructed to treat it as a user question, not as instructions.
- The knowledge base context is trusted (admin-uploaded) but still inserted in a delimited block.

### 8.9 Document Deletion While Conversations Are Active

- Deleting a document removes its chunks from Qdrant immediately.
- Active conversations that previously used chunks from that document are unaffected — the `qaInteractionSource.chunkContentSnapshot` preserves the text used at query time.
- Future queries will simply not retrieve those chunks.

---

## 9. Migration Strategy

### Phase 0: Schema Migration (Zero Downtime)

- Run `drizzle-kit generate` to produce the migration.
- Migration is additive: new tables + new nullable/defaulted columns on existing tables.
- Deploy migration to production. No application code changes needed yet — new tables are empty, new columns have defaults.

### Phase 1: Knowledge Base Management (No SMS Changes)

- Deploy `packages/knowledge-base/`, storage extension, admin API endpoints, admin UI.
- Admins can upload and manage documents. Q&A is not connected to SMS yet.
- This phase is fully self-contained and testable independently.
- Docker Compose updated to include Qdrant for local dev.
- Environment variables added to deployment configuration.

### Phase 2: Q&A Processing (Behind Feature Flag)

- Deploy intent classifier, Q&A handler, webhook handler modifications.
- All behind `qaEnabled` flag on `smsLocationConfig` — no location has this enabled yet.
- Internal testing: enable for a test location, verify end-to-end flow.
- Staged rollout: enable for one real location, monitor for a week, then expand.

### Phase 3: Q&A Reporting

- Deploy metrics queries, admin API endpoints, dashboard UI.
- Can be developed in parallel with Phase 2 using seeded test data.

### Rollback Strategy

- **Immediate revert:** Set `qaEnabled = false` on all locations. The webhook instantly reverts to feedback-only behavior.
- **Code rollback:** The webhook changes are behind the `qaEnabled` check. Deploying the previous version of the webhook handler is safe — it won't read the Q&A tables, and the `smsMessage.messageType` default of `"feedback"` means old code writes valid data.
- **Database rollback:** Not needed for immediate revert. New tables can be dropped later if the feature is abandoned, but there's no urgency — they don't interfere with existing functionality.

---

## 10. Open Questions

These require stakeholder input before implementation begins:

1. **KB scope — tenant-level or location-level?**
   Current plan: tenant-level (all locations under a tenant share one KB). Alternative: per-location KBs. Tenant-level is simpler and probably correct for most use cases (company-wide FAQs). If some tenants need location-specific knowledge, we could add an optional `locationId` to `knowledgeBaseDocument` later.

2. **Q&A rate limiting — separate from feedback?**
   Q&A is more expensive (multiple LLM calls + vector search). Should we have a separate, tighter rate limit for questions? E.g., 3 questions / 10 minutes vs. 5 feedback messages / 10 minutes.

3. **What SMS should users receive when KB is empty?**
   Option A: Same "no information" message as when search returns no results.
   Option B: Different message acknowledging the system isn't set up yet.
   Option C: Fall back to treating the message as feedback silently.

4. **Should source citations appear in SMS responses?**
   E.g., "Based on our Return Policy document: ..." — adds transparency but uses SMS characters. Could be a per-tenant config option.

5. **Maximum knowledge base size per tenant?**
   Need to set limits on: total documents, total storage (MB), total chunks. Suggested starting point: 100 documents, 500MB, 10,000 chunks.

6. **Session timeout — fixed or configurable per location?**
   Current plan includes per-location override (`qaSessionTimeoutMs` on `smsLocationConfig`). Is this needed for MVP, or should we start with a system-wide default?

7. **Follow-up feedback handling**
   When a user sends feedback after receiving a Q&A answer (classified as `follow_up_feedback`), should it:
   - (a) Be linked to the Q&A interaction for context?
   - (b) Be treated as standard feedback?
   - (c) Both — standard feedback record + a link to the Q&A conversation?
   Option (c) is the most complete but adds schema complexity.

8. **Document update workflow**
   When an admin wants to update a document, should we support:
   - (a) Delete and re-upload (simpler, MVP approach)?
   - (b) Versioning (upload new version, old one archived)?
   Delete-and-reupload is recommended for MVP.

9. **LLM cost tracking**
   Should we track per-tenant LLM token usage for Q&A? This is important for billing/fairness but adds complexity. At minimum, log token counts per interaction.

10. **Supported languages**
    Is Q&A expected to work in languages other than English? `text-embedding-004` and Gemini both support multilingual, but the "no information" fallback messages and system prompts would need localization.

---

## 11. Implementation Sequence

### Phase 1: Foundation (3-4 dev-days)

**Dependencies:** None (starting point)

1. Database schema: add all new tables, columns, indexes to Drizzle schema
2. Generate and review migration
3. Query functions: `packages/database/drizzle/queries/knowledge-base.ts` and `qa.ts`
4. Scaffold `packages/knowledge-base/` package with `package.json`, `tsconfig.json`
5. Implement `document-parser.ts` (PDF, DOCX, TXT extraction)
6. Implement `chunker.ts` (recursive character splitting)
7. Implement `embeddings.ts` (text-embedding-004 integration)
8. Implement `vector-store.ts` (Qdrant client abstraction, collection management)
9. Implement `processor.ts` (orchestrator: parse → chunk → embed → index)
10. Docker Compose: add Qdrant service for local dev
11. Unit tests for parser, chunker, embeddings (mocked), vector store (integration test against local Qdrant)

### Phase 2: Knowledge Base Admin (3-4 dev-days)

**Dependencies:** Phase 1

1. Extend `packages/storage/` with KB document upload support (content-type validation, signed URLs)
2. Admin API: `knowledge-base.ts` procedures (upload URL, process, list, detail, delete, status)
3. Admin UI: `KnowledgeBaseList`, `DocumentUploadDialog`, `DocumentStatusPoller`, `DeleteDocumentDialog`
4. Admin sidebar navigation update
5. Integration tests: upload → process → verify indexed → delete → verify cleaned up

### Phase 3: Q&A Core (4-5 dev-days)

**Dependencies:** Phase 1 (Phase 2 for end-to-end testing)

1. Implement `packages/knowledge-base/lib/search.ts` (semantic search with threshold)
2. Implement `packages/knowledge-base/lib/rag.ts` (RAG generation with grounding prompt)
3. Implement `packages/sms/lib/intent-classifier.ts` (4-class intent classification)
4. Implement conversation session management in `packages/database/drizzle/queries/qa.ts`
5. Implement `packages/api/modules/sms/procedures/qa-handler.ts` (extracted Q&A branch)
6. Modify `twilio-webhook.ts`: add branch point after rate limiting, integrate Q&A handler
7. Integration tests: full webhook flow with Q&A enabled/disabled, follow-ups, edge cases
8. Load testing: verify latency with concurrent Q&A requests

### Phase 4: Reporting (3-4 dev-days)

**Dependencies:** Phase 3 (can start in parallel using seeded test data)

1. Implement metrics queries in `packages/database/drizzle/queries/qa.ts`
2. Admin API: `qa-reports.ts` procedures (metrics, interactions list, detail, export)
3. Admin UI: `QaMetricsCards`, `QuestionsPerDayChart`, `QaInteractionList`, `QaInteractionDetail`, `QaExportButton`
4. UI integration tests

### Phase 5: Hardening (2-3 dev-days)

**Dependencies:** Phases 1-4

1. Qdrant health check endpoint + monitoring integration
2. PII compliance audit: verify phone masking in all new log paths
3. Performance testing: measure end-to-end latency (target: <5 seconds from SMS receipt to response sent)
4. Error monitoring: ensure all new error paths have structured logging with correlation IDs
5. Documentation: update API docs, add KB admin guide, update deployment runbook with Qdrant
6. Tenant cleanup: verify CASCADE deletes work correctly for all new tables
7. Environment variable documentation and validation

**Total estimated effort: 15-20 developer-days**

Phases 2 and 3 are partially parallelizable (different developers on admin UI vs. SMS flow). Phase 4 can start once Phase 3 has seeded data. Realistic timeline with one developer: ~4 weeks. With two developers: ~2.5 weeks.

---

## Appendix A: New Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `QDRANT_URL` | Yes | — | Qdrant server URL (`http://localhost:6333` for local) |
| `QDRANT_API_KEY` | Prod only | — | Qdrant Cloud API key |
| `KB_CHUNK_SIZE` | No | `1000` | Characters per chunk |
| `KB_CHUNK_OVERLAP` | No | `200` | Overlap between chunks |
| `KB_SEARCH_TOP_K` | No | `5` | Number of chunks to retrieve |
| `KB_SIMILARITY_THRESHOLD` | No | `0.65` | Minimum similarity score |
| `KB_MAX_FILE_SIZE` | No | `20000000` | Max upload size in bytes (20MB) |
| `QA_SESSION_TIMEOUT_MS` | No | `1800000` | Default session timeout (30 min) |
| `QA_MAX_ANSWER_LENGTH` | No | `450` | Max answer length in characters |
| `QA_MAX_HISTORY_PAIRS` | No | `5` | Max Q&A pairs in conversation context |
| `QA_MAX_INTERACTIONS_PER_SESSION` | No | `10` | Max interactions before session expires |

## Appendix B: Intent Classification Prompt (Draft)

```
You are a message intent classifier for a customer SMS system. Classify the customer's message into exactly one category.

Categories:
- feedback: The customer is providing feedback, a comment, a complaint, or a suggestion about their experience.
- question: The customer is asking a question seeking information or an answer.
- follow_up_feedback: The customer is responding to a previous answer with feedback (e.g., "thanks", "that didn't help", commenting on the answer quality).
- follow_up_question: The customer is asking a follow-up question related to a previous answer.

Rules:
- If there is no conversation history, the message can only be "feedback" or "question".
- Messages that are ambiguous should default to "feedback".
- Short affirmative responses after an answer ("ok", "thanks", "got it") are "follow_up_feedback".

Conversation history (most recent last):
{conversationHistory}

New message from customer:
"{messageBody}"

Respond with JSON only: {"intent": "<category>", "confidence": <0.0-1.0>}
```

## Appendix C: RAG Generation Prompt (Draft)

```
You are a helpful assistant answering customer questions via SMS. You MUST answer based ONLY on the provided knowledge base context. Do NOT use any external knowledge.

Rules:
- If the context does not contain information relevant to the question, respond with exactly: [NO_ANSWER]
- Keep your answer concise — under 400 characters. This will be sent as an SMS.
- Be direct and helpful. Do not include greetings or sign-offs.
- Do not mention "the context" or "the documents" — answer as if you naturally know the information.

Knowledge base context:
---
{retrievedChunks}
---

{conversationHistory}

Customer question: "{questionText}"
```
