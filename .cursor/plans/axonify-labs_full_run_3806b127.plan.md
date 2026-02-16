---
name: axonify-labs full run
overview: Run allium-evolve against the full 330-commit history of axonify-labs with reconciliation checkpoints every 25 trunk commits, then inspect the output quality.
todos:
  - id: run
    content: Execute the allium-evolve run against axonify-labs
    status: pending
  - id: inspect
    content: "Inspect output quality: spec, changelog, reconciliation findings"
    status: pending
isProject: false
---

# axonify-labs Full Evolution Run

## Target

- Repo: `~/workspace/axonify-labs`
- Branch: `cursor/stories-8-1-8-4-8-5-894d`
- 330 commits, 27 merges, 992 files, 12 packages (monorepo)

## Command

```bash
cd ~/workspace/allium-evolve
node --import tsx src/cli.ts \
  --repo ~/workspace/axonify-labs \
  --ref cursor/stories-8-1-8-4-8-5-894d \
  --no-parallel-branches \
  --reconciliation-strategy n-trunk-commits \
  --reconciliation-interval 25 \
  --state-file .allium-state-axonify.json \
  --allium-branch allium/axonify-evolution
```

Key flags:

- `--no-parallel-branches` for deterministic sequential replay
- `--reconciliation-interval 25` for aggressive checkpointing (~13 reconciliation points across 330 commits)
- Separate state file and branch name to keep the fixture results clean

## Expected cost and runtime

- ~330 evolution steps at ~$0.20/step = ~$66
- ~13 reconciliation checkpoints at ~$2-5 each = ~$26-65
- **Total estimate: $80-130**
- Runtime: ~45-90 minutes (sequential, each step ~10-20s)

## Monitoring

Background the process, poll the terminal output periodically. Watch for:

- Segment completion messages
- Reconciliation trigger log lines
- Any parse failures or retries

## Post-run inspection

1. Check `allium/axonify-evolution` branch log topology
2. Read the final spec at HEAD
3. Read the final changelog
4. Check the state file for reconciliation history and cost breakdown
5. Compare early spec (commit ~50) vs final spec to see evolution quality
6. Count reconciliation findings to assess value-add

