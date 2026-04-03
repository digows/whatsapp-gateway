package com.digows.whatsappgateway.operational;

public record SessionReference(
  String provider,
  int workspaceId,
  String sessionId
)
{
  public SessionReference
  {
    if (provider == null || provider.isBlank())
    {
      throw new IllegalArgumentException("SessionReference requires a non-empty provider.");
    }

    if (workspaceId <= 0)
    {
      throw new IllegalArgumentException("SessionReference requires a positive workspaceId.");
    }

    if (sessionId == null || sessionId.isBlank())
    {
      throw new IllegalArgumentException("SessionReference requires a non-empty sessionId.");
    }
  }

  public String toKey()
  {
    return provider + ":" + workspaceId + ":" + sessionId;
  }

  public String toLogLabel()
  {
    return provider + " session " + sessionId + " (WS: " + workspaceId + ")";
  }
}
