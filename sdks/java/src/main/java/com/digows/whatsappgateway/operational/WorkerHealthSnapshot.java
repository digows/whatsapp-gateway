package com.digows.whatsappgateway.operational;

public record WorkerHealthSnapshot(
  String status,
  String providerId,
  String workerId,
  boolean started,
  int hostedSessionCount,
  String checkedAt
)
{
}
