#!/usr/bin/env bash
set -euo pipefail

# Creates a test git repo with known topology:
#
# trunk:  A ── B ── C ──────── M1 ── D ── E ──── M2 ── F ── G ── H ── I ── J ── K ── L ── M ── N ── O ── P ── Q ── R ── S ── T ── U
#                   │          /                   /
# branch-x:        ├── X1 ── X2          dead:  Z1 ── Z2
#                   │                    /
# branch-y:        └── Y1 ── Y2 ── Y3 ─
#
# Total: ~35 commits (15 original + 20 new trunk commits after F)
# Idempotent: removes and recreates the repo directory each run.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${SCRIPT_DIR}/repo"

rm -rf "${REPO_DIR}"
mkdir -p "${REPO_DIR}"
cd "${REPO_DIR}"

git init
git branch -M main
git config user.email "test@allium-evolve.dev"
git config user.name "Test Author"

COMMIT_SEQ=1

make_commit() {
  local filename="$1"
  local content="$2"
  local message="$3"

  mkdir -p "$(dirname "${filename}")"
  echo "${content}" > "${filename}"
  git add "${filename}"
  GIT_COMMITTER_DATE="2025-01-01T00:00:0${COMMIT_SEQ}Z" \
    GIT_AUTHOR_DATE="2025-01-01T00:00:0${COMMIT_SEQ}Z" \
    git commit -m "${message}"
  COMMIT_SEQ=$(( COMMIT_SEQ + 1 ))
}

make_multi_commit() {
  local message="$1"
  shift
  while [[ $# -ge 2 ]]; do
    local filename="$1"
    local content="$2"
    shift 2
    mkdir -p "$(dirname "${filename}")"
    echo "${content}" > "${filename}"
    git add "${filename}"
  done
  GIT_COMMITTER_DATE="2025-01-01T00:00:0${COMMIT_SEQ}Z" \
    GIT_AUTHOR_DATE="2025-01-01T00:00:0${COMMIT_SEQ}Z" \
    git commit -m "${message}"
  COMMIT_SEQ=$(( COMMIT_SEQ + 1 ))
}

# ============================================================
# ORIGINAL TOPOLOGY (A-F, branches, merges) — preserved
# ============================================================

# === Trunk commits A, B, C ===

make_commit "src/entities/user.ts" \
  'export interface User { id: string; email: string; name: string; }' \
  "A: Initial domain model with User entity"

make_commit "src/entities/team.ts" \
  'export interface Team { id: string; name: string; ownerId: string; }' \
  "B: Add Team entity for multi-tenancy"

make_commit "src/routes/auth.ts" \
  'export function loginRoute() { /* login handler */ }
export function registerRoute() { /* register handler */ }' \
  "C: Add authentication routes"

SHA_C=$(git rev-parse HEAD)

# === Branch-x: X1, X2 (forks from C, merges back) ===

git checkout -b branch-x

make_commit "src/entities/payment.ts" \
  'export interface Payment { id: string; amount: number; currency: string; userId: string; }' \
  "X1: Add Payment entity"

make_commit "src/routes/payments.ts" \
  'export function createPaymentRoute() { /* create payment */ }
export function listPaymentsRoute() { /* list payments */ }' \
  "X2: Add payment routes"

# === Branch-y: Y1, Y2, Y3 (forks from C, merges back later) ===

git checkout "${SHA_C}"
git checkout -b branch-y

make_commit "src/entities/storage.ts" \
  'export interface StorageObject { id: string; key: string; bucket: string; size: number; }' \
  "Y1: Add StorageObject entity"

make_commit "src/routes/storage.ts" \
  'export function uploadRoute() { /* upload handler */ }
export function downloadRoute() { /* download handler */ }' \
  "Y2: Add storage routes"

make_commit "src/entities/storage.ts" \
  'export interface StorageObject { id: string; key: string; bucket: string; size: number; mimeType: string; }
export interface StoragePolicy { maxSizeMb: number; allowedTypes: string[]; }' \
  "Y3: Add StoragePolicy and mimeType to StorageObject"

# === Back to trunk: merge branch-x as M1 ===

git checkout main

git merge --no-ff branch-x -m "M1: Merge branch-x (payments feature)"

# === Trunk: D, E ===

make_commit "src/entities/notification.ts" \
  'export interface Notification { id: string; userId: string; type: string; message: string; read: boolean; }' \
  "D: Add Notification entity"

make_commit "src/routes/notifications.ts" \
  'export function listNotificationsRoute() { /* list notifications */ }
export function markReadRoute() { /* mark as read */ }' \
  "E: Add notification routes"

# === Dead-end branch: Z1, Z2 (forks from E, never merges) ===

git checkout -b dead-end

make_commit "src/entities/analytics.ts" \
  'export interface AnalyticsEvent { id: string; eventType: string; payload: Record<string, unknown>; }' \
  "Z1: Add AnalyticsEvent entity (experimental)"

make_commit "src/routes/analytics.ts" \
  'export function trackEventRoute() { /* track event */ }' \
  "Z2: Add analytics tracking route (experimental)"

# === Back to trunk: merge branch-y as M2, then F ===

git checkout main

git merge --no-ff branch-y -m "M2: Merge branch-y (storage feature)"

make_commit "src/entities/user.ts" \
  'export interface User { id: string; email: string; name: string; avatarUrl?: string; }
export interface UserPreferences { userId: string; theme: string; locale: string; }' \
  "F: Add UserPreferences and avatarUrl to User"

# ============================================================
# EXTENDED COMMITS (G-U) — real implementation code
# ============================================================

# --- G: Auth service with real login/register logic ---
make_commit "src/services/auth.ts" \
'import { User } from "../entities/user";

export interface AuthResult { success: boolean; token?: string; error?: string; }
export interface RegistrationInput { email: string; name: string; password: string; }

const PASSWORD_MIN_LENGTH = 8;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateRegistration(input: RegistrationInput): string[] {
  const errors: string[] = [];
  if (!EMAIL_REGEX.test(input.email)) errors.push("Invalid email format");
  if (input.password.length < PASSWORD_MIN_LENGTH) errors.push("Password must be at least 8 characters");
  if (!input.name.trim()) errors.push("Name is required");
  return errors;
}

export function hashPassword(password: string): string {
  return Buffer.from(password).toString("base64");
}

export function verifyPassword(password: string, hash: string): boolean {
  return hashPassword(password) === hash;
}

export async function registerUser(input: RegistrationInput): Promise<AuthResult> {
  const errors = validateRegistration(input);
  if (errors.length > 0) return { success: false, error: errors.join("; ") };
  const hashedPassword = hashPassword(input.password);
  return { success: true, token: "jwt-" + Date.now() };
}

export async function loginUser(email: string, password: string): Promise<AuthResult> {
  if (!email || !password) return { success: false, error: "Email and password required" };
  return { success: true, token: "jwt-" + Date.now() };
}' \
  "G: Add auth service with registration validation and password hashing"

# --- H: Payment entity with real validation and state machine ---
make_commit "src/entities/payment.ts" \
'export type PaymentStatus = "pending" | "processing" | "completed" | "failed" | "refunded";
export type Currency = "USD" | "EUR" | "GBP" | "CAD";

export interface Payment {
  id: string;
  amount: number;
  currency: Currency;
  userId: string;
  status: PaymentStatus;
  createdAt: Date;
  completedAt?: Date;
}

const SUPPORTED_CURRENCIES: Currency[] = ["USD", "EUR", "GBP", "CAD"];
const MIN_AMOUNT = 0.50;
const MAX_AMOUNT = 999999.99;

export function validatePayment(p: Partial<Payment>): string[] {
  const errors: string[] = [];
  if (!p.amount || p.amount < MIN_AMOUNT) errors.push("Amount must be at least " + MIN_AMOUNT);
  if (p.amount && p.amount > MAX_AMOUNT) errors.push("Amount exceeds maximum of " + MAX_AMOUNT);
  if (!p.currency || !SUPPORTED_CURRENCIES.includes(p.currency)) errors.push("Unsupported currency");
  if (!p.userId) errors.push("User ID is required");
  return errors;
}

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  const transitions: Record<PaymentStatus, PaymentStatus[]> = {
    pending: ["processing", "failed"],
    processing: ["completed", "failed"],
    completed: ["refunded"],
    failed: [],
    refunded: [],
  };
  return transitions[from]?.includes(to) ?? false;
}

export function refundPayment(payment: Payment): Payment {
  if (!canTransition(payment.status, "refunded")) {
    throw new Error("Cannot refund payment in status: " + payment.status);
  }
  return { ...payment, status: "refunded" };
}' \
  "H: Add payment validation, state machine, and refund logic"

# --- I: Auth and rate-limit middleware ---
make_multi_commit "I: Add auth and rate-limit middleware" \
  "src/middleware/auth.ts" \
'import { User } from "../entities/user";

export interface AuthenticatedRequest { user: User; token: string; }

export function requireAuth(req: any, res: any, next: any) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) { res.status(401).json({ error: "Authentication required" }); return; }
  try {
    const user = decodeToken(token);
    req.user = user;
    req.token = token;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

export function requireAdmin(req: any, res: any, next: any) {
  if (!req.user?.isAdmin) { res.status(403).json({ error: "Admin access required" }); return; }
  next();
}

function decodeToken(token: string): User {
  return { id: "user-1", email: "test@test.com", name: "Test", avatarUrl: undefined };
}' \
  "src/middleware/rate-limit.ts" \
'const requestCounts = new Map<string, { count: number; resetAt: number }>();

export interface RateLimitConfig { windowMs: number; maxRequests: number; }

export function rateLimit(config: RateLimitConfig) {
  return (req: any, res: any, next: any) => {
    const key = req.ip || req.headers["x-forwarded-for"] || "unknown";
    const now = Date.now();
    const entry = requestCounts.get(key);

    if (!entry || now > entry.resetAt) {
      requestCounts.set(key, { count: 1, resetAt: now + config.windowMs });
      next();
      return;
    }

    if (entry.count >= config.maxRequests) {
      res.status(429).json({
        error: "Too many requests",
        retryAfter: Math.ceil((entry.resetAt - now) / 1000),
      });
      return;
    }

    entry.count++;
    next();
  };
}'

# --- J: Shared types and utils package ---
make_multi_commit "J: Add shared types and utility package" \
  "packages/shared/types.ts" \
'export interface PaginatedResponse<T> { items: T[]; total: number; page: number; pageSize: number; hasMore: boolean; }
export interface ApiError { code: string; message: string; details?: Record<string, unknown>; }
export interface AuditEntry { action: string; userId: string; entityId: string; entityType: string; timestamp: Date; changes?: Record<string, { from: unknown; to: unknown }>; }
export type SortDirection = "asc" | "desc";
export interface SortOptions { field: string; direction: SortDirection; }
export interface FilterOptions { field: string; operator: "eq" | "ne" | "gt" | "lt" | "contains" | "in"; value: unknown; }' \
  "packages/shared/utils.ts" \
'export function paginate<T>(items: T[], page: number, pageSize: number): { items: T[]; total: number; page: number; pageSize: number; hasMore: boolean } {
  const start = (page - 1) * pageSize;
  const paged = items.slice(start, start + pageSize);
  return { items: paged, total: items.length, page, pageSize, hasMore: start + pageSize < items.length };
}

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function generateId(): string {
  return Math.random().toString(36).slice(2, 11);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function omit<T extends Record<string, unknown>, K extends keyof T>(obj: T, keys: K[]): Omit<T, K> {
  const result = { ...obj };
  for (const key of keys) delete result[key];
  return result;
}

export function groupBy<T>(items: T[], key: keyof T): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) {
    const k = String(item[key]);
    (groups[k] ??= []).push(item);
  }
  return groups;
}'

# --- K: Email package ---
make_multi_commit "K: Add email sender and templates package" \
  "packages/email/sender.ts" \
'import { AuditEntry } from "../shared/types";

export interface EmailConfig { host: string; port: number; from: string; apiKey: string; }
export interface EmailMessage { to: string; subject: string; html: string; text?: string; }

export async function sendEmail(config: EmailConfig, message: EmailMessage): Promise<boolean> {
  if (!message.to || !message.subject || !message.html) {
    throw new Error("Missing required email fields: to, subject, html");
  }
  console.log("[email] Sending to", message.to, "subject:", message.subject);
  return true;
}

export async function sendBatch(config: EmailConfig, messages: EmailMessage[]): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (const msg of messages) {
    try {
      await sendEmail(config, msg);
      sent++;
    } catch {
      failed++;
    }
  }
  return { sent, failed };
}' \
  "packages/email/templates.ts" \
'export function welcomeEmail(userName: string): { subject: string; html: string } {
  return {
    subject: "Welcome to the platform, " + userName,
    html: "<h1>Welcome " + userName + "</h1><p>Your account is ready.</p>",
  };
}

export function passwordResetEmail(resetLink: string): { subject: string; html: string } {
  return {
    subject: "Password Reset Request",
    html: "<p>Click <a href=\"" + resetLink + "\">here</a> to reset your password.</p><p>Link expires in 1 hour.</p>",
  };
}

export function invoiceEmail(invoiceId: string, amount: number, currency: string): { subject: string; html: string } {
  return {
    subject: "Invoice #" + invoiceId,
    html: "<p>Your invoice for " + currency + " " + amount.toFixed(2) + " is ready.</p>",
  };
}

export function notificationDigest(notifications: Array<{ type: string; message: string }>): { subject: string; html: string } {
  const items = notifications.map(n => "<li><strong>" + n.type + "</strong>: " + n.message + "</li>").join("");
  return {
    subject: "You have " + notifications.length + " new notifications",
    html: "<ul>" + items + "</ul>",
  };
}'

# --- L: Add filterable files (test, config, generated, lock) ---
make_multi_commit "L: Add test, config, and generated files" \
  "src/entities/user.test.ts" \
'import { describe, it, expect } from "vitest";
describe("User entity", () => {
  it("should have required fields", () => {
    const user = { id: "1", email: "test@test.com", name: "Test" };
    expect(user.id).toBeDefined();
    expect(user.email).toContain("@");
  });
});' \
  "src/config/database.config.ts" \
'export const databaseConfig = {
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "5432"),
  database: process.env.DB_NAME || "app_dev",
  ssl: process.env.DB_SSL === "true",
};' \
  "pnpm-lock.yaml" \
'lockfileVersion: "9.0"
settings:
  autoInstallPeers: true' \
  "src/generated/schema.generated.ts" \
'// AUTO-GENERATED - DO NOT EDIT
export const schemaVersion = "1.0.0";
export interface GeneratedUser { id: string; email: string; }
export interface GeneratedTeam { id: string; name: string; }'

# --- M: Notification service with real state transitions ---
make_commit "src/services/notification.ts" \
'import { Notification } from "../entities/notification";
import { sendEmail } from "../../packages/email/sender";

export type NotificationChannel = "in-app" | "email" | "push";
export interface NotificationPreferences { channels: NotificationChannel[]; digestEnabled: boolean; digestFrequency: "daily" | "weekly"; }

export function createNotification(userId: string, type: string, message: string): Notification {
  return { id: "notif-" + Date.now(), userId, type, message, read: false };
}

export function markAsRead(notification: Notification): Notification {
  if (notification.read) return notification;
  return { ...notification, read: true };
}

export function markAllAsRead(notifications: Notification[]): Notification[] {
  return notifications.map(n => n.read ? n : { ...n, read: true });
}

export function filterUnread(notifications: Notification[]): Notification[] {
  return notifications.filter(n => !n.read);
}

export function groupByType(notifications: Notification[]): Record<string, Notification[]> {
  const groups: Record<string, Notification[]> = {};
  for (const n of notifications) {
    (groups[n.type] ??= []).push(n);
  }
  return groups;
}' \
  "M: Add notification service with state transitions and grouping"

# --- N: Update payment routes with real validation, auth, imports ---
make_commit "src/routes/payments.ts" \
'import { validatePayment, refundPayment, canTransition, type Payment } from "../entities/payment";
import { requireAuth } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";

const paymentRateLimit = rateLimit({ windowMs: 60000, maxRequests: 10 });

export function createPaymentRoute(req: any, res: any) {
  const { userId, amount, currency } = req.body;
  if (!req.user || req.user.id !== userId) {
    res.status(403).json({ error: "Cannot create payment for another user" });
    return;
  }
  const errors = validatePayment({ amount, currency, userId });
  if (errors.length > 0) {
    res.status(400).json({ errors });
    return;
  }
  const payment: Payment = {
    id: "pay-" + Date.now(),
    amount,
    currency,
    userId,
    status: "pending",
    createdAt: new Date(),
  };
  res.status(201).json(payment);
}

export function refundPaymentRoute(req: any, res: any) {
  const payment = getPayment(req.params.id);
  if (!payment) { res.status(404).json({ error: "Payment not found" }); return; }
  if (req.user.id !== payment.userId && !req.user.isAdmin) {
    res.status(403).json({ error: "Not authorized to refund this payment" });
    return;
  }
  try {
    const refunded = refundPayment(payment);
    res.json(refunded);
  } catch (err: any) {
    res.status(422).json({ error: err.message });
  }
}

export function listPaymentsRoute(req: any, res: any) {
  const page = parseInt(req.query.page || "1");
  const pageSize = parseInt(req.query.pageSize || "20");
  res.json({ items: [], total: 0, page, pageSize, hasMore: false });
}

function getPayment(id: string): Payment | null { return null; }' \
  "N: Expand payment routes with validation, auth, and pagination"

# --- O: Update auth routes with real logic ---
make_commit "src/routes/auth.ts" \
'import { registerUser, loginUser, validateRegistration } from "../services/auth";
import { rateLimit } from "../middleware/rate-limit";
import { welcomeEmail } from "../../packages/email/templates";
import { sendEmail } from "../../packages/email/sender";

const authRateLimit = rateLimit({ windowMs: 300000, maxRequests: 5 });

export async function registerRoute(req: any, res: any) {
  const { email, name, password } = req.body;
  const validationErrors = validateRegistration({ email, name, password });
  if (validationErrors.length > 0) {
    res.status(400).json({ errors: validationErrors });
    return;
  }
  const result = await registerUser({ email, name, password });
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  const welcome = welcomeEmail(name);
  res.status(201).json({ token: result.token, message: "Account created" });
}

export async function loginRoute(req: any, res: any) {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }
  const result = await loginUser(email, password);
  if (!result.success) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  res.json({ token: result.token });
}

export function logoutRoute(req: any, res: any) {
  res.json({ message: "Logged out" });
}' \
  "O: Expand auth routes with real validation, rate limiting, and welcome emails"

# --- P: Team membership and ownership logic ---
make_commit "src/entities/team.ts" \
'export interface Team {
  id: string;
  name: string;
  ownerId: string;
  createdAt: Date;
}

export interface TeamMember {
  teamId: string;
  userId: string;
  role: "owner" | "admin" | "member";
  joinedAt: Date;
}

export function createTeam(name: string, ownerId: string): Team {
  if (!name.trim()) throw new Error("Team name is required");
  if (name.length > 100) throw new Error("Team name must be 100 characters or less");
  return { id: "team-" + Date.now(), name: name.trim(), ownerId, createdAt: new Date() };
}

export function addMember(teamId: string, userId: string, role: "admin" | "member" = "member"): TeamMember {
  return { teamId, userId, role, joinedAt: new Date() };
}

export function transferOwnership(team: Team, newOwnerId: string, members: TeamMember[]): { team: Team; members: TeamMember[] } {
  const currentOwnerMember = members.find(m => m.userId === team.ownerId && m.role === "owner");
  const newOwnerMember = members.find(m => m.userId === newOwnerId);
  if (!newOwnerMember) throw new Error("New owner must be an existing team member");
  const updatedMembers = members.map(m => {
    if (m.userId === team.ownerId) return { ...m, role: "admin" as const };
    if (m.userId === newOwnerId) return { ...m, role: "owner" as const };
    return m;
  });
  return { team: { ...team, ownerId: newOwnerId }, members: updatedMembers };
}

export function canPerformAction(member: TeamMember, action: "manage_members" | "edit_settings" | "delete_team"): boolean {
  const permissions: Record<string, ("owner" | "admin" | "member")[]> = {
    manage_members: ["owner", "admin"],
    edit_settings: ["owner", "admin"],
    delete_team: ["owner"],
  };
  return permissions[action]?.includes(member.role) ?? false;
}' \
  "P: Add team membership, ownership transfer, and permission model"

# --- Q: Storage service with policy enforcement ---
make_commit "src/services/storage.ts" \
'import { StorageObject, StoragePolicy } from "../entities/storage";

export interface UploadRequest { key: string; bucket: string; size: number; mimeType: string; }
export interface UploadResult { success: boolean; object?: StorageObject; error?: string; }

export function validateUpload(request: UploadRequest, policy: StoragePolicy): string[] {
  const errors: string[] = [];
  if (request.size > policy.maxSizeMb * 1024 * 1024) {
    errors.push("File exceeds maximum size of " + policy.maxSizeMb + "MB");
  }
  if (!policy.allowedTypes.includes(request.mimeType)) {
    errors.push("File type " + request.mimeType + " is not allowed. Allowed: " + policy.allowedTypes.join(", "));
  }
  if (!request.key.trim()) errors.push("File key is required");
  if (!request.bucket.trim()) errors.push("Bucket is required");
  return errors;
}

export function processUpload(request: UploadRequest, policy: StoragePolicy): UploadResult {
  const errors = validateUpload(request, policy);
  if (errors.length > 0) return { success: false, error: errors.join("; ") };
  const object: StorageObject = {
    id: "obj-" + Date.now(),
    key: request.key,
    bucket: request.bucket,
    size: request.size,
    mimeType: request.mimeType,
  };
  return { success: true, object };
}

export function calculateStorageUsage(objects: StorageObject[]): { totalBytes: number; totalMb: number; fileCount: number } {
  const totalBytes = objects.reduce((sum, o) => sum + o.size, 0);
  return { totalBytes, totalMb: totalBytes / (1024 * 1024), fileCount: objects.length };
}' \
  "Q: Add storage service with upload validation and policy enforcement"

# --- R: Update notification routes with filtering and digest ---
make_commit "src/routes/notifications.ts" \
'import { Notification } from "../entities/notification";
import { markAsRead, markAllAsRead, filterUnread, groupByType, createNotification } from "../services/notification";
import { requireAuth } from "../middleware/auth";
import { paginate } from "../../packages/shared/utils";

export function listNotificationsRoute(req: any, res: any) {
  const page = parseInt(req.query.page || "1");
  const pageSize = parseInt(req.query.pageSize || "20");
  const unreadOnly = req.query.unreadOnly === "true";
  const notifications: Notification[] = [];
  const filtered = unreadOnly ? filterUnread(notifications) : notifications;
  res.json(paginate(filtered, page, pageSize));
}

export function markReadRoute(req: any, res: any) {
  const { notificationId } = req.params;
  if (!notificationId) { res.status(400).json({ error: "Notification ID required" }); return; }
  res.json({ success: true });
}

export function markAllReadRoute(req: any, res: any) {
  res.json({ success: true, count: 0 });
}

export function getNotificationSummary(req: any, res: any) {
  const notifications: Notification[] = [];
  const unread = filterUnread(notifications);
  const grouped = groupByType(unread);
  const summary = Object.entries(grouped).map(([type, items]) => ({ type, count: items.length }));
  res.json({ totalUnread: unread.length, byType: summary });
}' \
  "R: Expand notification routes with filtering, pagination, and summary"

# --- S: Update storage routes with policy enforcement ---
make_commit "src/routes/storage.ts" \
'import { StoragePolicy } from "../entities/storage";
import { validateUpload, processUpload, calculateStorageUsage } from "../services/storage";
import { requireAuth } from "../middleware/auth";

const DEFAULT_POLICY: StoragePolicy = { maxSizeMb: 10, allowedTypes: ["image/png", "image/jpeg", "application/pdf"] };

export function uploadRoute(req: any, res: any) {
  const { key, bucket, size, mimeType } = req.body;
  const policy = req.teamPolicy || DEFAULT_POLICY;
  const result = processUpload({ key, bucket, size, mimeType }, policy);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.status(201).json(result.object);
}

export function downloadRoute(req: any, res: any) {
  const { objectId } = req.params;
  if (!objectId) { res.status(400).json({ error: "Object ID required" }); return; }
  res.json({ url: "https://storage.example.com/" + objectId });
}

export function getUsageRoute(req: any, res: any) {
  const objects = [];
  const usage = calculateStorageUsage(objects);
  res.json(usage);
}

export function deletObjectRoute(req: any, res: any) {
  const { objectId } = req.params;
  if (!objectId) { res.status(400).json({ error: "Object ID required" }); return; }
  res.json({ deleted: true });
}' \
  "S: Expand storage routes with policy enforcement and usage tracking"

# --- T: Notification entity with delivery channels ---
make_commit "src/entities/notification.ts" \
'export type NotificationChannel = "in-app" | "email" | "push";
export type NotificationPriority = "low" | "normal" | "high" | "urgent";

export interface Notification {
  id: string;
  userId: string;
  type: string;
  message: string;
  read: boolean;
  channel: NotificationChannel;
  priority: NotificationPriority;
  createdAt: Date;
  readAt?: Date;
}

export interface NotificationPreferences {
  userId: string;
  enabledChannels: NotificationChannel[];
  quietHoursStart?: string;
  quietHoursEnd?: string;
  digestEnabled: boolean;
  digestFrequency: "daily" | "weekly";
}

export function shouldDeliver(notification: Notification, prefs: NotificationPreferences): boolean {
  if (!prefs.enabledChannels.includes(notification.channel)) return false;
  if (notification.priority === "urgent") return true;
  if (prefs.quietHoursStart && prefs.quietHoursEnd) {
    const now = new Date();
    const hour = now.getHours().toString().padStart(2, "0") + ":" + now.getMinutes().toString().padStart(2, "0");
    if (hour >= prefs.quietHoursStart && hour <= prefs.quietHoursEnd) return false;
  }
  return true;
}

export function markNotificationRead(notification: Notification): Notification {
  if (notification.read) return notification;
  return { ...notification, read: true, readAt: new Date() };
}' \
  "T: Add notification channels, priority, preferences, and delivery rules"

# --- U: User entity with full registration and profile logic ---
make_commit "src/entities/user.ts" \
'export type UserRole = "user" | "admin" | "superadmin";
export type UserStatus = "active" | "suspended" | "deleted";

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
  role: UserRole;
  status: UserStatus;
  createdAt: Date;
  lastLoginAt?: Date;
}

export interface UserPreferences {
  userId: string;
  theme: "light" | "dark" | "system";
  locale: string;
  timezone: string;
  emailNotifications: boolean;
}

export function createUser(email: string, name: string, role: UserRole = "user"): User {
  return { id: "usr-" + Date.now(), email, name, role, status: "active", createdAt: new Date() };
}

export function suspendUser(user: User): User {
  if (user.status === "deleted") throw new Error("Cannot suspend a deleted user");
  if (user.role === "superadmin") throw new Error("Cannot suspend a superadmin");
  return { ...user, status: "suspended" };
}

export function deleteUser(user: User): User {
  if (user.role === "superadmin") throw new Error("Cannot delete a superadmin");
  return { ...user, status: "deleted" };
}

export function canPerformAdminAction(user: User): boolean {
  return user.role === "admin" || user.role === "superadmin";
}

export function updateProfile(user: User, updates: Partial<Pick<User, "name" | "avatarUrl">>): User {
  return { ...user, ...updates };
}

export function recordLogin(user: User): User {
  return { ...user, lastLoginAt: new Date() };
}' \
  "U: Expand User entity with roles, status, suspend/delete, and profile management"

echo ""
echo "Fixture repo created at: ${REPO_DIR}"
echo "Commit log:"
git log --all --oneline --graph
