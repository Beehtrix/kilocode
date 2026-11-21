import path from "path"

type Root = { directory: string; worktree: string; project: { id: string } }

/**
 * Directory that `edit` permission patterns are relative to. Non-git projects use "/" as
 * the worktree, which would turn `.local/a.md` into `<abs path without leading slash>`
 * and never match relative rules. Fall back to the project directory in that case so the
 * pattern is the same before and after `git init`. Only the "global" project id gets this
 * fallback: `project.vcs` can be set by KILO_FAKE_VCS without a repository, while a git repo
 * rooted at "/" has a real project id and keeps the worktree.
 */
export function editPatternRoot(ctx: Root) {
  return ctx.worktree === "/" && ctx.project.id === "global" ? ctx.directory : ctx.worktree
}

/** Pattern for `edit` permission checks. Always uses "/" so patterns match on every OS. */
export function editPatternPath(ctx: Root, filepath: string) {
  return path.relative(editPatternRoot(ctx), filepath).replaceAll("\\", "/")
}
