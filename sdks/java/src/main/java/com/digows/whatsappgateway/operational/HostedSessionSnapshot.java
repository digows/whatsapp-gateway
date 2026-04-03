package com.digows.whatsappgateway.operational;

public record HostedSessionSnapshot(
  SessionReference session,
  SessionStatus status,
  String workerId,
  String hostedAt,
  String updatedAt,
  String reason
)
{
}
