import { logger } from './logger'

const WEBHOOK_URL = process.env.WEBHOOK_URL

interface WebhookPayload {
    sessionId: string
    event: string
    data: Record<string, unknown>
}

/**
 * Dispatches an event payload to the configured WEBHOOK_URL (typically n8n).
 * Silently logs errors instead of crashing the session.
 */
export async function dispatchWebhook(payload: WebhookPayload): Promise<void> {
    if (!WEBHOOK_URL) {
        logger.warn('WEBHOOK_URL not configured – skipping dispatch')
        return
    }

    try {
        const res = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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
