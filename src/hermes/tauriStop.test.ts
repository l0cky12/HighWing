import { beforeEach, expect, it, vi } from "vitest";
import { onDesktopStop } from "./tauriStop";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  invoke.mockReset();
  listen.mockReset();
  listen.mockResolvedValue(vi.fn());
});

it("takes a `hermes-chat --stop` when Rust says one waits, and acknowledges it", async () => {
  let event!: () => void;
  listen.mockImplementation(async (name, fn) => {
    expect(name).toBe("stop-requested");
    event = fn;
    return vi.fn();
  });
  invoke.mockResolvedValueOnce(null).mockResolvedValueOnce(4).mockResolvedValueOnce(undefined);
  const stopped = vi.fn();
  const dispose = onDesktopStop(stopped);
  await flush();
  expect(stopped).not.toHaveBeenCalled();
  event();
  await flush();
  expect(stopped).toHaveBeenCalledTimes(1);
  expect(invoke.mock.calls).toEqual([["stop_pending_request"], ["stop_pending_request"], ["stop_ack_request", { id: 4 }]]);
  dispose();
});

it("leaves a pending Stop for the next window when cleanup happens while Rust answers", async () => {
  let answer!: (id: number | null) => void;
  invoke.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
  const old = vi.fn();
  const dispose = onDesktopStop(old);
  await flush();
  dispose();
  answer(7);
  await flush();
  expect(old).not.toHaveBeenCalled();
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["stop_pending_request"]);

  invoke.mockResolvedValueOnce(7).mockResolvedValueOnce(undefined);
  const next = vi.fn();
  const disposeNext = onDesktopStop(next);
  await flush();
  expect(next).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenLastCalledWith("stop_ack_request", { id: 7 });
  disposeNext();
});

it("unregisters once and never asks Rust when disposed before listener registration finishes", async () => {
  let registered!: (unlisten: () => void) => void;
  listen.mockImplementationOnce(() => new Promise((resolve) => (registered = resolve)));
  const unlisten = vi.fn();
  const stopped = vi.fn();
  const dispose = onDesktopStop(stopped);
  dispose();
  registered(unlisten);
  await flush();
  expect(unlisten).toHaveBeenCalledTimes(1);
  expect(invoke).not.toHaveBeenCalled();
  expect(stopped).not.toHaveBeenCalled();
});

it("serializes startup and event requests, acknowledging only after handling them", async () => {
  let event!: () => void;
  let answer!: (id: number | null) => void;
  const unlisten = vi.fn();
  listen.mockImplementation(async (_, fn) => {
    event = fn;
    return unlisten;
  });
  invoke
    .mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(null);
  const stopped = vi.fn(() => expect(invoke).not.toHaveBeenCalledWith("stop_ack_request", { id: 3 }));
  const dispose = onDesktopStop(stopped);
  await flush();
  event();
  event();
  answer(3);
  await flush();
  expect(stopped).toHaveBeenCalledTimes(1);
  expect(invoke.mock.calls).toEqual([["stop_pending_request"], ["stop_ack_request", { id: 3 }], ["stop_pending_request"]]);
  dispose();
  await flush();
  expect(unlisten).toHaveBeenCalledTimes(1);
});
