import { assertSupportedJsonSchema, validateJsonSchemaValue } from '../packages/core/tools/src/json-schema.ts'
import { apply, inject, name } from './src/index.mjs'

const tools: any[] = []
const commands: any[] = []
const sections: any[] = []
const disposers: (() => void)[] = []

const ctx: any = {
  effect(fn: () => any) { disposers.push(fn()) },
  tools: { register(def: any) { tools.push(def); return () => { tools.splice(tools.indexOf(def), 1) } } },
  commands: { register(def: any) { commands.push(def); return () => { commands.splice(commands.indexOf(def), 1) } } },
  systemPrompt: { section(s: any) { sections.push(s); return () => { sections.splice(sections.indexOf(s), 1) } } },
}

apply(ctx)
console.log('name/inject:', name, inject)
console.log('tools:', tools.map(t => t.name))
console.log('commands:', commands.map(c => c.name))
console.log('sections:', sections.map(s => `${s.name}@${s.order}`))

for (const tool of tools) {
  assertSupportedJsonSchema(tool.output.schema)
  assertSupportedJsonSchema(tool.parameters)
}
console.log('schemas: supported subset OK (parameters + output)')

const session = { id: 'sess-1' }
const exec = { agent: { session } }
const add = tools.find(t => t.name === 'bookmark_add')!
const list = tools.find(t => t.name === 'bookmark_list')!

const check = (tool: any, args: any, value: any) => {
  const violations = validateJsonSchemaValue(tool.output.schema, value)
  if (violations.length > 0) throw new Error(`${tool.name} output: ${violations.join('; ')}`)
  console.log(`  ${tool.name} ->`, JSON.stringify(value), '|', tool.output.render(args, value).map((b: any) => b.text).join('\\n'))
}

let args: any = { file: 'src/index.ts', line: 42, note: 'entry point' }
check(add, args, await add.execute(Object.freeze(args), exec))
console.log('  presentCall:', JSON.stringify(add.presentCall(args)))

args = { file: 'README.md', note: 'needs an update' }
check(add, args, await add.execute(Object.freeze(args), exec))
console.log('  presentCall:', JSON.stringify(add.presentCall(args)))

check(list, {}, await list.execute({}, exec))

// Rejections.
for (const bad of [{ note: 'x' }, { file: 'a', note: '  ' }, { file: 'a', note: 'n', line: 0 }, { file: 'a', note: 'n', line: 1.5 }, 'nope']) {
  try {
    await add.execute(bad, exec)
    throw new Error(`accepted invalid args: ${JSON.stringify(bad)}`)
  } catch (error) {
    console.log('  rejected:', JSON.stringify(bad), '->', (error as Error).message)
  }
}
try {
  await add.execute({ file: 'a', note: 'n' }, {})
} catch (error) { console.log('  rejected: no agent ->', (error as Error).message) }

// Prompt sections.
const listSection = sections.find(s => s.name === 'bookmarks:list')!
console.log('section(with agent):\n' + listSection.text({ agent: { session } }))
console.log('section(no agent):', JSON.stringify(listSection.text({})))
console.log('section(other session):', JSON.stringify(listSection.text({ agent: { session: { id: 'sess-2' } } })))

// Command plane.
const cmd = commands[0]!
const run = (rawInput: string) => cmd.handler({ agent: { session }, rawInput, commandId: 'c1', signal: new AbortController().signal })
for (const input of ['', ' remove 1 ', 'remove #99', 'bogus', '', 'clear', '']) {
  console.log(`  /bookmarks ${JSON.stringify(input)} ->`, JSON.stringify(run(input)))
}

// Bounds: 50 per session.
for (let i = 0; i < 60; i++) await add.execute({ file: `f${i}.ts`, note: `n${i}` }, exec)
const bounded = await list.execute({}, exec)
console.log('bounded per session:', bounded.total, 'first:', bounded.bookmarks[0].file, 'last:', bounded.bookmarks.at(-1).file)

// Bounds: 32 sessions.
for (let i = 0; i < 40; i++) await add.execute({ file: 'x.ts', note: 'n' }, { agent: { session: { id: `s${i}` } } })
console.log('evicted early session s0:', JSON.stringify(await list.execute({}, { agent: { session: { id: 's0' } } })))
console.log('kept recent session s39:', (await list.execute({}, { agent: { session: { id: 's39' } } })).total)

// Disposal.
for (const dispose of disposers) dispose()
console.log('after dispose — tools:', tools.length, 'commands:', commands.length, 'sections:', sections.length)
console.log('after dispose — s39 bookmarks:', (await list.execute({}, { agent: { session: { id: 's39' } } })).total)
