import { ActivepiecesError, ErrorCode, isNil } from '@inboxfm-connect/core-utils'
import { FastifyInstance, FastifyRequest } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { z } from 'zod'
import { securityAccess } from '../../core/security/authorization/fastify-security'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'
import { appsumoService } from './appsumo.service'

export const appSumoModule: FastifyPluginAsyncZod = async (app) => {
    await app.register(appsumoController, { prefix: '/v1/appsumo' })
}

function getAppsumoToken(): string {
    const token = system.get(AppSystemProp.APPSUMO_TOKEN)
    if (isNil(token)) {
        throw new ActivepiecesError({
            code: ErrorCode.SYSTEM_PROP_NOT_DEFINED,
            params: { prop: 'APPSUMO_TOKEN' },
        })
    }
    return token
}

const token = getAppsumoToken()
const exchangeCredentialUsername = token
const exchangeCredentialPassword = token

const ActionRequest = z.object({
    action: z.string(),
    plan_id: z.string(),
    uuid: z.string(),
    activation_email: z.string(),
})

type ActionRequest = z.infer<typeof ActionRequest>

const ExchangeTokenRequest = z.object({
    username: z.string(),
    password: z.string(),
})
type ExchangeTokenRequest = z.infer<typeof ExchangeTokenRequest>

const AuthorizationHeaders = z.object({
    authorization: z.string(),
})
type AuthorizationHeaders = z.infer<typeof AuthorizationHeaders>

const appsumoController: FastifyPluginAsyncZod = async (
    fastify: FastifyInstance,
) => {
    fastify.post(
        '/token',
        {
            config: {
                security: securityAccess.public(),
            },
            schema: {
                body: ExchangeTokenRequest,
            },
        },
        async (
            request: FastifyRequest<{
                Body: ExchangeTokenRequest
            }>,
            reply,
        ) => {
            if (
                request.body.username === exchangeCredentialUsername &&
        request.body.password === exchangeCredentialPassword
            ) {
                return reply.status(StatusCodes.OK).send({
                    access: token,
                })
            }
            else {
                return reply.status(StatusCodes.UNAUTHORIZED).send()
            }
        },
    )

    fastify.post(
        '/action',
        {
            config: {
                security: securityAccess.public(),
            },
            schema: {
                headers: AuthorizationHeaders,
                body: ActionRequest,
            },
        },
        async (
            request: FastifyRequest<{
                Headers: AuthorizationHeaders
                Body: ActionRequest
            }>,
            reply,
        ) => {
            if (request.headers.authorization != `Bearer ${token}`) {
                return reply.status(StatusCodes.UNAUTHORIZED).send()
            }
            else {
                const { plan_id, action, uuid, activation_email } = request.body
                await appsumoService(request.log).handleRequest({
                    plan_id,
                    action,
                    uuid,
                    activation_email,
                })
                switch (action) {
                    case 'activate':
                        return reply.status(StatusCodes.CREATED).send({
                            redirect_url:
                'https://cloud.activepieces.com/sign-up?email=' +
                encodeURIComponent(activation_email),
                            message: 'success',
                        })
                    default:
                        return reply.status(StatusCodes.OK).send({
                            message: 'success',
                        })
                }
            }
        },
    )
}
