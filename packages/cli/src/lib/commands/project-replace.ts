import { Command } from 'commander'
import fs from 'fs'
import path from 'path'
import {
    ConnectionMappingSchema,
    ProjectReplaceApplyResult,
    ProjectReplaceArtifact,
    ProjectReplaceArtifactSchema,
    ProjectStateSnapshot,
    ProviderMappingSchema,
} from '@inboxfm-connect/shared'

/**
 * Exit-code contract. Every distinct outcome gets its own code so a caller (CI, a wrapper script)
 * can tell "the destination rejected the plan" from "the destination drifted" from "the plan is
 * fine and simply has work to do".
 *
 * Previously `1` was overloaded for three unrelated outcomes — preflight failure, a dry run that
 * found pending changes, and an apply that partially succeeded — so a script could not react to
 * any of them. 0-6 keep their original values for backward compatibility; 7 and 8 are new.
 */
export const PROJECT_REPLACE_EXIT = {
    SUCCESS: 0,
    PREFLIGHT_FAILED: 1,
    VALIDATION_FAILED: 2,
    DESTINATION_DRIFT: 3,
    AUTH_FAILED: 4,
    TRANSPORT_FAILED: 5,
    SERVER_ERROR: 6,
    CHANGES_PENDING: 7,
    PARTIAL_APPLY: 8,
} as const

export type ProjectReplaceExitCode = (typeof PROJECT_REPLACE_EXIT)[keyof typeof PROJECT_REPLACE_EXIT]

const REDACTED = '[REDACTED]'

export type ReplaceCliOptions = {
    sourceUrl?: string
    sourceToken?: string
    sourceProject?: string
    destUrl: string
    destToken: string
    destProject: string
    planFile?: string
    out?: string
    dryRun?: boolean
    force?: boolean
    deployIntegrations?: boolean
    inspectOnly?: boolean
    connectionMap?: string[]
    connectionMappingFile?: string
    connectionBootstrap?: string
    providerMap?: string[]
    rotateMcpToken?: boolean
    json?: boolean
}

export type ProjectReplaceDeps = {
    fetch: typeof globalThis.fetch
}

export const projectReplaceCommand = new Command('replace')
    .description('Mirror a project configuration from source to destination, or review dry-run plan')
    .option('--source-url <url>', 'Source API URL')
    .option('--source-token <token>', 'Source authorization token')
    .option('--source-project <id>', 'Source project ID')
    .requiredOption('--dest-url <url>', 'Destination API URL')
    .requiredOption('--dest-token <token>', 'Destination authorization token')
    .requiredOption('--dest-project <id>', 'Destination project ID')
    .option('--plan-file <path>', 'Path to a signed plan artifact JSON file to apply')
    .option('--out <path>', 'Path to write generated plan artifact JSON')
    .option('--dry-run', 'Generate reviewable plan artifact without mutating destination', false)
    .option('--deploy-integrations', 'Deploy missing custom integrations automatically during replace', false)
    .option('--inspect-only', 'Inspect and report missing integrations without applying any changes', false)
    .option('--connection-map <mapping...>', 'Map source connection externalId to destination externalId (e.g. source=dest)')
    .option('--connection-mapping-file <path>', 'Path to file containing connection mappings or bootstrap secrets')
    .option('--connection-bootstrap <json>', 'JSON string of connection bootstrap credentials')
    .option('--provider-map <mapping...>', 'Map source piece name to destination piece name (e.g. SourcePiece=DestPiece)')
    .option('--force', 'Bypass preflight warnings', false)
    .option('--rotate-mcp-token', 'Rotate destination MCP server token during apply and output one-time credential', false)
    .option('--json', 'Output machine-readable JSON', false)
    .action(async (options: ReplaceCliOptions) => {
        process.exit(await runProjectReplace(options, { fetch: globalThis.fetch }))
    })

/**
 * Runs the whole command and returns the process exit code instead of terminating, so the exit-code
 * contract and the redaction behaviour are both directly testable.
 */
export async function runProjectReplace(options: ReplaceCliOptions, deps: ProjectReplaceDeps): Promise<number> {
    let restoreConsole: (() => void) | undefined
    try {
        const destBase = options.destUrl.replace(/\/$/, '')

        let snapshot: ProjectStateSnapshot
        let artifact: ProjectReplaceArtifact | null = null

        const connectionMappings = parseConnectionMappings(options)
        const providerMappings = parseProviderMappings(options)

        // Installed before the first write so that nothing downstream — including the `--json`
        // echo of a server response that may quote the submitted bootstrap — can print a
        // credential back out.
        restoreConsole = installSecretRedaction(collectSecretValues(connectionMappings))

        if (!options.json && connectionMappings.length > 0) {
            const bootstrapCount = connectionMappings.filter((m) => !!m.value).length
            const remapCount = connectionMappings.length - bootstrapCount
            console.log(`Connection mappings loaded: ${connectionMappings.length} (${remapCount} alias, ${bootstrapCount} credentials [REDACTED])`)
        }
        if (!options.json && providerMappings.length > 0) {
            console.log(`Provider mappings loaded: ${providerMappings.length}`)
        }

        // 1. If --plan-file is supplied, load and validate it with Zod schema
        if (options.planFile) {
            const raw = fs.readFileSync(path.resolve(options.planFile), 'utf-8')
            let parsedJson: unknown
            try {
                parsedJson = JSON.parse(raw)
            }
            catch (e) {
                console.error('Invalid JSON in plan file:', (e as Error).message)
                return PROJECT_REPLACE_EXIT.VALIDATION_FAILED
            }

            const parsed = ProjectReplaceArtifactSchema.safeParse(parsedJson)
            if (!parsed.success) {
                console.error('Invalid plan file schema:', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', '))
                return PROJECT_REPLACE_EXIT.VALIDATION_FAILED
            }
            artifact = parsed.data
            snapshot = artifact.snapshot

            // If --dry-run or --inspect-only is passed with --plan-file, verify signature & drift with destination /inspect
            if (options.dryRun || options.inspectOnly) {
                const inspectRes = await fetchJson<{ applied: Record<string, number>, failed: Array<{ error: string }>, error?: string }>(
                    `${destBase}/api/v1/projects/${options.destProject}/replace/inspect`,
                    {
                        method: 'POST',
                        headers: authHeaders(options.destToken),
                        body: JSON.stringify({
                            plan: artifact.plan,
                            snapshot,
                            connectionMappings: connectionMappings.length > 0 ? connectionMappings : undefined,
                        }),
                    },
                    deps,
                )

                if (inspectRes.status === 409) {
                    console.error('Error: Destination state has drifted since the plan was created. Re-run plan.')
                    return PROJECT_REPLACE_EXIT.DESTINATION_DRIFT
                }

                if (inspectRes.status === 401 || inspectRes.status === 403) {
                    console.error('Error: Unauthorized on destination:', inspectRes.data)
                    return PROJECT_REPLACE_EXIT.AUTH_FAILED
                }

                if (!inspectRes.ok) {
                    console.error(`Error: Plan verification failed on destination (${inspectRes.status}):`, inspectRes.data)
                    return inspectRes.status >= 500 ? PROJECT_REPLACE_EXIT.SERVER_ERROR : PROJECT_REPLACE_EXIT.VALIDATION_FAILED
                }

                if (options.dryRun) {
                    if (options.json) {
                        console.log(JSON.stringify(artifact, null, 2))
                    }
                    else {
                        printPlanHeader(artifact)
                        printPreflightCounts(artifact, 'Planned Changes:')
                    }
                    return pendingChangesExitCode(artifact)
                }

                if (options.inspectOnly) {
                    if (options.json) {
                        console.log(JSON.stringify(artifact, null, 2))
                    }
                    else {
                        console.log('Inspect-only mode: plan verified, no mutations applied.')
                        printPreflightDetail(artifact, 'Verified')
                    }
                    return PROJECT_REPLACE_EXIT.SUCCESS
                }
            }
        }
        else {
            // Otherwise source details are required to fetch snapshot
            if (!options.sourceUrl || !options.sourceToken || !options.sourceProject) {
                console.error('Error: --source-url, --source-token, and --source-project are required when --plan-file is not provided.')
                return PROJECT_REPLACE_EXIT.AUTH_FAILED
            }

            const sourceBase = options.sourceUrl.replace(/\/$/, '')
            const exportRes = await fetchJson<ProjectStateSnapshot>(
                `${sourceBase}/api/v1/projects/${options.sourceProject}/replace/export`,
                {
                    headers: authHeaders(options.sourceToken),
                },
                deps,
            )

            if (!exportRes.ok) {
                console.error(`Error: Failed to export snapshot from source (${exportRes.status}):`, exportRes.data)
                if (exportRes.status >= 500) return PROJECT_REPLACE_EXIT.SERVER_ERROR
                return exportRes.status === 401 || exportRes.status === 403 ? PROJECT_REPLACE_EXIT.AUTH_FAILED : PROJECT_REPLACE_EXIT.TRANSPORT_FAILED
            }
            snapshot = exportRes.data
        }

        // 2. Plan generation (if no plan file is provided)
        if (!artifact) {
            const planRes = await fetchJson<ProjectReplaceArtifact>(
                `${destBase}/api/v1/projects/${options.destProject}/replace/plan`,
                {
                    method: 'POST',
                    headers: authHeaders(options.destToken),
                    body: JSON.stringify({
                        snapshot,
                        connectionMappings: connectionMappings.length > 0 ? connectionMappings : undefined,
                        providerMappings: providerMappings.length > 0 ? providerMappings : undefined,
                    }),
                },
                deps,
            )

            if (planRes.status === 400) {
                const planBody = extractPreflightBody(planRes.data)
                if (planBody) {
                    if (!options.force && !options.inspectOnly) {
                        if (options.json) {
                            console.log(JSON.stringify(planRes.data, null, 2))
                        }
                        else {
                            console.error('Preflight checks failed on destination:')
                            for (const err of planBody.preflight.errors) {
                                console.error(`  - [${err.kind}]: ${err.message}`)
                            }
                        }
                        return PROJECT_REPLACE_EXIT.PREFLIGHT_FAILED
                    }
                    artifact = planRes.data as ProjectReplaceArtifact
                }
                else {
                    console.error(`Error: Validation failed on destination (${planRes.status}):`, planRes.data)
                    return PROJECT_REPLACE_EXIT.VALIDATION_FAILED
                }
            }
            else if (planRes.status === 401 || planRes.status === 403) {
                console.error(`Error: Auth failed on destination (${planRes.status}):`, planRes.data)
                return PROJECT_REPLACE_EXIT.AUTH_FAILED
            }
            else if (planRes.status === 409) {
                console.error(`Error: Drift detected (${planRes.status}):`, planRes.data)
                return PROJECT_REPLACE_EXIT.DESTINATION_DRIFT
            }
            else if (planRes.status >= 500) {
                console.error(`Error: Server error on destination (${planRes.status}):`, planRes.data)
                return PROJECT_REPLACE_EXIT.SERVER_ERROR
            }
            else if (!planRes.ok) {
                console.error(`Error: Failed to generate plan on destination (${planRes.status}):`, planRes.data)
                return PROJECT_REPLACE_EXIT.TRANSPORT_FAILED
            }
            else {
                artifact = planRes.data
            }

            if (options.out && artifact) {
                const outPath = path.resolve(options.out)
                fs.mkdirSync(path.dirname(outPath), { recursive: true })
                fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2), 'utf-8')
            }

            if (options.dryRun && artifact) {
                if (options.json) {
                    console.log(JSON.stringify(artifact, null, 2))
                }
                else {
                    printPlanHeader(artifact)
                    printPreflightCounts(artifact, 'Planned Changes:')
                    printPreflightWarnings(artifact)
                }
                return pendingChangesExitCode(artifact)
            }

            if (options.inspectOnly && artifact) {
                if (options.json) {
                    console.log(JSON.stringify(artifact, null, 2))
                }
                else {
                    console.log('Inspect-only mode: no mutations applied.')
                    printPreflightDetail(artifact, 'Inspected')
                    if (!artifact.plan.preflight.passed) {
                        console.log('\nPreflight checks:')
                        for (const err of artifact.plan.preflight.errors) {
                            console.log(`  - [${err.kind}]: ${err.message}`)
                        }
                    }
                }
                return artifact.plan.preflight.passed ? PROJECT_REPLACE_EXIT.SUCCESS : PROJECT_REPLACE_EXIT.PREFLIGHT_FAILED
            }
        }

        // 3. Apply phase
        const applyRes = await fetchJson<ProjectReplaceApplyResult>(
            `${destBase}/api/v1/projects/${options.destProject}/replace/apply`,
            {
                method: 'POST',
                headers: authHeaders(options.destToken),
                body: JSON.stringify({
                    plan: artifact!.plan,
                    snapshot,
                    force: options.force,
                    deployCustomIntegrations: options.deployIntegrations,
                    inspectOnly: options.inspectOnly,
                    connectionMappings: connectionMappings.length > 0 ? connectionMappings : undefined,
                    providerMappings: providerMappings.length > 0 ? providerMappings : undefined,
                    rotateMcpToken: options.rotateMcpToken,
                }),
            },
            deps,
        )

        if (applyRes.status === 409) {
            console.error('Error: Destination state has drifted since the plan was created. Re-run plan or recreate plan artifact.')
            return PROJECT_REPLACE_EXIT.DESTINATION_DRIFT
        }

        if (applyRes.status === 401 || applyRes.status === 403) {
            console.error('Error: Unauthorized on destination:', applyRes.data)
            return PROJECT_REPLACE_EXIT.AUTH_FAILED
        }

        if (!applyRes.ok && applyRes.status !== 207) {
            console.error(`Error: Apply failed on destination (${applyRes.status}):`, applyRes.data)
            return applyRes.status >= 500 ? PROJECT_REPLACE_EXIT.SERVER_ERROR : PROJECT_REPLACE_EXIT.TRANSPORT_FAILED
        }

        if (options.json) {
            console.log(JSON.stringify(applyRes.data, null, 2))
        }
        else {
            console.log('Project replacement apply finished:')
            console.log(JSON.stringify(applyRes.data.applied, null, 2))
            if (applyRes.data.mcpCredentials?.token) {
                console.log('\nDestination MCP Server Credentials [ONE-TIME DISPLAY]:')
                console.log(`  Token: ${applyRes.data.mcpCredentials.token}`)
                if (applyRes.data.mcpCredentials.serverUrl) {
                    console.log(`  Server URL: ${applyRes.data.mcpCredentials.serverUrl}`)
                }
            }
            if (applyRes.data.failed.length > 0) {
                console.warn(`Warnings: ${applyRes.data.failed.length} items failed to apply.`)
            }
        }

        return applyRes.data.failed.length > 0 ? PROJECT_REPLACE_EXIT.PARTIAL_APPLY : PROJECT_REPLACE_EXIT.SUCCESS
    }
    catch (err) {
        console.error('Fatal CLI Error:', (err as Error).message)
        if ((err as Error).message.startsWith('Transport error')) {
            return PROJECT_REPLACE_EXIT.TRANSPORT_FAILED
        }
        return PROJECT_REPLACE_EXIT.VALIDATION_FAILED
    }
    finally {
        restoreConsole?.()
    }
}

function authHeaders(token: string): Record<string, string> {
    return {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
    }
}

function pendingChangesExitCode(artifact: ProjectReplaceArtifact): number {
    const { created, updated, deleted } = artifact.plan.summary
    return created + updated + deleted > 0 ? PROJECT_REPLACE_EXIT.CHANGES_PENDING : PROJECT_REPLACE_EXIT.SUCCESS
}

function printPlanHeader(artifact: ProjectReplaceArtifact): void {
    console.log(`Plan ID: ${artifact.plan.planId}`)
    console.log(`Checksum: ${artifact.plan.checksum}`)
    console.log(`Signature: ${artifact.plan.signature}`)
}

function printPreflightCounts(artifact: ProjectReplaceArtifact, heading: string): void {
    console.log(`\n${heading}`)
    console.log(`  Creates:   ${artifact.plan.summary.created}`)
    console.log(`  Updates:   ${artifact.plan.summary.updated}`)
    console.log(`  Deletes:   ${artifact.plan.summary.deleted}`)
    console.log(`  Unchanged: ${artifact.plan.summary.unchanged}`)
    printIntegrationCounts(artifact)
    printConnectionCounts(artifact)
    printMcpCounts(artifact)
}

function printIntegrationCounts(artifact: ProjectReplaceArtifact): void {
    const ci = artifact.plan.preflight.customIntegrations
    if (!ci) return
    console.log('\nCustom Integrations:')
    console.log(`  Required:   ${ci.required.length}`)
    console.log(`  Missing:    ${ci.missing.length}`)
    console.log(`  Deployable: ${ci.deployable.length}`)
}

function printConnectionCounts(artifact: ProjectReplaceArtifact): void {
    const cp = artifact.plan.preflight.connections
    if (!cp) return
    console.log('\nConnections:')
    console.log(`  Required:   ${cp.required.length}`)
    console.log(`  Matched:    ${cp.matched.length}`)
    console.log(`  Missing:    ${cp.missing.length}`)
    console.log(`  Mapped:     ${cp.mapped.length}`)
}

function printMcpCounts(artifact: ProjectReplaceArtifact): void {
    const changes = artifact.plan.changes
    if (!changes) return
    const count = (kind: string, bucket: 'creates' | 'updates' | 'deletes' | 'unchanged') =>
        changes[bucket].filter(c => c.kind === kind).length
    const total = count('mcp_server', 'creates') + count('mcp_server', 'updates')
        + count('mcp_server', 'deletes') + count('mcp_server', 'unchanged')
    if (total === 0) return
    console.log('\nMCP Server Configuration:')
    console.log(`  Creates:   ${count('mcp_server', 'creates')}`)
    console.log(`  Updates:   ${count('mcp_server', 'updates')}`)
    console.log(`  Deletes:   ${count('mcp_server', 'deletes')}`)
    console.log(`  Unchanged: ${count('mcp_server', 'unchanged')}`)
}

function printPreflightWarnings(artifact: ProjectReplaceArtifact): void {
    const warnings = artifact.plan.preflight.warnings
    if (!warnings || warnings.length === 0) return
    console.log('\nPreflight Warnings:')
    for (const warn of warnings) {
        console.log(`  - [${warn.kind}]: ${warn.message}`)
    }
}

function printPreflightDetail(artifact: ProjectReplaceArtifact, label: 'Verified' | 'Inspected'): void {
    const ci = artifact.plan.preflight.customIntegrations
    if (ci) {
        console.log(`Required integrations:   ${ci.required.map((p) => `${p.name}@${p.version}`).join(', ') || 'none'}`)
        console.log(`Missing integrations:    ${ci.missing.map((p) => `${p.name}@${p.version}`).join(', ') || 'none'}`)
        if (label === 'Inspected') {
            console.log(`Deployable integrations: ${ci.deployable.map((p) => `${p.name}@${p.version}`).join(', ') || 'none'}`)
            console.log(`Compatible integrations: ${ci.compatible.map((p) => `${p.name}@${p.version}`).join(', ') || 'none'}`)
        }
    }
    const cp = artifact.plan.preflight.connections
    if (cp) {
        console.log(`Required connections:    ${cp.required.map((c) => `${c.externalId} (${c.pieceName})`).join(', ') || 'none'}`)
        console.log(`Matched connections:     ${cp.matched.map((c) => `${c.sourceExternalId} -> ${c.destExternalId}`).join(', ') || 'none'}`)
        console.log(`Missing connections:     ${cp.missing.map((c) => `${c.externalId} (${c.pieceName})`).join(', ') || 'none'}`)
    }
}

type PreflightFailure = {
    preflight: {
        passed: boolean
        errors: Array<{ kind: string, message: string }>
    }
}

/**
 * A 400 from /plan carries the preflight report when the plan was produced but rejected, and a
 * plain validation error otherwise. The two need different exit codes, so they are told apart by
 * shape rather than by status alone.
 */
function extractPreflightBody(data: unknown): PreflightFailure | null {
    if (typeof data !== 'object' || data === null) return null
    const plan = (data as { plan?: unknown }).plan
    if (typeof plan !== 'object' || plan === null) return null
    const preflight = (plan as { preflight?: unknown }).preflight
    if (typeof preflight !== 'object' || preflight === null) return null
    if (!('errors' in preflight) || !('passed' in preflight)) return null
    return plan as PreflightFailure
}

export function parseConnectionMappings(options: ReplaceCliOptions): ConnectionMappingSchema[] {
    const mappings: ConnectionMappingSchema[] = []

    const envVal = process.env.INBOXFM_CONNECTION_MAPPINGS
    if (envVal) {
        try {
            if (fs.existsSync(path.resolve(envVal))) {
                const content = fs.readFileSync(path.resolve(envVal), 'utf-8')
                parseMappingContent(content, mappings)
            }
            else {
                parseMappingContent(envVal, mappings)
            }
        }
        catch (err) {
            console.warn('Warning: Failed to parse INBOXFM_CONNECTION_MAPPINGS:', (err as Error).message)
        }
    }

    if (options.connectionMappingFile) {
        const filePath = path.resolve(options.connectionMappingFile)
        if (!fs.existsSync(filePath)) {
            throw new Error(`Connection mapping file not found: ${filePath}`)
        }
        const content = fs.readFileSync(filePath, 'utf-8')
        parseMappingContent(content, mappings)
    }

    if (options.connectionBootstrap) {
        parseMappingContent(options.connectionBootstrap, mappings)
    }

    for (const item of toList(options.connectionMap)) {
        for (const part of item.split(',')) {
            const trimmed = part.trim()
            if (!trimmed) continue
            const { source, dest } = parsePair(trimmed, 'connection', 'sourceExternalId=destExternalId')
            mappings.push({ sourceExternalId: source, destExternalId: dest })
        }
    }

    return mappings
}

export function parseProviderMappings(options: ReplaceCliOptions): ProviderMappingSchema[] {
    const mappings: ProviderMappingSchema[] = []
    for (const item of toList(options.providerMap)) {
        for (const part of item.split(',')) {
            const trimmed = part.trim()
            if (!trimmed) continue
            const { source, dest } = parsePair(trimmed, 'provider', 'sourcePieceName=destPieceName')
            mappings.push({ sourceProvider: source, destProvider: dest })
        }
    }
    return mappings
}

function toList(value: string[] | undefined): string[] {
    if (value === undefined) return []
    return Array.isArray(value) ? value : [value]
}

/**
 * `=` is preferred over `:` so a namespaced piece name (e.g. `@scope/http:request`) only has its
 * final segment treated as the destination.
 */
function parsePair(raw: string, kind: string, expected: string): { source: string, dest: string } {
    const delimiterIndex = raw.indexOf('=') !== -1 ? raw.indexOf('=') : raw.indexOf(':')
    if (delimiterIndex === -1) {
        throw new Error(`Invalid ${kind} mapping "${raw}". Format must be ${expected}`)
    }
    return {
        source: raw.slice(0, delimiterIndex).trim(),
        dest: raw.slice(delimiterIndex + 1).trim(),
    }
}

function parseMappingContent(content: string, out: ConnectionMappingSchema[]): void {
    const parsed = JSON.parse(content)
    if (Array.isArray(parsed)) {
        for (const item of parsed) {
            if (item && item.sourceExternalId) {
                out.push(item)
            }
        }
    }
    else if (isMappingEntry(parsed)) {
        // A single mapping object, which is the shape `--connection-bootstrap` is documented to take
        // ("{"sourceExternalId":"x","value":{...}}"). Without this branch it fell through to the
        // key→value map handling below and was mangled into {sourceExternalId: 'value', ...}, so the
        // bootstrap credential was silently reshaped and never reached the destination.
        out.push(parsed)
    }
    else if (typeof parsed === 'object' && parsed !== null) {
        if (Array.isArray((parsed as Record<string, unknown>).mappings)) {
            for (const item of (parsed as Record<string, unknown>).mappings as unknown[]) {
                if (isMappingEntry(item)) {
                    out.push(item)
                }
            }
        }
        else {
            for (const [key, val] of Object.entries(parsed)) {
                if (typeof val === 'string') {
                    out.push({ sourceExternalId: key, destExternalId: val })
                }
                else if (typeof val === 'object' && val !== null) {
                    out.push({ sourceExternalId: key, ...(val as object) })
                }
            }
        }
    }
}

function isMappingEntry(value: unknown): value is ConnectionMappingSchema {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        && typeof (value as { sourceExternalId?: unknown }).sourceExternalId === 'string'
}

/**
 * Every string leaf under a mapping's `value` is a credential the operator supplied via
 * `--connection-bootstrap` or a mapping file. They are collected so they can be scrubbed from
 * anything the command prints. Duplicates are collapsed so a credential repeated across mappings is
 * only searched for once.
 */
export function collectSecretValues(mappings: ConnectionMappingSchema[]): string[] {
    const secrets = new Set<string>()
    for (const mapping of mappings) {
        if (mapping.value === undefined) continue
        for (const leaf of stringLeaves(mapping.value)) {
            if (leaf.length > 0) secrets.add(leaf)
        }
    }
    return [...secrets]
}

function stringLeaves(value: unknown): string[] {
    if (typeof value === 'string') return [value]
    if (Array.isArray(value)) return value.flatMap(stringLeaves)
    if (typeof value === 'object' && value !== null) {
        return Object.values(value).flatMap(stringLeaves)
    }
    return []
}

export function redactSecrets(text: string, secrets: string[]): string {
    let result = text
    for (const secret of secrets) {
        if (secret.length === 0) continue
        result = result.split(secret).join(REDACTED)
    }
    return result
}

/**
 * Rebuilds a console argument with every string inside it scrubbed. Non-string arguments matter as
 * much as string ones: the widest leak path is `console.error('...', serverResponse)`, where a
 * destination that echoes the submitted bootstrap back inside a validation error would otherwise
 * print the credential verbatim. A new value is produced rather than mutating the caller's object.
 */
function scrubValue(value: unknown, secrets: string[]): unknown {
    if (typeof value === 'string') return redactSecrets(value, secrets)
    if (Array.isArray(value)) return value.map(item => scrubValue(item, secrets))
    if (value instanceof Error) return value
    if (typeof value === 'object' && value !== null) {
        const result: Record<string, unknown> = {}
        for (const [key, item] of Object.entries(value)) {
            result[key] = scrubValue(item, secrets)
        }
        return result
    }
    return value
}

/**
 * Wraps the console writers for the lifetime of the command so a credential cannot escape through
 * any print path — including the `--json` echo of a destination response that quotes the submitted
 * bootstrap payload back. Returns a restore function.
 */
export function installSecretRedaction(secrets: string[]): () => void {
    if (secrets.length === 0) return () => {}
    const originals = {
        log: console.log,
        error: console.error,
        warn: console.warn,
    }
    const scrub = (args: unknown[]): unknown[] => args.map(arg => scrubValue(arg, secrets))

    console.log = (...args: unknown[]) => originals.log(...scrub(args))
    console.error = (...args: unknown[]) => originals.error(...scrub(args))
    console.warn = (...args: unknown[]) => originals.warn(...scrub(args))

    return () => {
        console.log = originals.log
        console.error = originals.error
        console.warn = originals.warn
    }
}

type FetchResult<T> = { ok: boolean, status: number, data: T }

async function fetchJson<T>(url: string, init: RequestInit, deps: ProjectReplaceDeps): Promise<FetchResult<T>> {
    try {
        const res = await deps.fetch(url, init)
        const text = await res.text()
        let parsed: unknown
        try {
            parsed = JSON.parse(text)
        }
        catch {
            parsed = text
        }
        return { ok: res.ok, status: res.status, data: parsed as T }
    }
    catch (err) {
        throw new Error(`Transport error calling ${url}: ${(err as Error).message}`)
    }
}
