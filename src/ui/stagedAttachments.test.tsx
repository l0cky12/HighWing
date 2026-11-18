// @vitest-environment jsdom
// Pasted images staged in the signed-in app, driven the way the owner would, against a fake Hermes. Only the Rust side
// is faked: saving a paste's bytes, and deleting what the desk lets go. The attach check, the chip, sending and the
// upload are the real code. Each test checks what reached Hermes and which staged files were deleted.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { connect, type Hermes } from "../hermes/transport";
import { localChatCache, outboxAttachmentPaths, subscribeOutbox } from "../hermes/chatCache";
import { stagedFiles } from "../hermes/unsaved";
import { Main, type DeskWiring } from "../App";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
const rustSide = vi.hoisted(() => ({ picked: [] as string[], stage: (_bytes: ArrayBuffer, _name: string): string => "" }));
vi.mock("@tauri-apps/api/core", async (actual) => {
  const core = await actual<typeof import("@tauri-apps/api/core")>();
  return {
    ...core,
    invoke: async (cmd: string, ...rest: never[]) => {
      if (cmd === "attach_picked_files") return rustSide.picked;
      if (cmd === "stage_clipboard_file") {
        const [bytes, opts] = rest as unknown as [ArrayBuffer, { headers: Record<string, string> }];
        return rustSide.stage(bytes, decodeURIComponent(opts.headers["x-name"]));
      }
      return core.invoke(cmd, ...rest);
    },
  };
});

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});
const stopOutboxes: (() => void)[] = [];
// Each test's Hermes is closed, so none writes to the next test's storage: the fake mints the same chat ids each time.
const running: Hermes[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
  for (const stop of stopOutboxes.splice(0)) stop();
  localStorage.clear();
  vi.unstubAllGlobals();
  rustSide.picked = [];
});

const PNG = "\x89PNG\r\n\x1a\nscreen";
const composer = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message Hermes");
const settle = (hermes: Hermes) => act(async () => void (await hermes.idle()));

/** The Rust side of staging: a paste's bytes are saved on the fake Hermes's disk, and deleted once the desk lets go. */
function fakeRust(server: FakeHermes) {
  const names: string[] = [];
  const discarded: string[] = [];
  let n = 0;
  let retained = new Set<string>();
  const remove = (path: string) => {
    if (server.files[path] === undefined) return;
    discarded.push(path);
    delete server.files[path];
  };
  const syncOutbox = async () => {
    const next = new Set(outboxAttachmentPaths());
    for (const path of retained) if (!next.has(path)) remove(path);
    retained = next;
  };
  stopOutboxes.push(subscribeOutbox(() => { queueMicrotask(() => { void syncOutbox(); }); }));
  let staged: string[] = [];
  rustSide.stage = (bytes, name) => {
    const path = `/run/user/1000/hermes-chat/captures/4242/${n++}/${name}`;
    server.files[path] = String.fromCharCode(...new Uint8Array(bytes));
    staged.push(path);
    return path;
  };
  const wiring: DeskWiring = {
    api: {
      discard: async (path) => {
        if (!retained.has(path)) remove(path);
      },
    },
    syncOutbox,
  };
  return {
    wiring,
    names,
    discarded,
    /** The owner pastes an image into `into`, a composer; resolves to where Rust saved it. */
    land: async (bytes = PNG, into: HTMLElement = composer()) => {
      const name = `pasted-${names.length + 1}.png`;
      names.push(name);
      staged = [];
      const file = new File([Uint8Array.from(bytes, (c) => c.charCodeAt(0))], name, { type: "image/png" });
      fireEvent.paste(into, { clipboardData: { types: ["Files"], files: [file], getData: () => "" } });
      await waitFor(() => expect(staged).toHaveLength(1));
      return staged[0];
    },
  };
}

/** Signed in with one Active chat and the New chat pane on screen, focus in its composer. */
async function signedIn({ strict = false } = {}) {
  const server = new FakeHermes();
  server.sessions = [row("backup", 1, { pinned: true, title: "Nightly backup" }), row("nas", 2, { pinned: true, title: "NAS disks" })];
  server.transcripts = { backup: [{ role: "user", text: "Why did the backup fail?" }], nas: [{ role: "user", text: "Which disk is failing?" }] };
  const hermes = await connect(server.openPipe, undefined, localChatCache({ mode: "ssh", sshTarget: "lena@hermes", url: "", username: "lena" }));
  running.push(hermes);
  const rust = fakeRust(server);
  const user = userEvent.setup();
  const main = <Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "lena@hermes", url: "", username: "lena" }} onSignOut={async () => {}} deskWiring={rust.wiring} />;
  const view = render(strict ? <StrictMode>{main}</StrictMode> : main);
  await screen.findByRole("button", { name: /Nightly backup/ });
  await settle(hermes);
  composer().focus();
  return { server, hermes, rust, user, view };
}

/** The pasted images staged in the composer (not the names shown on sent messages). */
const chips = () => [...document.querySelectorAll(".composer .chip")].filter((c) => /pasted-\d+\.png/.test(c.textContent ?? ""));

describe("A pasted image in the composer", () => {
  it("has no screenshot button beside it", async () => {
    await signedIn();
    expect(screen.queryByRole("button", { name: /screenshot/i })).toBeNull();
  });

  it("stays in each pane's chat, and in its chat once the pane closes", async () => {
    const { rust, user } = await signedIn();
    await user.keyboard("{Control>}\\{/Control}");
    await user.click(screen.getByRole("button", { name: /Nightly backup/ }));
    const [left, right] = [...document.querySelectorAll<HTMLElement>(".pane")];
    await rust.land(PNG, within(left).getByPlaceholderText("Message Hermes"));
    await waitFor(() => expect(left.querySelectorAll(".chip")).toHaveLength(1));
    expect(right.querySelectorAll(".chip")).toHaveLength(0);
    await rust.land(PNG, within(right).getByPlaceholderText("Message Hermes"));
    await waitFor(() => expect(right.querySelectorAll(".chip")).toHaveLength(1));
    expect(left.querySelectorAll(".chip")).toHaveLength(1);
    expect(rust.discarded).toEqual([]);
    // Closing a pane leaves its chat's files staged in the chat (#443).
    await user.click(within(left).getByRole("button", { name: "Close the left pane" }));
    expect(chips()).toHaveLength(1);
    expect(rust.discarded).toEqual([]);
    await user.click(screen.getByRole("button", { name: "New chat (Ctrl+N)" }));
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(rust.discarded).toEqual([]);
  });

  it("waits for review, then goes to Hermes with the message and is deleted", async () => {
    const { server, hermes, rust, user } = await signedIn();
    const path = await rust.land();
    await screen.findByText(rust.names[0]);
    // Nothing went to Hermes yet: it waits in the composer for the owner.
    expect(server.requests.map((r) => r.method)).not.toContain("image.attach_bytes");
    expect(rust.discarded).toEqual([]);

    await user.type(composer(), "What's wrong in this dialog?{Enter}");
    await waitFor(() => expect(rust.discarded).toEqual([path]));
    await settle(hermes);
    const sent = server.requests.filter((r) => ["image.attach_bytes", "prompt.submit"].includes(r.method));
    expect(sent.map((r) => r.method)).toEqual(["image.attach_bytes", "prompt.submit"]);
    expect(sent[0].params).toMatchObject({ filename: rust.names[0], content_base64: btoa(PNG) });
    expect(sent[1].params).toMatchObject({ text: "What's wrong in this dialog?" });
  });

  it("stays in the failed message for Retry when Hermes rejects it", async () => {
    const { server, hermes, rust, user } = await signedIn();
    server.handlers["image.attach_bytes"] = (r) => server.fail(r.id, 4004, "unknown method image.attach_bytes");
    await rust.land();
    await waitFor(() => expect(chips()).toHaveLength(1));
    await user.type(composer(), "What's wrong here?{Enter}");
    await settle(hermes);

    await screen.findByRole("button", { name: /Retry/ });
    expect(chips()).toHaveLength(0);
    expect(rust.discarded).toEqual([]);
    expect(hermes.getSnapshot().chats.flatMap((c) => c.items).some((i) => i.kind === "user" && i.outgoing?.attachments?.length === 1)).toBe(true);
    expect(server.requests.map((r) => r.method)).not.toContain("prompt.submit");
  });

  it.each(["image.attach_bytes", "prompt.submit"])("is kept after a disconnect during %s, then the owner can dismiss it", async (method) => {
    const { server, hermes, rust, user } = await signedIn();
    server.handlers[method] = () => server.drop("closed during send");
    const path = await rust.land();
    await waitFor(() => expect(chips()).toHaveLength(1));
    await user.type(composer(), "What's wrong here?{Enter}");
    await settle(hermes);

    await screen.findByRole("button", { name: /Retry/ });
    expect(chips()).toHaveLength(0);
    expect(rust.discarded).toEqual([]);
    expect(server.files[path]).toBe(PNG);
    expect(server.requests.filter((r) => r.method === method)).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(rust.discarded).toEqual([path]));
    expect(server.files[path]).toBeUndefined();
  });

  it("goes with the failed message's Retry after leaving and returning to the chat", async () => {
    const { server, hermes, rust, user } = await signedIn();
    const accept = server.handlers["image.attach_bytes"];
    server.handlers["image.attach_bytes"] = (r) => server.fail(r.id, 4004, "unknown method image.attach_bytes");
    const path = await rust.land();
    await waitFor(() => expect(chips()).toHaveLength(1));
    await user.type(composer(), "Explain the screen{Enter}");
    await screen.findByRole("button", { name: /Retry/ });
    await user.click(screen.getByRole("button", { name: /Nightly backup/ }));
    expect(rust.discarded).toEqual([]);
    expect(server.files[path]).toBe(PNG);
    await user.click(screen.getByRole("button", { name: /Explain the screen/ }));
    server.handlers["image.attach_bytes"] = accept;
    await user.click(await screen.findByRole("button", { name: /Retry/ }));
    await settle(hermes);
    await waitFor(() => expect(rust.discarded).toEqual([path]));
    expect(server.requests.filter((r) => r.method === "image.attach_bytes")).toHaveLength(2);
    expect(server.requests.filter((r) => r.method === "prompt.submit")).toHaveLength(1);
  });

  it("is deleted when the owner removes it before sending", async () => {
    const { rust, user } = await signedIn();
    const path = await rust.land();
    await waitFor(() => expect(chips()).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(chips()).toHaveLength(0);
    expect(rust.discarded).toEqual([path]);
  });

  it("is deleted when the window signs out with it still staged", async () => {
    const { rust, view } = await signedIn();
    const path = await rust.land();
    await waitFor(() => expect(chips()).toHaveLength(1));
    view.unmount();
    expect(rust.discarded).toEqual([path]);
  });
});

describe("Attachments staged in each chat (#443)", () => {
  const openChat = async (user: ReturnType<typeof userEvent.setup>, hermes: Hermes, title: RegExp) => {
    await user.click(screen.getByRole("button", { name: title }));
    await settle(hermes);
  };
  const rowOf = (title: RegExp) => screen.getByRole("button", { name: title }).closest(".row") as HTMLElement;

  it("keeps a chat's pasted image while another chat is opened and sent in, and sends it with that chat's next message", async () => {
    const { server, hermes, rust, user } = await signedIn();
    await openChat(user, hermes, /Nightly backup/);
    const path = await rust.land();
    await waitFor(() => expect(chips()).toHaveLength(1));

    await openChat(user, hermes, /NAS disks/);
    expect(chips()).toHaveLength(0);
    await user.type(composer(), "Check sda{Enter}");
    await settle(hermes);
    expect(server.requests.filter((r) => r.method === "image.attach_bytes")).toHaveLength(0);
    expect(rust.discarded).toEqual([]);
    expect(server.files[path]).toBe(PNG);
    expect(stagedFiles.getSnapshot()).toEqual([rust.names[0]]);

    await openChat(user, hermes, /Nightly backup/);
    expect(chips()).toHaveLength(1);
    await user.type(composer(), "Here is the error{Enter}");
    await settle(hermes);
    await waitFor(() => expect(rust.discarded).toEqual([path]));
    const attached = server.requests.filter((r) => r.method === "image.attach_bytes");
    expect(attached).toHaveLength(1);
    expect(attached[0].params).toMatchObject({ filename: rust.names[0], content_base64: btoa(PNG) });
    expect(chips()).toHaveLength(0);
    expect(stagedFiles.getSnapshot()).toEqual([]);
  });

  it("keeps the New chat pane's pasted image while a chat is open in its place", async () => {
    const { rust, user, hermes } = await signedIn();
    const path = await rust.land();
    await waitFor(() => expect(chips()).toHaveLength(1));
    await openChat(user, hermes, /Nightly backup/);
    expect(chips()).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "New chat (Ctrl+N)" }));
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(rust.discarded).not.toContain(path);
  });

  it("shows a chat's pasted image in both panes on it, as they share its Draft, and sends it once", async () => {
    const { server, rust, user, hermes } = await signedIn();
    await openChat(user, hermes, /Nightly backup/);
    await user.keyboard("{Control>}\\{/Control}");
    await settle(hermes);
    const [left, right] = [...document.querySelectorAll<HTMLElement>(".pane")];
    const path = await rust.land(PNG, within(left).getByPlaceholderText("Message Hermes"));
    await waitFor(() => expect(left.querySelectorAll(".chip")).toHaveLength(1));
    expect(right.querySelectorAll(".chip")).toHaveLength(1);
    await user.type(within(right).getByPlaceholderText("Message Hermes"), "From the right{Enter}");
    await settle(hermes);
    await waitFor(() => expect(rust.discarded).toEqual([path]));
    expect(document.querySelectorAll(".composer .chip")).toHaveLength(0);
    expect(server.requests.filter((r) => r.method === "image.attach_bytes")).toHaveLength(1);
  });

  it("deletes a pasted image once the owner removes it from its chat, even after switching away and back", async () => {
    const { rust, user, hermes } = await signedIn();
    await openChat(user, hermes, /Nightly backup/);
    const path = await rust.land();
    await waitFor(() => expect(chips()).toHaveLength(1));
    await openChat(user, hermes, /NAS disks/);
    await openChat(user, hermes, /Nightly backup/);
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(chips()).toHaveLength(0);
    expect(rust.discarded).toEqual([path]);
  });

  it("moves a pasted image the owner picks from the staging folder into the chat they pick it in, so no chip outlives its file", async () => {
    const { server, hermes, rust, user } = await signedIn();
    await openChat(user, hermes, /Nightly backup/);
    const path = await rust.land();
    await waitFor(() => expect(chips()).toHaveLength(1));

    await openChat(user, hermes, /NAS disks/);
    rustSide.picked = [path];
    await user.click(screen.getByRole("button", { name: "Attach files" }));
    await waitFor(() => expect(chips()).toHaveLength(1));
    await user.type(composer(), "Same dialog here{Enter}");
    await settle(hermes);
    // Hermes confirmed it, so Rust lets go of the file with the outbox row.
    await waitFor(() => expect(server.files[path]).toBeUndefined());
    expect(server.requests.filter((r) => r.method === "image.attach_bytes")).toHaveLength(1);

    for (const title of [/NAS disks/, /Nightly backup/]) {
      await openChat(user, hermes, title);
      const missing = chips().map((c) => c.textContent).filter((text) => !Object.keys(server.files).some((p) => text?.includes(p.split("/").pop()!)));
      expect(missing).toEqual([]);
    }
    expect(chips()).toHaveLength(0);
  });

  it("keeps what is attached in a window StrictMode mounts twice, with the desk of the second mount", async () => {
    const { rust, user, hermes } = await signedIn({ strict: true });
    await openChat(user, hermes, /Nightly backup/);
    const path = await rust.land();
    await waitFor(() => expect(chips()).toHaveLength(1));
    await openChat(user, hermes, /NAS disks/);
    await openChat(user, hermes, /Nightly backup/);
    expect(chips()).toHaveLength(1);
    expect(rust.discarded).not.toContain(path);
  });

  it("deletes a chat's pasted images when the chat is deleted", async () => {
    const { server, rust, user, hermes } = await signedIn();
    await openChat(user, hermes, /NAS disks/);
    const path = await rust.land();
    await waitFor(() => expect(chips()).toHaveLength(1));
    await openChat(user, hermes, /Nightly backup/);
    expect(rust.discarded).toEqual([]);
    await user.click(within(rowOf(/NAS disks/)).getByTitle("Delete"));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete chat" }));
    await settle(hermes);
    await waitFor(() => expect(rust.discarded).toEqual([path]));
    expect(server.sessions.some((s) => s.id === "nas")).toBe(false);
    expect(stagedFiles.getSnapshot()).toEqual([]);
  });
});

describe("Images placed in the words (ADR 0200)", () => {
  const caretAt = (at: number) =>
    act(() => {
      composer().focus();
      composer().setSelectionRange(at, at);
      fireEvent.select(composer());
    });
  const stripped = () => document.querySelectorAll(".composer .chips .chip");
  const lastBubble = () => [...document.querySelectorAll<HTMLElement>(".msg.user")].at(-1)!;
  const openChat = async (user: ReturnType<typeof userEvent.setup>, hermes: Hermes, title: RegExp) => {
    await user.click(screen.getByRole("button", { name: title }));
    await settle(hermes);
  };

  it("keeps the first image above the words, marks each later one where the cursor was, and sends each image's bytes in the order its mark says", async () => {
    const { server, hermes, rust, user } = await signedIn();
    await rust.land("\x89PNG first");
    await waitFor(() => expect(stripped()).toHaveLength(1));
    await user.type(composer(), "Compare these.{Shift>}{Enter}{/Shift}Both are image.png");
    await caretAt("Compare these.".length);
    server.files["/home/lena/left/image.png"] = "\x89PNG left";
    server.files["/home/lena/right/image.png"] = "\x89PNG right";
    rustSide.picked = ["/home/lena/left/image.png", "/home/lena/right/image.png"];
    await user.click(screen.getByRole("button", { name: "Attach files" }));
    const placed = "Compare these. [image 2: image.png] [image 3: image.png]\nBoth are image.png";
    await waitFor(() => expect(composer().value).toBe(placed));
    // The two marked images aren't shown again above the words; the first still is.
    expect(stripped()).toHaveLength(1);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Attach files" }));

    await user.click(composer());
    await user.keyboard("{Enter}");
    await settle(hermes);
    const uploads = server.requests.filter((r) => r.method === "image.attach_bytes").map((r) => r.params.content_base64);
    expect(uploads).toEqual([btoa("\x89PNG first"), btoa("\x89PNG left"), btoa("\x89PNG right")]);
    expect(server.requests.find((r) => r.method === "prompt.submit")?.params).toMatchObject({ text: placed });

    const bubble = lastBubble();
    expect(bubble.querySelectorAll(".msg-images > *")).toHaveLength(1);
    const inline = [...bubble.querySelectorAll(".bubble-text .inline-image")];
    expect(inline.map((i) => i.textContent)).toEqual(["image.png", "image.png"]);
    expect(bubble.querySelector(".bubble-text")!.textContent).toBe("Compare these. image.png image.png\nBoth are image.png");
  });

  it("marks a late image where the cursor was when it was added, after words typed before it meanwhile, and leaves the focus where it went", async () => {
    const { hermes, rust, user } = await signedIn();
    await rust.land();
    await waitFor(() => expect(stripped()).toHaveLength(1));
    await user.type(composer(), "one two");
    await caretAt(3);
    const check = hermes.checkAttachments.bind(hermes);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const checking = vi.spyOn(hermes, "checkAttachments").mockImplementationOnce(async (paths) => {
      await gate;
      return check(paths);
    });
    await rust.land("\x89PNG late");
    await waitFor(() => expect(checking).toHaveBeenCalledTimes(1));
    await caretAt(0);
    await user.keyboard("zero ");
    await caretAt(composer().value.length);
    await user.keyboard(" three");
    const elsewhere = screen.getByRole("button", { name: "Attach files" });
    act(() => elsewhere.focus());
    await act(async () => release());
    await waitFor(() => expect(composer().value).toBe(`zero one [image 2: ${rust.names[1]}] two three`));
    expect(document.activeElement).toBe(elsewhere);
    expect(stripped()).toHaveLength(1);
    checking.mockRestore();
    await user.clear(composer());
  });

  it("marks nothing when the chat changed before a picked image was checked: it waits above the words of the chat it was added to", async () => {
    const { server, hermes, rust, user } = await signedIn();
    await openChat(user, hermes, /Nightly backup/);
    await rust.land();
    await waitFor(() => expect(stripped()).toHaveLength(1));
    await user.type(composer(), "backup words");
    const check = hermes.checkAttachments.bind(hermes);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const checking = vi.spyOn(hermes, "checkAttachments").mockImplementationOnce(async (paths) => {
      await gate;
      return check(paths);
    });
    server.files["/home/lena/late.png"] = "\x89PNG late";
    rustSide.picked = ["/home/lena/late.png"];
    await user.click(screen.getByRole("button", { name: "Attach files" }));
    await waitFor(() => expect(checking).toHaveBeenCalledTimes(1));
    await openChat(user, hermes, /NAS disks/);
    await user.type(composer(), "nas words");
    await act(async () => release());
    await settle(hermes);
    expect(composer().value).toBe("nas words");
    expect(stripped()).toHaveLength(0);
    await openChat(user, hermes, /Nightly backup/);
    expect(composer().value).toBe("backup words");
    expect([...stripped()].map((c) => c.textContent)).toEqual([expect.stringMatching(/^pasted-/), expect.stringMatching(/^late\.png/)]);
    checking.mockRestore();
  });

  it("takes a whole mark out with Backspace and brings it back with Undo, and renumbers the marks of what is sent", async () => {
    const { server, hermes, rust, user } = await signedIn();
    await rust.land("\x89PNG top");
    await waitFor(() => expect(stripped()).toHaveLength(1));
    await user.type(composer(), "see");
    await rust.land("\x89PNG marked");
    const mark = `[image 2: ${rust.names[1]}]`;
    await waitFor(() => expect(composer().value).toBe(`see ${mark}`));
    expect(stripped()).toHaveLength(1);

    await caretAt(composer().value.length);
    await user.keyboard("{Backspace}");
    expect(composer().value).toBe("see ");
    // The image isn't dropped with its mark: it waits above the words.
    expect(stripped()).toHaveLength(2);
    await user.keyboard("{Control>}z{/Control}");
    expect(composer().value).toBe(`see ${mark}`);
    expect(stripped()).toHaveLength(1);

    // The image above goes; the marked one stays where it is, now the first sent.
    await user.click(within(stripped()[0] as HTMLElement).getByRole("button", { name: "Remove" }));
    expect(stripped()).toHaveLength(0);
    expect(composer().value).toBe(`see ${mark}`);
    await caretAt(composer().value.length);
    await user.keyboard("{Enter}");
    await settle(hermes);
    expect(server.requests.filter((r) => r.method === "image.attach_bytes").map((r) => r.params.content_base64)).toEqual([btoa("\x89PNG marked")]);
    expect(server.requests.find((r) => r.method === "prompt.submit")?.params).toMatchObject({ text: `see [image 1: ${rust.names[1]}]` });
    expect(lastBubble().querySelectorAll(".msg-images")).toHaveLength(0);
    expect(lastBubble().querySelectorAll(".bubble-text .inline-image")).toHaveLength(1);
  });

  it("places a stored message's images by its marks without reading any this app didn't send, and keeps an old message's above its words", async () => {
    const { server, hermes, user } = await signedIn();
    server.transcripts.backup = [
      { role: "user", text: "old one\n@image:/home/lena/.hermes/images/upload_a.png" },
      { role: "assistant", text: "Seen." },
      { role: "user", text: "look [image 2: second.png] and [image 9: nothing.png]\n@image:/home/lena/.hermes/images/upload_b.png\n@image:/home/lena/.hermes/images/upload_c.png" },
    ];
    const reads = vi.spyOn(hermes, "readHostFile");
    await openChat(user, hermes, /Nightly backup/);
    const [old, placed] = [...document.querySelectorAll<HTMLElement>(".msg.user")];
    expect(old.querySelectorAll(".msg-images > *")).toHaveLength(1);
    expect(old.querySelector(".bubble-text")!.textContent).toBe("old one");
    expect(placed.querySelectorAll(".msg-images > *")).toHaveLength(1);
    const inline = placed.querySelectorAll(".bubble-text .inline-image");
    expect(inline).toHaveLength(1);
    expect(within(inline[0] as HTMLElement).getByRole("button", { name: "Show image upload_c.png" })).toBeTruthy();
    expect(placed.querySelector(".bubble-text")!.textContent).toMatch(/^look upload_c\.png.*second\.png and \[image 9: nothing\.png\]$/s);
    expect(reads).not.toHaveBeenCalled();
  });
});
