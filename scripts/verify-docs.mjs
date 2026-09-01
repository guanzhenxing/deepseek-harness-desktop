import { access, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))

const requiredDocuments = [
  'README.md',
  'SECURITY.md',
  'docs/architecture.md',
  'docs/data-layout.md',
  'docs/development.md',
  'docs/protocols/host-control.md',
  'docs/adr/README.md',
]

const ignoredDirectories = new Set([
  '.git',
  '.pnpm-store',
  '.tmp',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'playwright-report',
  'release',
  'test-results',
])

const errors = []

async function exists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function collectMarkdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue

    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(absolutePath)))
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(absolutePath)
    }
  }

  return files
}

function extractLocalLinkTarget(rawTarget) {
  const trimmed = rawTarget.trim()
  const target = trimmed.startsWith('<')
    ? trimmed.slice(1, trimmed.indexOf('>'))
    : trimmed.split(/\s+/u, 1)[0]

  if (
    !target ||
    target.startsWith('#') ||
    target.startsWith('/') ||
    /^(?:data|https?|mailto):/u.test(target)
  ) {
    return null
  }

  const withoutAnchor = target.split('#', 1)[0]
  return decodeURI(withoutAnchor).replace(/:\d+(?::\d+)?$/u, '')
}

async function verifyMarkdownFile(absolutePath) {
  const relativePath = path.relative(repositoryRoot, absolutePath)
  const contents = await readFile(absolutePath, 'utf8')

  if (!contents.endsWith('\n')) {
    errors.push(`${relativePath}: missing final newline`)
  }

  contents.split('\n').forEach((line, index) => {
    if (/[ \t]+$/u.test(line)) {
      errors.push(`${relativePath}:${index + 1}: trailing whitespace`)
    }
  })

  const linkPattern = /!?\[[^\]]*\]\(([^)]+)\)/gu
  for (const match of contents.matchAll(linkPattern)) {
    const target = extractLocalLinkTarget(match[1])
    if (!target) continue

    const resolvedTarget = path.resolve(path.dirname(absolutePath), target)
    const relativeTarget = path.relative(repositoryRoot, resolvedTarget)
    if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
      errors.push(`${relativePath}: local link leaves repository: ${target}`)
      continue
    }

    if (!(await exists(resolvedTarget))) {
      errors.push(`${relativePath}: missing local link target: ${target}`)
    }
  }
}

for (const relativePath of requiredDocuments) {
  if (!(await exists(path.join(repositoryRoot, relativePath)))) {
    errors.push(`missing required document: ${relativePath}`)
  }
}

const markdownFiles = await collectMarkdownFiles(repositoryRoot)
await Promise.all(markdownFiles.map(verifyMarkdownFile))

if (errors.length > 0) {
  console.error(`Documentation check failed with ${errors.length} error(s):`)
  for (const error of errors.sort()) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  console.log(`Documentation check passed (${markdownFiles.length} Markdown files).`)
}

