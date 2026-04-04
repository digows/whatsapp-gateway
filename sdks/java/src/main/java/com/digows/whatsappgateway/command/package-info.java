/**
 * Outbound command families exposed by the gateway on family-specific NATS command subjects.
 * <p>
 * Commands are modeled at the gateway contract level instead of mirroring Baileys internal helper methods.
 * The family/action pair is the stable integration boundary.
 */
package com.digows.whatsappgateway.command;
