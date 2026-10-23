import { z } from "zod";
import { InboundAlbumContentSchema } from "./album-content.ts";
import { InboundAudioContentSchema } from "./audio-content.ts";
import { ButtonsContentSchema } from "./buttons-content.ts";
import { InboundCardContentSchema } from "./card-content.ts";
import { InboundCarouselContentSchema } from "./carousel-content.ts";
import { ChannelSchema } from "./channel.ts";
import { ContactsContentSchema } from "./contacts-content.ts";
import { DeleteContentSchema } from "./delete-content.ts";
import { EditContentSchema } from "./edit-content.ts";
import { EventContentSchema } from "./event-content.ts";
import { InboundFileContentSchema } from "./file-content.ts";
import { InboundImageContentSchema } from "./image-content.ts";
import { LinkContentSchema } from "./link-content.ts";
import { ListContentSchema } from "./list-content.ts";
import { LocationContentSchema } from "./location-content.ts";
import { MessageContextSchema } from "./message-context.ts";
import { PollContentSchema } from "./poll-content.ts";
import { InboundReactionContentSchema } from "./reaction-content.ts";
import { SelectionContentSchema } from "./selection-content.ts";
import { InboundStickerContentSchema } from "./sticker-content.ts";
import { InboundTextContentSchema } from "./text-content.ts";
import { InboundVideoContentSchema } from "./video-content.ts";

const inboundMessageFields = {
  channel: ChannelSchema,
  receivingAddress: z.string().min(1),
  chatAddress: z.string().min(1),
  senderAddress: z.string().min(1),
  senderDisplayName: z.string().optional(),
  /** True when the receiving address was mentioned or replied to. */
  mentionsReceiver: z.boolean(),
  channelMessageId: z.string().min(1),
  occurredAt: z.iso.datetime({ offset: true }),
};

const inboundContentFields = { ...inboundMessageFields, ...MessageContextSchema.shape };

export const InboundMessageSchema = z.discriminatedUnion("contentKind", [
  InboundTextContentSchema.safeExtend(inboundContentFields),
  InboundImageContentSchema.safeExtend(inboundContentFields),
  InboundVideoContentSchema.safeExtend(inboundContentFields),
  InboundAudioContentSchema.safeExtend(inboundContentFields),
  InboundFileContentSchema.safeExtend(inboundContentFields),
  InboundStickerContentSchema.safeExtend(inboundContentFields),
  ContactsContentSchema.safeExtend(inboundContentFields),
  LocationContentSchema.safeExtend(inboundContentFields),
  PollContentSchema.safeExtend(inboundContentFields),
  EventContentSchema.safeExtend(inboundContentFields),
  ButtonsContentSchema.safeExtend(inboundContentFields),
  InboundCardContentSchema.safeExtend(inboundContentFields),
  LinkContentSchema.safeExtend(inboundContentFields),
  ListContentSchema.safeExtend(inboundContentFields),
  InboundCarouselContentSchema.safeExtend(inboundContentFields),
  InboundAlbumContentSchema.safeExtend(inboundContentFields),
  InboundReactionContentSchema.safeExtend(inboundMessageFields),
  EditContentSchema.safeExtend(inboundMessageFields),
  DeleteContentSchema.safeExtend(inboundMessageFields),
  SelectionContentSchema.safeExtend(inboundMessageFields),
  z.strictObject({ ...inboundContentFields, contentKind: z.literal("NON_TEXT"), text: z.never().optional() }),
]);

export type InboundMessage = z.infer<typeof InboundMessageSchema>;
