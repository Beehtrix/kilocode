---
"@kilocode/cli": patch
---

Reduce the pause between agent steps by computing a step's file patch from the snapshot trees already recorded, which removes one full worktree scan per step.
