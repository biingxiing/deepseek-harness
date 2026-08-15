# Agent Note: Runtime local plugin command

Status: implemented

English | [中文](2026-08-14-runtime-local-plugin-command.zh.md)

## Problem

Profile plugin management installs durable packages and composes their bundle layers at process startup. That path cannot satisfy an operator who has already started an interactive DSH process and wants to try one local Host plugin without stopping the process, mutating the profile, or running a package manager. Editing the live user patch can mount a module that is already addressable, but it exposes Loader configuration details, persists an experiment, and does not give the command plane a bounded trust or lifecycle decision.

## Decision

The shipped base composition registers `/add-plugin <directory>` through `@deepseek-ai/dsh-command-add-plugin`. The complete suffix is one path relative to the receiving Session workspace. Canonical workspace containment rejects lexical and link-based escapes. The directory is one prebuilt Node package whose `package.json.main` resolves to an in-directory `.js`, `.mjs`, or `.cjs` file; bundle and Client package formats fail explicitly.

The command creates an in-memory Loader root entry by file URL. Canonical directory identity makes repeated requests idempotent for the process. Loads run serially, failed activation rolls back through Loader, cancellation retracts a late entry, and the command plugin's effect waits for admitted work before removing every entry it owns. No profile, patch, package manifest, or dependency tree changes. The loaded Host plugin is global process state and disappears when the producer unloads or DSH exits.

## Trust and presentation

Only the human command plane invokes this operation; it is not a model tool. Workspace containment limits which package the command selects but does not constrain the selected code after import. The module receives an ordinary Host Cordis context and therefore has the authority of trusted in-process plugin code. The command catalog names that trust requirement, and the package README states that effects can reach every Session.

The generic command lifecycle records the supplied path and direct result through `command/run` and `command/done`. Neither becomes a model message. Any prompt, tool, event, or cache effect introduced after activation belongs to the loaded plugin.

## Alternatives considered

**Run `dsh plugin ... add` from the command.** Rejected because package-manager execution mutates the profile and dependency tree, may require network or build approval, and still cannot transactionally add a newly declared bundle layer to the boot composition.

**Rewrite the live `cordis.patch.yml`.** Rejected because it turns an experiment into persistent configuration, races user edits, requires inventing an entry id and YAML write semantics, and would leave cleanup ownership outside the command invocation.

**Reuse the dynamic Cordis package runner.** Rejected because that runner owns model-authored in-memory source, Session-scoped version definitions, optional Client approval, and a guarded context. A trusted filesystem package with Node dependency resolution has different identity, authority, and lifecycle requirements.

**Allow any host directory or direct source file.** Rejected for the initial command. Session-workspace containment makes the user's current project the selection boundary, while a built package entry gives Node module format and dependency behavior one explicit source. Wider roots, TypeScript execution, bundle recomposition, and Client publication require separate designs.

## Consequences

An operator can activate a local Host plugin in a running Web process and observe its ordinary Cordis effects immediately. The operation is reversible with producer teardown and leaves durable profile state untouched. Focused coverage exercises path and package validation, duplicate identity, activation rollback, cancellation, serial shutdown, and Loader-composed HMR removal; the shipped Web composition verifies command discovery.

The command is intentionally not a package installer, bundle loader, Client hot-deployer, source compiler, or durable plugin manager. A loaded module has full Host plugin authority despite originating inside the workspace, and all Sessions share its global effects. Persisting a successful experiment still uses profile plugin management followed by restart.
