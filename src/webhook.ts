import { logger } from './logger'

const WEBHOOK_URL = process.env.WEBHOOK_URL
const WEBHOOK_USER = process.env.WEBHOOK_USER
const WEBHOOK_PASSWORD = process.env.WEBHOOK_PASSWORD

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
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        }

        if (WEBHOOK_USER && WEBHOOK_PASSWORD) {
            const encoded = Buffer.from(`${WEBHOOK_USER}:${WEBHOOK_PASSWORD}`).toString('base64')
            headers['Authorization'] = `Basic ${encoded}`
        }

        const res = await fetch(WEBHOOK_URL, {
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
