import { MessageReference } from '../messaging/MessageReference.js';
import { SessionReference } from '../operational/SessionReference.js';

export enum OutboundCommandFamily {
  Message = 'message',
  Presence = 'presence',
  Read = 'read',
  Chat = 'chat',
  Group = 'group',
  Community = 'community',
  Newsletter = 'newsletter',
  Profile = 'profile',
  Privacy = 'privacy',
  Call = 'call',
}

export function parseOutboundCommandFamily(value: string): OutboundCommandFamily {
  switch (value) {
    case OutboundCommandFamily.Message:
      return OutboundCommandFamily.Message;
    case OutboundCommandFamily.Presence:
      return OutboundCommandFamily.Presence;
    case OutboundCommandFamily.Read:
      return OutboundCommandFamily.Read;
    case OutboundCommandFamily.Chat:
      return OutboundCommandFamily.Chat;
    case OutboundCommandFamily.Group:
      return OutboundCommandFamily.Group;
    case OutboundCommandFamily.Community:
      return OutboundCommandFamily.Community;
    case OutboundCommandFamily.Newsletter:
      return OutboundCommandFamily.Newsletter;
    case OutboundCommandFamily.Profile:
      return OutboundCommandFamily.Profile;
    case OutboundCommandFamily.Privacy:
      return OutboundCommandFamily.Privacy;
    case OutboundCommandFamily.Call:
      return OutboundCommandFamily.Call;
    default:
      throw new Error(`Unsupported outbound command family "${value}".`);
  }
}

export interface OutboundCommand {
  readonly commandId: string;
  readonly session: SessionReference;
  readonly family: OutboundCommandFamily;
  readonly action: string;
}

export class CommandMessageKey {
  constructor(
    public readonly reference: MessageReference,
    public readonly timestamp?: number,
    public readonly fromMe?: boolean,
  ) {}
}

export enum PresenceType {
  Unavailable = 'unavailable',
  Available = 'available',
  Composing = 'composing',
  Recording = 'recording',
  Paused = 'paused',
}

export function parsePresenceType(value: string): PresenceType {
  switch (value) {
    case PresenceType.Unavailable:
      return PresenceType.Unavailable;
    case PresenceType.Available:
      return PresenceType.Available;
    case PresenceType.Composing:
      return PresenceType.Composing;
    case PresenceType.Recording:
      return PresenceType.Recording;
    case PresenceType.Paused:
      return PresenceType.Paused;
    default:
      throw new Error(`Unsupported presence type "${value}".`);
  }
}

export enum PresenceCommandAction {
  Subscribe = 'subscribe',
  Update = 'update',
}

export function parsePresenceCommandAction(value: string): PresenceCommandAction {
  switch (value) {
    case PresenceCommandAction.Subscribe:
      return PresenceCommandAction.Subscribe;
    case PresenceCommandAction.Update:
      return PresenceCommandAction.Update;
    default:
      throw new Error(`Unsupported presence command action "${value}".`);
  }
}

export class PresenceCommand implements OutboundCommand {
  public readonly family = OutboundCommandFamily.Presence;

  constructor(
    public readonly commandId: string,
    public readonly session: SessionReference,
    public readonly action: PresenceCommandAction,
    public readonly chatId: string,
    public readonly presence?: PresenceType,
  ) {}
}

export enum ReadCommandAction {
  ReadMessages = 'read_messages',
  SendReceipt = 'send_receipt',
}

export function parseReadCommandAction(value: string): ReadCommandAction {
  switch (value) {
    case ReadCommandAction.ReadMessages:
      return ReadCommandAction.ReadMessages;
    case ReadCommandAction.SendReceipt:
      return ReadCommandAction.SendReceipt;
    default:
      throw new Error(`Unsupported read command action "${value}".`);
  }
}

export enum MessageReceiptType {
  Read = 'read',
  ReadSelf = 'read-self',
  HistorySync = 'hist_sync',
  PeerMessage = 'peer_msg',
  Sender = 'sender',
  Inactive = 'inactive',
  Played = 'played',
}

export function parseMessageReceiptType(value: string): MessageReceiptType {
  switch (value) {
    case MessageReceiptType.Read:
      return MessageReceiptType.Read;
    case MessageReceiptType.ReadSelf:
      return MessageReceiptType.ReadSelf;
    case MessageReceiptType.HistorySync:
      return MessageReceiptType.HistorySync;
    case MessageReceiptType.PeerMessage:
      return MessageReceiptType.PeerMessage;
    case MessageReceiptType.Sender:
      return MessageReceiptType.Sender;
    case MessageReceiptType.Inactive:
      return MessageReceiptType.Inactive;
    case MessageReceiptType.Played:
      return MessageReceiptType.Played;
    default:
      throw new Error(`Unsupported message receipt type "${value}".`);
  }
}

export class ReadCommand implements OutboundCommand {
  public readonly family = OutboundCommandFamily.Read;

  constructor(
    public readonly commandId: string,
    public readonly session: SessionReference,
    public readonly action: ReadCommandAction,
    public readonly messages: readonly CommandMessageKey[] = [],
    public readonly chatId?: string,
    public readonly participantId?: string,
    public readonly messageIds: readonly string[] = [],
    public readonly receiptType?: MessageReceiptType,
  ) {}
}

export enum ChatCommandAction {
  Archive = 'archive',
  Unarchive = 'unarchive',
  Pin = 'pin',
  Unpin = 'unpin',
  Mute = 'mute',
  Unmute = 'unmute',
  Clear = 'clear',
  DeleteForMe = 'delete_for_me',
  DeleteChat = 'delete_chat',
  MarkRead = 'mark_read',
  MarkUnread = 'mark_unread',
  Star = 'star',
  Unstar = 'unstar',
}

export function parseChatCommandAction(value: string): ChatCommandAction {
  switch (value) {
    case ChatCommandAction.Archive:
      return ChatCommandAction.Archive;
    case ChatCommandAction.Unarchive:
      return ChatCommandAction.Unarchive;
    case ChatCommandAction.Pin:
      return ChatCommandAction.Pin;
    case ChatCommandAction.Unpin:
      return ChatCommandAction.Unpin;
    case ChatCommandAction.Mute:
      return ChatCommandAction.Mute;
    case ChatCommandAction.Unmute:
      return ChatCommandAction.Unmute;
    case ChatCommandAction.Clear:
      return ChatCommandAction.Clear;
    case ChatCommandAction.DeleteForMe:
      return ChatCommandAction.DeleteForMe;
    case ChatCommandAction.DeleteChat:
      return ChatCommandAction.DeleteChat;
    case ChatCommandAction.MarkRead:
      return ChatCommandAction.MarkRead;
    case ChatCommandAction.MarkUnread:
      return ChatCommandAction.MarkUnread;
    case ChatCommandAction.Star:
      return ChatCommandAction.Star;
    case ChatCommandAction.Unstar:
      return ChatCommandAction.Unstar;
    default:
      throw new Error(`Unsupported chat command action "${value}".`);
  }
}

export class ChatCommand implements OutboundCommand {
  public readonly family = OutboundCommandFamily.Chat;

  constructor(
    public readonly commandId: string,
    public readonly session: SessionReference,
    public readonly action: ChatCommandAction,
    public readonly chatId: string,
    public readonly lastMessages: readonly CommandMessageKey[] = [],
    public readonly targetMessage?: CommandMessageKey,
    public readonly messageReferences: readonly CommandMessageKey[] = [],
    public readonly muteDurationMs?: number | null,
    public readonly deleteMedia?: boolean,
    public readonly deleteTimestamp?: number,
  ) {}
}

export enum ParticipantAction {
  Add = 'add',
  Remove = 'remove',
  Promote = 'promote',
  Demote = 'demote',
  Modify = 'modify',
}

export function parseParticipantAction(value: string): ParticipantAction {
  switch (value) {
    case ParticipantAction.Add:
      return ParticipantAction.Add;
    case ParticipantAction.Remove:
      return ParticipantAction.Remove;
    case ParticipantAction.Promote:
      return ParticipantAction.Promote;
    case ParticipantAction.Demote:
      return ParticipantAction.Demote;
    case ParticipantAction.Modify:
      return ParticipantAction.Modify;
    default:
      throw new Error(`Unsupported participant action "${value}".`);
  }
}

export enum GroupJoinRequestAction {
  Approve = 'approve',
  Reject = 'reject',
}

export function parseGroupJoinRequestAction(value: string): GroupJoinRequestAction {
  switch (value) {
    case GroupJoinRequestAction.Approve:
      return GroupJoinRequestAction.Approve;
    case GroupJoinRequestAction.Reject:
      return GroupJoinRequestAction.Reject;
    default:
      throw new Error(`Unsupported group join request action "${value}".`);
  }
}

export enum GroupSettingValue {
  Announcement = 'announcement',
  NotAnnouncement = 'not_announcement',
  Locked = 'locked',
  Unlocked = 'unlocked',
}

export function parseGroupSettingValue(value: string): GroupSettingValue {
  switch (value) {
    case GroupSettingValue.Announcement:
      return GroupSettingValue.Announcement;
    case GroupSettingValue.NotAnnouncement:
      return GroupSettingValue.NotAnnouncement;
    case GroupSettingValue.Locked:
      return GroupSettingValue.Locked;
    case GroupSettingValue.Unlocked:
      return GroupSettingValue.Unlocked;
    default:
      throw new Error(`Unsupported group setting value "${value}".`);
  }
}

export enum GroupMemberAddMode {
  AdminAdd = 'admin_add',
  AllMemberAdd = 'all_member_add',
}

export function parseGroupMemberAddMode(value: string): GroupMemberAddMode {
  switch (value) {
    case GroupMemberAddMode.AdminAdd:
      return GroupMemberAddMode.AdminAdd;
    case GroupMemberAddMode.AllMemberAdd:
      return GroupMemberAddMode.AllMemberAdd;
    default:
      throw new Error(`Unsupported group member-add mode "${value}".`);
  }
}

export enum GroupJoinApprovalMode {
  On = 'on',
  Off = 'off',
}

export function parseGroupJoinApprovalMode(value: string): GroupJoinApprovalMode {
  switch (value) {
    case GroupJoinApprovalMode.On:
      return GroupJoinApprovalMode.On;
    case GroupJoinApprovalMode.Off:
      return GroupJoinApprovalMode.Off;
    default:
      throw new Error(`Unsupported group join-approval mode "${value}".`);
  }
}

export enum GroupCommandAction {
  Metadata = 'metadata',
  Create = 'create',
  Leave = 'leave',
  UpdateSubject = 'update_subject',
  UpdateDescription = 'update_description',
  InviteCode = 'invite_code',
  RevokeInvite = 'revoke_invite',
  AcceptInvite = 'accept_invite',
  GetInviteInfo = 'get_invite_info',
  ParticipantsUpdate = 'participants_update',
  RequestParticipantsList = 'request_participants_list',
  RequestParticipantsUpdate = 'request_participants_update',
  ToggleEphemeral = 'toggle_ephemeral',
  SettingUpdate = 'setting_update',
  MemberAddMode = 'member_add_mode',
  JoinApprovalMode = 'join_approval_mode',
  FetchAllParticipating = 'fetch_all_participating',
}

export function parseGroupCommandAction(value: string): GroupCommandAction {
  switch (value) {
    case GroupCommandAction.Metadata:
      return GroupCommandAction.Metadata;
    case GroupCommandAction.Create:
      return GroupCommandAction.Create;
    case GroupCommandAction.Leave:
      return GroupCommandAction.Leave;
    case GroupCommandAction.UpdateSubject:
      return GroupCommandAction.UpdateSubject;
    case GroupCommandAction.UpdateDescription:
      return GroupCommandAction.UpdateDescription;
    case GroupCommandAction.InviteCode:
      return GroupCommandAction.InviteCode;
    case GroupCommandAction.RevokeInvite:
      return GroupCommandAction.RevokeInvite;
    case GroupCommandAction.AcceptInvite:
      return GroupCommandAction.AcceptInvite;
    case GroupCommandAction.GetInviteInfo:
      return GroupCommandAction.GetInviteInfo;
    case GroupCommandAction.ParticipantsUpdate:
      return GroupCommandAction.ParticipantsUpdate;
    case GroupCommandAction.RequestParticipantsList:
      return GroupCommandAction.RequestParticipantsList;
    case GroupCommandAction.RequestParticipantsUpdate:
      return GroupCommandAction.RequestParticipantsUpdate;
    case GroupCommandAction.ToggleEphemeral:
      return GroupCommandAction.ToggleEphemeral;
    case GroupCommandAction.SettingUpdate:
      return GroupCommandAction.SettingUpdate;
    case GroupCommandAction.MemberAddMode:
      return GroupCommandAction.MemberAddMode;
    case GroupCommandAction.JoinApprovalMode:
      return GroupCommandAction.JoinApprovalMode;
    case GroupCommandAction.FetchAllParticipating:
      return GroupCommandAction.FetchAllParticipating;
    default:
      throw new Error(`Unsupported group command action "${value}".`);
  }
}

export class GroupCommand implements OutboundCommand {
  public readonly family = OutboundCommandFamily.Group;

  constructor(
    public readonly commandId: string,
    public readonly session: SessionReference,
    public readonly action: GroupCommandAction,
    public readonly groupJid?: string,
    public readonly subject?: string,
    public readonly description?: string,
    public readonly participants: readonly string[] = [],
    public readonly participantAction?: ParticipantAction,
    public readonly requestAction?: GroupJoinRequestAction,
    public readonly inviteCode?: string,
    public readonly ephemeralExpiration?: number,
    public readonly setting?: GroupSettingValue,
    public readonly memberAddMode?: GroupMemberAddMode,
    public readonly joinApprovalMode?: GroupJoinApprovalMode,
  ) {}
}

export enum CommunityCommandAction {
  Metadata = 'metadata',
  Create = 'create',
  CreateGroup = 'create_group',
  Leave = 'leave',
  UpdateSubject = 'update_subject',
  UpdateDescription = 'update_description',
  LinkGroup = 'link_group',
  UnlinkGroup = 'unlink_group',
  FetchLinkedGroups = 'fetch_linked_groups',
  RequestParticipantsList = 'request_participants_list',
  RequestParticipantsUpdate = 'request_participants_update',
  ParticipantsUpdate = 'participants_update',
  InviteCode = 'invite_code',
  RevokeInvite = 'revoke_invite',
  AcceptInvite = 'accept_invite',
  GetInviteInfo = 'get_invite_info',
  ToggleEphemeral = 'toggle_ephemeral',
  SettingUpdate = 'setting_update',
  MemberAddMode = 'member_add_mode',
  JoinApprovalMode = 'join_approval_mode',
  FetchAllParticipating = 'fetch_all_participating',
}

export function parseCommunityCommandAction(value: string): CommunityCommandAction {
  switch (value) {
    case CommunityCommandAction.Metadata:
      return CommunityCommandAction.Metadata;
    case CommunityCommandAction.Create:
      return CommunityCommandAction.Create;
    case CommunityCommandAction.CreateGroup:
      return CommunityCommandAction.CreateGroup;
    case CommunityCommandAction.Leave:
      return CommunityCommandAction.Leave;
    case CommunityCommandAction.UpdateSubject:
      return CommunityCommandAction.UpdateSubject;
    case CommunityCommandAction.UpdateDescription:
      return CommunityCommandAction.UpdateDescription;
    case CommunityCommandAction.LinkGroup:
      return CommunityCommandAction.LinkGroup;
    case CommunityCommandAction.UnlinkGroup:
      return CommunityCommandAction.UnlinkGroup;
    case CommunityCommandAction.FetchLinkedGroups:
      return CommunityCommandAction.FetchLinkedGroups;
    case CommunityCommandAction.RequestParticipantsList:
      return CommunityCommandAction.RequestParticipantsList;
    case CommunityCommandAction.RequestParticipantsUpdate:
      return CommunityCommandAction.RequestParticipantsUpdate;
    case CommunityCommandAction.ParticipantsUpdate:
      return CommunityCommandAction.ParticipantsUpdate;
    case CommunityCommandAction.InviteCode:
      return CommunityCommandAction.InviteCode;
    case CommunityCommandAction.RevokeInvite:
      return CommunityCommandAction.RevokeInvite;
    case CommunityCommandAction.AcceptInvite:
      return CommunityCommandAction.AcceptInvite;
    case CommunityCommandAction.GetInviteInfo:
      return CommunityCommandAction.GetInviteInfo;
    case CommunityCommandAction.ToggleEphemeral:
      return CommunityCommandAction.ToggleEphemeral;
    case CommunityCommandAction.SettingUpdate:
      return CommunityCommandAction.SettingUpdate;
    case CommunityCommandAction.MemberAddMode:
      return CommunityCommandAction.MemberAddMode;
    case CommunityCommandAction.JoinApprovalMode:
      return CommunityCommandAction.JoinApprovalMode;
    case CommunityCommandAction.FetchAllParticipating:
      return CommunityCommandAction.FetchAllParticipating;
    default:
      throw new Error(`Unsupported community command action "${value}".`);
  }
}

export class CommunityCommand implements OutboundCommand {
  public readonly family = OutboundCommandFamily.Community;

  constructor(
    public readonly commandId: string,
    public readonly session: SessionReference,
    public readonly action: CommunityCommandAction,
    public readonly communityJid?: string,
    public readonly subject?: string,
    public readonly description?: string,
    public readonly groupJid?: string,
    public readonly participants: readonly string[] = [],
    public readonly participantAction?: ParticipantAction,
    public readonly requestAction?: GroupJoinRequestAction,
    public readonly inviteCode?: string,
    public readonly ephemeralExpiration?: number,
    public readonly setting?: GroupSettingValue,
    public readonly memberAddMode?: GroupMemberAddMode,
    public readonly joinApprovalMode?: GroupJoinApprovalMode,
  ) {}
}

export enum NewsletterLookupType {
  Invite = 'invite',
  Jid = 'jid',
}

export function parseNewsletterLookupType(value: string): NewsletterLookupType {
  switch (value) {
    case NewsletterLookupType.Invite:
      return NewsletterLookupType.Invite;
    case NewsletterLookupType.Jid:
      return NewsletterLookupType.Jid;
    default:
      throw new Error(`Unsupported newsletter lookup type "${value}".`);
  }
}

export enum NewsletterCommandAction {
  Create = 'create',
  Update = 'update',
  Subscribers = 'subscribers',
  Metadata = 'metadata',
  Follow = 'follow',
  Unfollow = 'unfollow',
  Mute = 'mute',
  Unmute = 'unmute',
  ReactMessage = 'react_message',
  FetchMessages = 'fetch_messages',
  SubscribeUpdates = 'subscribe_updates',
  AdminCount = 'admin_count',
  ChangeOwner = 'change_owner',
  Demote = 'demote',
  Delete = 'delete',
}

export function parseNewsletterCommandAction(value: string): NewsletterCommandAction {
  switch (value) {
    case NewsletterCommandAction.Create:
      return NewsletterCommandAction.Create;
    case NewsletterCommandAction.Update:
      return NewsletterCommandAction.Update;
    case NewsletterCommandAction.Subscribers:
      return NewsletterCommandAction.Subscribers;
    case NewsletterCommandAction.Metadata:
      return NewsletterCommandAction.Metadata;
    case NewsletterCommandAction.Follow:
      return NewsletterCommandAction.Follow;
    case NewsletterCommandAction.Unfollow:
      return NewsletterCommandAction.Unfollow;
    case NewsletterCommandAction.Mute:
      return NewsletterCommandAction.Mute;
    case NewsletterCommandAction.Unmute:
      return NewsletterCommandAction.Unmute;
    case NewsletterCommandAction.ReactMessage:
      return NewsletterCommandAction.ReactMessage;
    case NewsletterCommandAction.FetchMessages:
      return NewsletterCommandAction.FetchMessages;
    case NewsletterCommandAction.SubscribeUpdates:
      return NewsletterCommandAction.SubscribeUpdates;
    case NewsletterCommandAction.AdminCount:
      return NewsletterCommandAction.AdminCount;
    case NewsletterCommandAction.ChangeOwner:
      return NewsletterCommandAction.ChangeOwner;
    case NewsletterCommandAction.Demote:
      return NewsletterCommandAction.Demote;
    case NewsletterCommandAction.Delete:
      return NewsletterCommandAction.Delete;
    default:
      throw new Error(`Unsupported newsletter command action "${value}".`);
  }
}

export class NewsletterCommand implements OutboundCommand {
  public readonly family = OutboundCommandFamily.Newsletter;

  constructor(
    public readonly commandId: string,
    public readonly session: SessionReference,
    public readonly action: NewsletterCommandAction,
    public readonly newsletterJid?: string,
    public readonly name?: string,
    public readonly description?: string,
    public readonly pictureUrl?: string,
    public readonly lookupType?: NewsletterLookupType,
    public readonly lookupKey?: string,
    public readonly serverId?: string,
    public readonly reactionText?: string,
    public readonly count?: number,
    public readonly since?: number,
    public readonly after?: number,
    public readonly newOwnerJid?: string,
    public readonly userJid?: string,
  ) {}
}

export enum ProfilePictureType {
  Preview = 'preview',
  Image = 'image',
}

export function parseProfilePictureType(value: string): ProfilePictureType {
  switch (value) {
    case ProfilePictureType.Preview:
      return ProfilePictureType.Preview;
    case ProfilePictureType.Image:
      return ProfilePictureType.Image;
    default:
      throw new Error(`Unsupported profile picture type "${value}".`);
  }
}

export enum BlockAction {
  Block = 'block',
  Unblock = 'unblock',
}

export function parseBlockAction(value: string): BlockAction {
  switch (value) {
    case BlockAction.Block:
      return BlockAction.Block;
    case BlockAction.Unblock:
      return BlockAction.Unblock;
    default:
      throw new Error(`Unsupported block action "${value}".`);
  }
}

export interface MediaDimensions {
  readonly width: number;
  readonly height: number;
}

export enum ProfileCommandAction {
  ProfilePictureUrl = 'profile_picture_url',
  UpdateProfilePicture = 'update_profile_picture',
  RemoveProfilePicture = 'remove_profile_picture',
  UpdateProfileStatus = 'update_profile_status',
  UpdateProfileName = 'update_profile_name',
  UpdateBlockStatus = 'update_block_status',
  FetchBlocklist = 'fetch_blocklist',
  FetchStatus = 'fetch_status',
  FetchDisappearingDuration = 'fetch_disappearing_duration',
  GetBusinessProfile = 'get_business_profile',
}

export function parseProfileCommandAction(value: string): ProfileCommandAction {
  switch (value) {
    case ProfileCommandAction.ProfilePictureUrl:
      return ProfileCommandAction.ProfilePictureUrl;
    case ProfileCommandAction.UpdateProfilePicture:
      return ProfileCommandAction.UpdateProfilePicture;
    case ProfileCommandAction.RemoveProfilePicture:
      return ProfileCommandAction.RemoveProfilePicture;
    case ProfileCommandAction.UpdateProfileStatus:
      return ProfileCommandAction.UpdateProfileStatus;
    case ProfileCommandAction.UpdateProfileName:
      return ProfileCommandAction.UpdateProfileName;
    case ProfileCommandAction.UpdateBlockStatus:
      return ProfileCommandAction.UpdateBlockStatus;
    case ProfileCommandAction.FetchBlocklist:
      return ProfileCommandAction.FetchBlocklist;
    case ProfileCommandAction.FetchStatus:
      return ProfileCommandAction.FetchStatus;
    case ProfileCommandAction.FetchDisappearingDuration:
      return ProfileCommandAction.FetchDisappearingDuration;
    case ProfileCommandAction.GetBusinessProfile:
      return ProfileCommandAction.GetBusinessProfile;
    default:
      throw new Error(`Unsupported profile command action "${value}".`);
  }
}

export class ProfileCommand implements OutboundCommand {
  public readonly family = OutboundCommandFamily.Profile;

  constructor(
    public readonly commandId: string,
    public readonly session: SessionReference,
    public readonly action: ProfileCommandAction,
    public readonly jid?: string,
    public readonly pictureType?: ProfilePictureType,
    public readonly mediaUrl?: string,
    public readonly dimensions?: MediaDimensions,
    public readonly statusText?: string,
    public readonly profileName?: string,
    public readonly blockAction?: BlockAction,
    public readonly jids: readonly string[] = [],
  ) {}
}

export enum PrivacyValue {
  All = 'all',
  Contacts = 'contacts',
  ContactBlacklist = 'contact_blacklist',
  None = 'none',
}

export function parsePrivacyValue(value: string): PrivacyValue {
  switch (value) {
    case PrivacyValue.All:
      return PrivacyValue.All;
    case PrivacyValue.Contacts:
      return PrivacyValue.Contacts;
    case PrivacyValue.ContactBlacklist:
      return PrivacyValue.ContactBlacklist;
    case PrivacyValue.None:
      return PrivacyValue.None;
    default:
      throw new Error(`Unsupported privacy value "${value}".`);
  }
}

export enum OnlinePrivacyValue {
  All = 'all',
  MatchLastSeen = 'match_last_seen',
}

export function parseOnlinePrivacyValue(value: string): OnlinePrivacyValue {
  switch (value) {
    case OnlinePrivacyValue.All:
      return OnlinePrivacyValue.All;
    case OnlinePrivacyValue.MatchLastSeen:
      return OnlinePrivacyValue.MatchLastSeen;
    default:
      throw new Error(`Unsupported online privacy value "${value}".`);
  }
}

export enum GroupsAddPrivacyValue {
  All = 'all',
  Contacts = 'contacts',
  ContactBlacklist = 'contact_blacklist',
}

export function parseGroupsAddPrivacyValue(value: string): GroupsAddPrivacyValue {
  switch (value) {
    case GroupsAddPrivacyValue.All:
      return GroupsAddPrivacyValue.All;
    case GroupsAddPrivacyValue.Contacts:
      return GroupsAddPrivacyValue.Contacts;
    case GroupsAddPrivacyValue.ContactBlacklist:
      return GroupsAddPrivacyValue.ContactBlacklist;
    default:
      throw new Error(`Unsupported groups-add privacy value "${value}".`);
  }
}

export enum ReadReceiptsPrivacyValue {
  All = 'all',
  None = 'none',
}

export function parseReadReceiptsPrivacyValue(value: string): ReadReceiptsPrivacyValue {
  switch (value) {
    case ReadReceiptsPrivacyValue.All:
      return ReadReceiptsPrivacyValue.All;
    case ReadReceiptsPrivacyValue.None:
      return ReadReceiptsPrivacyValue.None;
    default:
      throw new Error(`Unsupported read-receipts privacy value "${value}".`);
  }
}

export enum CallPrivacyValue {
  All = 'all',
  Known = 'known',
}

export function parseCallPrivacyValue(value: string): CallPrivacyValue {
  switch (value) {
    case CallPrivacyValue.All:
      return CallPrivacyValue.All;
    case CallPrivacyValue.Known:
      return CallPrivacyValue.Known;
    default:
      throw new Error(`Unsupported call privacy value "${value}".`);
  }
}

export enum MessagesPrivacyValue {
  All = 'all',
  Contacts = 'contacts',
}

export function parseMessagesPrivacyValue(value: string): MessagesPrivacyValue {
  switch (value) {
    case MessagesPrivacyValue.All:
      return MessagesPrivacyValue.All;
    case MessagesPrivacyValue.Contacts:
      return MessagesPrivacyValue.Contacts;
    default:
      throw new Error(`Unsupported messages privacy value "${value}".`);
  }
}

export enum PrivacyCommandAction {
  FetchSettings = 'fetch_settings',
  UpdateDisableLinkPreviews = 'update_disable_link_previews',
  UpdateCallPrivacy = 'update_call_privacy',
  UpdateMessagesPrivacy = 'update_messages_privacy',
  UpdateLastSeenPrivacy = 'update_last_seen_privacy',
  UpdateOnlinePrivacy = 'update_online_privacy',
  UpdateProfilePicturePrivacy = 'update_profile_picture_privacy',
  UpdateStatusPrivacy = 'update_status_privacy',
  UpdateReadReceiptsPrivacy = 'update_read_receipts_privacy',
  UpdateGroupsAddPrivacy = 'update_groups_add_privacy',
  UpdateDefaultDisappearingMode = 'update_default_disappearing_mode',
}

export function parsePrivacyCommandAction(value: string): PrivacyCommandAction {
  switch (value) {
    case PrivacyCommandAction.FetchSettings:
      return PrivacyCommandAction.FetchSettings;
    case PrivacyCommandAction.UpdateDisableLinkPreviews:
      return PrivacyCommandAction.UpdateDisableLinkPreviews;
    case PrivacyCommandAction.UpdateCallPrivacy:
      return PrivacyCommandAction.UpdateCallPrivacy;
    case PrivacyCommandAction.UpdateMessagesPrivacy:
      return PrivacyCommandAction.UpdateMessagesPrivacy;
    case PrivacyCommandAction.UpdateLastSeenPrivacy:
      return PrivacyCommandAction.UpdateLastSeenPrivacy;
    case PrivacyCommandAction.UpdateOnlinePrivacy:
      return PrivacyCommandAction.UpdateOnlinePrivacy;
    case PrivacyCommandAction.UpdateProfilePicturePrivacy:
      return PrivacyCommandAction.UpdateProfilePicturePrivacy;
    case PrivacyCommandAction.UpdateStatusPrivacy:
      return PrivacyCommandAction.UpdateStatusPrivacy;
    case PrivacyCommandAction.UpdateReadReceiptsPrivacy:
      return PrivacyCommandAction.UpdateReadReceiptsPrivacy;
    case PrivacyCommandAction.UpdateGroupsAddPrivacy:
      return PrivacyCommandAction.UpdateGroupsAddPrivacy;
    case PrivacyCommandAction.UpdateDefaultDisappearingMode:
      return PrivacyCommandAction.UpdateDefaultDisappearingMode;
    default:
      throw new Error(`Unsupported privacy command action "${value}".`);
  }
}

export class PrivacyCommand implements OutboundCommand {
  public readonly family = OutboundCommandFamily.Privacy;

  constructor(
    public readonly commandId: string,
    public readonly session: SessionReference,
    public readonly action: PrivacyCommandAction,
    public readonly previewsDisabled?: boolean,
    public readonly callPrivacy?: CallPrivacyValue,
    public readonly messagesPrivacy?: MessagesPrivacyValue,
    public readonly lastSeenPrivacy?: PrivacyValue,
    public readonly onlinePrivacy?: OnlinePrivacyValue,
    public readonly profilePicturePrivacy?: PrivacyValue,
    public readonly statusPrivacy?: PrivacyValue,
    public readonly readReceiptsPrivacy?: ReadReceiptsPrivacyValue,
    public readonly groupsAddPrivacy?: GroupsAddPrivacyValue,
    public readonly defaultDisappearingModeSeconds?: number,
  ) {}
}

export enum CallType {
  Audio = 'audio',
  Video = 'video',
}

export function parseCallType(value: string): CallType {
  switch (value) {
    case CallType.Audio:
      return CallType.Audio;
    case CallType.Video:
      return CallType.Video;
    default:
      throw new Error(`Unsupported call type "${value}".`);
  }
}

export enum CallCommandAction {
  Reject = 'reject',
  CreateLink = 'create_link',
}

export function parseCallCommandAction(value: string): CallCommandAction {
  switch (value) {
    case CallCommandAction.Reject:
      return CallCommandAction.Reject;
    case CallCommandAction.CreateLink:
      return CallCommandAction.CreateLink;
    default:
      throw new Error(`Unsupported call command action "${value}".`);
  }
}

export class CallCommand implements OutboundCommand {
  public readonly family = OutboundCommandFamily.Call;

  constructor(
    public readonly commandId: string,
    public readonly session: SessionReference,
    public readonly action: CallCommandAction,
    public readonly callId?: string,
    public readonly callFrom?: string,
    public readonly callType?: CallType,
    public readonly startTime?: number,
    public readonly timeoutMs?: number,
  ) {}
}
