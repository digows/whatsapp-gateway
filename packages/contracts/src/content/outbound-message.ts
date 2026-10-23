import { z } from "zod";
import { OutboundAlbumContentSchema } from "./album-content.ts";
import { AudioContentSchema } from "./audio-content.ts";
import { ButtonsContentSchema } from "./buttons-content.ts";
import { CardContentSchema } from "./card-content.ts";
import { CarouselContentSchema } from "./carousel-content.ts";
import { ChannelSchema } from "./channel.ts";
import { ContactsContentSchema } from "./contacts-content.ts";
import { DeleteContentSchema } from "./delete-content.ts";
import { EditContentSchema } from "./edit-content.ts";
import { EventContentSchema } from "./event-content.ts";
import { FileContentSchema } from "./file-content.ts";
import { ImageContentSchema } from "./image-content.ts";
import { LinkContentSchema } from "./link-content.ts";
import { ListContentSchema } from "./list-content.ts";
import { LocationContentSchema } from "./location-content.ts";
import { MessageContextSchema } from "./message-context.ts";
import { PollContentSchema } from "./poll-content.ts";
import { ReactionContentSchema } from "./reaction-content.ts";
import { StickerContentSchema } from "./sticker-content.ts";
import { TextContentSchema } from "./text-content.ts";
import { VideoContentSchema } from "./video-content.ts";

const outboundMessageFields = {
  channel: ChannelSchema,
  senderAddress: z.string().min(1),
  recipientAddress: z.string().min(1),
  idempotencyKey: z.string().min(1),
};

const outboundContentFields = { ...outboundMessageFields, ...MessageContextSchema.shape };

export const OutboundMessageSchema = z.discriminatedUnion("contentKind", [
  TextContentSchema.extend({
    ...outboundContentFields,
    contentKind: z.literal("TEXT"),
    text: z.string().min(1),
  }),
  ImageContentSchema.safeExtend(outboundContentFields),
  VideoContentSchema.safeExtend(outboundContentFields),
  AudioContentSchema.safeExtend(outboundContentFields),
  FileContentSchema.safeExtend(outboundContentFields),
  StickerContentSchema.safeExtend(outboundContentFields),
  ContactsContentSchema.safeExtend(outboundContentFields),
  LocationContentSchema.safeExtend(outboundContentFields),
  PollContentSchema.safeExtend(outboundContentFields),
  EventContentSchema.safeExtend(outboundContentFields),
  ButtonsContentSchema.safeExtend(outboundContentFields),
  CardContentSchema.safeExtend(outboundContentFields),
  LinkContentSchema.safeExtend(outboundContentFields),
  ListContentSchema.safeExtend(outboundContentFields),
  CarouselContentSchema.safeExtend(outboundContentFields),
  OutboundAlbumContentSchema.safeExtend(outboundContentFields),
  ReactionContentSchema.safeExtend(outboundMessageFields),
  EditContentSchema.safeExtend(outboundMessageFields),
  DeleteContentSchema.safeExtend(outboundMessageFields),
]);

export type OutboundMessage = z.infer<typeof OutboundMessageSchema>;
