# dsh-plugin-bookmarks

A demo Cordis Host plugin loadable at runtime through the `/add-plugin` command, without restarting DSH.

It registers session bookmarks across the three seams a runtime-loaded module can reach:

| Seam | Registration | Surface |
| --- | --- | --- |
| `ctx.tools` | `bookmark_add`, `bookmark_list` | model-visible tools |
| `ctx.commands` | `/bookmarks` | human command plane |
| `ctx.systemPrompt` | `bookmarks:guidance`, `bookmarks:list` | system prompt |

## Loading it

`/add-plugin` resolves its argument against the receiving Session's `header.cwd` and rejects anything outside that workspace, so start DSH at the repository root:

```sh
pnpm dsh web            # the web app ships the interactive command adapter
```

Then, in the session:

```text
/add-plugin local-plugin-demo
```

The `headless` profile and the automation surfaces do not dispatch slash commands, so the plugin cannot be loaded there.

## Checking it without a session

[`verify.mts`](verify.mts) drives `apply()` against a stub context: it runs both tools, the command, and the prompt section, validates every declared schema through the repository's own `assertSupportedJsonSchema` / `validateJsonSchemaValue`, and exercises the argument rejections, the two eviction bounds, and disposal.

```sh
node --import tsx/esm local-plugin-demo/verify.mts
```

## Using it

The model calls the tools:

```text
bookmark_add({ file: "packages/core/tools/src/index.ts", line: 1037, note: "raw register(); only output.schema is validated" })
bookmark_list()
```

A human drives the same list from the command plane:

```text
/bookmarks              list every bookmark in this session
/bookmarks remove 2     remove one by the id shown in the list
/bookmarks clear        drop them all
```

Once a session holds at least one bookmark, `bookmarks:list` renders it into that session's system prompt, so the model carries the list without calling `bookmark_list` again.

## Design notes

**Import-free entry.** The Loader resolves `src/index.mjs` through Node's ESM resolver from a directory where the harness packages are not resolvable, so the module imports nothing and builds raw JSON Schema instead of using `defineTool`.

**Arguments are validated by hand.** A raw `ctx.tools.register()` enforces only `output.schema`; the `parameters` schema is advertised to the model but never checked. `execute` therefore narrows every field itself.

**Per-session state from a global section.** Prompt sections register globally, but each assembly carries the requesting agent on `AssembleContext.agent` — that is how `bookmarks:list` reaches the right session's list. An assembly with no agent contributes nothing.

**Bounded in both dimensions.** The plugin has no session-disposal hook, so the store keeps at most 32 sessions (least-recently-written evicted) and 50 bookmarks per session (oldest evicted).

## Known limitations

- **Not durable.** Bookmarks live in process memory only. They are gone when the plugin's fiber is disposed or DSH exits, and they are absent from the session log — so a resumed session starts empty and a second DSH process sees nothing.
- **Not model-visible as an event.** Because nothing is logged, the prompt injection is not reconstructable from the session log; a shipped package would append a session event instead.
- **No persistence path.** To keep the plugin across restarts, add it to a profile with `dsh plugin --profile <name> add <package>` rather than `/add-plugin`.
