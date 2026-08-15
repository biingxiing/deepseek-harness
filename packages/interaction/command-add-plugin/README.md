# @deepseek-ai/dsh-command-add-plugin

English | [中文](README.zh.md)

Human-facing `/add-plugin` command for loading one trusted local Cordis Host plugin into the running process. The command registers through [`ctx.commands`](../commands/README.md) and creates an in-memory root entry through the Cordis Loader, so a compatible interactive adapter can activate a plugin without restarting DSH.

## Command contract

```text
/add-plugin <directory>
```

The complete suffix after the command is one directory path, so paths may contain spaces without quoting. A relative path resolves from the receiving Session's `header.cwd`; an absolute path is accepted only when its canonical target remains inside that workspace. Both the workspace and plugin directory pass through `fs.realpath`, so `..`, symlinks, and Windows junctions cannot select a package outside the Session workspace. A Session without `cwd` cannot run the command.

The selected directory must contain a JSON-object `package.json` with a non-empty string `main`. The canonical entry must stay inside the selected directory, be a regular file, and end in `.js`, `.mjs`, or `.cjs`. The package and all of its dependencies must already be built and locally resolvable; the command performs no install or build. Packages declaring `dsh.bundle` or `dsh.client` are rejected because those formats require configuration recomposition or browser bundle delivery rather than one Host module mount.

Successful loading returns the package name, canonical directory, and generated Loader entry id. Repeating the command for the same canonical directory returns the existing entry instead of mounting a duplicate. Operational failures return direct command errors and a failed import or activation leaves no Loader entry.

## Lifecycle and trust

Loads are serialized because Loader root-tree mutation is transactional and not reentrant. An aborted command removes an entry that completed after cancellation. Unloading this command plugin first stops admitting work, waits for admitted loads to settle, then removes its entries in reverse order; DSH restart has the same process-local consequence. It does not write `package.json`, `cordis.patch.yml`, the profile manifest, or Session domain events beyond the generic `command/run` and `command/done` records.

The workspace check is path selection policy, not a code sandbox. The selected module executes as trusted Host code with the ordinary Cordis context and may register global services, tools, commands, event listeners, or other effects visible to every Session in the process. Typing `/add-plugin` is the explicit execution decision; only load code whose contents and dependencies are trusted.

## Composition

The plugin injects `commands` and `loader`:

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: command-add-plugin
  name: '@deepseek-ai/dsh-command-add-plugin'
```

The shipped base bundle mounts the producer. The Web app supplies the shipped interactive command adapter; headless and automation surfaces do not dispatch slash commands.

## Model Experience

### Human `/add-plugin` loading

#### What the model sees

Nothing directly. The `/add-plugin` line and direct result stay in the human command plane and are not submitted as a user message. A loaded plugin may independently add model-visible tools, prompt sections, or later Session events according to that plugin's own behavior.

#### Token effect

The command itself adds no model tokens. Any later token effect belongs to contributions registered by the loaded plugin.

#### KV Cache effect

Command discovery and direct output do not affect request caching. A loaded plugin that changes prompt sections or tool schemas changes later request prefixes under the ordinary registration rules.

## Known Limitations and Deferred Work

- **Host module only** — runtime bundle-layer recomposition and Client bundle publication are not implemented; `dsh.bundle` and `dsh.client` directories fail explicitly.
- **No persistence or removal command** — loaded entries disappear when this producer unloads or DSH exits. Persist a trusted package through `dsh plugin --profile <name> add <package>` and profile configuration; restart the profile to activate that durable composition.
- **Built entry required** — TypeScript source, package-manager installation, dependency resolution repair, compilation, and source HMR are outside this command.
