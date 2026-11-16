import path from "path"

/**
 * Path used to match `edit` permission patterns. Non-git projects use "/" as the
 * worktree, which would turn `.local/a.md` into `<abs path without leading slash>`
 * and never match relative rules. Fall back to the project directory in that case
 * so the pattern is the same before and after `git init`.
 */
export function editPatternPath(ctx: { directory: string; worktree: string }, filepath: string) {
  const root = ctx.worktree === "/" ? ctx.directory : ctx.worktree
  return path.relative(root, filepath)
}
