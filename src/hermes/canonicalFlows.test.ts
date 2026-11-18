import { describe, expect, it } from "vitest";
import { CANONICAL_FLOWS, flowSocket, type FlowGateway } from "./canonicalFlows";
import { FakeHermes } from "./fakeHermes";
import { RestError } from "./pipe";

function fakeGateway(server = new FakeHermes()) {
  const authority = server.asCanonical({ stubModel: true });
  server.approvalModes = { default: "manual" };
  server.skills.add("default", { dir: "/home/hermes/.hermes/skills/research/arxiv", source: "bundled" }, "---\nname: arxiv\ndescription: Search arXiv.\n---\nSearch arXiv.");
  server.display = { status: { supported: false, installed: false, missing: [], running: false }, lease: { holder: "agent", viewer_hash: null, since: 1, epoch: 0 }, minted: new Set() };
  const gateway: FlowGateway = {
    socket: () =>
      flowSocket(async (onText) => {
        const pipe = await server.openPipe((e) => e.kind === "frame" && onText(e.text), "default");
        return { send: (text) => void pipe.send(text), close: () => void pipe.close() };
      }),
    loseNextAnswer: (method) => authority.loseNextAnswer(method),
    createProfile: async (name) => {
      const pipe = await server.openPipe(() => {}, "default");
      await pipe.request("POST", "/api/profiles", JSON.stringify({ name, clone_from: "default" })).catch(() => {});
      await pipe.close();
    },
    rest: async (method, path, body) => {
      const pipe = await server.openPipe(() => {}, "default");
      try {
        return { status: 200, body: JSON.parse(await pipe.request(method, path, body === undefined ? undefined : JSON.stringify(body))) };
      } catch (e) {
        if (e instanceof RestError) return { status: e.status, body: JSON.parse(e.body) };
        throw e;
      } finally {
        await pipe.close();
      }
    },
  };
  return { server, authority, gateway };
}

describe("FakeHermes's canonical mode, held to the flows a real gateway passes", () => {
  for (const flow of CANONICAL_FLOWS) it(flow.name, () => flow.run(fakeGateway().gateway));
});

describe("FakeHermes's canonical mode, driven by a test", () => {
  const manual = () => {
    const server = new FakeHermes();
    server.asCanonical();
    const heard: string[] = [];
    const pipes: Awaited<ReturnType<typeof server.openPipe>>[] = [];
    const socket = () =>
      flowSocket(async (onText) => {
        const pipe = await server.openPipe((e) => e.kind === "frame" && (heard.push(e.text), onText(e.text)), "default");
        pipes.push(pipe);
        return { send: (text) => void pipe.send(text), close: () => void pipe.close() };
      });
    return { server, socket, heard, pipes };
  };

  it("starts the oldest admission on the test's message.start, and stamps each event of the turn", async () => {
    const { server, socket } = manual();
    const s = await socket();
    const sid = (await s.rpc("session.create", { source: "gui" })).result!.session_id as string;
    const receipt = (await s.rpc("prompt.submit", { session_id: sid, text: "hi", submission_id: "m-1" })).result!;
    server.event(sid, "message.start");
    server.event(sid, "message.delta", { text: "Hel" });
    server.event(sid, "message.complete", { text: "Hello", status: "complete" });
    const stamp = { admission_id: receipt.admission_id, execution_generation: 1, authority_epoch: 1 };
    expect(await s.event("message.start", sid)).toMatchObject(stamp);
    expect(await s.event("message.delta", sid)).toMatchObject({ ...stamp, payload: { text: "Hel" } });
    expect(await s.event("message.complete", sid)).toMatchObject({ ...stamp, payload: { text: "Hello", status: "complete", outcome: "completed", admission_id: receipt.admission_id } });
    expect((await s.rpc("prompt.receipt", { session_id: sid, admission_id: receipt.admission_id })).result).toMatchObject({ status: "terminal", outcome: "completed" });
  });

  it("asks an Approval and a Clarify with events, and Sudo with a request", async () => {
    const { server, socket, heard } = manual();
    const s = await socket();
    await s.rpc("client.capabilities", { server_requests: true });
    const sid = (await s.rpc("session.create", { source: "gui" })).result!.session_id as string;
    await s.rpc("prompt.submit", { session_id: sid, text: "hi", submission_id: "m-1" });
    server.event(sid, "message.start");
    const { id } = server.askApproval(sid);
    server.askClarify(sid, [{ question: "Which?", choices: ["a", "b"] }]);
    expect((await s.event("approval.request", sid)).payload).toMatchObject({ kind: "approval", prompt_id: id, execution_generation: 1, command: "rm -rf /var/log/old" });
    expect((await s.event("clarify.request", sid)).payload).toMatchObject({ kind: "clarify", question: "Which?", choices: ["a", "b"], execution_generation: 1 });
    expect((await s.rpc("approval.respond", { session_id: sid, execution_generation: 1, prompt_id: id, choice: "once" })).result).toEqual({ status: "resolved", prompt_id: id });
    expect(server.approvalAnswers).toEqual([{ id, choice: "once", via: "approval.respond" }]);
    const sudo = server.askSudo(sid);
    expect(JSON.parse(heard.at(-1)!)).toEqual({ jsonrpc: "2.0", id: sudo, method: "sudo", params: { session_id: sid, command: "sudo apt-get install -y ripgrep" } });
  });

  it("sends a legacy handler's answer to the socket that asked, whatever id the other socket used", async () => {
    const { socket } = manual();
    const [a, b] = [await socket(), await socket()];
    const [fromA, fromB] = await Promise.all([a.rpc("gateway.ping", {}), b.rpc("model.options", { profile: "default" })]);
    expect(fromA.result).toEqual({ ok: true });
    expect(fromB.result).toHaveProperty("providers");
  });

  it("drops the next answer to a method, after the request took effect", async () => {
    const { server, socket } = manual();
    const s = await socket();
    server.authority!.loseNextAnswer("session.create");
    void s.rpc("session.create", { source: "gui" });
    const listed = (await s.rpc("session.list", {})).result!;
    expect(listed.sessions).toHaveLength(1);
  });

  it("files a chat under the source it was made with until its first turn, then as Hermes Desktop's", async () => {
    const { server, socket, pipes } = manual();
    const s = await socket();
    const sid = (await s.rpc("session.create", { source: "gui" })).result!.session_id as string;
    const row = async () => (JSON.parse(await pipes[0].request("GET", "/api/sessions?profile=default&limit=50")) as { sessions: { id: string }[] }).sessions.find((r) => r.id === sid);
    expect(await row()).toMatchObject({ source: "gui", created_source: "desktop" });
    await s.rpc("prompt.submit", { session_id: sid, text: "hi", submission_id: "m-1" });
    server.event(sid, "message.start");
    expect(await row()).toMatchObject({ source: "local", created_source: "desktop" });
  });

  it("keeps its sessions when the server drops every socket", async () => {
    const { server, socket } = manual();
    const s = await socket();
    const sid = (await s.rpc("session.create", { source: "gui" })).result!.session_id as string;
    server.drop();
    const again = await socket();
    expect((await again.rpc("session.resume", { session_id: sid })).result).toMatchObject({ session_id: sid, running: false });
  });
});
