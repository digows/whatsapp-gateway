# Java SDK

This module provides the public Java integration contract for the Digows WhatsApp Gateway.

Package base:

- `com.digows.whatsappgateway`

It contains:

- durable session models
- activation models and activation lifecycle events
- messaging models and inbound/delivery events
- request models for the public REST API

It does not contain:

- Baileys internals
- Redis, PostgreSQL or NATS infrastructure implementations
- control-plane internals

## Coordinates

```xml
<dependency>
  <groupId>com.digows.whatsappgateway</groupId>
  <artifactId>java-whatsappgateway-sdk</artifactId>
  <version>0.1.0-SNAPSHOT</version>
</dependency>
```

## GitHub Packages Consumption

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
