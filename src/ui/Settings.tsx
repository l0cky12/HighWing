// The Settings screen (ADR 0160): fifteen pages in a sidebar tree that takes the chat list's column, in three groups (App,
// Agent, Server), each page under one header (SettingsPage.tsx); a narrow window has a bar that opens the tree as a sheet.
// General, ported from the prototype: the connection and Sign out, what shows on
// launch, updates, the local cache, older history, importing transcripts, and backups. Appearance: how the app looks on this
// computer (AppearanceSettings.tsx). Keyboard Shortcuts: every command and its keys, changed here (KeyboardSettings.tsx).
// Snapshots: the bucket Share snapshot publishes to, and the snapshots in it (SnapshotSettings.tsx, ADR 0123).
// Model: the profile's models on Hermes (ModelSettings.tsx), and Idle compaction on this computer
// (IdleCompactSettings.tsx). Providers: which providers Highwing's model lists show (ProviderVisibility.tsx, ADR 0235), the
// profile's model provider API keys on Hermes, listed, added, replaced and removed
// (ProviderSettings.tsx, ADR 0095), its subscription sign-ins (SignInSettings.tsx) and custom endpoints
// (EndpointSettings.tsx, ADR 0133). Voice: Dictation, Read aloud and voice
// conversations, and the profile's speech providers on Hermes (VoiceProviderSettings.tsx). Toolsets: which tools
// Hermes offers the model in the profile (ToolsetSettings.tsx). Memory: what Hermes remembers for the profile
// (MemorySettings.tsx). Skills: the profile's
// skills, switched and edited on Hermes (SkillSettings.tsx). Diagnostics: what the connected Hermes is and what it
// supports (Diagnostics.tsx), and Logs, this app's and the profile's Hermes logs (Logs.tsx, ADR 0087); a tab whose
// feature Hermes lacks says so in its place. Profiles: every profile on the server, made, renamed, described, given a
// model and deleted (ProfileSettings.tsx, ADR 0156).
// Profiles are switched in the list's header, not here (ADR 0001), and the list is hidden while Settings is open;
// Profiles' Open goes through the same question. The search box (Ctrl+F) shows the sections of every tab whose text holds
// what was typed (settingsSearch.ts).
import type { ToolProgress } from "../hermes/flightRecorder";
import { Fragment, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowLeft, AudioLines, Blocks, Brain, ChevronDown, Cpu, Download, KeyRound, Keyboard, Lock, LogOut, Palette, PlugZap, Puzzle, RadioTower, Search, Server, Settings2, Share2, ShieldCheck, Stethoscope, Trash2, Users, Wrench, X } from "lucide-react";
import type { MemorySource } from "../hermes/memory";
import { EditingProfile, ProfileInUse, SearchHeads, SettingsPage } from "./SettingsPage";
import type { PlatformId } from "../hermes/gateways";
import { SettingRow, SettingsSearching, SettingsSection } from "./SettingRows";
import { isZoomKey, pickApp } from "./keybindings";
import { isTextEdit } from "./editKeys";
import { trapTab } from "./modal";
import type { Chat, ConnectionStatus } from "../hermes/model";
import type { Route } from "../hermes/pipe";
import { viaLabel } from "../hermes/routes";
import { TRANSCRIPT_LIMIT_BYTES } from "../hermes/chatCache";
import { STATUS_LABEL, arrowSelect, composing, routeLabel } from "./bits";
import type { AppearanceStore, Fonts } from "./appearance";
import { AppearanceSettings } from "./AppearanceSettings";
import { KeyboardSettings } from "./KeyboardSettings";
import type { ModelSettingsApi } from "../hermes/modelSettings";
import { ProviderVisibility } from "./ProviderVisibility";
import { ModelSettings } from "./ModelSettings";
import { IdleCompactSettings } from "./IdleCompactSettings";
import { WritingModelSettings } from "./WritingModelSettings";
import { checkReadiness } from "../hermes/computerUseReadiness";
import type { ToolsetsApi } from "../hermes/toolsets";
import { ToolsetSettings, type OpenChat } from "./ToolsetSettings";
import { AllowlistSettings } from "./AllowlistSettings";
import type { AllowlistApi } from "../hermes/allowlist";
import type { MemoryApi } from "../hermes/memory";
import { MemorySettings } from "./MemorySettings";
import type { MemoryProvidersApi } from "../hermes/memoryProviders";
import { MemoryProviderSettings } from "./MemoryProviderSettings";
import type { SkillsApi } from "../hermes/skills";
import { SkillSettings } from "./SkillSettings";
import type { WritingDesk } from "../hermes/writingModel";
import { StartupSettings } from "./StartupSettings";
import { SummonSettings } from "./SummonSettings";
import { ChatSectionSettings } from "./ChatSectionSettings";
import { InboxSettings } from "./InboxSettings";
import { AskFirstSettings } from "./AskFirstSettings";
import { FollowScreenSettings } from "./FollowScreenSettings";
import { JobRunSettings } from "./JobRunSettings";
import { FollowUpSettings } from "./FollowUpSettings";
import { SpellCheckSettings } from "./SpellCheckSettings";
import { VoiceSettings, useVoiceChanges } from "./Voice";
import type { VoiceSetup } from "../hermes/pipe";
import type { VoiceSettingsApi } from "../hermes/voiceSettings";
import { VoiceProviderSettings } from "./VoiceProviderSettings";
import { LocalSttSettings } from "./LocalSttSettings";
import type { LocalSttApi } from "../hermes/localStt";
import type { SttSide, HeardTranscript } from "../hermes/sttRoute";
import { TraySettings } from "./TraySettings";
import type { TrayWiring } from "../hermes/tauriTray";
import { UpdateSettings } from "./UpdateSettings";
import { SnapshotSettings } from "./SnapshotSettings";
import type { SnapshotApi } from "../hermes/snapshots";
import { ImportSection, type ImportWiring } from "./ImportTranscripts";
import { BackupSection, type BackupWiring } from "./Backup";
import { guideUrl, type CapabilityId, type CapabilityStore } from "../hermes/capabilities";
import { CapabilityGate, DiagnosticsSettings, type OpenGuide, type WorkDispatchApi } from "./Diagnostics";
import { LogsPanel, type LogsWiring } from "./Logs";
import type { ScreenApi } from "../hermes/screen";
import { NAMED, applySearch, clearMarks, queryWords, textMatches } from "./settingsSearch";
import { ProfilePicker } from "./ProfilePicker";
import type { McpApi } from "../hermes/mcp";
import { McpSettings } from "./McpSettings";
import type { GatewaysApi } from "../hermes/gateways";
import type { GatewayRestartApi } from "../hermes/gatewayRestart";
import { GatewaySettings } from "./GatewaySettings";
import { ProviderSettings, type ProviderKeysApi } from "./ProviderSettings";
import { SignInSettings, type SignInApi } from "./SignInSettings";
import { EndpointSettings, type EndpointApi } from "./EndpointSettings";
import { useLocale } from "../i18n/locale";
import { ProfileSettings, type ProfilesWiring } from "./ProfileSettings";
import { ExtensionsSettings } from "./ExtensionsSettings";
import type { SkillCommands } from "../hermes/skillCommands";
import { errorText, formatBytes } from "../hermes/values";

type Tab = "general" | "appearance" | "keyboard" | "snapshots" | "model" | "providers" | "voice" | "toolsets" | "approvals" | "mcp" | "gateways" | "profiles" | "memory" | "skills" | "diagnostics" | "extensions";
type GenGroup = "connection" | "chats" | "launch" | "storage";
/** A section of a page that shows its sections one at a time, picked under the page in the sidebar's tree. */
type SectionItem = { id: string; label: string };
const GEN_GROUPS: SectionItem[] = [
  { id: "connection", label: "Connection" },
  { id: "chats", label: "Chats" },
  { id: "launch", label: "Launch, tray & updates" },
  { id: "storage", label: "Storage & data" },
];
/** Diagnostics' two groups (ADR 0087): what the connected Hermes supports, and the logs. */
type DiagGroup = "server" | "logs";
const DIAG_GROUPS: SectionItem[] = [
  { id: "server", label: "Server" },
  { id: "logs", label: "Logs" },
];
/** Memory's: the profile's two memory files, and its external memory provider, for the profile picked in the header. */
const MEM_GROUPS: SectionItem[] = [
  { id: "file:memory", label: "Agent notes" },
  { id: "file:profile", label: "User profile" },
  { id: "external", label: "External memory" },
];
/** Gateways': one platform at a time. */
const GW_GROUPS: SectionItem[] = [
  { id: "telegram", label: "Telegram" },
  { id: "discord", label: "Discord" },
  { id: "slack", label: "Slack" },
];
/** What each section is for, under its title. */
const SECTION_INTRO: Record<string, string> = {
  connection: "Sign in to a Hermes server, switch to another, or sign out.",
  chats: "What the chat list shows, what Enter does while Hermes replies, whether the Screen follows computer use, and spell checking.",
  launch: "What happens when the app starts and closes, and how it updates.",
  storage: "This computer's cache, older history, imported transcripts and backups.",
  "file:memory": "What Hermes noted for itself, such as facts about your setup and projects.",
  "file:profile": "What Hermes noted about you, such as your preferences and how you work.",
  external: "An external provider, such as Honcho, that keeps what the agent learns in its own store.",
  telegram: "Run Hermes from Telegram DMs, groups and topics.",
  discord: "Connect Hermes to Discord DMs, channels and threads.",
  slack: "Use Hermes from Slack DMs and channels, through a Slack app in Socket Mode.",
  server: "What the connected Hermes says about itself, and which features it supports.",
  logs: "This app's diagnostics and the profile's Hermes logs.",
};
/** What the Memory tab shows: one of the profile's two memory files, or one profile's external memory. */
type MemSel = { kind: "file"; source: MemorySource } | { kind: "profile"; name: string };
const memKey = (m: MemSel) => (m.kind === "file" ? `file:${m.source}` : `profile:${m.name}`);
const memSelOf = (id: string): MemSel => (id.startsWith("file:") ? { kind: "file", source: id.slice(5) as MemorySource } : { kind: "profile", name: id.slice(8) });
/** The sidebar's three groups (ADR 0160): this app, the agent (the profile's setup on Hermes), and the server. */
const SIDEBAR_GROUPS: { id: "app" | "agent" | "server"; tabs: Tab[] }[] = [
  { id: "app", tabs: ["general", "appearance", "keyboard", "voice", "snapshots", "extensions"] },
  { id: "agent", tabs: ["model", "providers", "toolsets", "approvals", "mcp", "gateways", "memory", "skills"] },
  { id: "server", tabs: ["profiles", "diagnostics"] },
];
/** Pages that edit the profile in use name it in their header; Memory, Skills, MCP and Gateways pick theirs. */
const IN_USE_PAGES: readonly Tab[] = ["voice", "model", "providers", "toolsets"];
/** Each tab's label is the catalogue's `settings.tabs[id]`. */
const TABS = [
  { id: "general", Icon: Settings2 },
  { id: "appearance", Icon: Palette },
  { id: "keyboard", Icon: Keyboard },
  { id: "voice", Icon: AudioLines },
  { id: "snapshots", Icon: Share2 },
  { id: "extensions", Icon: Blocks },
  { id: "model", Icon: Cpu },
  { id: "providers", Icon: KeyRound },
  { id: "toolsets", Icon: Wrench },
  { id: "approvals", Icon: ShieldCheck },
  { id: "mcp", Icon: Server },
  { id: "gateways", Icon: RadioTower },
  { id: "memory", Icon: Brain },
  { id: "skills", Icon: Puzzle },
  { id: "profiles", Icon: Users },
  { id: "diagnostics", Icon: Stethoscope },
] as const;

/** The tabs whose sections a search shows in place. */
const SEARCHED: readonly Tab[] = ["general", "appearance", "keyboard", "model", "providers", "voice", "toolsets"];
/**
 * The tabs a search names instead: each edits one thing Hermes keeps (a file, a list of entries), so it's opened to
 * search rather than mounted beside the others with its unsaved edit.
 */
const ABOUT: Partial<Record<Tab, string>> = {
  approvals: "What Hermes always allows: the commands an Approval answered Always allow, in each profile's command_allowlist, each with Remove so Hermes asks again.",
  mcp: "Tools from other programs and services Hermes connects to (MCP servers): add, edit, remove, switch, test and sign in, for each profile.",
  gateways: "Reach Hermes from Telegram, Discord or Slack: each profile's bot tokens, on/off switch, allowed users and connection status, kept on the server.",
  memory: "What Hermes remembers about you and your work between chats, changed or removed entry by entry.",
  skills: "Instructions Hermes can load for a kind of task: turn each skill on or off for the profile, and edit its SKILL.md.",
  snapshots:
    "Share snapshot's host: the S3-compatible bucket and access key this computer publishes chat pages to, tested, changed or removed. The snapshots in the bucket, with Copy link and Revoke.",
  extensions: "Optional commands and views that run in a sandbox: install the ones that come with Highwing, grant or withdraw their permissions, disable or uninstall them, and see why one stopped.",
  diagnostics:
    "The connected Hermes's version, protocol and sign-in, which features this server supports, and whether its Bot Desktop has a browser. Logs: this app's own diagnostics and the profile's Hermes logs, followed, filtered, exported, or saved as a support bundle.",
};

/** How the connection signs in, in words, for diagnostics: this app signs in only with the dashboard's username and password. */
export const signInText = (route?: Route) =>
  route?.kind === "ssh"
    ? "Dashboard username and password, through an SSH tunnel"
    : route
      ? "Dashboard username and password, at the dashboard's URL"
      : "Dashboard username and password";

const allow = (go: () => void) => go();

/** What a pull added: the older chats in Archived, and any pinned in another Hermes client, which are Active. */
function pulledText(added: Chat[]): string {
  if (!added.length) return "There were no older chats on the server.";
  const active = added.filter((c) => !c.settled).length;
  const settled = added.length - active;
  const chats = (n: number) => `${n} older ${n === 1 ? "chat" : "chats"}`;
  if (!active) return `Added ${chats(settled)} to Archived.`;
  if (!settled) return `Added ${chats(active)} to Active: ${active === 1 ? "it's" : "they're"} pinned in another Hermes client.`;
  return `Added ${chats(settled)} to Archived, and ${active} to Active: ${active === 1 ? "it's" : "they're"} pinned in another Hermes client.`;
}

export function SettingsScreen({
  status,
  route,
  unsecure,
  username,
  signsInWith,
  passwordSaved,
  headers = [],
  headersSaved = true,
  profile,
  olderPulled,
  cacheBytes,
  appearance,
  listFonts,
  tray,
  snapshots,
  showSnapshots,
  modelSettings,
  toolsets,
  allowlist,
  mcp,
  gateways,
  gatewayRestart,
  providers,
  accounts,
  openUrl = () => {},
  runningReplies = 0,
  openChat,
  memory,
  memoryProviders,
  onMemoryDirty = () => {},
  memoryDiscards = 0,
  skills,
  extensions,
  onSkillDirty = () => {},
  skillDiscards = 0,
  onClearCache,
  onPullOlder,
  onSignOut,
  onSetUp,
  onClose,
  voiceSetup,
  voiceSettings,
  onVoiceChange,
  localStt,
  transcribe,
  showVoice,
  guard = allow,
  showTextGeneration,
  writing,
  importer,
  backup,
  showMemory,
  capabilities,
  openGuide = () => {},
  showDiagnostics,
  screen,
  toolProgress,
  work,
  logs,
  connectionManager,
  listProfiles,
  profilesTab,
  defaultName,
}: {
  status: ConnectionStatus;
  route?: Route;
  unsecure: boolean;
  username: string;
  /** `token`: the connection signs in with the dashboard's session token (ADR 0058); absent, with a password. */
  signsInWith?: "token";
  /** The keyring kept the password, or the token, at sign-in. */
  passwordSaved: boolean;
  /** The names of the extra request headers the connection sends; their values are never shown. */
  headers?: string[];
  /** The keyring kept the extra headers at sign-in. */
  headersSaved?: boolean;
  profile: string;
  olderPulled: boolean;
  /** The storage the saved chat lists and Saved copies take now. */
  cacheBytes: () => number;
  appearance: AppearanceStore;
  /** The installed font families, for the font pickers. */
  listFonts: () => Promise<Fonts>;
  /** The tray icon and Close to tray; left out where there is no desktop app to ask. */
  tray?: TrayWiring;
  /** Where Share snapshot publishes, and what it published (ADR 0123); without it there is no Snapshots tab. */
  snapshots?: SnapshotApi;
  /** Set, each time anew, to show the Snapshots tab: from Share snapshot when no host is set up. */
  showSnapshots?: object;
  /** The profile's model setup on Hermes. */
  modelSettings: ModelSettingsApi;
  /** The profile's toolsets on Hermes; without it there is no Toolsets tab. */
  toolsets?: ToolsetsApi;
  /** What Hermes always allows, per profile (ADR 0236); without it there is no Approvals tab. */
  allowlist?: AllowlistApi;
  /** Each profile's MCP servers on Hermes (ADR 0121); without it there is no MCP servers tab. */
  mcp?: McpApi;
  /** Each profile's Telegram, Discord and Slack gateways on Hermes (ADR 0073, ADR 0238); without it there is no Gateways tab. */
  gateways?: GatewaysApi;
  /** Restarts a profile's gateway, beside a change it picks up only then (ADR 0205); without it there is no Restart gateway button. */
  gatewayRestart?: GatewayRestartApi;
  /** The shown profile's provider API keys on Hermes (ADR 0095); without it there is no Providers tab. */
  providers?: ProviderKeysApi;
  /** The shown profile's subscription sign-ins and custom endpoints on Hermes, in the Providers tab (ADR 0133). */
  accounts?: SignInApi & EndpointApi;
  /** Opens a page in the browser: an MCP server's or a subscription provider's sign-in. */
  openUrl?: (url: string) => Promise<void> | void;
  /** Chats of the shown profile with a reply running now. */
  runningReplies?: number;
  /** The chat in the active pane, for Toolsets' read of what it has. */
  openChat?: OpenChat;
  /** The profile's memory on Hermes; the Memory tab shows only with it. */
  memory?: MemoryApi;
  /** Each profile's external memory provider on Hermes, shown in the Memory tab under the profile's own memory. */
  memoryProviders?: MemoryProvidersApi;
  /** Called with whether the Memory tab has an unsaved edit. */
  onMemoryDirty?: (dirty: boolean) => void;
  /** Changes each time the owner discards the unsaved memory edit from App's question. */
  memoryDiscards?: number;
  /** The profile's skills on Hermes; the Skills tab shows only with it. */
  skills?: SkillsApi;
  /** Shows Settings → Extensions (ADR 0126). `skills` reads the skills offered in the profile shown, whose names win. */
  extensions?: { skills: () => Promise<SkillCommands | undefined> };
  /** Called with whether the Skills tab has an unsaved edit. */
  onSkillDirty?: (dirty: boolean) => void;
  /** Changes each time the owner discards the unsaved skill edit from App's question. */
  skillDiscards?: number;
  onClearCache: () => void;
  /** Importing transcripts into the profile shown; without it there is no Import section. */
  importer?: ImportWiring;
  /** Export and restore of what this computer keeps; without it there is no Backup section. */
  backup?: BackupWiring;
  /** Resolves to the older chats added. */
  onPullOlder: () => Promise<Chat[]>;
  onSignOut: () => Promise<void>;
  /** Opens setup again, to change the connection or give Hermes a model provider's key. */
  onSetUp?: () => void;
  onClose: () => void;
  /** The shown profile's voice set-up, for the Voice tab. */
  voiceSetup?: () => Promise<VoiceSetup>;
  /** The profile's speech providers on Hermes, picked and set up in the Voice tab. */
  voiceSettings?: VoiceSettingsApi;
  /** Calls `fn` whenever the voice set-up may have changed on Hermes; returns its unsubscribe. */
  onVoiceChange?: (fn: () => void) => () => void;
  /** Where speech to text runs, and this computer's engine and models (ADR 0065, 0067), in the Voice tab. */
  localStt?: LocalSttApi;
  /** Transcribes a recording the way Dictation does, or on one side alone, for the Voice tab's Test. */
  transcribe?: (audio: Uint8Array, mime: string, side?: SttSide, signal?: AbortSignal) => Promise<HeardTranscript>;
  /** Set, each time anew, to show the Voice tab: from a voice conversation's "Change voice settings". */
  showVoice?: object;
  /**
   * Every profile on the server (`GET /api/profiles`). With it, Skills and Memory each pick which profile they show, and
   * skills can be copied between profiles (ADR 0118).
   */
  listProfiles?: () => Promise<string[]>;
  /** Runs `go`, once the owner agrees to leave an unsaved memory or skill edit behind, if there is one. */
  guard?: (go: () => void) => void;
  /** Set, each time anew, to show the Model tab at the Text generation model: from a title that couldn't be regenerated. */
  showTextGeneration?: object;
  /** The Writing model (ADR 0209): the connection's writing desk while connected, and where its pick is kept. */
  writing?: { desk?: WritingDesk; scope: string };
  /** The saved connections (Connections.tsx `ConnectionManager`), shown first in General. */
  connectionManager?: ReactNode;
  /** Set (to a new object each time) to show the Memory tab. */
  showMemory?: object;
  /** What the connected Hermes supports; without it no tab is held back, and Diagnostics shows only Logs, if anything. */
  capabilities?: CapabilityStore;
  /** Opens a compatibility guide page in the browser. */
  openGuide?: OpenGuide;
  /** Set, each time anew, to show the Diagnostics tab, at a capability if it names one: from a screen's note. */
  showDiagnostics?: { id?: CapabilityId };
  /** The profile's Bot Desktop, for Diagnostics' browser check. */
  screen?: Pick<ScreenApi, "status" | "doctor">;
  /** Reads the profile's `display.tool_progress`, for Diagnostics' flight recorder rows (ADR 0178). */
  toolProgress?: () => Promise<ToolProgress>;
  /** The kanban plugin, for Diagnostics' Work dispatch settings. */
  work?: WorkDispatchApi;
  /** Diagnostics → Logs (ADR 0033, 0087); without it Diagnostics has no Logs. */
  logs?: LogsWiring;
  /** Settings → Profiles (ADR 0156); without it there is no Profiles tab. Settings adds where its menu's tab jumps go. */
  profilesTab?: Omit<ProfilesWiring, "showTab">;
  /** The display name Hermes keeps for `default`, for the profile pickers (ADR 0156). */
  defaultName?: string;
}) {
  const frame = useLocale().settings;
  const tabLabels = frame.tabs;
  const [bytes, setBytes] = useState(cacheBytes);
  const [confirmClear, setConfirmClear] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pulled, setPulled] = useState<string>();
  const [pullError, setPullError] = useState<string>();
  const [signingOut, setSigningOut] = useState(false);
  /** What's typed in the search box; Settings shows search results while it holds a word. */
  const [query, setQuery] = useState("");
  // The Memory tab's two parts each say whether they hold an unsaved change; the tab has one while either does.
  const memoryParts = useRef({ entries: false, providers: false });
  const onEntriesDirty = useCallback(
    (dirty: boolean) => {
      memoryParts.current.entries = dirty;
      onMemoryDirty(memoryParts.current.entries || memoryParts.current.providers);
    },
    [onMemoryDirty],
  );
  const onProvidersDirty = useCallback(
    (dirty: boolean) => {
      memoryParts.current.providers = dirty;
      onMemoryDirty(memoryParts.current.entries || memoryParts.current.providers);
    },
    [onMemoryDirty],
  );
  const [modelWrites, setModelWrites] = useState(0);
  const [tab, setTabNow] = useState<Tab>(
    showTextGeneration
      ? "model"
      : showMemory && memory
        ? "memory"
        : showDiagnostics && capabilities
          ? "diagnostics"
          : showVoice
            ? "voice"
            : showSnapshots && snapshots
              ? "snapshots"
              : "general",
  );
  const [diagGroup, setDiagGroup] = useState<DiagGroup>("server");
  // The Voice tab's set-up rows read again after a save there (or a Toolsets speech-to-text switch).
  const voiceChanges = useVoiceChanges(onVoiceChange ? { onChange: onVoiceChange } : undefined);
  // A new object each time a note asks for a capability, so the row is focused again even for the same one.
  const [diagFocus, setDiagFocus] = useState<{ id: CapabilityId } | undefined>(showDiagnostics?.id ? { id: showDiagnostics.id } : undefined);
  const [genGroup, setGenGroup] = useState<GenGroup>("connection");
  const [memSel, setMemSel] = useState<MemSel>({ kind: "file", source: "memory" });
  /** The profile whose external memory shows, picked in the header; the profile in use until another is. */
  const [memExternal, setMemExternal] = useState(profile);
  /** The Gateways platform shown, picked in the sidebar's tree, among those the server offers once read. */
  const [gwPlatform, setGwPlatform] = useState<PlatformId>("telegram");
  const [gwOffered, setGwOffered] = useState<PlatformId[]>();
  const gwShown: PlatformId = !gwOffered || gwOffered.includes(gwPlatform) ? gwPlatform : (gwOffered[0] ?? gwPlatform);
  /** Every profile's name, once the Memory tab's provider overview has read them; until then only the shown profile. */
  const [memProfiles, setMemProfiles] = useState<string[]>();
  /** Picking a memory file or profile leaves any unsaved memory edit, so it asks first, as switching tabs does. */
  const pickMem = (id: string) =>
    memKey(memSel) !== id &&
    guard(() => {
      const next = memSelOf(id);
      setMemSel(next);
      if (next.kind === "profile") setMemExternal(next.name);
    });
  // Which profile Skills and Memory each show (ADR 0118): the app's own until the owner picks another, and the app's own
  // again when the app switches profile. Picking one leaves an unsaved edit, so it asks first.
  const [profiles, setProfiles] = useState<string[]>();
  const [shownIn, setShownIn] = useState({ skills: profile, memory: profile, mcp: profile, gateways: profile, approvals: profile, of: profile });
  const tabProfile = shownIn.of === profile ? shownIn : { skills: profile, memory: profile, mcp: profile, gateways: profile, approvals: profile, of: profile };
  useEffect(() => setShownIn({ skills: profile, memory: profile, mcp: profile, gateways: profile, approvals: profile, of: profile }), [profile]);
  const connected = status === "connected";
  useEffect(() => {
    if (!listProfiles || !connected) return;
    let live = true;
    listProfiles().then(
      (names) => live && setProfiles(names),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [listProfiles, connected]);
  const pickProfile = (which: "skills" | "memory" | "mcp" | "gateways" | "approvals", p: string) =>
    p !== tabProfile[which] && guard(() => setShownIn((cur) => ({ ...(cur.of === profile ? cur : tabProfile), [which]: p })));
  const picker = (which: "skills" | "memory" | "mcp" | "gateways" | "approvals", label: string) =>
    listProfiles && <ProfilePicker value={tabProfile[which]} shown={profile} profiles={profiles} label={label} defaultName={defaultName} onPick={(p) => pickProfile(which, p)} />;
  const tabs = TABS.filter(
    (t) =>
      (t.id !== "toolsets" || toolsets) &&
      (t.id !== "approvals" || allowlist) &&
      (t.id !== "snapshots" || snapshots) &&
      (t.id !== "mcp" || mcp) &&
      (t.id !== "gateways" || gateways) &&
      (t.id !== "profiles" || profilesTab) &&
      (t.id !== "providers" || providers) &&
      (t.id !== "voice" || voiceSetup || voiceSettings || localStt) &&
      (t.id !== "memory" || memory) &&
      (t.id !== "skills" || skills) &&
      (t.id !== "diagnostics" || capabilities || logs) &&
      (t.id !== "extensions" || extensions),
  ).map((t) => ({ ...t, label: tabLabels[t.id] }));
  // Leaving the Memory or Skills tab asks first while it holds an unsaved edit.
  const setTab = (t: Tab) => t !== tab && guard(() => setTabNow(t));
  // Asked from elsewhere in the app, these end a search too.
  useEffect(() => {
    if (!showTextGeneration) return;
    setQuery("");
    setTab("model");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- open the Model tab only when a new `showTextGeneration` arrives; `setTab` is rebuilt each render, so listing it would switch back to Model on every render
  }, [showTextGeneration]);
  useEffect(() => {
    if (!showMemory || !memory) return;
    setQuery("");
    setTab("memory");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- open the Memory tab only when a new `showMemory` arrives; `setTab` is rebuilt each render, so listing it (or `memory`) would switch back to Memory on later renders
  }, [showMemory]);
  useEffect(() => {
    if (!showVoice) return;
    setQuery("");
    setTab("voice");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- open the Voice tab only when a new `showVoice` arrives; `setTab` is rebuilt each render, so listing it would switch back to Voice on every render
  }, [showVoice]);
  useEffect(() => {
    if (!showSnapshots || !snapshots) return;
    setQuery("");
    setTab("snapshots");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- open the Snapshots tab only when a new `showSnapshots` arrives; `setTab` is rebuilt each render, so listing it would switch back to Snapshots on every render
  }, [showSnapshots]);
  useEffect(() => {
    if (!showDiagnostics || !capabilities) return;
    setQuery("");
    setDiagFocus(showDiagnostics.id ? { id: showDiagnostics.id } : undefined);
    setDiagGroup("server");
    setTab("diagnostics");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- open Diagnostics only when a new `showDiagnostics` arrives; `setTab` is rebuilt each render, so listing it (or `capabilities`) would switch back to Diagnostics on later renders
  }, [showDiagnostics]);
  /** A tab's note about a feature Hermes lacks opens Diagnostics at it. */
  const toDiagnostics = (id: CapabilityId) =>
    guard(() => {
      setQuery("");
      setDiagFocus({ id });
      setDiagGroup("server");
      setTabNow("diagnostics");
    });
  /** `body`, unless the connected Hermes lacks capability `id`; then the note saying so, and nothing of `body` runs. */
  const gated = (id: CapabilityId, body: ReactNode) =>
    capabilities ? (
      <CapabilityGate store={capabilities} id={id} openGuide={openGuide} onDiagnostics={toDiagnostics}>
        {body}
      </CapabilityGate>
    ) : (
      body
    );

  const pull = async () => {
    setPulling(true);
    setPullError(undefined);
    try {
      setPulled(pulledText(await onPullOlder()));
    } catch (e) {
      setPullError(`Couldn't pull older history: ${errorText(e)}`);
    } finally {
      setPulling(false);
    }
  };

  const searchBox = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const words = queryWords(query);
  const searching = words.length > 0;
  const wordsKey = words.join(" ");
  const [found, setFound] = useState(0);
  /** A narrow window's search box shows only once opened (or while a search is on). */
  const [searchOpen, setSearchOpen] = useState(false);
  /** How many sections of each tab a search shows, for the counts beside the tabs in the tree. */
  const [matchCount, setMatchCount] = useState<Partial<Record<Tab, number>>>({});
  // The shown sections follow the text as it changes: a tab reading from Hermes fills in after the search starts.
  useLayoutEffect(() => {
    const root = resultsRef.current;
    if (!root || !wordsKey) return;
    const w = wordsKey.split(" ");
    const run = () => {
      setFound(applySearch(root, w));
      const counts: Partial<Record<Tab, number>> = {};
      for (const g of root.querySelectorAll<HTMLElement>("[data-search-group]"))
        counts[g.dataset.searchGroup as Tab] = [...g.querySelectorAll("section:not([data-search-miss])")].filter((x) => !x.parentElement?.closest("section")).length;
      for (const e of root.querySelectorAll<HTMLElement>("[data-search-elsewhere]")) counts[e.dataset.searchElsewhere as Tab] = 1;
      setMatchCount((cur) => (JSON.stringify(cur) === JSON.stringify(counts) ? cur : counts));
      // A match inside a <details> fold would be counted but unseen: open them. Settings' own (i) folds open through SettingsSearching.
      for (const d of root.querySelectorAll<HTMLDetailsElement>("details")) d.open = true;
    };
    run();
    const seen = new MutationObserver(run);
    seen.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: NAMED });
    return () => {
      seen.disconnect();
      clearMarks();
    };
  }, [wordsKey]);
  // Ctrl+F finds in Settings; the chat panes it covers aren't active, so theirs doesn't open. A dialog keeps its focus, and a
  // shortcut recorder keeps the keys it takes.
  // Escape ends a search from anywhere in Settings, not only the box: the focus is often on a result by then.
  const searchingRef = useRef(false);
  searchingRef.current = searching;
  const screenRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector('[aria-modal="true"]')) return;
      if (pickApp(e) === "find") {
        e.preventDefault();
        // A narrow window keeps the box behind an icon: open it, and it takes the focus when it shows.
        setSearchOpen(true);
        searchBox.current?.focus();
        searchBox.current?.select();
      } else if (e.key === "Escape" && searchingRef.current && !composing(e)) {
        const at = document.activeElement;
        if (at && at !== document.body && !screenRef.current?.contains(at)) return;
        e.preventDefault();
        setQuery("");
        searchBox.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  /** Starting a search leaves the tab shown, so it asks first, as switching tabs does, while that tab holds an unsaved edit. */
  const typed = (v: string) => (!searching && queryWords(v).length ? guard(() => setQuery(v)) : setQuery(v));
  /** A tab picked while searching ends the search there. */
  const pick = (t: Tab) => {
    if (!searching) return setTab(t);
    setQuery("");
    setTabNow(t);
  };
  /** What a search reads of a tab it names: Profiles' words in the language shown, with the profiles' names. */
  const aboutOf = (id: Tab) => (id === "profiles" ? `${frame.about.profiles} ${(profiles ?? []).join(" ")}` : ABOUT[id]);
  const elsewhere = tabs.filter((t) => aboutOf(t.id) && textMatches(`${t.label} ${aboutOf(t.id)}`, words));
  /** Profiles' menu: Memory or Skills, showing `name`. Leaving Profiles asks nothing, as it holds no edit. */
  const showTabFor = (t: "memory" | "skills", name: string) => {
    setShownIn((cur) => ({ ...(cur.of === profile ? cur : tabProfile), [t]: name }));
    setQuery("");
    setTabNow(t);
  };

  const generalGroups: Record<GenGroup, ReactNode> = {
    connection: (
      <>
        {connectionManager}
        <SettingsSection title="Connection in use">
          <SettingRow
            name={
              <>
                <span className={`conn-dot ${status} ${unsecure ? "unsecure" : ""}`} /> {STATUS_LABEL[status]}
              </>
            }
            hint={<span className="mono">{routeLabel(route) ?? "No address yet"}</span>}
            control={
              (unsecure || route?.via) && (
                <>
                  {unsecure && <span className="badge warn">Unsecure</span>}
                  {route?.via && (
                    <span className="badge" title={route.via.index > 0 ? "A route earlier in the list didn't answer. It's checked again now and then." : "The first route in the list"}>
                      {viaLabel(route.via)}
                      {route.via.index > 0 ? " (fallback)" : ""}
                    </span>
                  )}
                </>
              )
            }
          />
          <SettingRow
            name={
              signsInWith === "token" ? (
                "Signed in with the dashboard's session token"
              ) : (
                <>
                  Signed in as <span className="mono">{username}</span>
                </>
              )
            }
            about="signing out"
            hint={
              <>
                <KeyRound size={12} aria-hidden />{" "}
                {signsInWith === "token"
                  ? passwordSaved
                    ? "The token is saved in your system keyring. Signing out deletes it from this computer."
                    : "The system keyring couldn't save the token."
                  : passwordSaved
                    ? "The password is saved in your system keyring. Signing out deletes it."
                    : "The system keyring couldn't save the password."}
              </>
            }
            more={
              <>
                {signsInWith === "token" ? (
                  <p>
                    Signing out deletes the saved token from this computer's keyring. The token itself keeps working on the server: to revoke it, replace{" "}
                    <span className="mono">HERMES_DASHBOARD_SESSION_TOKEN</span> on the server.
                  </p>
                ) : (
                  <p>Signing out deletes the saved password from the keyring. You type it again at the next sign-in.</p>
                )}
                {headers.length > 0 && headersSaved && (
                  <p>
                    The extra request headers' values are saved in your system keyring and never shown. They stay saved when you sign out, to change or
                    remove on the sign-in screen.
                  </p>
                )}
              </>
            }
            control={
              <button
                className="btn"
                disabled={signingOut}
                onClick={async () => {
                  setSigningOut(true);
                  // Resolves without signing out when the owner chose to stay with an unsaved edit.
                  await onSignOut().finally(() => setSigningOut(false));
                }}
              >
                <LogOut size={14} /> {signingOut ? "Signing out…" : "Sign out"}
              </button>
            }
          >
            {headers.length > 0 && (
              <div className="set-hint">
                <ShieldCheck size={12} aria-hidden /> Sends {headers.length === 1 ? "an extra request header" : `${headers.length} extra request headers`}:{" "}
                {headers.map((h, i) => (
                  <span key={i}>
                    {i > 0 && ", "}
                    <span className="mono">{h}</span>
                  </span>
                ))}
                . {!headersSaved && "Their values are never shown. The system keyring couldn't save them, so you type them again at the next sign-in."}
              </div>
            )}
          </SettingRow>
          {capabilities && (
            <SettingRow
              name="Server details"
              hint="The Hermes version, protocol and sign-in, and which features this server supports."
              control={
                <button
                  className="btn"
                  onClick={() => {
                    // Server details are Diagnostics' Server group, whichever group was shown last.
                    setDiagGroup("server");
                    pick("diagnostics");
                  }}
                >
                  <Stethoscope size={14} aria-hidden /> Connection diagnostics
                </button>
              }
            />
          )}
          {onSetUp && (
            <SettingRow
              name="Setup"
              hint="Change this connection's address or sign-in, or give Hermes a model provider's API key."
              more="The connection stays as it is until the change is tested and saved. To keep it and use another server too, add a connection above."
              control={
                <button className="btn" onClick={onSetUp}>
                  <PlugZap size={14} /> Run setup again
                </button>
              }
            />
          )}
        </SettingsSection>
      </>
    ),
    chats: (
      <>
        <ChatSectionSettings />
        <FollowUpSettings />
        <FollowScreenSettings />
        <AskFirstSettings />
        <SpellCheckSettings />
        <InboxSettings />
        <JobRunSettings />
      </>
    ),
    launch: (
      <>
        <StartupSettings />
        <SummonSettings />
        <TraySettings tray={tray} />
        <UpdateSettings />
      </>
    ),
    storage: (
      <>
        <SettingsSection title="Local cache">
          <SettingRow
            name="Chat lists and Saved copies"
            hint="Lets the chat list show at once, and recent chats open while Hermes can't be reached."
            more={
              <p>
                Highwing keeps a copy of each profile's chat list on this computer. It also keeps a Saved copy of the chats you opened most recently,
                up to {formatBytes(TRANSCRIPT_LIMIT_BYTES)}; the oldest copies are deleted first when that fills up. Clearing the cache keeps your display
                settings.
              </p>
            }
            control={
              !confirmClear && (
                <>
                  <span className="set-value">{bytes ? `${formatBytes(bytes)} stored` : "Nothing stored"}</span>
                  <button className="btn" disabled={!bytes} onClick={() => setConfirmClear(true)}>
                    <Trash2 size={14} /> Clear local cache
                  </button>
                </>
              )
            }
          >
            {confirmClear && (
              <div className="confirm set-confirm">
                <span>
                  <Lock size={12} /> Only the chat copies on this computer are deleted; your display settings are kept. Nothing on your Hermes server is
                  touched; the list is saved again at the next refresh, and a chat's Saved copy when you next open it.
                </span>
                <div className="confirm-actions">
                  <button className="btn" onClick={() => setConfirmClear(false)}>
                    Cancel
                  </button>
                  <button
                    className="btn danger"
                    onClick={() => {
                      onClearCache();
                      setBytes(cacheBytes());
                      setConfirmClear(false);
                    }}
                  >
                    Clear {formatBytes(bytes)}
                  </button>
                </div>
              </div>
            )}
          </SettingRow>
        </SettingsSection>

        <SettingsSection title="History">
          <SettingRow
            name="Older chats"
            hint={
              <>
                The list shows the past month. Older <span className="mono">{profile}</span> chats stay on the server until you pull them.
              </>
            }
            control={
              <button className="btn" disabled={pulling || olderPulled || status !== "connected"} onClick={pull}>
                <Download size={14} /> {pulling ? "Pulling…" : olderPulled ? "Up to date" : "Pull older history"}
              </button>
            }
          >
            {(pullError || pulled || olderPulled) && (
              <div className={`small ${pullError ? "sign-in-error" : "muted"}`} role={pullError ? "alert" : undefined}>
                {pullError ?? pulled ?? "All chats are listed, however old."}
              </div>
            )}
          </SettingRow>
        </SettingsSection>
        {importer && <ImportSection wiring={importer} connected={status === "connected"} />}
        {backup && <BackupSection wiring={backup} />}
      </>
    ),
  };
  // A search shows every group's sections together, so what's typed can be found in any of them. Otherwise the group
  // picked in the sidebar's tree shows alone (ADR 0160).
  const general = searching ? (
    <>
      {generalGroups.connection}
      {generalGroups.chats}
      {generalGroups.launch}
      {generalGroups.storage}
    </>
  ) : (
    generalGroups[genGroup]
  );

  /** The content of a tab: the same whether it's shown alone or with others in a search. */
  const panel = (id: Tab): ReactNode => {
    switch (id) {
      case "memory": {
        if (!memory) return null;
        // Both parts stay mounted whichever is shown, so an unsaved edit in either is kept, and guarded, as before. Only
        // the part shown fills the page header.
        return (
          <>
            <div hidden={memSel.kind !== "file"}>
              {gated(
                "memory",
                <MemorySettings
                  key={tabProfile.memory}
                  api={memory}
                  profile={tabProfile.memory}
                  shown={profile}
                  status={status}
                  server={routeLabel(route) ?? "not known until connected"}
                  onDirtyChange={onEntriesDirty}
                  discardSignal={memoryDiscards}
                  source={memSel.kind === "file" ? memSel.source : undefined}
                  files={false}
                  picker={picker("memory", "Profile whose memory is shown")}
                />,
              )}
            </div>
            {memoryProviders && (
              <div hidden={memSel.kind !== "profile"}>
                <MemoryProviderSettings
                  key={`providers-${profile}`}
                  api={memoryProviders}
                  profile={profile}
                  connected={status === "connected"}
                  onDirtyChange={onProvidersDirty}
                  discardSignal={memoryDiscards}
                  target={memSel.kind === "profile" ? memSel.name : undefined}
                  onProfiles={setMemProfiles}
                  onPick={(p) => pickMem(`profile:${p}`)}
                  overview="folded"
                />
              </div>
            )}
          </>
        );
      }
      case "skills":
        // An edit lives only while this tab is open, and for one profile; leaving with one asks first.
        return (
          skills &&
          gated(
            "skills",
            <SkillSettings
              key={tabProfile.skills}
              api={skills}
              profile={tabProfile.skills}
              status={status}
              server={routeLabel(route) ?? "not known until connected"}
              onDirtyChange={onSkillDirty}
              discardSignal={skillDiscards}
              picker={picker("skills", "Profile whose skills are shown")}
              shown={profile}
              profiles={profiles}
            />,
          )
        );
      case "appearance":
        return <AppearanceSettings store={appearance} listFonts={listFonts} />;
      case "keyboard":
        return <KeyboardSettings />;
      case "snapshots":
        return snapshots && <SnapshotSettings api={snapshots} />;
      case "extensions":
        return <ExtensionsSettings skills={extensions?.skills} />;
      case "model":
        return (
          <>
            <ModelSettings
              key={profile}
              api={modelSettings}
              profile={profile}
              connected={status === "connected"}
              showTextGeneration={searching ? undefined : showTextGeneration}
              writingScope={writing?.scope}
              onWritten={() => setModelWrites((n) => n + 1)}
            />
            {writing && (
              <WritingModelSettings
                desk={writing.desk}
                scope={writing.scope}
                profiles={listProfiles ?? (async () => [profile])}
                catalog={() => modelSettings.providers()}
                reread={modelWrites}
              />
            )}
            <IdleCompactSettings />
          </>
        );
      case "providers":
        // Read for one profile and connection; another starts afresh, with nothing typed kept.
        return (
          providers && (
            <>
              <ProviderVisibility key={`model-lists-${profile}`} catalog={() => modelSettings.providers()} connected={status === "connected"} />
              <ProviderSettings key={profile} hermes={providers} profile={profile} connected={status === "connected"} openModel={() => pick("model")} />
              {accounts && (
                <>
                  <SignInSettings key={`sign-ins-${profile}`} api={accounts} profile={profile} connected={status === "connected"} openUrl={openUrl} />
                  <EndpointSettings key={`endpoints-${profile}`} api={accounts} profile={profile} connected={status === "connected"} />
                </>
              )}
            </>
          )
        );
      case "voice":
        return (
          <>
            <VoiceSettings status={status} profile={profile} setup={voiceSetup} changes={voiceChanges} />
            {localStt && <LocalSttSettings api={localStt} transcribe={transcribe} status={status} setup={voiceSetup} changes={voiceChanges} />}
            {voiceSettings && (
              // Read for one profile and connection; another starts afresh, with nothing typed kept.
              <VoiceProviderSettings key={profile} api={voiceSettings} profile={profile} connected={status === "connected"} />
            )}
          </>
        );
      case "toolsets":
        // Read for one profile; switching profile reads the new one's afresh.
        return (
          toolsets &&
          gated("toolsets", <ToolsetSettings key={profile} api={toolsets} profile={profile} connected={status === "connected"} runningReplies={runningReplies} chat={openChat} onGuide={() => openGuide(guideUrl("toolsetSwitches"))} />)
        );
      case "approvals":
        // Read for one profile; picking another reads it afresh.
        return (
          allowlist && (
            <AllowlistSettings
              key={tabProfile.approvals}
              api={allowlist}
              profile={tabProfile.approvals}
              connected={status === "connected"}
              picker={picker("approvals", "Profile whose always-allowed commands are shown")}
              inUse={profile}
            />
          )
        );
      case "mcp":
        // Read for one profile; picking another reads it afresh, and a dialog left open goes with it.
        return (
          mcp && (
            <McpSettings
              key={tabProfile.mcp}
              api={mcp}
              restart={gatewayRestart}
              profile={tabProfile.mcp}
              connected={status === "connected"}
              picker={picker("mcp", "Profile whose MCP servers are shown")}
              shown={profile}
              openUrl={openUrl}
            />
          )
        );
      case "gateways":
        // Read for one profile; picking another reads it afresh, and anything typed goes with it. The platform shown is
        // picked in the sidebar's tree.
        return (
          gateways && (
            <GatewaySettings
              key={tabProfile.gateways}
              api={gateways}
              restart={gatewayRestart}
              profile={tabProfile.gateways}
              shown={profile}
              connected={status === "connected"}
              picker={picker("gateways", "Profile whose gateways are shown")}
              openUrl={openUrl}
              platform={gwShown}
              onPlatforms={setGwOffered}
            />
          )
        );
      case "diagnostics":
        // Server and Logs, one at a time, picked in the sidebar's tree as General's groups are (ADR 0160, 0087). Logs
        // reads Hermes only while it's shown; what it read goes when another group, tab or profile is shown.
        return diagShown === "server" ? (
          capabilities && (
            <DiagnosticsSettings
              store={capabilities}
              connected={status === "connected"}
              server={routeLabel(route)}
              signIn={signInText(route)}
              headers={headers.length}
              unsecure={unsecure}
              profile={profile}
              openGuide={openGuide}
              focus={diagFocus}
              screen={screen}
              computerUse={
                screen && toolsets ? { check: () => checkReadiness({ screen, toolsets: () => toolsets.list(profile) }), openToolsets: () => setTab("toolsets") } : undefined
              }
              toolProgress={toolProgress}
              work={work}
            />
          )
        ) : (
          logs && <LogsPanel key={profile} {...logs} profile={profile} connected={status === "connected"} />
        );
      case "profiles":
        return profilesTab && gated("profiles", <ProfileSettings wiring={{ ...profilesTab, showTab: showTabFor }} />);
      case "general":
        return general;
    }
  };
  const shownTab = tabs.some((t) => t.id === tab) ? tab : "general";
  const total = found + elsewhere.length;
  const groups = SIDEBAR_GROUPS.map((g) => ({ ...g, tabs: tabs.filter((t) => g.tabs.includes(t.id)) })).filter((g) => g.tabs.length);
  const diagShown: DiagGroup = !capabilities || (diagGroup === "logs" && logs) ? "logs" : "server";
  // External memory's profile is picked in the header, as Memory's files' is; today's sub-nav listed each profile.
  const externalPicker = listProfiles && (
    <EditingProfile
      inUse={memExternal === profile}
      picker={<ProfilePicker value={memExternal} shown={profile} profiles={memProfiles ?? profiles} label="Profile whose external memory is shown" defaultName={defaultName} onPick={(p) => pickMem(`profile:${p}`)} />}
    />
  );
  const tabLabel = (id: Tab) => tabs.find((t) => t.id === id)?.label ?? tabLabels[id];

  /** The sections a page shows one at a time, picked under it in the tree. */
  const sectionsOf = (id: Tab): { items: SectionItem[]; selected: string; onPick: (id: string) => void } | undefined => {
    switch (id) {
      case "general":
        return { items: GEN_GROUPS, selected: genGroup, onPick: (g) => setGenGroup(g as GenGroup) };
      case "memory":
        return memory
          ? { items: memoryProviders ? MEM_GROUPS : MEM_GROUPS.slice(0, 2), selected: memSel.kind === "file" ? memKey(memSel) : "external", onPick: (g) => pickMem(g === "external" ? `profile:${memExternal}` : g) }
          : undefined;
      case "diagnostics":
        return capabilities && logs ? { items: DIAG_GROUPS, selected: diagShown, onPick: (g) => setDiagGroup(g as DiagGroup) } : undefined;
      case "gateways": {
        // Only the platforms this Hermes offers; a pick it doesn't offer shows the first it does, named as such.
        const items = GW_GROUPS.filter((g) => !gwOffered || gwOffered.includes(g.id as PlatformId));
        return gateways && items.length ? { items, selected: gwShown, onPick: (g) => setGwPlatform(g as PlatformId) } : undefined;
      }
    }
  };
  const sections = searching ? undefined : sectionsOf(shownTab);
  const section = sections?.items.find((i) => i.id === sections.selected);

  const mainRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [jumps, setJumps] = useState<string[]>([]);
  const [here] = useState(currentJump);
  const pinned = useRef<{ name: string; settling: number }>(undefined);
  const sectioned = !!sections;
  useLayoutEffect(() => {
    const root = panelRef.current;
    if (!root || sectioned) return setJumps([]);
    const read = () => {
      const names = jumpSections(root).map(headingOf);
      setJumps((cur) => (cur.join("\n") === names.join("\n") ? cur : names));
    };
    read();
    const seen = new MutationObserver(read);
    // Text changes too: a heading renamed in place (another interface language) renames its jump link.
    seen.observe(root, { childList: true, subtree: true, characterData: true });
    return () => seen.disconnect();
  }, [shownTab, searching, sectioned]);
  // Before the links' passive effects. The highlight reads this publication to tell the page's first heading from a later scroll.
  useLayoutEffect(() => {
    const main = mainRef.current;
    const root = panelRef.current;
    pinned.current = undefined;
    if (!main || !root || jumps.length < 2) return here.set(undefined);
    const spy = () => {
      const pin = pinned.current;
      if (pin && Date.now() < pin.settling) {
        // The jump's own scroll: it settles once 150 ms pass without one.
        pin.settling = Date.now() + 150;
        return here.set(pin.name);
      }
      pinned.current = undefined;
      const secs = jumpSections(root);
      if (!secs.length) return;
      const top = main.getBoundingClientRect().top + 24;
      let cur = secs[0];
      for (const s of secs) if (s.getBoundingClientRect().top <= top + 4) cur = s;
      if (main.scrollTop > 0 && main.scrollTop + main.clientHeight >= main.scrollHeight - 2) cur = secs[secs.length - 1];
      here.set(headingOf(cur));
    };
    spy();
    main.addEventListener("scroll", spy, { passive: true });
    return () => main.removeEventListener("scroll", spy);
  }, [jumps, here]);
  const jump = (name: string) => {
    const s = panelRef.current && jumpSections(panelRef.current).find((x) => headingOf(x) === name);
    if (!s) return;
    pinned.current = { name, settling: Date.now() + 150 };
    here.set(name);
    s.scrollIntoView?.({ block: "start" });
  };
  /** Under the open page in the tree: its sections, or its headings to jump to. */
  const children: SubLink[] = sections
    ? sections.items.map((i) => ({ id: i.id, label: i.label, current: i.id === sections.selected, go: () => sections.onPick(i.id) }))
    : jumps.length >= 2
      ? jumps.map((j, at) => ({ id: j, label: j, jump: { here, first: at === 0 }, go: () => jump(j) }))
      : [];

  // The narrow window (760 px wide at the least) has no room for the sidebar: a bar names the page and opens the same
  // tree as a sheet, and search sits behind an icon in it.
  const narrow = useNarrow();
  const [sheet, setSheet] = useState(false);
  // The sheet is a modal dialog: focus moves to the page shown in it, Tab stays inside, Escape closes it, and focus goes
  // back to the bar's page button.
  const sideRef = useRef<HTMLElement>(null);
  const crumbRef = useRef<HTMLButtonElement>(null);
  const sheetWas = useRef(false);
  /** The sheet's tab the arrows moved the focus to: its one Tab stop (a roving tabindex), so Tab wraps inside the sheet. */
  const [rove, setRove] = useState<Tab>();
  useEffect(() => {
    if (sheet) {
      setRove(undefined);
      (sideRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? sideRef.current?.querySelector<HTMLElement>('[role="tab"]'))?.focus();
    }
    else if (sheetWas.current) {
      // Only while the focus is still the sheet's (or nobody's): a pick that asks first (an unsaved edit) has moved it into
      // the question, which keeps it.
      const at = document.activeElement;
      if (!at || at === document.body || sideRef.current?.contains(at)) crumbRef.current?.focus();
    }
    sheetWas.current = sheet;
  }, [sheet]);
  const onSheetKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (!sheet) return;
    if (e.key === "Escape" && !composing(e)) {
      e.preventDefault();
      e.stopPropagation();
      return setSheet(false);
    }
    if (!isTextEdit(e) && !isZoomKey(e)) e.stopPropagation();
    trapTab(e, sideRef.current);
  };
  useEffect(() => {
    if (!narrow) setSheet(false);
  }, [narrow]);
  const pickTab = (t: Tab) => {
    setSheet(false);
    pick(t);
  };
  const searchField = (
    <div className="settings-search" role="search">
      <Search size={14} aria-hidden />
      <input
        ref={searchBox}
        type="search"
        aria-label={frame.search}
        placeholder={frame.search}
        value={query}
        onChange={(e) => typed(e.target.value)}
        onBlur={() => !query && setSearchOpen(false)}
      />
      {query ? (
        <button className="icon-btn" aria-label={frame.clearSearch} title={frame.clearSearch} onClick={() => (setQuery(""), searchBox.current?.focus())}>
          <X size={14} />
        </button>
      ) : (
        !narrow && <kbd className="settings-search-key">Ctrl F</kbd>
      )}
    </div>
  );
  // Ctrl+F in a narrow window opens the bar's search first, then focuses it.
  useEffect(() => {
    if (narrow && searchOpen) searchBox.current?.focus();
  }, [narrow, searchOpen]);

  const tree = (
    <div
      className="settings-tabs"
      role="tablist"
      aria-orientation="vertical"
      aria-label={frame.title}
      // While searching no tab is selected, so the arrows move on from the tab that has the focus. A section's button
      // under a tab moves on its own (below).
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).getAttribute("role") !== "tab") return;
        const ids = groups.flatMap((g) => g.tabs.map((t) => t.id));
        const focused = ids.find((id) => (e.target as HTMLElement).id === `settings-tab-${id}`);
        // In the narrow sheet the arrows only move the focus, and Enter or a click picks (and closes the sheet): a pick can
        // ask first about an unsaved edit, and that question belongs to a deliberate pick, not to a step through the list.
        if (sheet) {
          const at = ids.indexOf(focused ?? tab);
          const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
          const next = e.key === "Home" ? 0 : e.key === "End" ? ids.length - 1 : step ? (at + step + ids.length) % ids.length : -1;
          if (next < 0) return;
          e.preventDefault();
          setRove(ids[next]);
          document.getElementById(`settings-tab-${ids[next]}`)?.focus();
          return;
        }
        arrowSelect(e, ids, searching && focused ? focused : tab, pickTab);
      }}
    >
      {groups.map((g) => (
        <div key={g.id} className="settings-group" role="presentation">
          <div className="settings-group-label" aria-hidden>
            {frame.groups[g.id]}
          </div>
          {g.tabs.map(({ id, label, Icon }) => {
            const on = !searching && shownTab === id;
            const kids = on && children.length > 0;
            const count = searching ? matchCount[id] : undefined;
            return (
              <Fragment key={id}>
                <button
                  id={`settings-tab-${id}`}
                  className={`settings-tab ${on ? (kids ? "parent" : "on") : ""} ${searching && !count ? "dim" : ""}`}
                  role="tab"
                  aria-selected={on}
                  tabIndex={(sheet && rove ? rove === id : on || (searching && id === groups[0].tabs[0].id)) ? 0 : -1}
                  aria-controls={searching ? undefined : `settings-panel-${id}`}
                  onClick={() => pickTab(id)}
                >
                  <Icon size={15} aria-hidden /> <span className="settings-tab-label">{label}</span>
                  {!!count && <span className="settings-tab-count">{count}</span>}
                </button>
                {kids && (
                  <div className="settings-subs" role="group" aria-label={`${label}: ${sections ? "sections" : "on this page"}`} onKeyDown={(e) => moveAmong(e, ".settings-sub")}>
                    {children.map((c) => (
                      <SubLinkButton key={c.id} link={c} className="settings-sub" onClick={() => (c.go(), setSheet(false))} />
                    ))}
                  </div>
                )}
              </Fragment>
            );
          })}
        </div>
      ))}
    </div>
  );

  // Search's results, grouped by page: each names its page and, on a page that edits the profile in use, says so, as
  // the page's header would (ADR 0160).
  const results = (
    <div className="settings-results">
      <header className="page-head">
        <h2 className="page-title">{frame.searchTitle}</h2>
        <p className="page-desc settings-search-count" role="status">
          {total ? `${total} ${total === 1 ? "match" : "matches"} for “${query.trim()}”` : `No settings match “${query.trim()}”.`}
        </p>
      </header>
      <div ref={resultsRef}>
        {elsewhere.map(({ id, label, Icon }) => (
          <div key={id} className="settings-row settings-search-elsewhere" data-search-mark data-search-elsewhere={id}>
            <div>
              <div className="settings-search-tab">
                <Icon size={13} /> {label}
              </div>
              <div className="muted small">{aboutOf(id)}</div>
            </div>
            <button className="btn" onClick={() => pickTab(id)}>
              {id === "profiles" ? frame.about.open(label) : `Open ${label}`}
            </button>
          </div>
        ))}
        <SearchHeads>
          {tabs
            .filter((t) => SEARCHED.includes(t.id))
            .map(({ id, label, Icon }) => (
              <div key={id} data-search-group={id} role="group" aria-label={label}>
                <div className="settings-search-head">
                  <button className="settings-search-tab" onClick={() => pickTab(id)}>
                    <Icon size={13} /> {label}
                  </button>
                  {IN_USE_PAGES.includes(id) && <ProfileInUse name={profile} />}
                </div>
                {panel(id)}
              </div>
            ))}
        </SearchHeads>
      </div>
    </div>
  );

  const crumb = (
    <>
      {(() => {
        const Icon = tabs.find((t) => t.id === shownTab)?.Icon ?? Settings2;
        return <Icon size={15} aria-hidden />;
      })()}
      <span>
        {searching ? frame.searchTitle : tabLabel(shownTab)}
        {!searching && section && (
          <>
            {" "}
            <span className="faint">›</span> {section.label}
          </>
        )}
      </span>
      <ChevronDown size={14} aria-hidden />
    </>
  );

  return (
    <SettingsSearching.Provider value={searching}>
      <div className={`settings settings-frame ${narrow ? "narrow" : ""}`} ref={screenRef}>
        {narrow && (
          <div className="settings-bar">
            <div className="settings-bar-row">
              <button className="icon-btn" aria-label={frame.back} title={frame.back} onClick={onClose}>
                <ArrowLeft size={16} />
              </button>
              {searchOpen || searching ? (
                <>
                  {searchField}
                  <button className="btn" onClick={() => (setQuery(""), setSearchOpen(false))}>
                    {frame.done}
                  </button>
                </>
              ) : (
                <>
                  <button ref={crumbRef} className="settings-crumb" aria-haspopup="dialog" aria-expanded={sheet} onClick={() => setSheet(true)}>
                    {crumb}
                  </button>
                  <button className="icon-btn settings-bar-search" aria-label={`${frame.search} (Ctrl+F)`} title={`${frame.search} (Ctrl+F)`} onClick={() => setSearchOpen(true)}>
                    <Search size={16} />
                  </button>
                </>
              )}
            </div>
            {!searching && children.length > 0 && (
              <div className="settings-chips" role="group" aria-label={`${tabLabel(shownTab)}: ${sections ? "sections" : "on this page"}`} onKeyDown={(e) => moveAmong(e, "button", true)}>
                {children.map((c) => (
                  <SubLinkButton key={c.id} link={c} onClick={c.go} />
                ))}
              </div>
            )}
          </div>
        )}
        <aside
          ref={sideRef}
          className={`settings-side ${sheet ? "sheet" : ""}`}
          role={sheet ? "dialog" : undefined}
          aria-modal={sheet || undefined}
          aria-label={sheet ? frame.title : undefined}
          onKeyDown={onSheetKey}
        >
          <div className="settings-side-top">
            {narrow ? (
              <div className="settings-sheet-head">
                <b>{frame.title}</b>
                <button className="icon-btn" aria-label={frame.closeNav} title={frame.closeNav} onClick={() => setSheet(false)}>
                  <X size={16} />
                </button>
              </div>
            ) : (
              <>
                <button className="back" onClick={onClose}>
                  <ArrowLeft size={15} /> {frame.back}
                </button>
                <h1 className="settings-side-title">{frame.title}</h1>
                {searchField}
              </>
            )}
          </div>
          <div className="settings-side-scroll">{tree}</div>
        </aside>
        {sheet && <div className="settings-scrim" aria-hidden="true" onClick={() => setSheet(false)} />}
        <div className="settings-main" ref={mainRef}>
          <div className="settings-inner">
            {searching ? (
              results
            ) : (
              <div id={`settings-panel-${shownTab}`} role="tabpanel" aria-labelledby={`settings-tab-${shownTab}`} ref={panelRef}>
                <SettingsPage
                  // Keyed by page only: picking a section keeps the page's components mounted, with any edit in them (ADR 0113).
                  key={shownTab}
                  narrow={narrow}
                  eyebrow={section ? tabLabel(shownTab) : undefined}
                  title={section?.label ?? tabLabel(shownTab)}
                  description={(section && SECTION_INTRO[section.id]) || frame.pages[shownTab]}
                  profile={IN_USE_PAGES.includes(shownTab) ? profile : undefined}
                  slot={shownTab === "memory" && memSel.kind === "profile" && memoryProviders ? externalPicker : undefined}
                >
                  {panel(shownTab)}
                </SettingsPage>
              </div>
            )}
          </div>
        </div>
      </div>
    </SettingsSearching.Provider>
  );
}

/** Which jump link is current. Only the links subscribe, so a scroll renders them again and not the page. */
type CurrentJump = { get: () => string | undefined; set: (name: string | undefined) => void; subscribe: (changed: () => void) => () => void };
function currentJump(): CurrentJump {
  let name: string | undefined;
  const watchers = new Set<() => void>();
  return {
    get: () => name,
    set: (next) => {
      if (next === name) return;
      name = next;
      for (const changed of watchers) changed();
    },
    subscribe: (changed) => {
      watchers.add(changed);
      return () => watchers.delete(changed);
    },
  };
}

/** Under the open page, in the tree and in the narrow bar: one of its sections, or one of its headings to jump to. */
type SubLink = { id: string; label: string; go: () => void } & ({ current: boolean; jump?: undefined } | { current?: undefined; jump: { here: CurrentJump; first: boolean } });
const noJump: CurrentJump = currentJump();

const HIGHLIGHT_SETTLE_MS = 200;

function linkCurrent(link: SubLink, at: string | undefined): boolean {
  if (!link.jump) return link.current;
  return at === undefined ? link.jump.first : at === link.id;
}

function useSettledHighlight(defer: boolean, current: boolean, read: () => boolean): boolean {
  const [painted, setPainted] = useState(current);
  const armed = useRef(false);
  const readRef = useRef(read);
  readRef.current = read;
  useEffect(() => {
    if (!defer) return;
    // The store subscription is passive, so this render can still show the previous page after the spy has published.
    // Stay unarmed until a render shows the spy's heading. Until then the class follows `current`. A later scroll waits.
    if (!armed.current) {
      if (readRef.current() !== current) return;
      armed.current = true;
      if (painted !== current) setPainted(current);
      return;
    }
    if (painted === current) return;
    const id = window.setTimeout(() => setPainted(current), HIGHLIGHT_SETTLE_MS);
    return () => window.clearTimeout(id);
  }, [defer, current, painted]);
  return defer && armed.current ? painted : current;
}

function SubLinkButton({ link, className, onClick }: { link: SubLink; className?: string; onClick: () => void }) {
  const here = link.jump?.here ?? noJump;
  const at = useSyncExternalStore(here.subscribe, here.get);
  const current = linkCurrent(link, at);
  const painted = useSettledHighlight(!!link.jump, current, () => linkCurrent(link, here.get()));
  return (
    <button className={[className, painted && "on"].filter(Boolean).join(" ")} aria-current={current ? (link.jump ? "location" : "page") : undefined} onClick={onClick}>
      {link.label}
    </button>
  );
}

/** Whether the window is narrow: 900 px or less, where the sidebar gives way to the bar (ADR 0160). */
function useNarrow(): boolean {
  const query = typeof window !== "undefined" ? window.matchMedia?.("(max-width: 900px)") : undefined;
  const [narrow, setNarrow] = useState(!!query?.matches);
  useEffect(() => {
    if (!query) return;
    const on = () => setNarrow(query.matches);
    on();
    query.addEventListener?.("change", on);
    return () => query.removeEventListener?.("change", on);
  }, [query]);
  return narrow;
}

/** A page's outer sections that have a heading, in order: what its jump links go to. The "How changes apply" box isn't one. */
function jumpSections(root: Element): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("section.set-section")].filter((s) => {
    const outer = s.parentElement?.closest("section");
    return (!outer || !root.contains(outer)) && !s.closest(".page-head") && !!s.querySelector(":scope > .set-head h2");
  });
}
const headingOf = (s: Element) => s.querySelector(":scope > .set-head h2")?.textContent?.trim() ?? "";

/** Up and Down (or Left and Right, across) move between a group's buttons, as the tree's tabs do. */
function moveAmong(e: ReactKeyboardEvent<HTMLElement>, selector: string, across = false) {
  const back = across ? "ArrowLeft" : "ArrowUp";
  const on = across ? "ArrowRight" : "ArrowDown";
  if (![back, on, "Home", "End"].includes(e.key)) return;
  const all = [...e.currentTarget.querySelectorAll<HTMLElement>(selector)];
  const at = all.indexOf(e.target as HTMLElement);
  if (at < 0) return;
  e.preventDefault();
  e.stopPropagation();
  const next = e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : Math.max(0, Math.min(all.length - 1, at + (e.key === on ? 1 : -1)));
  all[next]?.focus();
}
