# Java SDK

This module provides the public Java integration contract for the Digows WhatsApp Gateway.

Package base:

- `com.digows.whatsappgateway`

It contains:

- durable session models
- activation models and activation lifecycle events
- messaging models and inbound/delivery events
- request models for the public REST API

Inbound lifecycle exposed by the SDK:

- `message.created`
- `message.updated`
- `message.deleted`

Reaction changes are represented as `MessageUpdatedEvent` with
`MessageUpdateKind.REACTION`, `reactionText` and `reactionRemoved`.

For `MessageUpdatedEvent` and `MessageDeletedEvent`, `targetMessage` identifies the logical
WhatsApp message affected by the lifecycle transition. When `MessageUpdatedEvent.message` is
present, its timestamp reflects the WhatsApp/Baileys `messageTimestamp` from the update payload.

It does not contain:

- Baileys internals
- Redis, PostgreSQL or NATS infrastructure implementations
- control-plane internals

## Coordinates

Published package base:

- `com.digows.whatsappgateway`

GitHub Packages Maven coordinates:

```xml
<dependency>
  <groupId>com.digows.whatsappgateway</groupId>
  <artifactId>java-whatsappgateway-sdk</artifactId>
  <version>0.1.0-SNAPSHOT</version>
</dependency>
```

## JitPack Consumption

For public consumption without Maven credentials, use JitPack.

Add the repository:

```xml
<repositories>
  <repository>
    <id>jitpack.io</id>
    <url>https://jitpack.io</url>
  </repository>
</repositories>
```

Add the dependency. For JitPack, the version is the Git tag or commit hash. Example:

```xml
<dependency>
  <groupId>com.github.digows</groupId>
  <artifactId>whatsapp-gateway</artifactId>
  <version>2.0.3</version>
</dependency>
```

JitPack exposes the SDK with repository-based coordinates. The Java package base inside the jar still remains `com.digows.whatsappgateway`.

The repository root contains [jitpack.yml](/Volumes/Files/Development/workspaces/digows/whatsapp-gateway/jitpack.yml), so JitPack builds this module from [/sdks/java](/Volumes/Files/Development/workspaces/digows/whatsapp-gateway/sdks/java).

## GitHub Packages Consumption

For controlled internal consumption, the repository CI also publishes the SDK to GitHub Packages.

Add the GitHub Packages Maven repository:

```xml
<repositories>
  <repository>
    <id>github</id>
    <url>https://maven.pkg.github.com/digows/whatsapp-gateway</url>
  </repository>
</repositories>
```

GitHub Packages Maven consumption requires credentials. Configure Maven `settings.xml` with the same repository id:

```xml
<settings>
  <servers>
    <server>
      <id>github</id>
      <username>YOUR_GITHUB_USERNAME</username>
      <password>YOUR_GITHUB_CLASSIC_PAT_WITH_READ_PACKAGES</password>
    </server>
  </servers>
</settings>
```

## Local Build

```bash
mvn clean test
```

## GitHub Packages Publishing

The CI publishes the SDK to GitHub Packages on pushes to `main`.

The publish job uses the repository `GITHUB_TOKEN` and the Maven repository id `github`.

## Notes

GitHub Packages Maven downloads still require credentials, even when the repository itself is public. Use a GitHub personal access token (classic) with at least `read:packages` for local consumption.
