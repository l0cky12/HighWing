// Which providers the model lists leave out (ADR 0235): the ones hidden on the connection Main shows, whose scope it
// provides. Outside a connection's screens every provider shows.
import { createContext, useContext, useSyncExternalStore } from "react";
import type { HiddenProviders } from "../hermes/models";
import { getUIPrefs, hiddenProvidersOf, subscribe } from "../hermes/uiPrefs";

/** The `connectionScope` of the connection whose hidden providers apply. */
export const ModelListScope = createContext<string | undefined>(undefined);

export function useHiddenProviders(): HiddenProviders {
  const scope = useContext(ModelListScope);
  return hiddenProvidersOf(useSyncExternalStore(subscribe, getUIPrefs), scope);
}
