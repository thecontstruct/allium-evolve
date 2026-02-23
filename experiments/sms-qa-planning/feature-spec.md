# Feature Specification: SMS Q&A with Knowledge Base

## Overview

Extend the existing SMS feedback system to support a Q&A feature where customers can text in questions and receive LLM-generated answers derived exclusively from a tenant-managed knowledge base.

## Requirements

### 1. Message Classification

The system must distinguish incoming SMS messages as one of:
- **Pure feedback** — existing behavior, routed to feedback pipeline
- **A new question** — a question unrelated to any prior conversation
- **Follow-up feedback** — feedback related to a previously provided answer
- **Follow-up question** — a follow-up question to a previously provided answer

Use the existing LLM integration to make this classification judgment.

### 2. Knowledge Base

- Admins can upload documents to a per-tenant knowledge base
- Documents are stored and indexed in a vector database for semantic search
- Answers to questions can ONLY be derived from the knowledge base content
- If no relevant answer is found in the knowledge base, the system must communicate this clearly to the user

### 3. Q&A Interaction Flow

- When a question is detected, perform semantic search against the knowledge base
- Generate an LLM answer using ONLY the retrieved context from the knowledge base
- Send the answer back via SMS
- Support follow-up questions that maintain conversation context

### 4. Auditability

- Every interaction (question received, search performed, answer generated, SMS sent) must be recorded
- Full audit trail linking questions to knowledge base sources used
- Track which documents contributed to each answer

### 5. Admin UI — Knowledge Base Management

- Document upload (support common formats: PDF, TXT, DOCX)
- Document listing with metadata (upload date, file type, size, uploading user)
- Document deletion with confirmation
- Document status tracking (processing, indexed, failed)

### 6. Admin UI — Q&A Reports

- Q&A interaction activity dashboard
- Metrics: total questions, answer rate, unanswered rate, avg response time
- Filter by date range, location, answer status
- View individual Q&A interactions with full audit trail
- Export capability
