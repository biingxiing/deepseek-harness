import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { Session, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import * as CommandAddPlugin from '../src/index.ts'

const contexts: Context[] = []
const roots: string[] = []
let sessionSequence = 0

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), label))
  roots.push(root)
  return root
}

async function writePlugin(
  directory: string,
  manifest: Record<string, unknown>,
  source = 'export function apply(ctx) { ctx.provide("localProbe", { state: "ready" }) }\n',
): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify(manifest, undefined, 2) + '\n')
  if (typeof manifest.main === 'string' && manifest.main.endsWith('/')) {
    await mkdir(join(directory, manifest.main), { recursive: true })
  } else if (typeof manifest.main === 'string' && manifest.main.length > 0) {
    await writeFile(join(directory, manifest.main), source)
  }
}

async function harness(): Promise<{ ctx: Context; commandFiber: ReturnType<Context['plugin']> }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string): Promise<unknown> {
      return await import(/* @vite-ignore */ specifier) as unknown
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.plugin(CommandRuntime)
  const commandFiber = ctx.plugin(CommandAddPlugin)
  await commandFiber.await()
  return { ctx, commandFiber }
}

function agent(cwd?: string): Agent {
  const id = SessionId(`command-add-plugin-${String(sessionSequence += 1)}`)
  const session = Session.create(id, undefined, {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 0,
    ...(cwd === undefined ? {} : { cwd }),
  })
  return { id, session } as unknown as Agent
}

async function execute(
  ctx: Context,
  owner: Agent,
  line: string,
  signal = new AbortController().signal,
) {
  const execution = await ctx.commands.execute(owner, line, signal)
  if (execution === undefined) throw new Error(`command did not resolve: ${line}`)
  return execution.result
}

function localEntryIds(ctx: Context): string[] {
  return Object.values(ctx.loader.store)
    .filter(entry => entry.options.name.startsWith('file:'))
    .map(entry => entry.id)
}

async function expectLoadError(ctx: Context, owner: Agent, path: string, fragment: string): Promise<void> {
  await expect(execute(ctx, owner, `/add-plugin ${path}`)).resolves.toEqual({
    kind: 'error',
    text: expect.stringContaining(fragment) as unknown as string,
  })
}

describe('/add-plugin', () => {
  it('loads one canonical package once and removes every owned entry on plugin disposal', async () => {
    const workspace = await temporaryRoot('dsh-add-plugin-success-')
    const directory = join(workspace, 'plugin with spaces')
    await writePlugin(directory, { main: 'plugin.mjs', dsh: {} })
    const { ctx, commandFiber } = await harness()
    const owner = agent(workspace)

    expect(ctx.commands.list(owner)).toContainEqual({
      name: 'add-plugin',
      description: 'load a trusted local Cordis Host plugin from this workspace',
      input: { hint: '<directory>' },
    })
    const loaded = await execute(ctx, owner, '/add-plugin plugin with spaces')
    expect(loaded.kind).toBe('success')
    expect(loaded.text).toContain(`Loaded local plugin ${JSON.stringify(basename(directory))}.`)
    expect(ctx.get('localProbe') as unknown).toEqual({ state: 'ready' })
    expect(localEntryIds(ctx)).toHaveLength(1)

    const duplicate = await execute(ctx, owner, `/add-plugin ${directory}`)
    expect(duplicate.kind).toBe('success')
    expect(duplicate.text).toContain('is already loaded')
    expect(localEntryIds(ctx)).toHaveLength(1)

    const staleId = localEntryIds(ctx)[0]
    if (staleId === undefined) throw new Error('local entry missing')
    await ctx.loader.remove(staleId)
    const reloaded = await execute(ctx, owner, '/add-plugin plugin with spaces')
    expect(reloaded.kind).toBe('success')
    expect(reloaded.text).toContain('Loaded local plugin')
    expect(localEntryIds(ctx)).toHaveLength(1)

    const removedBeforeCleanup = localEntryIds(ctx)[0]
    if (removedBeforeCleanup === undefined) throw new Error('reloaded local entry missing')
    await ctx.loader.remove(removedBeforeCleanup)

    await commandFiber.dispose()
    expect(ctx.commands.list(owner).some(command => command.name === 'add-plugin')).toBe(false)
    expect(ctx.get('localProbe') as unknown).toBeUndefined()
    expect(localEntryIds(ctx)).toEqual([])
  })

  it('removes a plugin that finishes loading after its command request is aborted', async () => {
    const workspace = await temporaryRoot('dsh-add-plugin-abort-')
    const gateKey = `dsh-command-add-plugin-abort-${String(sessionSequence)}`
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    Object.assign(globalThis, {
      [gateKey]: {
        started: () => { started.resolve(undefined) },
        wait: release.promise,
      },
    })
    await writePlugin(join(workspace, 'slow'), { name: 'slow-abort', main: 'index.mjs' }, [
      `const gate = globalThis[${JSON.stringify(gateKey)}]`,
      'gate.started()',
      'await gate.wait',
      'export function apply(ctx) { ctx.provide("abortedProbe", true) }',
      '',
    ].join('\n'))
    const { ctx } = await harness()
    const controller = new AbortController()
    const execution = ctx.commands.execute(agent(workspace), '/add-plugin slow', controller.signal)
    await started.promise
    controller.abort(new Error('cancel local plugin load'))
    release.resolve(undefined)

    await expect(execution).rejects.toThrow('cancel local plugin load')
    await expect.poll(() => localEntryIds(ctx)).toEqual([])
    Reflect.deleteProperty(globalThis, gateKey)
    expect(ctx.get('abortedProbe') as unknown).toBeUndefined()
  })

  it('rejects paths and package formats outside the single built Host entry contract', async () => {
    const workspace = await temporaryRoot('dsh-add-plugin-validation-')
    const outside = await temporaryRoot('dsh-add-plugin-outside-')
    const { ctx } = await harness()
    const owner = agent(workspace)

    await expect(execute(ctx, owner, '/add-plugin')).resolves.toEqual({
      kind: 'error',
      text: 'Usage: /add-plugin <directory>',
    })
    await expectLoadError(ctx, agent(), '.', 'current Session has no workspace')
    await expectLoadError(ctx, owner, 'missing', 'Plugin path does not exist')

    const workspaceFile = join(workspace, 'not-a-workspace')
    await writeFile(workspaceFile, '')
    await expectLoadError(ctx, agent(workspaceFile), '.', 'Session workspace is not a directory')

    await writePlugin(join(outside, 'external'), { name: 'external', main: 'index.mjs' })
    await expectLoadError(ctx, owner, join(outside, 'external'), 'must stay inside the current Session workspace')

    const escapedLink = join(workspace, 'escaped-link')
    await symlink(join(outside, 'external'), escapedLink, 'junction')
    await expectLoadError(ctx, owner, 'escaped-link', 'must stay inside the current Session workspace')

    const plainFile = join(workspace, 'plain-file')
    await writeFile(plainFile, '')
    await expectLoadError(ctx, owner, 'plain-file', 'Plugin path is not a directory')

    const noManifest = join(workspace, 'no-manifest')
    await mkdir(noManifest)
    await expectLoadError(ctx, owner, 'no-manifest', 'no readable package.json')

    for (const [directoryName, source] of [
      ['invalid-json', '{'],
      ['null-json', 'null'],
      ['array-json', '[]'],
      ['scalar-json', '1'],
    ] as const) {
      const directory = join(workspace, directoryName)
      await mkdir(directory)
      await writeFile(join(directory, 'package.json'), source)
      await expectLoadError(ctx, owner, directoryName, directoryName === 'invalid-json'
        ? 'not valid JSON'
        : 'must contain a JSON object')
    }

    await writePlugin(join(workspace, 'no-main'), { name: 'no-main' })
    await expectLoadError(ctx, owner, 'no-main', 'must declare a non-empty string "main"')
    await writePlugin(join(workspace, 'blank-main'), { main: ' ' })
    await expectLoadError(ctx, owner, 'blank-main', 'must declare a non-empty string "main"')
    await writePlugin(join(workspace, 'numeric-main'), { main: 4 })
    await expectLoadError(ctx, owner, 'numeric-main', 'must declare a non-empty string "main"')

    const missingMain = join(workspace, 'missing-main')
    await mkdir(missingMain)
    await writeFile(join(missingMain, 'package.json'), JSON.stringify({ main: 'absent.mjs' }))
    await expectLoadError(ctx, owner, 'missing-main', 'main entry does not exist')

    await writePlugin(join(workspace, 'directory-main'), { main: 'nested/' })
    await expectLoadError(ctx, owner, 'directory-main', 'main entry is not a file')
    await writePlugin(join(workspace, 'typescript-main'), { main: 'index.ts' })
    await expectLoadError(ctx, owner, 'typescript-main', 'main entry must be built JavaScript')

    const escapedMain = join(workspace, 'escaped-main')
    await mkdir(escapedMain)
    await writeFile(join(workspace, 'outside-entry.mjs'), 'export function apply() {}\n')
    await writeFile(join(escapedMain, 'package.json'), JSON.stringify({ main: '../outside-entry.mjs' }))
    await expectLoadError(ctx, owner, 'escaped-main', 'main entry escapes its package directory')

    await writePlugin(join(workspace, 'bundle'), { main: 'index.mjs', dsh: { bundle: { patch: './cordis.patch.yml' } } })
    await expectLoadError(ctx, owner, 'bundle', 'dsh.bundle directories are not supported')
    await writePlugin(join(workspace, 'client'), { main: 'index.mjs', dsh: { client: { bundle: './client.js' } } })
    await expectLoadError(ctx, owner, 'client', 'dsh.client packages are not supported')
    expect(localEntryIds(ctx)).toEqual([])
  })

  it('rolls back activation failures and an entry that finishes during command-plugin shutdown', async () => {
    const workspace = await temporaryRoot('dsh-add-plugin-lifecycle-')
    const broken = join(workspace, 'broken')
    await writePlugin(broken, { name: 'broken', main: 'index.mjs' }, 'export function apply() { throw new Error("activation exploded") }\n')
    const { ctx, commandFiber } = await harness()
    const owner = agent(workspace)

    await expectLoadError(ctx, owner, 'broken', 'activation exploded')
    expect(localEntryIds(ctx)).toEqual([])

    const gateKey = `dsh-command-add-plugin-gate-${String(sessionSequence)}`
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    Object.assign(globalThis, {
      [gateKey]: {
        started: () => { started.resolve(undefined) },
        wait: release.promise,
      },
    })
    const slow = join(workspace, 'slow')
    await writePlugin(slow, { name: 'slow', main: 'index.mjs' }, [
      `const gate = globalThis[${JSON.stringify(gateKey)}]`,
      'gate.started()',
      'await gate.wait',
      'export function apply(ctx) { ctx.provide("slowProbe", true) }',
      '',
    ].join('\n'))

    const execution = execute(ctx, owner, '/add-plugin slow')
    const queued = execute(ctx, owner, '/add-plugin broken')
    await started.promise
    const disposing = commandFiber.dispose()
    release.resolve(undefined)
    await expect(execution).resolves.toEqual({
      kind: 'error',
      text: expect.stringContaining('shut down while the plugin was loading') as unknown as string,
    })
    await expect(queued).resolves.toEqual({
      kind: 'error',
      text: expect.stringContaining('local plugin loader is shutting down') as unknown as string,
    })
    await disposing
    Reflect.deleteProperty(globalThis, gateKey)
    expect(ctx.get('slowProbe') as unknown).toBeUndefined()
    expect(localEntryIds(ctx)).toEqual([])
  })
})
