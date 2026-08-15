/**
 * Human-facing `/add-plugin` command for process-local Host plugin loading.
 * @module @deepseek-ai/dsh-command-add-plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'command-add-plugin'
export const inject = ['commands', 'loader']

const USAGE = 'Usage: /add-plugin <directory>'
const SUPPORTED_EXTENSIONS = new Set(['.cjs', '.js', '.mjs'])

interface LocalPackageManifest {
  readonly name?: unknown
  readonly main?: unknown
  readonly dsh?: unknown
}

interface LocalPlugin {
  readonly directory: string
  readonly packageName: string
  readonly moduleUrl: string
}

interface MountedLocalPlugin extends LocalPlugin {
  readonly entryId: string
}

/** Render an operational failure for direct command output. */
function errorMessage(error: unknown): string {
  /* v8 ignore next -- every owned filesystem/parser/Loader path rejects with Error; retain an honest fallback for foreign plugins. */
  return error instanceof Error ? error.message : String(error)
}

/** Whether `candidate` is `root` itself or a descendant after realpath normalization. */
function containsPath(root: string, candidate: string): boolean {
  const offset = relative(root, candidate)
  return offset === ''
    || (offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))
}

/** Resolve one existing directory to its canonical filesystem path. */
async function canonicalDirectory(path: string, label: string): Promise<string> {
  let canonical: string
  try {
    canonical = await realpath(path)
  } catch (cause) {
    throw new Error(`${label} does not exist or cannot be resolved: ${path}`, { cause })
  }
  if (!(await stat(canonical)).isDirectory()) {
    throw new Error(`${label} is not a directory: ${canonical}`)
  }
  return canonical
}

/** Read and validate the package fields owned by the local-plugin command. */
async function readManifest(directory: string): Promise<LocalPackageManifest> {
  const path = join(directory, 'package.json')
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch (cause) {
    throw new Error(`plugin directory has no readable package.json: ${path}`, { cause })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (cause) {
    throw new Error(`plugin package.json is not valid JSON: ${path}`, { cause })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`plugin package.json must contain a JSON object: ${path}`)
  }
  return parsed
}

/** Reject package formats whose runtime meaning is not one Host module entry. */
function rejectUnsupportedPackageKind(manifest: LocalPackageManifest): void {
  if (typeof manifest.dsh !== 'object' || manifest.dsh === null) return
  if ('bundle' in manifest.dsh) {
    throw new Error('dsh.bundle directories are not supported by /add-plugin; load one Host Cordis plugin package')
  }
  if ('client' in manifest.dsh) {
    throw new Error('dsh.client packages are not supported by /add-plugin; only Host Cordis plugins can load at runtime')
  }
}

/** Resolve the package's built Host entry and keep it inside the selected directory. */
async function resolvePackageEntry(directory: string, manifest: LocalPackageManifest): Promise<string> {
  if (typeof manifest.main !== 'string' || manifest.main.trim().length === 0) {
    throw new Error('plugin package.json must declare a non-empty string "main" entry')
  }
  let entry: string
  try {
    entry = await realpath(resolve(directory, manifest.main))
  } catch (cause) {
    throw new Error(`plugin main entry does not exist or cannot be resolved: ${manifest.main}`, { cause })
  }
  if (!containsPath(directory, entry)) {
    throw new Error(`plugin main entry escapes its package directory: ${entry}`)
  }
  if (!(await stat(entry)).isFile()) {
    throw new Error(`plugin main entry is not a file: ${entry}`)
  }
  const extension = extname(entry).toLowerCase()
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new Error(`plugin main entry must be built JavaScript (.js, .mjs, or .cjs): ${entry}`)
  }
  return entry
}

/** Resolve one command path against the receiving Session workspace. */
async function resolveLocalPlugin(invocation: CommandInvocation, input: string): Promise<LocalPlugin> {
  const cwd = invocation.agent.session.header.cwd
  if (cwd === undefined) {
    throw new Error('the current Session has no workspace; /add-plugin needs a workspace-relative directory')
  }
  const workspace = await canonicalDirectory(cwd, 'Session workspace')
  const directory = await canonicalDirectory(resolve(workspace, input), 'Plugin path')
  if (!containsPath(workspace, directory)) {
    throw new Error(`plugin directory must stay inside the current Session workspace: ${workspace}`)
  }
  const manifest = await readManifest(directory)
  rejectUnsupportedPackageKind(manifest)
  const entry = await resolvePackageEntry(directory, manifest)
  const packageName = typeof manifest.name === 'string' && manifest.name.trim().length > 0
    ? manifest.name
    : basename(directory)
  return { directory, packageName, moduleUrl: pathToFileURL(entry).href }
}

/** Remove a root Loader entry when it still exists. */
async function removeEntry(ctx: Context, entryId: string): Promise<void> {
  const loader = ctx.get('loader')
  /* v8 ignore next -- the injected Loader outlives this plugin's disposer; root teardown may still make the read absent. */
  if (loader === undefined) return
  if (loader.store[entryId] === undefined) return
  await loader.remove(entryId)
}

/** Mount or identify one canonical local package. */
async function mountLocalPlugin(
  ctx: Context,
  invocation: CommandInvocation,
  input: string,
  loaded: Map<string, MountedLocalPlugin>,
  active: () => boolean,
): Promise<CommandResult> {
  invocation.signal.throwIfAborted()
  const plugin = await resolveLocalPlugin(invocation, input)
  invocation.signal.throwIfAborted()
  if (!active()) throw new Error('the local plugin loader is shutting down')

  const loader = ctx.get('loader')
  /* v8 ignore next -- plugin-level `loader` injection keeps this service present throughout an admitted operation. */
  if (loader === undefined) throw new Error('the Cordis Loader is not available')
  const existing = loaded.get(plugin.directory)
  if (existing !== undefined && loader.store[existing.entryId] !== undefined) {
    return {
      kind: 'success',
      text: `Local plugin ${JSON.stringify(existing.packageName)} is already loaded.\nDirectory: ${existing.directory}\nLoader entry: ${existing.entryId}`,
    }
  }
  if (existing !== undefined) loaded.delete(plugin.directory)

  const entryId = await loader.create({ name: plugin.moduleUrl })
  if (invocation.signal.aborted || !active()) {
    await removeEntry(ctx, entryId)
    invocation.signal.throwIfAborted()
    throw new Error('the local plugin loader shut down while the plugin was loading')
  }
  loaded.set(plugin.directory, { ...plugin, entryId })
  return {
    kind: 'success',
    text: `Loaded local plugin ${JSON.stringify(plugin.packageName)}.\nDirectory: ${plugin.directory}\nLoader entry: ${entryId}`,
  }
}

/** Register `/add-plugin` and own every process-local Loader entry it creates. */
export function apply(ctx: Context): void {
  const loaded = new Map<string, MountedLocalPlugin>()
  const operations = new Set<Promise<CommandResult>>()
  let operationTail: Promise<void> = Promise.resolve()
  let active = true

  ctx.effect(() => async () => {
    active = false
    await Promise.allSettled([...operations])
    for (const plugin of [...loaded.values()].reverse()) {
      await removeEntry(ctx, plugin.entryId)
    }
    loaded.clear()
  }, 'command-add-plugin: local Loader entries')

  ctx.commands.register({
    name: 'add-plugin',
    description: 'load a trusted local Cordis Host plugin from this workspace',
    input: { hint: '<directory>' },
    handler: (invocation) => {
      /* v8 ignore next -- command registration is removed before this owning fiber's cleanup can make `active` false. */
      if (!active) return { kind: 'error', text: 'The local plugin loader is shutting down.' }
      const input = invocation.rawInput.trim()
      if (input.length === 0) return { kind: 'error', text: USAGE }
      const operation: Promise<CommandResult> = operationTail.then(async (): Promise<CommandResult> => {
        try {
          return await mountLocalPlugin(ctx, invocation, input, loaded, () => active)
        } catch (error) {
          if (invocation.signal.aborted) invocation.signal.throwIfAborted()
          return { kind: 'error', text: `Could not load local plugin: ${errorMessage(error)}` }
        }
      })
      operationTail = operation.then(() => {}, () => {})
      operations.add(operation)
      const settled = (): void => { operations.delete(operation) }
      void operation.then(settled, settled)
      return operation
    },
  })
}
