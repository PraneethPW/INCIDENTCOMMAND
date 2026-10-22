import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'

// Resolve against this module in src/ or dist/, never the process working directory.
// Deployment-provided variables take precedence over local development settings.
if (process.env.NODE_ENV !== 'test') {
  config({ path: fileURLToPath(new URL('../.env', import.meta.url)) })
}
