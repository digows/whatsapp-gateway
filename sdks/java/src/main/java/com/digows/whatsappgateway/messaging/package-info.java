/**
 * Messaging integration contracts published by the WhatsApp Gateway.
 * <p>
 * The package exposes two complementary layers:
 * <ul>
 *   <li>{@link com.digows.whatsappgateway.messaging.Message} and {@link com.digows.whatsappgateway.messaging.MessageContent}
 *   define the normalized WhatsApp payload model.</li>
 *   <li>{@link com.digows.whatsappgateway.messaging.InboundEvent} defines the message lifecycle
 *   observed by the gateway: creation, update and deletion. Reaction changes are represented as
 *   {@link com.digows.whatsappgateway.messaging.MessageUpdatedEvent} with
 *   {@link com.digows.whatsappgateway.messaging.MessageUpdateKind#REACTION}.</li>
 * </ul>
 * Consumers should treat lifecycle from {@code InboundEvent} as the primary source of truth and
 * use content polymorphism only to inspect the actual message payload.
 */
package com.digows.whatsappgateway.messaging;
