import { Boom } from '@hapi/boom'
import NodeCache from 'node-cache'
import makeWASocket, {
    CacheStore,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    useMultiFileAuthState,
    WASocket,
    proto,
    WAMessageContent,
    WAMessageKey,
    jidNormalizedUser,
} from '@whiskeysockets/baileys'
import path from 'path'
import fs from 'fs'
import { logger } from './logger'
import { dispatchWebhook } from './webhook'

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data', 'sessions')

export interface SessionInfo {
    id: string
    status: 'connecting' | 'open' | 'close' | 'qr'
    qr?: string
}

interface ManagedSession {
    socket: WASocket
    status: 'connecting' | 'open' | 'close' | 'qr'
    qr?: string
}

class SessionManager {
    private sessions = new Map<string, ManagedSession>()

    /** Returns a list of all currently tracked session IDs and their status */
    listSessions(): SessionInfo[] {
        return Array.from(this.sessions.entries()).map(([id, s]) => ({
            id,
            status: s.status,
            qr: s.qr,
        }))
    }

    /** Gets info about a specific session */
    getSession(id: string): SessionInfo | undefined {
        const s = this.sessions.get(id)
        if (!s) return undefined
        return { id, status: s.status, qr: s.qr }
    }

    /** Gets the raw WASocket for a session (used for sending messages) */
    getSocket(id: string): WASocket | undefined {
        return this.sessions.get(id)?.socket
    }

    /** Starts (or restarts) a session for the given ID */
    async startSession(id: string): Promise<SessionInfo> {
        // If session already running and open, just return info
        const existing = this.sessions.get(id)
        if (existing && existing.status === 'open') {
            return { id, status: 'open' }
        }

        // Cleanup previous socket if any
        if (existing) {
            try {
                existing.socket.end(undefined)
            } catch {
                // ignore
            }
            this.sessions.delete(id)
        }

        const sessionDir = path.join(DATA_DIR, id)
        fs.mkdirSync(sessionDir, { recursive: true })

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir)
        const { version } = await fetchLatestBaileysVersion()

        const msgRetryCounterCache = new NodeCache() as CacheStore

        const sock = makeWASocket({
            version,
            logger: logger.child({ session: id }) as any,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger as any),
            },
            msgRetryCounterCache,
            generateHighQualityLinkPreview: true,
            getMessage: async (_key: WAMessageKey): Promise<WAMessageContent | undefined> => {
                return proto.Message.create({})
            },
        })

        const managed: ManagedSession = {
            socket: sock,
            status: 'connecting',
        }
        this.sessions.set(id, managed)

        // Process events
        sock.ev.process(async (events) => {
            // ---- Connection Updates ----
            if (events['connection.update']) {
                const { connection, lastDisconnect, qr } = events['connection.update']

                if (qr) {
                    managed.status = 'qr'
                    managed.qr = qr
                    logger.info({ session: id }, 'QR Code received – scan to authenticate')
                }

                if (connection === 'open') {
                    managed.status = 'open'
                    managed.qr = undefined
                    logger.info({ session: id }, 'Session connected')

                    dispatchWebhook({
                        sessionId: id,
                        event: 'connection.open',
                        data: { message: 'Session connected' },
                    })
                }

                if (connection === 'close') {
                    const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
                    const shouldReconnect = statusCode !== DisconnectReason.loggedOut

                    managed.status = 'close'
                    managed.qr = undefined

                    if (shouldReconnect) {
                        logger.info({ session: id, statusCode }, 'Connection closed – reconnecting…')
                        // Small delay before reconnecting
                        setTimeout(() => this.startSession(id), 3000)
                    } else {
                        logger.warn({ session: id }, 'Session logged out – removing credentials')
                        this.sessions.delete(id)
                        // Optionally remove stored creds
                        fs.rmSync(sessionDir, { recursive: true, force: true })

                        dispatchWebhook({
                            sessionId: id,
                            event: 'connection.logout',
                            data: { message: 'Device was logged out' },
                        })
                    }
                }
            }

            // ---- Credentials Updated ----
            if (events['creds.update']) {
                await saveCreds()
            }

            // ---- Incoming Messages ----
            if (events['messages.upsert']) {
                const upsert = events['messages.upsert']
                if (upsert.type === 'notify') {
                    for (const msg of upsert.messages) {
                        // Skip messages sent by ourselves
                        if (msg.key.fromMe) continue

                        const remoteJid = msg.key.remoteJid || ''

                        // Skip Status broadcasts (Stories) to avoid flooding the webhook
                        if (remoteJid === 'status@broadcast') {
                            logger.debug({ session: id }, 'Ignored status@broadcast message')
                            continue
                        }

                        let text = ''
                        let messageType = 'NEW' // 'NEW', 'EDITED', 'REVOKED'
                        let originalMessageId = undefined

                        // Determine message type and extract correct text
                        const msgContent = msg.message
                        if (msgContent) {
                            if (msgContent.protocolMessage) {
                                const protocolMsg = msgContent.protocolMessage
                                if (protocolMsg.type === proto.Message.ProtocolMessage.Type.REVOKE) {
                                    messageType = 'REVOKED'
                                    originalMessageId = protocolMsg.key?.id || undefined
                                } else if (protocolMsg.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT) {
                                    messageType = 'EDITED'
                                    originalMessageId = protocolMsg.key?.id || undefined
                                    text = protocolMsg.editedMessage?.conversation ||
                                        protocolMsg.editedMessage?.extendedTextMessage?.text || ''
                                }
                            } else {
                                text = msgContent.conversation ||
                                    msgContent.extendedTextMessage?.text ||
                                    msgContent.imageMessage?.caption ||
                                    msgContent.videoMessage?.caption || ''
                            }
                        }

                        dispatchWebhook({
                            sessionId: id,
                            event: 'messages.upsert',
                            data: {
                                type: messageType,
                                from: remoteJid,
                                participant: msg.key.participant,
                                phoneNumber: jidNormalizedUser(msg.key.participant || remoteJid).replace(/@.*$/, ''),
                                pushName: msg.pushName || '',
                                messageId: msg.key.id || '',
                                originalMessageId,
                                text: text,
                                hasMedia: !!(
                                    msg.message?.imageMessage ||
                                    msg.message?.videoMessage ||
                                    msg.message?.audioMessage ||
                                    msg.message?.documentMessage
                                ),
                                timestamp: msg.messageTimestamp,
                                rawMessage: msg.message as Record<string, unknown>,
                            },
                        })
                    }
                }
            }
        })

        // Wait a brief moment before returning so QR / open can settle
        await new Promise((r) => setTimeout(r, 2500))

        return {
            id,
            status: managed.status,
            qr: managed.qr,
        }
    }

    /** Deletes / logs out a session */
    async deleteSession(id: string): Promise<void> {
        const managed = this.sessions.get(id)
        if (managed) {
            try {
                await managed.socket.logout()
            } catch {
                managed.socket.end(undefined)
            }
            this.sessions.delete(id)
        }

        const sessionDir = path.join(DATA_DIR, id)
        fs.rmSync(sessionDir, { recursive: true, force: true })
    }

    /** Auto-loads all sessions found in the data directory */
    async loadExistingSessions(): Promise<void> {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true })
            return
        }

        const entries = fs.readdirSync(DATA_DIR, { withFileTypes: true })
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const sessionId = entry.name
                logger.info({ session: sessionId }, 'Auto-loading existing session from disk...')
                try {
                    // Start in the background to not block the server startup
                    this.startSession(sessionId).catch(err => {
                        logger.error({ err, session: sessionId }, 'Failed to auto-load session')
                    })
                } catch (err) {
                    logger.error({ err, session: sessionId }, 'Failed to initiate auto-load')
                }
            }
        }
    }
}

// Export singleton
export const sessionManager = new SessionManager()
