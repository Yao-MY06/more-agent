/** The registered projects the Leader may route to, kept in a plain file a person can read and edit. */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { BRIEF_CHARS } from './config.ts'

const BRIEF_FILES = ['README.zh-CN.md', 'README.md']
const MAX_PROJECTS = 200

const ProjectSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'Use lowercase letters, digits and hyphens'),
    path: z.string().min(1),
    brief: z.string().max(BRIEF_CHARS),
    /** Off by default: until a person switches it on, the project's Tickets run in shadow and nothing touches its files. */
    execute: z.boolean().default(false),
  })
  .strict()
export type Project = z.infer<typeof ProjectSchema>
const ProjectsSchema = z.array(ProjectSchema).max(MAX_PROJECTS)

export function loadProjects(file: string): Project[] {
  if (!existsSync(file)) return []
  return ProjectsSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
}

/** Registers a project, replacing one with the same id. */
export function addProject(
  file: string,
  input: { id: string; path: string; brief?: string; execute?: boolean },
): Project {
  const path = resolve(input.path)
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`Not a directory: ${path}`)
  const brief = (input.brief ?? readBrief(path)).slice(0, BRIEF_CHARS)
  const project = ProjectSchema.parse({ id: input.id, path, brief, execute: input.execute ?? false })
  const others = loadProjects(file).filter((item) => item.id !== project.id)
  saveProjects(file, [...others, project])
  return project
}

function readBrief(path: string): string {
  const found = BRIEF_FILES.map((name) => join(path, name)).find((file) => existsSync(file))
  return found ? readFileSync(found, 'utf8') : ''
}

function saveProjects(file: string, projects: Project[]): void {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, `${JSON.stringify(projects, null, 2)}\n`)
  renameSync(temporary, file)
}
