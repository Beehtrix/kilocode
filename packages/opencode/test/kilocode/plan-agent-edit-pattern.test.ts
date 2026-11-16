import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { InstanceState } from "../../src/effect/instance-state"
import { editPatternPath, editPatternRoot } from "../../src/kilocode/permission/edit-path"
import { Permission } from "../../src/permission"
import {
  disposeAllInstances,
  provideInstance,
  provideTestInstance,
  testInstanceStoreLayer,
  tmpdir,
} from "../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
})

function plan(dir: string) {
  return Effect.runPromise(
    provideInstance(dir)(
      Effect.gen(function* () {
        const agent = yield* Agent.Service.use((svc) => svc.get("plan"))
        const ctx = yield* InstanceState.context
        return { agent, ctx }
      }),
    ).pipe(Effect.provide(AppNodeBuilder.build(Agent.node)), Effect.provide(testInstanceStoreLayer)),
  )
}

// #15209: the plan agent must be able to write its default plan file under Global.Path.data.
test.each([{ git: false }, { git: true }])("plan agent may write its default plan file (git=$git)", async ({ git }) => {
  await using tmp = await tmpdir({ git })
  const { agent, ctx } = await provideTestInstance({ directory: tmp.path, fn: () => plan(tmp.path) })
  expect(agent).toBeDefined()
  const file = path.join(Global.Path.data, "plans", "plan.md")
  const pattern = editPatternPath(ctx, file)
  expect(Permission.evaluate("edit", pattern, agent!.permission).action).toBe("allow")
  expect(Permission.evaluate("edit", "src/output.log", agent!.permission).action).toBe("deny")
})

test("git repo rooted at / keeps worktree-relative patterns", () => {
  const ctx = { directory: "/a/b", worktree: "/", project: { vcs: "git" } }
  expect(editPatternRoot(ctx)).toBe("/")
  expect(editPatternPath(ctx, "/a/b/x.md")).toBe("a/b/x.md")
})

test("non-git project rooted at / uses the directory", () => {
  const ctx = { directory: "/a/b", worktree: "/", project: {} }
  expect(editPatternRoot(ctx)).toBe("/a/b")
  expect(editPatternPath(ctx, "/a/b/.local/x.md")).toBe(".local/x.md")
})

test("patterns use forward slashes", () => {
  const ctx = { directory: "/a/b", worktree: "/a/b", project: { vcs: "git" } }
  expect(editPatternPath(ctx, path.join("/a/b", ".local", "x.md"))).not.toContain("\\")
})
