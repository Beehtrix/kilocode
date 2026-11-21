import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { InstanceState } from "../../src/effect/instance-state"
import { editPatternPath, editPatternRoot } from "../../src/kilocode/permission/edit-path"
import { Permission } from "../../src/permission"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(Agent.node))

// #15209: the plan agent must be able to write its default plan file under Global.Path.data.
for (const git of [false, true]) {
  it.instance(
    `plan agent may write its default plan file (git=${git})`,
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service.use((svc) => svc.get("plan"))
        const ctx = yield* InstanceState.context
        const file = path.join(Global.Path.data, "plans", "plan.md")
        const pattern = editPatternPath(ctx, file)
        expect(Permission.evaluate("edit", pattern, agent.permission).action).toBe("allow")
        expect(Permission.evaluate("edit", "src/output.log", agent.permission).action).toBe("deny")
      }),
    { git },
  )
}

test("git repo rooted at / keeps worktree-relative patterns", () => {
  const ctx = { directory: "/a/b", worktree: "/", project: { id: "abc123" } }
  expect(editPatternRoot(ctx)).toBe("/")
  expect(editPatternPath(ctx, "/a/b/x.md")).toBe("a/b/x.md")
})

test("non-git project rooted at / uses the directory even when vcs is faked", () => {
  const ctx = { directory: "/a/b", worktree: "/", project: { id: "global", vcs: "git" } }
  expect(editPatternRoot(ctx)).toBe("/a/b")
  expect(editPatternPath(ctx, "/a/b/.local/x.md")).toBe(".local/x.md")
})

test("patterns use forward slashes", () => {
  const ctx = { directory: "/a/b", worktree: "/a/b", project: { id: "abc123" } }
  expect(editPatternPath(ctx, path.join("/a/b", ".local", "x.md"))).not.toContain("\\")
})
