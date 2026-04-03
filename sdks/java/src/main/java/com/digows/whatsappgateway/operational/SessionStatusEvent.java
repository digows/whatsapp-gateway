package com.digows.whatsappgateway.operational;

public record SessionStatusEvent(
  SessionReference session,
  SessionStatus status,
  String timestamp,
  String workerId,
  String reason
)
{
}
