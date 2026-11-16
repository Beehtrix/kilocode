/**
 * Counts snapshot git work per agent step (issue #16147).
 *
 * A `git` shim first on PATH records every invocation that targets the snapshot
 * gitdir. Each full worktree scan (`add()`) runs exactly one `ls-files --others`.
 */
import { afterEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LSP } from "@/lsp/lsp"
import { Session } from "@/session/session"
import { MCP } from "../../../src/mcp"
import { MessageV2 } from "../../../src/session/message-v2"
import { SessionPrompt } from "../../../src/session/prompt"
import { SessionSummary } from "../../../src/session/summary"
import { disposeAllInstances, provideTmpdirServer } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import { TestLLMServer } from "../../lib/llm-server"

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    remove: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    cancelAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const root = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  SessionSummary.node,
  Database.node,
  CrossSpawnSpawner.node,
  LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
])
const it = testEffect(
  LayerNode.compile(root, [
    [MCP.node, mcp],
    [LSP.node, lsp],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  ]),
)

const providerCfg = (url: string) => ({
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: url },
    },
  },
})

afterEach(async () => {
  await disposeAllInstances()
})

// Installs a git shim that logs the arguments of every call, then restores PATH.
const shim = Effect.acquireRelease(
  Effect.promise(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "git-shim-"))
    const log = path.join(dir, "calls.log")
    const real = Bun.which("git")
    if (!real) throw new Error("git not found")
    const script = path.join(dir, "git")
    await fs.writeFile(script, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 })
    const prev = process.env.PATH
    process.env.PATH = `${dir}${path.delimiter}${prev}`
    return { dir, log, prev }
  }),
  (item) =>
    Effect.promise(async () => {
      process.env.PATH = item.prev
      await fs.rm(item.dir, { recursive: true, force: true })
    }),
)

const calls = (log: string) =>
  Effect.promise(async () => {
    const text = await fs.readFile(log, "utf8").catch(() => "")
    return text.split("\n").filter((line) => line.includes("--git-dir") && line.includes("/snapshot/"))
  })

const scans = (lines: string[]) => lines.filter((line) => line.includes("ls-files") && line.includes("--others")).length

const mark = (lines: string[], name: string) => lines.filter((line) => line.split(" ").includes(name)).length

// Skipped on Windows: the shim is a POSIX shell script.
const live = process.platform === "win32" ? it.live.skip : it.live

live("a single model step runs one scan for its end state, not two (#16147)", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ dir, llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const spy = yield* shim

      const session = yield* sessions.create({
        title: "snapshot per step",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("say hi"), "hi")
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "say hi" }],
      })

      // Settle repository initialization so only the step itself is counted.
      yield* Effect.promise(() => fs.writeFile(path.join(dir, "seed.txt"), "seed"))
      yield* prompt.loop({ sessionID: session.id })
      yield* Effect.promise(() => fs.rm(spy.log, { force: true }))

      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("second"), "ok")
      yield* Effect.promise(() => fs.writeFile(path.join(dir, "before.txt"), "before"))
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "second" }],
      })
      const result = yield* prompt.loop({ sessionID: session.id })
      expect(result.info.role).toBe("assistant")

      const lines = yield* calls(spy.log)
      const steps = (yield* MessageV2.filterCompactedEffect(session.id))
        .flatMap((msg) => msg.parts)
        .filter((part): part is SessionV1.StepFinishPart => part.type === "step-finish")
      console.log(`git calls=${lines.length} scans=${scans(lines)} write-tree=${mark(lines, "write-tree")}`)
      // One scan before the stream starts and one for the end state of the step.
      expect(steps.length).toBeGreaterThan(0)
      expect(scans(lines)).toBe(2)
    }),
    { git: true, config: providerCfg },
  ),
)

live("the patch of a tool step still lists the changed file with one scan per step edge (#16147)", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ dir, llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const spy = yield* shim

      const session = yield* sessions.create({
        title: "snapshot patch",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const file = path.join(dir, "made.txt")
      yield* llm.toolMatch((hit) => JSON.stringify(hit.body).includes("make it"), "bash", {
        command: `echo made > ${file}`,
      })
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("bash"), "done")
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "make it" }],
      })
      yield* prompt.loop({ sessionID: session.id })

      const parts = (yield* MessageV2.filterCompactedEffect(session.id)).flatMap((msg) => msg.parts)
      const finishes = parts.filter((part): part is SessionV1.StepFinishPart => part.type === "step-finish")
      const patches = parts.filter((part): part is SessionV1.PatchPart => part.type === "patch")
      expect(patches.flatMap((part) => [...part.files])).toEqual([file.replaceAll("\\", "/")])
      expect(finishes.length).toBe(2)

      const lines = yield* calls(spy.log)
      console.log(`git calls=${lines.length} scans=${scans(lines)} steps=${finishes.length}`)
      // Per step: one scan before the stream and one for the end state.
      expect(scans(lines)).toBe(finishes.length * 2)
    }),
    { git: true, config: providerCfg },
  ),
)
