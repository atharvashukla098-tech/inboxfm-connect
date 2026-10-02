import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Mustache from 'mustache'
import { describe, expect, it } from 'vitest'
import { getEmailSubject } from '../../../../../src/app/ee/helper/email/email-sender/smtp-email-sender'
import { buildEmailSubject } from '../../../../../src/app/helper/email/smtp-email-sender'

// The subject an invitee actually receives is built in TypeScript, while the copy they read is
// built in the HTML template's <title>. Both said `invited to "<project>" project` while the
// template said `invited to the "<project>" project`, so the fix had to land in two languages and
// the existing copy guard only read the HTML. These tests assert the three sources agree, which
// fails the moment any one of them drifts.
const TEMPLATE = 'invitation-email'
const PROJECT_NAME = 'Acme Platform'

describe('invitation email subject (issue #355)', () => {
    it('reads "invited to the <project> project"', () => {
        const subject = buildEmailSubject({ template: TEMPLATE, vars: { projectName: PROJECT_NAME } })
        expect(subject).toContain(`invited to the "${PROJECT_NAME}" project`)
    })

    it('keeps the CE sender, the EE sender and the HTML <title> in agreement', () => {
        const ce = buildEmailSubject({ template: TEMPLATE, vars: { projectName: PROJECT_NAME } })
        const ee = getEmailSubject(TEMPLATE, { projectName: PROJECT_NAME })
        const title = titleOf(renderTemplate())

        expect(ce).toBe(ee)
        expect(ce).toBe(title)
    })

    it('keeps the project-member-added subject in agreement across editions', () => {
        const ce = buildEmailSubject({ template: 'project-member-added', vars: { projectName: PROJECT_NAME } })
        const ee = getEmailSubject('project-member-added', { projectName: PROJECT_NAME })
        expect(ce).toBe(ee)
    })
})

function renderTemplate(): string {
    return Mustache.render(readTemplate(), { projectName: PROJECT_NAME })
}

function readTemplate(): string {
    return readFileSync(resolve(__dirname, '../../../../../src/assets/emails', `${TEMPLATE}.html`), 'utf-8')
}

function titleOf(html: string): string {
    return /<title>([\s\S]*?)<\/title>/.exec(html)?.[1].trim() ?? ''
}