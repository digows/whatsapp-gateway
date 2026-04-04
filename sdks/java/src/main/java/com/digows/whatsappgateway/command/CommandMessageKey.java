package com.digows.whatsappgateway.command;

import com.digows.whatsappgateway.messaging.MessageReference;

/**
 * Lightweight message locator used by command families that target or mutate existing messages.
 * Timestamp is required only by actions that depend on Baileys `MinimalMessage` semantics.
 */
public record CommandMessageKey(
  MessageReference reference,
  Long timestamp,
  Boolean fromMe
)
{
}

