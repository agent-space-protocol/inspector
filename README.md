# Agent Space Protocol Inspector

The `agent-space` command for the [Agent Space Protocol](https://github.com/agent-space-protocol/agentspaceprotocol):
conformance tests that run against any space, a terminal client that enters any space, and the
test space and test participant both SDKs are tested with.

**Status: draft**, like the protocol. Not yet published to npm.

```text
agent-space check <address> [--profile <file>] [--launch <command>] [--json <file>]
agent-space tui <address> [--role <role>] [--key <file>] [--script <file>] [--plain]
agent-space participant <address>
agent-space test-space [--listen <address>] [--data <dir>] [--keep-seconds <n>] [--variant <name>] [--close-on-eof]
```

An address is a `ws://` or `http://` URL, or a command that starts a space on standard input and
output.

## check: the conformance tests

`agent-space check` runs the space end of the [conformance tests](https://github.com/agent-space-protocol/agentspaceprotocol/blob/main/docs/en/conformance.md)
and reports each as passed, failed or skipped, as text and, with `--json`, as a JSON report a space
can attach to its description. The tests never look at an image: they check outcomes, the record
and the declarations.

Most tests derive what to do from the space's declarations. A few need a concrete action, such as
one that takes a while; the space names them in a **profile**, given with `--profile` or sent in its
`hello` as `inspector.profile` ([the test space's profile](profiles/test-space.json)). A test whose
probe is missing is skipped, never passed.

`--launch` starts the space with a command that closes it gracefully when its standard input ends,
so that the closing and restart tests can run:

```sh
agent-space check ws://127.0.0.1:7777 \
  --launch "agent-space test-space --listen ws://127.0.0.1:7777 --data ./space-data --keep-seconds 3 --close-on-eof"
```

| Test | What |
| --- | --- |
| `handshake.errors` | Requests before `hello` are malformed; no common core is unsupported |
| `compat.parts`, `compat.unknown-fields` | Negotiation by part; unknown fields are ignored |
| `outcome.*` | Exactly one outcome: done, forbidden, malformed, deadline, cancel, cancel after done, consent timing out, closing, killed and restarted |
| `idempotency.repeat` | One ID three times: one effect, three identical answers |
| `stale.basis` | Old basis refused as stale, current done, future malformed |
| `atomic.constraint` | A broken constraint changes nothing |
| `record.once`, `record.resume`, `record.expired` | Exactly once, in order; resuming loses and repeats nothing; expired beyond retention |
| `projection.roles`, `projection.score` | Each role sees what it is declared to see; scores only for the evaluator |
| `unsupported.all` | Undeclared capabilities, parts not negotiated, unknown messages: a clear `unsupported` |
| `doors.handover` | A handover cut off midway leaves the thing on exactly one side |

## The test space and its broken variants

`agent-space test-space` runs a minimal space that declares every capability: a lamp, a counter, a
box of balls with a capacity, a safe whose code guests do not see, and a door. It is written with
the TypeScript SDK. `--variant` starts it deliberately broken, to show that each test catches what
it should and nothing else:

| Variant | Broken how | Caught by |
| --- | --- | --- |
| `drop-outcome` | An action that was asked to cancel never gets its outcome | `outcome.cancel` |
| `run-twice` | A repeated action ID is carried out again | `idempotency.repeat` |
| `half-commit` | A change that breaks a constraint keeps its first half | `atomic.constraint` |
| `drop-on-resume` | Resuming a subscription loses an entry | `record.resume` |
| `silent-unsupported` | A message of a part that was not negotiated is ignored | `unsupported.all` |

```sh
node test/acceptance.ts   # the test space passes everything; each variant fails only its own test
node test/pairings.ts     # TypeScript and Python test spaces × TypeScript and Python test participants
```

`test/pairings.ts` needs the [Python SDK](https://github.com/agent-space-protocol/python-sdk)
checked out next to this repository with its environment made (`uv sync`), or `--python <path>`.

## participant: the test participant

`agent-space participant <address>` runs a fixed scenario against a space with the TypeScript SDK's
participant: shake hands, join with a key, check the vocabulary's hash, observe, subscribe and act,
a refusal, a cancel, resend an ID, drop the connection and act meanwhile, resume, leave. The Python
SDK has the same scenario (`python -m agent_space.testing participant <address>`).

## tui: a terminal client

`agent-space tui <address>` shows any space as things (nested by their relations), a stream of
events and the actions you took with their intermediate states and final outcomes, and lets you
act, edit and cancel. It uses structure only, so every space can be used with it. Type `help`.

```text
act test.toggle lamp:1
act test.wait {"seconds": 4}
cancel
edit set lamp:1 on false
```

Outcomes and event families have one colour and one symbol each, the same in every client:
`✓` done, `⊘` refused, `✗` failed, `◼` cancelled, `?` unknown; `○` accepted, `◔` progress,
`⧗` waiting. The colours are temporary values on top of the archive design's tokens, to be reviewed
before they join the shared design ([src/tui/tokens.ts](src/tui/tokens.ts)).

`--script <file>` runs commands from a file and exits; with `--plain` it prints the screen after
each command, without colours.

## Development

Node 24 and pnpm. Until the SDK is published, this repository uses the
[TypeScript SDK](https://github.com/agent-space-protocol/typescript-sdk) checked out next to it:

```sh
git clone https://github.com/agent-space-protocol/typescript-sdk ../typescript-sdk
(cd ../typescript-sdk && pnpm install && pnpm --filter @agent-space-protocol/sdk build)
pnpm install
node src/cli.ts check ...
```

## Licence

Apache-2.0.
