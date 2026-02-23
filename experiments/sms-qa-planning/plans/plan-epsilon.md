# Implementation Plan: SMS Q&A with Knowledge Base

**Date:** 2026-02-22
**Status:** Draft — Pending stakeholder review

---

## 1. Architecture Decisions

### 1.1 Vector Database — Pinecone Serverless

**Choice:** Pinecone Serverless (managed) with the `@pinecone-database/pinecone` Node.js SDK.

**Justification:**
- MySQL 8.4 has no vector search capability. Adding PostgreSQL + pgvector introduces a second relational engine, which is unnecessary complexity.
- Pinecone Serverless has a generous free tier suitable for early rollout and pay-per-query pricing that avoids idle cost.
- Fully managed — no Docker container to maintain locally, no infrastructure provisioning for production. This reduces operational burden compared to self-hosted options like Qdrant or Milvus.
- Well-maintained TypeScript SDK with namespace support that maps cleanly to multi-tenant isolation.
- **Alternative considered:** Qdrant (self-hosted via Docker for dev, Qdrant Cloud for prod). Better suited if we want to avoid vendor lock-in or need on-prem deployment. Worth revisiting if Pinecone pricing becomes a concern at scale.

**Tenant isolation strategy:** Single Pinecone index with per-tenant namespaces. Namespaces provide hard query isolation without separate infrastructure per tenant. Deletion is a namespace-level operation. If tenant volume exceeds index limits, shard to multiple indexes by tenant hash.

### 1.2 Embedding Model — OpenAI text-embedding-3-small

**Choice:** `text-embedding-3-small` via the OpenAI SDK (already at v6.6.0 in `packages/ai/`).

**Justification:**
- The existing codebase already depends on `openai@6.6.0` for feedback classification. Reusing the same SDK and API key avoids a new vendor relationship.
- 1536 dimensions, strong English performance, 8191 token context window.
- `dimensions` parameter allows dimension reduction (e.g. to 512) if storage costs become a concern — Pinecone supports this natively.
- **Alternative considered:** Google `text-embedding-004` via `@google/generative-ai`. Viable since the SDK is present, but 768 dimensions and fewer tuning knobs. The OpenAI embedding model has stronger benchmark performance for retrieval tasks.

### 1.3 Document Processing — Background Processing with Status Polling

**Choice:** Async document processing triggered by an API call after upload confirmation. Status tracked in MySQL (`pending → processing → indexed | failed`). Admin polls a lightweight status endpoint.

**Justification:**
- No job queue infrastructure exists in the codebase. Introducing Redis + BullMQ for a single low-frequency admin operation is premature.
- Document processing is CPU-bound (parsing, chunking) and I/O-bound (embedding API, vector upsert) but not long-running for typical documents (<5MB policy docs, FAQs).
- Processing is initiated explicitly by the admin (not on upload), allowing upload-then-review-then-process workflow.
- A stale-processing timeout (15 minutes) auto-fails stuck documents, preventing orphaned `processing` states.
- **Upgrade path:** If processing latency or volume requires it, wrap the existing processing function in a BullMQ worker. The isolation is already there.

### 1.4 Conversation Session Management — Implicit Time-Windowed Sessions

**Choice:** Sessions inferred from `(contactId, locationId)` pairs with a configurable inactivity timeout (default 30 minutes). No explicit session start/end from the user.

**Justification:**
- SMS has no session protocol — timing is the only reliable heuristic.
- 30 minutes balances "still thinking" vs "new topic" for typical customer interactions.
- Session history bounded to last 5 Q&A exchanges to control LLM token usage and avoid stale context contamination.
- Sessions expire automatically; a cron-like mechanism or lazy expiration on next message handles cleanup.

### 1.5 Message Classification — Two-Stage Pipeline

**Choice:** New first-stage intent classifier upstream of the existing `classifyFeedback()`:

1. **Stage 1 — Intent detection:** `feedback | question | follow_up_feedback | follow_up_question`
2. **Stage 2 — Domain processing:**
   - `feedback` / `follow_up_feedback` → existing `classifyFeedback()` pipeline (unchanged)
   - `question` / `follow_up_question` → Q&A pipeline (search → RAG → respond)

**Justification:**
- Preserves the existing `classifyFeedback()` function without modification — that code is production-tested with known failure modes.
- Intent classification is a cleaner, lower-entropy problem (4 classes) than combining it with the existing feedback taxonomy.
- Follow-up detection requires conversation history context that the current classifier doesn't receive.
- **Fallback:** If intent classification fails or confidence is below threshold, default to `feedback`. This preserves backward compatibility — no question is lost, it just goes through the existing feedback path.

### 1.6 Document Parsing

| Format | Library | Notes |
|--------|---------|-------|
| PDF | `pdf-parse` | Handles text-based PDFs. Detects and reports empty extraction (scanned PDFs) as a processing error. |
| DOCX | `mammoth` | Extracts text with structural markers. Strips formatting. |
| TXT | Native `fs.readFile` | Direct read with encoding detection. |

### 1.7 Chunking Strategy

Paragraph-aware recursive splitting: split on double newlines first, then single newlines, then sentence boundaries, then character boundaries. Target chunk size: 800 tokens. Overlap: 100 tokens. Token counting via `tiktoken` (GPT tokenizer — close enough for embedding models).

---

## 2. Database Schema Changes

All new tables follow existing conventions: `bigint` auto-increment PKs, camelCase column names, `tenantId` FK with `CASCADE` delete, `createdAt`/`updatedAt` timestamps where applicable.

### 2.1 New Tables

```typescript
// In packages/database/drizzle/schema/mysql.ts

export const knowledgeBaseDocument = mysqlTable("knowledge_base_document", {
  id: bigint("id", { mode: "bigint" }).primaryKey().autoincrement(),
  tenantId: bigint("tenant_id", { mode: "bigint" })
    .notNull()
    .references(() => tenant.id, { onDelete: "cascade" }),
  title: varchar("title", { length: 255 }).notNull(),
  fileName: varchar("file_name", { length: 512 }).notNull(),
  fileType: mysqlEnum("file_type", ["pdf", "txt", "docx"]).notNull(),
  fileSize: int("file_size").notNull(),
  storagePath: varchar("storage_path", { length: 1024 }).notNull(),
  status: mysqlEnum("status", ["pending", "processing", "indexed", "failed"])
    .notNull()
    .default("pending"),
  chunkCount: int("chunk_count").default(0),
  errorMessage: text("error_message"),
  processingStartedAt: timestamp("processing_started_at"),
  processingCompletedAt: timestamp("processing_completed_at"),
  uploadedBy: bigint("uploaded_by", { mode: "bigint" })
    .notNull()
    .references(() => user.id),
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
  vectorId: varchar("vector_id", { length: 64 }),
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
  contactId: bigint("contact_id", { mode: "bigint" }).notNull(),
  status: mysqlEnum("status", ["active", "expired"])
    .notNull()
    .default("active"),
  messageCount: int("message_count").notNull().default(0),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  lastActivityAt: timestamp("last_activity_at").defaultNow().notNull(),
  expiredAt: timestamp("expired_at"),
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
  questionMessageId: bigint("question_message_id", { mode: "bigint" }).notNull(),
  answerMessageId: bigint("answer_message_id", { mode: "bigint" }),
  questionText: text("question_text").notNull(),
  answerText: text("answer_text"),
  answerStatus: mysqlEnum("answer_status", [
    "pending",
    "answered",
    "no_relevant_content",
    "error",
  ]).notNull().default("pending"),
  isFollowUp: boolean("is_follow_up").notNull().default(false),
  intentClassification: varchar("intent_classification", { length: 50 }),
  intentConfidence: decimal("intent_confidence", { precision: 4, scale: 3 }),
  searchScoreMax: decimal("search_score_max", { precision: 5, scale: 4 }),
  searchLatencyMs: int("search_latency_ms"),
  generationLatencyMs: int("generation_latency_ms"),
  totalLatencyMs: int("total_latency_ms"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const qaInteractionSource = mysqlTable("qa_interaction_source", {
  id: bigint("id", { mode: "bigint" }).primaryKey().autoincrement(),
  interactionId: bigint("interaction_id", { mode: "bigint" })
    .notNull()
    .references(() => qaInteraction.id, { onDelete: "cascade" }),
  chunkId: bigint("chunk_id", { mode: "bigint" })
    .notNull()
    .references(() => knowledgeBaseChunk.id, { onDelete: "set null" }),
  documentId: bigint("document_id", { mode: "bigint" })
    .notNull()
    .references(() => knowledgeBaseDocument.id, { onDelete: "set null" }),
  similarityScore: decimal("similarity_score", { precision: 5, scale: 4 }).notNull(),
  chunkRank: int("chunk_rank").notNull(),
  chunkContentSnapshot: text("chunk_content_snapshot").notNull(),
});
```

### 2.2 Modifications to Existing Tables

**`smsMessage`** — Add message type column:

```typescript
messageType: mysqlEnum("message_type", [
  "feedback",
  "qa_question",
  "qa_answer",
  "system",
]).notNull().default("feedback"),
```

**`smsLocationConfig`** — Add Q&A feature flag:

```typescript
qaEnabled: boolean("qa_enabled").notNull().default(false),
```

### 2.3 Indexes

```typescript
// knowledgeBaseDocument
index("idx_kb_doc_tenant_status").on(
  knowledgeBaseDocument.tenantId,
  knowledgeBaseDocument.status
),

// knowledgeBaseChunk
index("idx_kb_chunk_document").on(knowledgeBaseChunk.documentId),
index("idx_kb_chunk_tenant").on(knowledgeBaseChunk.tenantId),

// qaConversation
uniqueIndex("idx_qa_conv_active").on(
  qaConversation.contactId,
  qaConversation.locationId,
  qaConversation.status
),
index("idx_qa_conv_tenant").on(qaConversation.tenantId),
index("idx_qa_conv_last_activity").on(qaConversation.lastActivityAt),

// qaInteraction
index("idx_qa_int_conversation").on(qaInteraction.conversationId),
index("idx_qa_int_tenant_created").on(qaInteraction.tenantId, qaInteraction.createdAt),
index("idx_qa_int_location").on(qaInteraction.locationId),
index("idx_qa_int_status").on(qaInteraction.answerStatus),

// qaInteractionSource
index("idx_qa_src_interaction").on(qaInteractionSource.interactionId),
index("idx_qa_src_document").on(qaInteractionSource.documentId),
```

### 2.4 Migration

Single additive migration generated via `drizzle-kit generate`. All new tables are independent; modifications to existing tables add nullable/defaulted columns only. Safe for zero-downtime deployment.

---

## 3. New Packages & Modules

### 3.1 `packages/knowledge-base/` — New Package

```
packages/knowledge-base/
├── package.json
├── tsconfig.json
├── index.ts                    # Public exports
├── types.ts                    # Shared types
├── config.ts                   # Configuration (chunk size, thresholds, etc.)
├── lib/
│   ├── document-parser.ts      # PDF/DOCX/TXT extraction
│   ├── chunker.ts              # Paragraph-aware recursive splitting
│   ├── embeddings.ts           # OpenAI embedding wrapper
│   ├── vector-store.ts         # Pinecone client abstraction
│   ├── semantic-search.ts      # Search orchestration (embed query → search → rank)
│   ├── answer-generator.ts     # RAG prompt construction and LLM call
│   └── document-processor.ts   # End-to-end pipeline: parse → chunk → embed → upsert
└── __tests__/
    ├── chunker.test.ts
    ├── document-parser.test.ts
    ├── semantic-search.test.ts
    └── answer-generator.test.ts
```

**Dependencies:** `@pinecone-database/pinecone`, `openai` (shared), `pdf-parse`, `mammoth`, `tiktoken`

### 3.2 Extensions to `packages/sms/`

- `lib/intent-classifier.ts` — Stage 1 intent classification using OpenAI
- Update `lib/webhook-handler.ts` — Branch on intent result

### 3.3 Extensions to `packages/ai/`

- `lib/intent-classifier-prompts.ts` — System/user prompt templates for intent classification

### 3.4 New API Procedures

```
packages/api/modules/admin/procedures/
├── knowledge-base.ts       # KB CRUD, upload URL, processing trigger
├── qa-reports.ts           # Metrics, interaction list, detail, export
└── qa-config.ts            # Location-level Q&A toggle
```

### 3.5 New Database Query Modules

```
packages/database/drizzle/queries/
├── knowledge-base.ts       # Document and chunk CRUD
├── qa-conversation.ts      # Conversation find-or-create, expiration
├── qa-interaction.ts       # Interaction recording, reporting queries
└── qa-audit.ts             # Source recording, audit trail queries
```

---

## 4. API Endpoints

All endpoints protected by `adminProcedure` (existing tenant-scoped authorization guard).

### 4.1 Knowledge Base Management

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/admin/knowledge-base/upload-url` | Generate signed upload URL + create document record |
| POST | `/admin/knowledge-base/documents/:id/process` | Trigger async processing |
| GET | `/admin/knowledge-base/documents` | Paginated list with status/type filters |
| GET | `/admin/knowledge-base/documents/:id` | Document detail with chunk count |
| DELETE | `/admin/knowledge-base/documents/:id` | Delete document + chunks + vectors |
| GET | `/admin/knowledge-base/documents/:id/status` | Lightweight status poll |

### 4.2 Q&A Reports

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/admin/qa/metrics` | Dashboard metrics (totals, rates, avg response time, trends) |
| GET | `/admin/qa/interactions` | Paginated interaction list with filters |
| GET | `/admin/qa/interactions/:id` | Full interaction detail with sources and audit trail |
| GET | `/admin/qa/export` | CSV export with filter passthrough |

### 4.3 Q&A Configuration

| Method | Path | Purpose |
|--------|------|---------|
| PATCH | `/admin/locations/:id/qa-config` | Toggle `qaEnabled` per location |

---

## 5. SMS Flow Changes

### 5.1 Modified Webhook Handler

```
Existing steps 1-6: [UNCHANGED — Twilio validation, tenant resolution,
                      contact lookup, location resolution, message record]

Step 7:   Read smsLocationConfig.qaEnabled for resolved location
Step 8:   IF qaEnabled is false → skip to existing classifyFeedback flow (no change)
Step 9:   IF qaEnabled is true:
          a. Load active conversation for (contactId, locationId) within timeout window
          b. Build conversation context (last N messages)
          c. Call intentClassifier(messageBody, conversationContext)
Step 10:  BRANCH on intent:
          ┌─ feedback | follow_up_feedback → existing classifyFeedback() flow
          └─ question | follow_up_question → Q&A pipeline:
             i.   Find-or-create qaConversation
             ii.  Create qaInteraction record (status: pending)
             iii. Semantic search against tenant namespace
             iv.  RAG answer generation with retrieved chunks
             v.   Update qaInteraction (answerText, status, latencies)
             vi.  Record qaInteractionSource rows
             vii. Create outbound smsMessage (type: qa_answer)
             viii. Send SMS via Twilio
Step 11:  Error handling — on Q&A pipeline failure:
          a. Update qaInteraction status to "error"
          b. Send apology SMS ("Sorry, I couldn't find an answer...")
          c. Do NOT reclassify as feedback
```

### 5.2 Design Invariants

- `qaEnabled = false` → **zero behavioral change** to existing SMS flow
- Intent classification failure → default to `feedback` (preserves backward compat)
- Q&A pipeline failure → error SMS, not reclassified as feedback
- All Q&A interactions are recorded regardless of success/failure (audit requirement)

---

## 6. UI Components

### 6.1 Knowledge Base Management

**Route:** `apps/web/app/(saas)/app/(account)/admin/knowledge-base/`

- **Document list page** — Table with columns: title, file type, size, status badge, upload date, uploader. Filterable by status. Sortable by date.
- **Upload dialog** — Drag-and-drop zone accepting PDF/TXT/DOCX. File type and size validation client-side (<10MB default). Uses signed URL for direct-to-storage upload, then calls `/process` endpoint.
- **Document detail** — Metadata display, chunk count, processing timestamps, error message display for failed documents.
- **Delete confirmation** — Destructive action dialog following existing pattern.
- **Processing status** — Badge component with color-coded states (gray=pending, blue=processing, green=indexed, red=failed). Polling every 3 seconds during `processing` state.

### 6.2 Q&A Reports Dashboard

**Route:** `apps/web/app/(saas)/app/(account)/admin/qa/`

- **Metrics cards** — Total questions, answer rate (%), unanswered rate (%), avg response time (ms), questions today.
- **Activity chart** — Questions per day, line chart with 30-day default range.
- **Interaction list** — Filterable table: date range, location, answer status, search text. URL state via nuqs (matching existing feedback dashboard pattern).
- **Interaction detail** — Full question + answer text, conversation thread, source documents with relevance scores, timing breakdown, audit timestamps.
- **Top unanswered questions** — Panel showing recurring questions with no relevant content.
- **CSV export** — Respects active filters, triggers download.

### 6.3 Q&A Location Configuration

**Route:** Extend existing location settings page at `apps/web/app/(saas)/app/(account)/admin/locations/`

- Toggle switch for `qaEnabled` per location.
- Disabled state with explanation if no KB documents are indexed for the tenant.

### 6.4 Navigation Changes

Add to admin sidebar:
- "Knowledge Base" under a new "Q&A" group
- "Q&A Reports" under the same group

---

## 7. Integration Points

### 7.1 Multi-Tenancy

- Every new MySQL table has `tenantId` FK with `CASCADE` delete
- Pinecone namespaces scoped by `tenantId`
- Storage paths namespaced: `knowledge-base/{tenantId}/{documentId}/...`
- All query functions accept `tenantId` parameter — no cross-tenant data leakage possible

### 7.2 Authorization

- All admin endpoints use `adminProcedure` (existing tenant-scoped guard)
- No new roles needed — existing admin/owner distinction is sufficient
- Q&A webhook processing is system-initiated (Twilio), no user auth context needed

### 7.3 Storage

- Reuse existing storage abstraction (`packages/storage/`) for KB document uploads
- New bucket or prefix: `knowledge-base/` within existing tenant-scoped bucket
- Signed URL generation uses existing `SignedURLConfig` pattern with PDF/DOCX/TXT content types

### 7.4 Existing SMS Flow

- Additive change — the branch point is a new `if/else` after location config lookup
- Existing `classifyFeedback()` is never modified, only conditionally bypassed
- All existing tests continue to pass without modification

### 7.5 AI/LLM

- Uses existing OpenAI SDK (`openai@6.6.0`) for embeddings and intent classification
- Answer generation via OpenAI chat completions (gpt-4o-mini for cost efficiency in RAG)
- Same error handling, timeout, and retry patterns as existing feedback classification

---

## 8. Edge Cases & Error Handling

### 8.1 No Relevant KB Content Found

Similarity score below threshold (default 0.65) for all retrieved chunks. Record interaction as `no_relevant_content`, send configurable "I don't have information about that" message. Track in metrics for admin visibility.

### 8.2 Empty Knowledge Base

If tenant has zero indexed documents when a question arrives, immediately return `no_relevant_content` without hitting Pinecone. Admin UI shows a warning banner when Q&A is enabled but KB is empty.

### 8.3 Document Processing Failures

- Parse failure (corrupt PDF, password-protected): Mark `failed` with descriptive error. Admin can delete and re-upload.
- Embedding API failure mid-document: Rollback all chunks and vectors for that document. Mark `failed`.
- Stale processing detection: Documents in `processing` state for >15 minutes are auto-failed by a periodic check (run on admin dashboard load, not a background cron).

### 8.4 Vector Database Unavailability

- 5-second timeout on Pinecone calls
- Single retry with exponential backoff
- On failure: record interaction as `error`, send apology SMS
- Do NOT fall back to feedback classification — the user asked a question, don't silently reinterpret it

### 8.5 Conversation Context Edge Cases

- Session timeout (30 min inactivity): Create new conversation, classify as `question` not `follow_up_question`
- Rapid successive messages: Process sequentially per (contactId, locationId) — use database-level unique constraint on active conversations to prevent race conditions
- Very long conversations: Cap context window at 5 most recent Q&A exchanges

### 8.6 SMS Length Constraints

- RAG prompt instructs model to answer in ≤300 characters
- Hard truncation at 480 characters (3 SMS segments) with "..." suffix
- If answer requires more detail, append "For more info, contact [location]"

### 8.7 Concurrent Document Operations

- Check document status before allowing re-processing (reject if already `processing`)
- Document deletion while processing: Mark for deletion, processing pipeline checks status before vector upsert
- Unique constraint on `(tenantId, storagePath)` prevents duplicate uploads

### 8.8 Prompt Injection / Adversarial Input

- System prompt uses strict RAG grounding: "Answer ONLY from the provided context"
- Input sanitization on SMS body before passing to LLM
- Model temperature set to 0.1 for factual consistency

### 8.9 Rate Limiting

- Existing Twilio webhook rate limiting still applies
- Consider adding a separate Q&A interaction rate limit per contact (e.g., 20 questions/hour) to prevent abuse — mark as open question for stakeholder input

---

## 9. Migration Strategy

### Phase 0: Infrastructure Setup
- Provision Pinecone index (serverless, us-east-1)
- Add environment variables to Secret Manager and deployment config
- No code changes deployed

### Phase 1: Schema + Packages (no behavioral change)
- Database migration (additive only, zero-downtime safe)
- `packages/knowledge-base/` scaffolded and tested in isolation
- New query modules created
- `qaEnabled` defaults to `false` everywhere — no impact on existing behavior

### Phase 2: Knowledge Base Admin
- API endpoints for document management
- Admin UI for upload, list, delete, status
- Location config UI for Q&A toggle
- Still no SMS behavioral change

### Phase 3: Q&A Pipeline (gated by `qaEnabled`)
- Intent classifier deployed
- Webhook handler modified with Q&A branch
- Q&A pipeline end-to-end operational
- `qaEnabled` remains `false` in production — requires explicit admin opt-in

### Phase 4: Reporting + Polish
- Q&A metrics and reporting API
- Dashboard UI
- Export functionality
- Monitoring and alerting

### Phase 5: Rollout
- Enable for pilot tenant(s)
- Monitor metrics, latency, answer quality
- Gradual rollout to remaining tenants

**Rollback:** Set `qaEnabled = false` on all locations for immediate behavioral revert. No schema rollback needed — all changes are additive.

---

## 10. Open Questions

1. **KB scope — per-tenant or per-location?** Spec says "tenant-managed" but locations have different contexts. Recommend starting per-tenant with a possible per-location override in the future.
2. **Q&A rate limiting — shared with feedback or separate?** Separate limits may be needed since Q&A is more resource-intensive (LLM + vector search per interaction).
3. **Source citations in SMS?** Should the answer include "Based on [Document Title]"? Adds transparency but consumes character budget.
4. **Document size limits?** Need a per-document max (10MB?) and per-tenant total KB size limit.
5. **Follow-up feedback routing** — If someone provides feedback about a Q&A answer, should it be linked to the Q&A interaction, recorded as standard feedback, or both?
6. **"No answer" escalation** — Should unanswered questions trigger a notification to staff? If so, via what channel?
7. **Document versioning vs. delete-and-reupload** — The spec says "deletion" but admins may want to update a document. For MVP, delete-and-reupload is simplest.
8. **LLM cost monitoring** — Per-tenant usage tracking? Monthly caps? This could become significant at scale.
9. **Multilingual support** — Are questions expected in languages other than English? Embedding model and prompt design implications.
10. **Q&A reports access level** — Admin only, or should `member` role users (store managers) see reports for their locations?
11. **Conversation session timeout configurability** — Global default or per-tenant? Per-location seems excessive for MVP.

---

## 11. Implementation Sequence

### Phase 1: Foundation (4-5 days)
- **1a.** Database schema additions + migration generation (1 day)
- **1b.** `packages/knowledge-base/` scaffolding — types, config, document parser (1 day)
- **1c.** Chunker implementation + unit tests (0.5 day)
- **1d.** Embedding client + Pinecone vector store client (1 day)
- **1e.** Document processor end-to-end pipeline + tests (1 day)
- **1f.** Docker Compose: no changes needed (Pinecone is fully managed)

### Phase 2: KB Admin + Intent Classification (5-6 days, parallelizable)
- **2a.** KB query functions in database package (1 day)
- **2b.** KB admin API endpoints — upload URL, process, list, detail, delete, status (2 days)
- **2c.** KB admin UI — document list, upload dialog, status badges, delete (2 days)
- **2d.** Location Q&A config toggle — API + UI (0.5 day)
- **2e.** Intent classifier implementation + tests (2 days, parallel with 2a-d)

### Phase 3: Q&A SMS Pipeline (5-6 days)
- **3a.** Semantic search module (1 day)
- **3b.** RAG answer generator with constrained prompting (1.5 days)
- **3c.** Conversation find-or-create + session management (1 day)
- **3d.** Webhook handler modification — intent branch, Q&A pipeline integration (2 days)
- **3e.** Integration tests for full Q&A flow (1.5 days)

### Phase 4: Reporting & Hardening (4-5 days)
- **4a.** Q&A reporting query functions (1 day)
- **4b.** Q&A metrics + interaction list API (1 day)
- **4c.** Q&A dashboard UI — metrics cards, interaction list, detail view (2 days)
- **4d.** CSV export with filter passthrough (0.5 day)
- **4e.** Stale processing detection, error logging, PII audit (1 day)

### Phase 5: Rollout (2-3 days)
- Pinecone production provisioning and configuration
- Environment variable setup via Secret Manager
- Pilot tenant onboarding
- Monitoring dashboard setup

**Total estimate: 20-25 developer-days (~4-5 weeks single developer, ~2.5-3 weeks with two developers).**

**Critical path:** Phase 1 → Phase 2e (intent classifier) → Phase 3 → Phase 5

---

## Appendix A: New Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PINECONE_API_KEY` | Yes | — | Pinecone API key |
| `PINECONE_INDEX` | Yes | — | Pinecone index name |
| `PINECONE_ENVIRONMENT` | No | `us-east-1` | Pinecone serverless region |
| `KB_CHUNK_SIZE_TOKENS` | No | `800` | Target chunk size in tokens |
| `KB_CHUNK_OVERLAP_TOKENS` | No | `100` | Chunk overlap in tokens |
| `KB_SEARCH_TOP_K` | No | `5` | Number of chunks to retrieve |
| `KB_SIMILARITY_THRESHOLD` | No | `0.65` | Minimum similarity score |
| `QA_SESSION_TIMEOUT_MS` | No | `1800000` | Conversation inactivity timeout (30 min) |
| `QA_MAX_ANSWER_LENGTH` | No | `480` | Hard max SMS answer length |
| `QA_MAX_CONTEXT_EXCHANGES` | No | `5` | Max conversation history depth |

## Appendix B: New Dependencies

| Package | Version | Used By |
|---------|---------|---------|
| `@pinecone-database/pinecone` | `^4.x` | `packages/knowledge-base/` |
| `pdf-parse` | `^1.x` | `packages/knowledge-base/` |
| `mammoth` | `^1.x` | `packages/knowledge-base/` |
| `tiktoken` | `^2.x` | `packages/knowledge-base/` |
