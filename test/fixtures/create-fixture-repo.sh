#!/usr/bin/env bash
set -euo pipefail

# Creates a test git repo with known topology:
#
# trunk:  A ── B ── C ──────── M1 ── D ── E ──── M2 ── F
#                   │          /                   /
# branch-x:        ├── X1 ── X2          dead:  Z1 ── Z2
#                   │                    /
# branch-y:        └── Y1 ── Y2 ── Y3 ─
#
# Idempotent: removes and recreates the repo directory each run.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${SCRIPT_DIR}/repo"

rm -rf "${REPO_DIR}"
mkdir -p "${REPO_DIR}"
cd "${REPO_DIR}"

git init
git config user.email "test@allium-evolve.dev"
git config user.name "Test Author"

# Helper to create a file and commit
make_commit() {
  local filename="$1"
  local content="$2"
  local message="$3"

  mkdir -p "$(dirname "${filename}")"
  echo "${content}" > "${filename}"
  git add "${filename}"
  GIT_COMMITTER_DATE="2025-01-01T00:00:0${COMMIT_SEQ:-0}Z" \
    GIT_AUTHOR_DATE="2025-01-01T00:00:0${COMMIT_SEQ:-0}Z" \
    git commit -m "${message}"
  COMMIT_SEQ=$(( ${COMMIT_SEQ:-0} + 1 ))
}

COMMIT_SEQ=1

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

# Save C's SHA for branching
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

git checkout main 2>/dev/null || git checkout master

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

git checkout main 2>/dev/null || git checkout master

git merge --no-ff branch-y -m "M2: Merge branch-y (storage feature)"

make_commit "src/entities/user.ts" \
  'export interface User { id: string; email: string; name: string; avatarUrl?: string; }
export interface UserPreferences { userId: string; theme: string; locale: string; }' \
  "F: Add UserPreferences and avatarUrl to User"

echo ""
echo "Fixture repo created at: ${REPO_DIR}"
echo "Commit log:"
git log --all --oneline --graph
