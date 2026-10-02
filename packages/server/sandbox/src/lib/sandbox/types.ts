import { ChildProcess } from 'child_process'
import { EngineOperation, EngineOperationType, EngineResponse } from '@inboxfm-connect/shared'

export type SandboxMount = {
    hostPath: string
    sandboxPath: string
    optional?: boolean
}

// Only `memoryLimitMb` is applied by the process makers (`isolate.ts` passes it as both `--mem` and
// `--max-old-space-size`; `fork.ts` as `--max-old-space-size`). There is deliberately no CPU quota:
// neither backend exposes a per-process CPU-budget flag, so one was never wired up — a
// `cpuMsPerSec` field here would only promise a cap that no code applies. Wall-clock is bounded
// separately, per execution, by the `setTimeout` in `sandbox.ts#execute` from the engine's own
// `timeoutInSeconds`, not by a process flag (see the `--time` note in `isolate.ts`).
export type SandboxResourceLimits = {
    memoryLimitMb: number
    timeLimitSeconds: number
}

export type CreateSandboxProcessParams = {
    sandboxId: string
    command: string[]
    mounts: SandboxMount[]
    env: Record<string, string>
    resourceLimits: SandboxResourceLimits
}

export type SandboxProcessMaker = {
    create: (params: CreateSandboxProcessParams) => Promise<ChildProcess>
}

export type SandboxResult = EngineResponse<unknown> & {
    logs: string | undefined
}

export type Sandbox = {
    id: string
    start: (options: SandboxStartOptions) => Promise<void>
    execute: (operationType: EngineOperationType, operation: EngineOperation, options: SandboxOptions) => Promise<SandboxResult>
    shutdown: () => Promise<void>
    isReady: () => boolean
    getPid: () => number | null
    isBusy: () => boolean
}

export type SandboxStartOptions = {
    flowVersionId: string | undefined
    platformId: string
    mounts: SandboxMount[]
}

export type SandboxInitOptions = {
    env: Record<string, string>
    memoryLimitMb: number
    timeLimitSeconds: number
    reusable: boolean
    maxHttpBufferSizeBytes: number
    basePath: string
    command?: string[]
    baseMounts?: SandboxMount[]
    wsRpcPort?: number
}

export type SandboxOptions = {
    timeoutInSeconds: number
}

export type SandboxLogger = {
    info: (obj: unknown, msg?: string) => void
    debug: (obj: unknown, msg?: string) => void
    error: (obj: unknown, msg?: string) => void
    warn: (obj: unknown, msg?: string) => void
}
