package com.digows.whatsappgateway.messaging;

import com.digows.whatsappgateway.operational.SessionReference;

public record DeliveryResult(
  String commandId,
  SessionReference session,
  String recipientId,
  DeliveryStatus status,
  String timestamp,
  String providerMessageId,
  String reason
)
{
}
