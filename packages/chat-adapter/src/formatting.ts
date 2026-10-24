import type { Choice } from "@digows/whatsapp-gateway-contracts";
import {
  type AdapterPostableMessage,
  type CardChild,
  type CardElement,
  convertEmojiPlaceholders,
  type FormattedContent,
  getNodeChildren,
  getNodeValue,
  isCardElement,
  parseMarkdown,
  toCardElement,
} from "chat";
type MarkdownNode = ReturnType<typeof getNodeChildren>[number];
function renderNode(node: MarkdownNode): string
{
  const children = (): string => getNodeChildren(node).map(renderNode).join("");
  switch (node.type)
  {
    case "text":
      return getNodeValue(node);
    case "strong":
      return `*${children()}*`;
    case "emphasis":
      return `_${children()}_`;
    case "delete":
      return `~${children()}~`;
    case "inlineCode":
      return "`" + getNodeValue(node) + "`";
    case "code":
      return "```\n" + getNodeValue(node) + "\n```\n\n";
    case "paragraph":
      return children() + "\n\n";
    case "heading":
      return `*${children()}*\n\n`;
    case "break":
      return "\n";
    case "link":
      return children() === node.url ? node.url : `${children()} (${node.url})`;
    case "blockquote":
      return children().trimEnd().split("\n").map(line => "> " + line).join("\n") + "\n\n";
    case "list":
      return node.children.map((item, index) =>
        `${node.ordered ? `${(node.start ?? 1) + index}.` : "-"} ${renderNode(item).trimEnd()}`
      ).join("\n") + "\n\n";
    case "listItem":
      return children();
    case "thematicBreak":
      return "────────\n\n";
    default:
      throw new Error(`Markdown ${node.type} has no qualified WhatsApp rendering`);
  }
}
export function renderWhatsAppFormatted(content: FormattedContent): string
{
  return convertEmojiPlaceholders(content.children.map(renderNode).join("").trimEnd(), "whatsapp");
}
export function postableText(message: AdapterPostableMessage): string | undefined
{
  if (typeof message === "string") return convertEmojiPlaceholders(message, "whatsapp");
  if ("raw" in message) return convertEmojiPlaceholders(message.raw, "whatsapp");
  if ("markdown" in message) return renderWhatsAppFormatted(parseMarkdown(message.markdown));
  if ("ast" in message) return renderWhatsAppFormatted(message.ast);
  return undefined;
}
export interface GatewayCardProjection
{
  readonly text: string;
  readonly choices: Choice[];
  readonly imageUrl?: string;
}
export function projectCard(message: AdapterPostableMessage): GatewayCardProjection
{
  const candidate = typeof message === "object" && "card" in message ? message.card : message;
  const card: CardElement | null = isCardElement(candidate) ? candidate : toCardElement(candidate);
  if (!card) throw new Error("Unsupported Chat SDK card");
  const texts: string[] = [];
  const choices: Choice[] = [];
  let imageUrl = card.imageUrl;
  if (card.title) texts.push(`*${card.title}*`);
  if (card.subtitle) texts.push(card.subtitle);
  const visit = (child: CardChild): void =>
  {
    switch (child.type)
    {
      case "text":
        texts.push(child.style === "bold" ? `*${child.content}*` : child.content);
        break;
      case "section":
        child.children.forEach(visit);
        break;
      case "divider":
        texts.push("────────");
        break;
      case "image":
        if (imageUrl) throw new Error("A gateway reply card supports one image");
        imageUrl = child.url;
        break;
      case "actions":
        for (const action of child.children)
        {
          if (
            action.type !== "button" || action.actionType === "modal" || action.disabled || action.callbackUrl
            || action.visibleTo?.length
          )
          {
            throw new Error("This card action has no qualified WhatsApp control");
          }
          choices.push({ id: encodeGatewayAction(action.id, action.value), label: action.label });
        }
        break;
      case "link":
        texts.push(`${child.label} (${child.url})`);
        break;
      default:
        throw new Error(`Card ${child.type} has no qualified WhatsApp control`);
    }
  };
  card.children.forEach(visit);
  if (!choices.length) throw new Error("A gateway reply card requires reply choices");
  return { text: texts.join("\n\n"), choices, ...(imageUrl ? { imageUrl } : {}) };
}
export function encodeGatewayAction(id: string, value?: string): string
{
  return "chat-action:" + Buffer.from(JSON.stringify([id, value ?? null])).toString("base64url");
}
export interface GatewayAction
{
  readonly id: string;
  readonly value?: string;
}
export function decodeGatewayAction(value: string): GatewayAction
{
  if (!value.startsWith("chat-action:")) return { id: value };
  const parsed: unknown = JSON.parse(Buffer.from(value.slice(12), "base64url").toString());
  if (
    !Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "string"
    || (parsed[1] !== null && typeof parsed[1] !== "string")
  ) throw new Error("Invalid gateway action correlation");
  if (encodeGatewayAction(parsed[0], parsed[1] ?? undefined) !== value)
  {
    throw new Error("Invalid gateway action encoding");
  }
  return { id: parsed[0], ...(parsed[1] === null ? {} : { value: parsed[1] }) };
}
