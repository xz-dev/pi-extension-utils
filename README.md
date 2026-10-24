# pi-extension-utils

Shared utilities for Pi extensions. The package exposes independent entry points and has no native bindings. Only the `private-inquiry` entry uses a runtime dependency (see below); every other entry point stays dependency-free at runtime and never loads it.

## Semantic hooks

`pi-extension-utils/semantic-hook` validates and publishes neutral best-effort events on Pi's shared `pi:semantic-hook:v1` EventBus channel without importing Pi types or runtime code.

```ts
import {
  publishSemanticHook,
  subscribeSemanticHooks,
} from "pi-extension-utils/semantic-hook";

const unsubscribe = subscribeSemanticHooks(
  pi.events,
  (hook) => console.log(hook.name, hook.values),
  (reason) => console.warn(`ignored malformed semantic hook: ${reason}`),
);

publishSemanticHook(pi.events, {
  name: "build-finished",
  values: { RESULT: "SUCCESS" },
});
```

Envelopes use lowercase kebab-case names and optional uppercase-snake string values. Parser output is an immutable copy. Delivery is synchronous, current-listener-only, and has no acknowledgement, retry, replay, buffering, or consumer exception policy. Plugins retain ownership of hook meanings, configuration, and state machines.

## Process domain

`pi-extension-utils/process-domain` provides one root-owned local transport and inherited child nodes:

- framed messaging over loopback TCP (`node:net`) with directed sends, broadcast, receive acknowledgements, and peer events;
- application-level ping/pong heartbeat options for liveness, so a frozen peer is reported even though the kernel keeps its connection open;
- Pi lifecycle forwarding without imposing a watchdog state machine;
- one listener on an ephemeral loopback port (`tcp://127.0.0.1:*`); every peer is one exact connection, so a disconnect maps to one exact node;
- an inherited authenticated declaration in `PI_EXTENSION_UTILS_PROCESS_DOMAIN`.

The wire format is a 4-byte big-endian length prefix carrying a strictly validated JSON envelope (64 KiB bound, fail-closed). Authentication is a per-connection HMAC challenge-response: fresh nonces on every connection make consumed proofs useless for replay, and a reconnecting peer fences and replaces its stale incarnation. Disconnected clients retry connection every fixed 1 second, open a brand-new connection, and rerun the full handshake; pending sends fail instead of being replayed. Consumers receive the online peer event and must publish any newly queried business state themselves. A receipt acknowledgement resolves once the message reaches the target peer; routed messages acknowledge only after every downstream hop acknowledged.

```ts
import { attachPiLifecycle, openProcessDomain } from "pi-extension-utils/process-domain";

const node = await openProcessDomain({
  metadata: { extension: "pi-reflect-watchdog" },
});

attachPiLifecycle(node, pi, sessionId);
node.subscribe("work", (message) => console.log(message.senderId, message.value));
await node.broadcast("work", { kind: "turn-end" });
```

The root is the only node that binds endpoints. Children only connect to inherited endpoints. The transport does not own counters, retry policies, idle decisions, watchdog thresholds, or durable delivery.

Startup failures are exposed as `ProcessDomainOpenError` with a stable `code`: `INVALID_DECLARATION`, `AUTHENTICATION_FAILED`, or `CONNECTION_UNAVAILABLE`. Consumers should branch only through `isProcessDomainOpenError()` and `code`; the public error message is sanitized and is not a classification contract.

## XML

`pi-extension-utils/xml` builds and strictly parses one unique trailing XML document, extracts non-thinking assistant text, and neutralizes a finalized assistant message without importing Pi.

```ts
import { buildXmlDocument, parseTrailingXml } from "pi-extension-utils/xml";

const example = buildXmlDocument("reflection", [
  { name: "type", value: "NO_ISSUE" },
]);
const result = parseTrailingXml(`Checked.\n${example}`, "reflection");
```

## Pi inquiry

`pi-extension-utils/pi-inquiry` creates correlated hidden inquiry and fold messages, neutralizes inquiry assistants, and registers provider-context folding. Business validation and retry policy remain in the consuming extension.

`createInquiryRuntime(namespace).attempt(n)` returns one pure terminal handle with immutable correlation and `pending | sent | completed | cancelled` state. It matches only its exact prompt, blocks capture after terminal cancellation, makes completion first-terminal-wins, and makes cancellation idempotently return the same remove-fold for retry. Its `neutralize()` helper clears assistant content while preserving exact correlation. Context folding removes an aborted exchange without a fold marker only when the assistant was neutralized with that exact correlation. The utility does not import Pi types, call `ctx.abort()`, enqueue user input, or decide business outcomes.

## Pi agent state

`pi-extension-utils/pi-agent-state` provides one dependency-free live probe over Pi's public extension context. `probePiAgentState(ctx)` queries `ctx.isIdle()` and, when available, `ctx.hasPendingMessages()` exactly once per call and returns `{ idle, busy, pendingMessages }`.

Call it at each relevant public Pi event instead of inferring busy/idle from event names. The helper deliberately owns no cache, lifecycle state machine, timers, cross-process aggregation, or watchdog policy; those remain with the consuming extension.

```ts
import { probePiAgentState } from "pi-extension-utils/pi-agent-state";

pi.on("agent_start", (_event, ctx) => {
  const state = probePiAgentState(ctx);
  publishBusy(state.busy);
});
```

## Preempt takeover

`pi-extension-utils/preempt-takeover` provides a dependency-free capture-and-reissue state machine for user input that preempts a plugin-owned hidden run (a decision/reflection inquiry the plugin aborts on user takeover).

pi-coding-agent 0.85.1 made `ctx.abort()` asynchronous: a user input arriving while the hidden run is still streaming is enqueued as `steer` into that run and silently dropped when the abort settles. To avoid losing user input, the host returns `handled` from its input hook for the takeover, captures the text in `PreemptTakeover`, and re-issues it as a fresh user turn once the host is idle.

The module owns only the decisions and captured state; aborting the run, choosing the input-hook action, and calling `sendUserMessage` stay in the consuming plugin's adapter. It holds a single pending takeover and guards re-entry by exact text match.

```ts
import { PreemptTakeover } from "pi-extension-utils/preempt-takeover";

const takeover = new PreemptTakeover();

pi.on("input", (event, ctx) => {
  // Let a re-issued takeover through untouched.
  if (takeover.isReissuedTakeover(event.text)) return { action: "continue" };
  if (!ownsActiveHiddenRun()) return { action: "continue" };
  takeover.capture(event.text);
  ctx.abort();
  return { action: "handled" };
});

pi.on("agent_settled", async (_event, ctx) => {
  const text = takeover.takeForReissue();
  if (text !== null && ctx.isIdle()) await pi.sendUserMessage(text);
});
```

## Private inquiry

`pi-extension-utils/private-inquiry` runs one bounded private question in a fork of the current Pi session that the user and other extensions cannot reach. It is the private-decision core proven in pi-continue-watchdog, shared so consumers do not reinvent it. The consumer owns scheduling, prompts, payload validation, review and publication; this entry owns the mechanism:

- full fork of the parent session from a frozen anchor (`captureAnchor()` picks the latest replayable entry, skipping an open tool batch; no anchor is a typed `PrivateInquirySetupError`, never a fresh or pruned fallback), with the selected provider/model/thinking;
- one owned `/var/tmp` result file, reset to `{}` before every attempt, opened no-follow, and joined to the child's own response; the file is the only result transport, with no acknowledgement request after the write;
- same-child correction bounded by `invalidAttemptLimit` (default 3), with typed `decision`, `decision-failed`, `cancelled` and `execution-error` outcomes;
- `profile`: `result-write-only` (default), or `read-only-evidence`, which also admits helper-only batches of built-in `read`/`ls`/`grep`/`find` under one operation-wide allowance (default 10); mixed, duplicate, unknown or over-budget batches execute nothing;
- `retryPolicy`: `"disabled"` or `"native"` Pi provider retry for the child;
- aborting `signal` aborts the exact child immediately, including an in-flight provider stream or helper subprocess; `isCurrent()` is the checkpoint backstop, checked at every awaited boundary and before the result commits. A late result never commits, and the parent session and other runs are never aborted. Consumers abort `signal` as soon as they observe a revocation event.

Terminal decision/failure results carry additive `session` evidence (a late-cancelled result may return without it): `{ kind: "available", path }` is the exact child's native fork JSONL, verified as an absolute regular readable file after child settlement (the file lives under `<parent-session-name>/forks/<run-id>/`, outside the owned result directory that is always removed); `{ kind: "unavailable", reason }` reports `no-session`, `missing`, `not-regular-file`, `unreadable` or `not-absolute` — never an invented or unverified path. A `WatchdogForkSetupError` thrown by the runtime after the fork file exists still carries its real `sessionFile` locator. Retained sessions are local diagnostic evidence only: no upload, no replay, no restored authority.

```ts
import { captureAnchor, runPrivateInquiry } from "pi-extension-utils/private-inquiry";

// Load the runtime from the extension's own TypeScript source so Pi's loader transpiles it;
// the only call that loads Pi and the private runtime.
const { createWatchdogRuntime } = await import("private-inquiry-subagents-runtime/watchdog-runtime");
const runtime = createWatchdogRuntime();
const result = await runPrivateInquiry({
  runtime,
  fork: { parent: ctx.sessionManager, parentProviderRegistry: ctx.modelRegistry, cwd: ctx.cwd, model: "provider/id", retryPolicy: "native", anchorId: captureAnchor(ctx.sessionManager), profile: { kind: "read-only-evidence" } },
  signal,
  isCurrent: () => stillOwned,
  validate: (payload) => (isVerdict(payload) ? { valid: true, value: payload } : { valid: false, error: "explain the fix" }),
  prompt: () => "Review the work, then write the result file.",
  correction: (error) => `Invalid result: ${error}`,
});
```

Requirements and installation: Linux, macOS or Windows (the result file is opened with `O_NOFOLLOW` where available, and on every platform the opened descriptor must match the link-free `lstat` identity of the exact designated path; a link, junction or other replacement is an `execution-error`, never followed), Pi `>=1.3.0` (an optional peer dependency, needed only by this entry). The entry depends on `pi-subagents` pinned to commit `1008e5993e90fcf13b815c97c15a0c54f7f6f116` under the private package name `private-inquiry-subagents-runtime`. `postinstall`/`prepack` run `scripts/prepare-private-runtime.mjs`, which verifies the upstream source hashes, applies the reviewed patch in `patches/pi-subagents-0.79.0`, strips public Pi discovery metadata and refuses a symlinked or shared runtime copy. Git installs therefore need lifecycle scripts enabled. The runtime package ships TypeScript source, so a Pi extension must import `private-inquiry-subagents-runtime/watchdog-runtime` itself, from its own `.ts` entry graph, and declare that package as a root dependency at the same pin. Pi's loader transpiles only the extension's graph. `createPrivateRuntime()` imports it from this package's compiled `dist`, and Node refuses to strip types under `node_modules`, so it works only where the host transpiles dependencies (tsx, Bun, Deno), as in this package's tests. This is installation and module isolation inside one Pi process, not an OS sandbox.

## Runtime support

process-domain relies only on the portable `node:net`/`node:crypto` surface and runs the same TypeScript on Node.js, Bun, and Deno, including their standalone compiled forms. The same full liveness/reconnect acceptance file runs under all three hosts (`test:acceptance`, `test:acceptance:bun`, and `test:acceptance:deno`). The Deno harness uses `Deno.kill()` for Unix stop/continue signals because Deno 2.9.5's `node:child_process` shim incorrectly treats `killed` as a one-shot guard: after a successful `SIGSTOP`, `ChildProcess.kill("SIGCONT")` returns `false` without sending the signal. This is a Deno Node-compatibility bug, not a transport limitation. Compiled Bun and Deno host startup smoke tests are also verified.

## Development

```sh
npm ci
npm run check
```
