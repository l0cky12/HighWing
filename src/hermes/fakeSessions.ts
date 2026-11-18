import { LegacyProtocol, type Port } from "./sessionProtocol";

export const legacyOver = (rpc: (method: never, params: Record<string, unknown>) => Promise<unknown>) =>
  new LegacyProtocol({
    call: (async (method: never, params: Record<string, unknown>, options?: { read?: (result: unknown) => unknown }) => {
      const result = await rpc(method, params);
      return options?.read ? options.read(result) : result;
    }) as Port["call"],
    reply: async () => {},
    inHermesQueue: () => false,
    track: () => {},
  });
