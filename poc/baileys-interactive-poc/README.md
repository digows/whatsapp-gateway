# Baileys Interactive POC

This POC is isolated from the main runtime and uses:

- `baileys: github:digows/baileys`

It tests interactive payload delivery using the low-level path:

- `generateWAMessageFromContent(...)`
- `relayMessage(...)`

This is the path validated in the library source for message types that are not mapped by `sendMessage(...)` high-level content generation.

## 1) Install

```bash
cd poc/baileys-interactive-poc
npm install
cp .env.example .env
```

## 2) Authenticate session

```bash
npm run auth
```

If required, scan the QR displayed in terminal.

## 3) Send test messages

Set `WA_TARGET` in `.env` or pass `--to`.

### 0) Plain text sanity check

```bash
npm run send:test -- --to 5511999999999
```

Optional custom text:

```bash
npm run send:test -- --to 5511999999999 --text "hello from poc"
```

Optional ACK level and timeout:

```bash
npm run send:test -- --to 5511999999999 --ack delivery --ack-timeout-ms 60000
```

## 4) Send normal button (`buttonsMessage`)

```bash
npm run send:legacy:buttons -- --to 5511999999999
```

Optional text customization:

```bash
npm run send:legacy:buttons -- --to 5511999999999 --title "Menu" --body "Choose" --footer "Footer"
```

## 5) Send interactive button (carousel + nativeFlow)

```bash
npm run send:interactive:button -- --to 5511999999999
```

Optional customization:

```bash
npm run send:interactive:button -- --to 5511999999999 \
  --image "https://example.com/button-card.jpg" \
  --title "Promotion" \
  --description "Tap below" \
  --button-text "Open" \
  --button-id "promo_open_1"
```

This command uses the proven format in this POC:
- `interactiveMessage.carouselMessage`
- single card
- `nativeFlowMessage.buttons` inside the card

## 6) Send carousel (multiple cards)

```bash
npm run send:interactive:carousel -- --to 5511999999999
```

Optional custom images for carousel:

```bash
npm run send:interactive:carousel -- --to 5511999999999 --image1 "https://example.com/1.jpg" --image2 "https://example.com/2.jpg"
```

By default carousel reads image URLs from:

- `WA_CARD_IMAGE_1_URL`
- `WA_CARD_IMAGE_2_URL`

## 7) Native flow fuzz (diagnostic)

Use only for controlled tests:

```bash
npm run send:interactive:native-fuzz -- --to 5511999999999
```

Safe mode is default:
- fewer messages
- longer pauses

## Notes

- `--to` accepts either phone number digits or full JID.
- `--ack` supports: `server`, `delivery`, `read`, `played`.
- Auth files are stored in `.auth`.
- This POC does not modify the main runtime.
- Rendering depends on recipient client support and server-side policy.
