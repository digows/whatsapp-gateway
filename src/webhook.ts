import { logger } from './logger'

const WEBHOOK_URL = process.env.WEBHOOK_URL
const WEBHOOK_STATUS_URL = process.env.WEBHOOK_STATUS_URL
const WEBHOOK_USER = process.env.WEBHOOK_USER
const WEBHOOK_PASSWORD = process.env.WEBHOOK_PASSWORD

interface WebhookPayload {
    sessionId: string
    event: string
    data: Record<string, unknown>
}

/**
 * Dispatches an event payload to the configured WEBHOOK_URL or WEBHOOK_STATUS_URL.
 * Silently logs errors instead of crashing the session.
 */
export async function dispatchWebhook(payload: WebhookPayload): Promise<void> {
    const isStatusEvent = payload.event.startsWith('connection.')
    const targetUrl = isStatusEvent ? WEBHOOK_STATUS_URL : WEBHOOK_URL

    if (!targetUrl) {
        // Only warn if it's the main messages webhook missing. Status webhooks are strictly optional.
        if (!isStatusEvent) {
            logger.warn('WEBHOOK_URL not configured – skipping dispatch')
        }
        return
    }

    try {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        }

        if (WEBHOOK_USER && WEBHOOK_PASSWORD) {
            const encoded = Buffer.from(`${WEBHOOK_USER}:${WEBHOOK_PASSWORD}`).toString('base64')
            headers['Authorization'] = `Basic ${encoded}`
        }

        const res = await fetch(targetUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
        })

        if (!res.ok) {
            logger.error(
                { status: res.status, body: await res.text().catch(() => '') },
                `Webhook dispatch failed for session ${payload.sessionId}`
            )
        } else {
            logger.debug({ sessionId: payload.sessionId, event: payload.event }, 'Webhook dispatched')
        }
    } catch (err) {
        logger.error({ err, sessionId: payload.sessionId }, 'Webhook dispatch error')
    }
}
