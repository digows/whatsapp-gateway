import Fastify from 'fastify'
import QRCode from 'qrcode'
import { sessionManager } from './sessionManager'
import { logger } from './logger'

const PORT = Number(process.env.PORT) || 3000
const HOST = process.env.HOST || '0.0.0.0'

const app = Fastify({ loggerInstance: logger as any })

// ─── Health Check ────────────────────────────────────────────────────────────

app.get('/health', async () => ({ status: 'ok' }))

// ─── List all sessions ───────────────────────────────────────────────────────

app.get('/sessions', async () => {
    return sessionManager.listSessions()
})

// ─── Get session status ──────────────────────────────────────────────────────

app.get<{ Params: { id: string } }>('/sessions/:id/status', async (req, reply) => {
    const info = sessionManager.getSession(req.params.id)
    if (!info) {
        return reply.code(404).send({ error: 'Session not found' })
    }
    return info
})

// ─── Start / Connect a session ───────────────────────────────────────────────

app.post<{ Params: { id: string } }>('/sessions/:id/start', async (req, reply) => {
    const { id } = req.params

    const info = await sessionManager.startSession(id)

    // If we have a QR code, also return it as a data-URI image for convenience
    if (info.qr) {
        const qrDataUrl = await QRCode.toDataURL(info.qr, { width: 300 })
        return reply.send({ ...info, qrImage: qrDataUrl })
    }

    return reply.send(info)
})

// ─── QR code as image (for browser / convenient scanning) ────────────────────

app.get<{ Params: { id: string } }>('/sessions/:id/qr', async (req, reply) => {
    const info = sessionManager.getSession(req.params.id)
    if (!info || !info.qr) {
        return reply.code(404).send({ error: 'No QR code available for this session' })
    }

    const qrImage = await QRCode.toBuffer(info.qr, { width: 400 })
    return reply.type('image/png').send(qrImage)
})

// ─── Send a message ──────────────────────────────────────────────────────────

interface SendBody {
    to: string
    text?: string
    image?: { url: string; caption?: string }
}

app.post<{ Params: { id: string }; Body: SendBody }>('/sessions/:id/send', async (req, reply) => {
    const { id } = req.params
    const { to, text, image } = req.body || {}

    const sock = sessionManager.getSocket(id)
    if (!sock) {
        return reply.code(404).send({ error: 'Session not found or not connected' })
    }

    const info = sessionManager.getSession(id)
    if (info?.status !== 'open') {
        return reply.code(400).send({ error: `Session is not open (status: ${info?.status})` })
    }

    // Format the recipient JID
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`

    try {
        let result
        if (image) {
            result = await sock.sendMessage(jid, {
                image: { url: image.url },
                caption: image.caption || '',
            })
        } else {
            result = await sock.sendMessage(jid, { text: text || '' })
        }

        return reply.send({
            success: true,
            messageId: result?.key?.id,
            to: jid,
        })
    } catch (err: any) {
        logger.error({ err, session: id, to: jid }, 'Failed to send message')
        return reply.code(500).send({ error: 'Failed to send message', detail: err?.message })
    }
})

// ─── Delete / Logout a session ───────────────────────────────────────────────

app.delete<{ Params: { id: string } }>('/sessions/:id', async (req, reply) => {
    await sessionManager.deleteSession(req.params.id)
    return reply.send({ success: true, message: `Session ${req.params.id} deleted` })
})

// ─── Start server ────────────────────────────────────────────────────────────

async function main() {
    try {
        await app.listen({ port: PORT, host: HOST })
        logger.info(`WhatsApp Gateway running on http://${HOST}:${PORT}`)
    } catch (err) {
        logger.error(err, 'Failed to start server')
        process.exit(1)
    }
}

main()
