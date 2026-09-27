import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const envPath = resolve('backend/.env')
let content = await readFile(envPath, 'utf8')
const line = /^SESSION_SECRET=(.*)$/m.exec(content)
if (line?.[1]?.trim().length >= 32) {
  console.log('SESSION_SECRET is already configured.')
  process.exit(0)
}
const secret = randomBytes(48).toString('base64url')
if (line) content = content.replace(/^SESSION_SECRET=.*$/m, `SESSION_SECRET=${secret}`)
else content = `${content.trimEnd()}\nSESSION_SECRET=${secret}\n`
await writeFile(envPath, content, 'utf8')
console.log('Generated a secure local SESSION_SECRET in backend/.env.')
