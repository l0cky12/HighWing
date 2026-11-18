import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronRight, MessagesSquare, Pencil, Plus, Trash2 } from "lucide-react";
import type { Bot } from "../hermes/bots";
import { TOPIC_MAX, type BotThread, type ThreadShelf, type ThreadTitle } from "../hermes/threads";
import { Age, composing } from "./bits";
import { Menu } from "./ChatMenu";
import { DeleteChatDialog } from "./DeleteChat";
import { pick } from "./keybindings";
import { MenuEntry } from "./ProfileSettings";
import { useLocale } from "../i18n/locale";

export type BotThreads = {
  shelves: Readonly<Record<string, ThreadShelf>>;
  shown?: ThreadTitle;
  expanded: Readonly<Record<string, boolean>>;
  onExpand: (profile: string, open: boolean) => void;
  onOpen: (bot: Bot, title: ThreadTitle) => void;
  onNew: (bot: Bot, topic: string) => void;
  onRename: (thread: BotThread, topic: string) => Promise<void>;
  onDelete: (thread: BotThread) => Promise<void>;
};

function TopicField({ label, start = "", onTake, onLeave }: { label: string; start?: string; onTake: (topic: string) => void; onLeave: (by: "escape" | "blur") => void }) {
  const w = useLocale().threads;
  const [topic, setTopic] = useState(start);
  return (
    <input
      className="bots-thread-topic-field"
      autoFocus
      aria-label={label}
      placeholder={w.topicHint}
      maxLength={TOPIC_MAX}
      value={topic}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setTopic(e.target.value)}
      onBlur={() => onLeave("blur")}
      onKeyDown={(e) => {
        if (composing(e)) return;
        e.stopPropagation();
        if (e.key === "Escape") onLeave("escape");
        else if (e.key === "Enter" && topic.trim()) onTake(topic);
      }}
    />
  );
}

export function ThreadDisclosure({
  bot,
  shelf,
  open,
  shown,
  onToggle,
  onOpen,
  onNew,
  onRename,
  onDelete,
}: {
  bot: Bot;
  shelf?: ThreadShelf;
  open: boolean;
  shown?: ThreadTitle;
  onToggle: () => void;
  onOpen: (title: ThreadTitle) => void;
  onNew: (topic: string) => void;
  onRename: BotThreads["onRename"];
  onDelete: BotThreads["onDelete"];
}) {
  const l = useLocale();
  const w = l.threads;
  const [adding, setAdding] = useState(false);
  const [menu, setMenu] = useState<{ thread: BotThread; x: number; y: number }>();
  const [renaming, setRenaming] = useState<ThreadTitle>();
  const [deleting, setDeleting] = useState<BotThread>();
  const [busy, setBusy] = useState<readonly ThreadTitle[]>([]);
  const menuFrom = useRef<HTMLElement | null>(null);
  const root = useRef<HTMLLIElement>(null);
  const focusNext = useRef<string>(undefined);
  useEffect(() => {
    const selector = focusNext.current;
    focusNext.current = undefined;
    if (selector) root.current?.querySelector<HTMLElement>(selector)?.focus();
  });

  const known = !!shelf && (shelf.at > 0 || !shelf.error);
  const count = known ? w.count(shelf.threads.length) : w.notRead;
  const during = (thread: BotThread, work: Promise<void>) => {
    setBusy((b) => [...b, thread.title]);
    void work.finally(() => {
      if (document.activeElement === document.body) focusNext.current = ".bots-threads-toggle";
      setBusy((b) => b.filter((t) => t !== thread.title));
    });
  };
  const openMenu = (thread: BotThread, x: number, y: number) => {
    menuFrom.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMenu({ thread, x, y });
  };
  const rowKeys = (thread: BotThread) => (e: KeyboardEvent<HTMLElement>) => {
    // WebKitGTK sends no contextmenu event for Shift+F10, as on a bot's row.
    if (pick(e, "chatRow") !== "rowMenu") return;
    e.preventDefault();
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    openMenu(thread, r.left + 24, r.bottom);
  };

  return (
    <li ref={root} className="bots-threads" data-threads-of={bot.profile}>
      <button className="bots-threads-toggle" aria-expanded={open} aria-label={w.toggle(bot.name, count)} onClick={onToggle}>
        {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
        {count}
      </button>
      {open && (
        <>
          {shelf?.error && (
            <p className="bots-note" role="alert">
              {w.readFailed(shelf.error)}
            </p>
          )}
          <ul className="bots-thread-list" role="group" aria-label={w.of(bot.name)}>
            {shelf?.threads.map((t) => (
              <li key={t.rootId} className={`bots-thread${t.title === shown ? " sel" : ""}`}>
                {renaming === t.title ? (
                  <TopicField
                    label={w.renameFor(t.topic)}
                    start={t.topic}
                    onLeave={(by) => {
                      if (by === "escape") focusNext.current = `[data-thread="${CSS.escape(t.rootId)}"]`;
                      setRenaming(undefined);
                    }}
                    onTake={(topic) => {
                      setRenaming(undefined);
                      during(t, onRename(t, topic));
                    }}
                  />
                ) : (
                  <button
                    className="bots-thread-open"
                    data-thread={t.rootId}
                    aria-current={t.title === shown || undefined}
                    aria-busy={busy.includes(t.title) || undefined}
                    onClick={() => onOpen(t.title)}
                    onKeyDown={rowKeys(t)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      openMenu(t, e.clientX, e.clientY);
                    }}
                  >
                    <MessagesSquare size={12} className="bots-thread-icon" aria-hidden />
                    <span className="bots-thread-topic" translate="no">
                      {t.topic}
                    </span>
                    {t.lastActive > 0 && (
                      <time className="bots-thread-age" dateTime={new Date(t.lastActive).toISOString()} title={l.fmt.dateTime(t.lastActive)}>
                        <Age at={t.lastActive} />
                      </time>
                    )}
                  </button>
                )}
              </li>
            ))}
            {shelf?.capped && <li className="bots-thread-note">{w.capped}</li>}
            <li>
              {adding ? (
                <TopicField
                  label={w.topicFor(bot.name)}
                  onLeave={(by) => {
                    if (by === "escape") focusNext.current = ".bots-thread-new";
                    setAdding(false);
                  }}
                  onTake={(topic) => {
                    setAdding(false);
                    onNew(topic);
                  }}
                />
              ) : (
                <button className="bots-thread-new" onClick={() => setAdding(true)}>
                  <Plus size={12} aria-hidden />
                  {w.new}
                </button>
              )}
            </li>
          </ul>
        </>
      )}
      {menu && (
        <Menu label={w.moreFor(menu.thread.topic)} x={menu.x} y={menu.y} onClose={() => setMenu(undefined)}>
          <MenuEntry
            icon={<Pencil size={15} />}
            label={w.menu.rename}
            onPick={() => {
              setMenu(undefined);
              setRenaming(menu.thread.title);
            }}
          />
          <MenuEntry
            icon={<Trash2 size={15} />}
            label={w.menu.delete}
            danger
            onPick={() => {
              setMenu(undefined);
              setDeleting(menu.thread);
            }}
          />
        </Menu>
      )}
      {deleting && (
        <DeleteChatDialog
          title={deleting.topic}
          words={{ title: w.remove.title(deleting.topic), note: w.remove.note, cancel: l.common.cancel, confirm: w.remove.confirm }}
          returnTo={menuFrom}
          onClose={() => setDeleting(undefined)}
          onDelete={() => {
            setDeleting(undefined);
            during(deleting, onDelete(deleting));
          }}
        />
      )}
    </li>
  );
}
