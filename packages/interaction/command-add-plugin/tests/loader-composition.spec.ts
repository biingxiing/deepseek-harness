import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { Session, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import * as CommandAddPlugin from '../src/index.ts'

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('/add-plugin real Loader composition through cordis.yml', () => {
  it('loads a local package and retracts it when the command row is hot-removed', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-command-add-plugin-loader-'))
    const configPath = join(root, 'cordis.yml')
    const pluginDirectory = join(root, 'local-plugin')
    await mkdir(pluginDirectory)
    await writeFile(join(pluginDirectory, 'package.json'), JSON.stringify({
      name: 'loader-local-plugin',
      main: 'index.mjs',
    }))
    await writeFile(join(pluginDirectory, 'index.mjs'), [
      'export const name = "loader-local-plugin"',
      'export function apply(ctx) { ctx.provide("loaderLocalProbe", { active: true }) }',
      '',
    ].join('\n'))
    await writeFile(configPath, [
      "- id: commands\n  name: '@deepseek-ai/dsh-commands'",
      "- id: command-add-plugin\n  name: '@deepseek-ai/dsh-command-add-plugin'",
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-commands', CommandRuntime],
      ['@deepseek-ai/dsh-command-add-plugin', CommandAddPlugin],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string): Promise<unknown> {
        if (modules.has(specifier)) return modules.get(specifier)
        return await import(/* @vite-ignore */ specifier) as unknown
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    const includeId = await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    const id = SessionId('loader-command-add-plugin')
    const session = Session.create(id, undefined, {
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: 0,
      cwd: root,
    })
    const owner = { id, session } as unknown as Agent
    expect(context.commands.list(owner)).toContainEqual({
      name: 'add-plugin',
      description: 'load a trusted local Cordis Host plugin from this workspace',
      input: { hint: '<directory>' },
    })

    const execution = await context.commands.execute(owner, '/add-plugin ./local-plugin', new AbortController().signal)
    if (execution === undefined) throw new Error('Loader composition did not resolve /add-plugin')
    expect(execution.result.kind).toBe('success')
    expect(execution.result.text).toContain('Loaded local plugin "loader-local-plugin".')
    expect(context.get('loaderLocalProbe') as unknown).toEqual({ active: true })
    expect(session.events.map(event => event.type)).toEqual(['command/run', 'command/done'])
    expect(session.deriveMessages()).toEqual([])

    await writeFile(configPath, "- id: commands\n  name: '@deepseek-ai/dsh-commands'\n")
    const include = context.loader.resolve(includeId).subtree
    if (!(include instanceof Include)) throw new Error('root include subtree missing')
    await include.refresh()

    expect(context.commands.list(owner).some(command => command.name === 'add-plugin')).toBe(false)
    expect(context.get('loaderLocalProbe') as unknown).toBeUndefined()
    expect([...context.loader.entries()].some(entry => entry.options.name === pathToFileURL(join(pluginDirectory, 'index.mjs')).href)).toBe(false)
  })
})
