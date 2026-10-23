import type { InboundMessage } from "./inbound-message.ts";
import { type MediaReference, MediaReferenceSchema } from "./media-reference.ts";
import type { OutboundMessage } from "./outbound-message.ts";

export interface MaterializedMessageMediaPart
{
  readonly partKey: string;
  readonly media: MediaReference;
}

/** Stable JSON-pointer paths identify real stored media, including albums and nested previews. */
export function materializedMessageMediaParts(
  payload: InboundMessage | OutboundMessage,
): readonly MaterializedMessageMediaPart[]
{
  function visit(value: unknown, pointer: string): readonly MaterializedMessageMediaPart[]
  {
    if (value === null || typeof value !== "object") return [];
    const media = MediaReferenceSchema.safeParse(value);
    if (media.success) return [{ partKey: pointer, media: media.data }];
    if (Array.isArray(value))
    {
      return value.flatMap((item: unknown, index: number) => visit(item, `${pointer}/${String(index)}`));
    }
    return Object.entries(value).flatMap(([key, field]) =>
      visit(field, `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`)
    );
  }
  return visit(payload, "");
}
