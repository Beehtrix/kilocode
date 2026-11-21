---
"@kilocode/cli": patch
---

Fix `edit` permission path patterns matching differently in folders without Git. Patterns are now relative to the project directory before and after `git init`.
