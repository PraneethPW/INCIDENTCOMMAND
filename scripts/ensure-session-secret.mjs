import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const envPath = fileURLToPath(new URL('../backend/.env', import.meta.url))
let content
try {
  content = await readFile(envPath, 'utf8')
} catch (error) {
  if (error.code !== 'ENOENT') throw error
  content = await readFile(new URL('../backend/.env.example', import.meta.url), 'utf8')
}
const line = /^SESSION_SECRET=(.*)$/m.exec(content)
const current = line?.[1]?.trim() || ''
if (current.length >= 32 && !current.startsWith('replace-with-')) {
  console.log('SESSION_SECRET is already configured.')
  process.exit(0)
}
const secret = randomBytes(48).toString('base64url')
if (line) content = content.replace(/^SESSION_SECRET=.*$/m, `SESSION_SECRET=${secret}`)
else content = `${content.trimEnd()}\nSESSION_SECRET=${secret}\n`
await writeFile(envPath, content, { encoding: 'utf8', mode: 0o600 })
console.log('Generated a secure local SESSION_SECRET in backend/.env.')
