import { describe, expect, it } from 'vitest'
import { FlowActionType } from '../../src/lib/flows/actions/action'
import { FlowTrigger, FlowTriggerType } from '../../src/lib/flows/triggers/trigger'
import {
    FLOW_CANVAS_STEP_WIDTH,
    flowCanvasUtils,
} from '../../src/lib/flows/util/flow-canvas-util'

/**
 * Issue #141 asked for "meaningful coverage on variable resolution + step execution paths" in the
 * core libraries. Neither a variable resolver nor a step executor exists in this fork (the execution
 * package is types plus flow operations), so the closest real target is the flow canvas layout
 * engine: pure geometry that positions every step, recursing through loops, routers and
 * continue-on-failure branches. It was entirely untested, and a sign or off-by-one error in it
 * silently corrupts the layout of every flow a user opens.
 *
 * The assertions pin observable contract (step count, relative ordering, non-overlap) rather than
 * absolute pixel values, so a deliberate layout change is a visible diff rather than 40 failures.
 */

type MinimalAction = {
    name: string
    type: FlowActionType
    nextAction?: unknown
    children?: unknown[]
    firstLoopAction?: unknown
    settings?: unknown
    continueOnFailureBranches?: { onSuccess?: unknown, onFailure?: unknown }
}

// `settings` (and `settings.errorHandlingOptions`) are required on PieceAction/CodeAction by the
// schema in flows/actions/action.ts, and `hasContinueOnFailureBranches` dereferences them
// unguarded, so the fixtures below mirror the minimal schema-valid shape rather than a partial step.
const MINIMAL_SETTINGS = { errorHandlingOptions: {} }

function piece(name: string, next?: unknown): MinimalAction {
    return { name, type: FlowActionType.PIECE, nextAction: next, settings: MINIMAL_SETTINGS }
}

function code(name: string, next?: unknown): MinimalAction {
    return { name, type: FlowActionType.CODE, nextAction: next, settings: MINIMAL_SETTINGS }
}

function router(name: string, children: unknown[], next?: unknown): MinimalAction {
    return { name, type: FlowActionType.ROUTER, children, nextAction: next }
}

function loop(name: string, firstLoopAction: unknown, next?: unknown): MinimalAction {
    return { name, type: FlowActionType.LOOP_ON_ITEMS, firstLoopAction, nextAction: next }
}

// A flow's first step is a trigger, and its discriminator is FlowTriggerType.PIECE
// ('PIECE_TRIGGER') — not FlowActionType.PIECE ('PIECE'). That difference matters: the
// continue-on-failure guard only inspects settings for CODE/PIECE *action* types, so a real trigger
// short-circuits before touching settings. Using the action literal here would fabricate a crash
// that cannot happen in production.
function trigger(next: unknown): FlowTrigger {
    return {
        name: 'trigger',
        type: FlowTriggerType.PIECE,
        settings: { propertySettings: {}, pieceName: '@inboxfm-connect/piece-manual-trigger', pieceVersion: '1.0.0', input: {} },
        nextAction: next,
    } as unknown as FlowTrigger
}

function emptyTrigger(): FlowTrigger {
    return { name: 'trigger', type: FlowTriggerType.EMPTY, settings: {} } as unknown as FlowTrigger
}

function withContinueOnFailure(step: MinimalAction, onSuccess?: unknown, onFailure?: unknown): MinimalAction {
    return {
        ...step,
        settings: { errorHandlingOptions: { continueOnFailure: { value: true } } },
        continueOnFailureBranches: { onSuccess, onFailure },
    }
}
describe('flowCanvasUtils.computeStepPositions', () => {
    it('positions a single step and returns a map keyed by step name', () => {
        const positions = flowCanvasUtils.computeStepPositions(trigger(piece('only')))

        // The trigger itself is part of the layout, above the first action.
        expect(positions.size).toBe(2)
        expect(positions.has('trigger')).toBe(true)
        const only = positions.get('only')
        expect(only).toBeDefined()
        expect(only!.x).toBe(FLOW_CANVAS_STEP_WIDTH / 2)
        expect(only!.y).toBeGreaterThan(positions.get('trigger')!.y)
    })

    it('handles a trigger with no next action without throwing', () => {
        const positions = flowCanvasUtils.computeStepPositions(trigger(undefined))

        expect(positions.size).toBe(1)
        expect(positions.has('trigger')).toBe(true)
    })

    it('lays out an empty trigger, which is how a brand-new flow looks', () => {
        const positions = flowCanvasUtils.computeStepPositions(emptyTrigger())

        expect(positions.has('trigger')).toBe(true)
        expect(positions.get('trigger')!.y).toBe(0)
    })

    it('places a linear chain top-to-bottom, each step one row below the previous', () => {
        const positions = flowCanvasUtils.computeStepPositions(
            trigger(piece('a', piece('b', piece('c')))),
        )

        expect(positions.size).toBe(4)
        expect(positions.get('trigger')!.y).toBe(0)
        expect(positions.get('a')!.y).toBeGreaterThan(positions.get('trigger')!.y)
        expect(positions.get('b')!.y).toBeGreaterThan(positions.get('a')!.y)
        expect(positions.get('c')!.y).toBeGreaterThan(positions.get('b')!.y)
        // A plain chain stays on the centre line.
        expect(positions.get('b')!.x).toBe(positions.get('a')!.x)
        expect(positions.get('c')!.x).toBe(positions.get('a')!.x)
    })

    it('keeps a loop child strictly below its parent and below the loop', () => {
        const positions = flowCanvasUtils.computeStepPositions(
            trigger(piece('before', loop('l', piece('inner', piece('inner2')), piece('after')))),
        )

        expect(positions.size).toBe(6)
        const parent = positions.get('l')!
        const inner = positions.get('inner')!
        const after = positions.get('after')!

        expect(inner.y).toBeGreaterThan(parent.y)
        expect(after.y).toBeGreaterThan(inner.y)
        expect(inner.x).not.toBe(parent.x)
    })

    it('indents loop children to the right of the loop step', () => {
        const positions = flowCanvasUtils.computeStepPositions(
            trigger(loop('l', piece('inner'), piece('after'))),
        )

        expect(positions.get('inner')!.x).toBeGreaterThan(positions.get('l')!.x)
        // The step after the loop returns to the centre line.
        expect(positions.get('after')!.x).toBe(positions.get('l')!.x)
    })

    it('tolerates an empty loop with no first action', () => {
        const positions = flowCanvasUtils.computeStepPositions(
            trigger(loop('l', undefined, piece('after'))),
        )

        expect(positions.has('l')).toBe(true)
        expect(positions.has('after')).toBe(true)
        expect(positions.get('after')!.y).toBeGreaterThan(positions.get('l')!.y)
    })

    it('places router children side by side without overlapping horizontally', () => {
        const positions = flowCanvasUtils.computeStepPositions(
            trigger(router('r', [piece('c1'), piece('c2'), piece('c3')], piece('after'))),
        )

        expect(positions.size).toBe(6)
        const xs = ['c1', 'c2', 'c3'].map(n => positions.get(n)!.x)
        const sorted = [...xs].sort((a, b) => a - b)
        expect(sorted).toEqual(xs)
        // Each child is a full step width clear of the previous one.
        expect(sorted[1] - sorted[0]).toBeGreaterThanOrEqual(FLOW_CANVAS_STEP_WIDTH)
        expect(sorted[2] - sorted[1]).toBeGreaterThanOrEqual(FLOW_CANVAS_STEP_WIDTH)
    })

    it('tolerates a router with zero children', () => {
        const positions = flowCanvasUtils.computeStepPositions(
            trigger(router('r', [], piece('after'))),
        )

        expect(positions.has('r')).toBe(true)
        expect(positions.get('after')!.y).toBeGreaterThan(positions.get('r')!.y)
    })

    it('centres a single router child on the router', () => {
        const positions = flowCanvasUtils.computeStepPositions(
            trigger(router('r', [piece('only')])),
        )

        expect(positions.get('only')!.x).toBe(positions.get('r')!.x)
    })

    it('handles a deeply nested loop-inside-router without losing a step', () => {
        const positions = flowCanvasUtils.computeStepPositions(
            trigger(router('r', [
                loop('l1', piece('i1', loop('l2', piece('i2')))),
                piece('c2'),
            ], piece('after'))),
        )

        for (const name of ['trigger', 'r', 'l1', 'i1', 'l2', 'i2', 'c2', 'after']) {
            expect(positions.has(name), `missing step ${name}`).toBe(true)
        }
        expect(positions.size).toBe(8)
        expect(positions.get('i2')!.y).toBeGreaterThan(positions.get('l2')!.y)
    })

    it('never returns a non-finite coordinate', () => {
        const positions = flowCanvasUtils.computeStepPositions(
            trigger(router('r', [loop('l', piece('i')), piece('c')], piece('after'))),
        )

        for (const [name, pos] of positions) {
            expect(Number.isFinite(pos.x), `x not finite for ${name}`).toBe(true)
            expect(Number.isFinite(pos.y), `y not finite for ${name}`).toBe(true)
        }
    })
})

describe('flowCanvasUtils.hasContinueOnFailureBranches', () => {
    it('is false for a step without the setting', () => {
        expect(flowCanvasUtils.hasContinueOnFailureBranches(piece('p') as never)).toBe(false)
    })

    it('is true only for code/piece steps with continueOnFailure enabled', () => {
        expect(flowCanvasUtils.hasContinueOnFailureBranches(withContinueOnFailure(piece('p')) as never)).toBe(true)
        expect(flowCanvasUtils.hasContinueOnFailureBranches(withContinueOnFailure(code('c')) as never)).toBe(true)
    })

    it('is false for a non-action step type even if settings claim it', () => {
        // A router cannot carry continue-on-failure; trusting the flag would mis-branch the layout.
        const spoofed = { ...withContinueOnFailure(piece('p')), type: FlowActionType.ROUTER }
        expect(flowCanvasUtils.hasContinueOnFailureBranches(spoofed as never)).toBe(false)
    })

    it('is false when the setting exists but is disabled', () => {
        const step = { ...piece('p'), settings: { errorHandlingOptions: { continueOnFailure: { value: false } } } }
        expect(flowCanvasUtils.hasContinueOnFailureBranches(step as never)).toBe(false)
    })
})

describe('flowCanvasUtils.getContinueOnFailureBranchPair', () => {
    it('returns both branches in on-success, on-failure order', () => {
        const onSuccess = piece('s')
        const onFailure = piece('f')
        const step = withContinueOnFailure(piece('p'), onSuccess, onFailure)

        const [first, second] = flowCanvasUtils.getContinueOnFailureBranchPair(step as never)
        expect(first).toBe(onSuccess)
        expect(second).toBe(onFailure)
    })

    it('returns undefined entries rather than throwing when a branch is missing', () => {
        const step = withContinueOnFailure(piece('p'), piece('s'))
        const [first, second] = flowCanvasUtils.getContinueOnFailureBranchPair(step as never)

        expect(first).toBeDefined()
        expect(second).toBeUndefined()
    })
})

describe('flowCanvasUtils.getStepBranchRelativeTo', () => {
    it('returns null for an ancestor without continue-on-failure branches', () => {
        expect(flowCanvasUtils.getStepBranchRelativeTo(piece('p') as never, 'target')).toBeNull()
    })

    it('identifies a step nested inside the on-success branch', () => {
        const step = withContinueOnFailure(piece('p'), piece('s', piece('deep')), piece('f'))

        expect(flowCanvasUtils.getStepBranchRelativeTo(step as never, 'deep')).toBe('on-success')
    })

    it('identifies a step nested inside the on-failure branch', () => {
        const step = withContinueOnFailure(piece('p'), piece('s'), piece('f', piece('boom')))

        expect(flowCanvasUtils.getStepBranchRelativeTo(step as never, 'boom')).toBe('on-failure')
    })

    it('returns null for a step that is in neither branch', () => {
        const step = withContinueOnFailure(piece('p'), piece('s'), piece('f'))

        expect(flowCanvasUtils.getStepBranchRelativeTo(step as never, 'unrelated')).toBeNull()
    })

    it('returns null rather than throwing when only one branch exists and the target is absent', () => {
        const step = withContinueOnFailure(piece('p'), piece('s'))

        expect(flowCanvasUtils.getStepBranchRelativeTo(step as never, 'unrelated')).toBeNull()
    })
})

describe('flowCanvasUtils.computeRouterChildOffsets', () => {
    it('returns an empty array for no children', () => {
        expect(flowCanvasUtils.computeRouterChildOffsets([])).toEqual([])
    })

    it('returns a single offset for a single child', () => {
        const offsets = flowCanvasUtils.computeRouterChildOffsets([{ width: 100, left: 0, right: 100 }])
        expect(offsets).toHaveLength(1)
        expect(Number.isFinite(offsets[0])).toBe(true)
    })

    it('separates consecutive children by exactly the branch gap', () => {
        const branchGap = 20
        const boxes = [
            { width: 100, left: 0, right: 100 },
            { width: 100, left: 0, right: 100 },
            { width: 100, left: 0, right: 100 },
        ]
        const offsets = flowCanvasUtils.computeRouterChildOffsets(boxes, branchGap)

        expect(offsets[1] - offsets[0]).toBe(100 + branchGap)
        expect(offsets[2] - offsets[1]).toBe(100 + branchGap)
    })

    it('respects a child whose box does not start at zero', () => {
        const offsets = flowCanvasUtils.computeRouterChildOffsets([{ width: 50, left: 25, right: 75 }])
        expect(offsets[0]).toBe(25)
    })
})
