/**
 * Bundle the host plugin into a single ESM file.
 * Core modules are inlined; @deepseek-ai/* stay external because the host
 * composition owns those services.
 */

import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'

await mkdir('lib', { recursive: true })

await build({
  entryPoints: ['src/host/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'warning',
  minify: false,
  legalComments: 'none',
  external: ['@deepseek-ai/*'],
})

console.info('built: lib/index.js')
