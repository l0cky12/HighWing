# A provider hidden in Settings leaves every model list in Highwing, and Hermes keeps it

> **Accepted.** Issue #122. The code is `offeredProviders`, `offeredCatalog`, `pickerRows` and `modelFromArg` in `src/hermes/models.ts`, `hiddenProviders` with `hiddenProvidersOf` and `setProviderHidden` in `src/hermes/uiPrefs.ts`, `src/ui/modelLists.ts`, and `src/ui/ProviderVisibility.tsx`. Tested in `src/hermes/models.test.ts`, `src/hermes/uiPrefs.test.ts`, `src/hermes/profileLocalData.test.ts`, `src/hermes/botSetupApply.transport.test.ts`, `src/ui/providerVisibility.test.tsx`, `src/ui/modelSettings.test.tsx`, `src/ui/writingModelSettings.test.tsx`, `src/ui/profileSettings.test.tsx`, `src/ui/projects.test.tsx` and `src/ui/work.test.tsx`.

The owner has providers configured on Hermes that they don't use, and wants their models out of the way without deleting keys, signing out or removing endpoints. After they turn OpenRouter off, its models should leave the composer's model list, `/model`, and every other place a model is picked, until they turn it back on.

## Decisions

- **It is a display preference in Highwing, nothing more.** Nothing reaches Hermes. Keys, sign-ins, endpoints and running work are untouched. The words say "hidden in Highwing's model lists", never "disabled", so nothing suggests Hermes stopped using the provider.
- **A provider is its route.** The preference is a set of provider slugs. OpenAI's GPT-5 through OpenRouter belongs to OpenRouter, so hiding OpenRouter leaves OpenAI's own GPT-5 on offer.
- **It is kept per connection**, in `uiPrefs.hiddenProviders`, keyed by `connectionScope`, as the Writing model is (ADR 0209): provider slugs and custom endpoints are a server's own. Every profile of a connection shares it. Removing a connection drops its entry. It survives a restart and a reconnect.
- **What is kept is the hidden set.** No entry means every provider shows, so nothing changes for an owner who never opens the switches, and a provider Hermes lists for the first time shows until it is hidden.
- **One filter.** `offeredProviders(providers, hidden)` is generic over the three catalog shapes (the composer's `ModelCatalog`, Settings → Model's `CatalogProvider[]`, and a task's `ModelProvider[]`), and every list calls it or a function built on it:
  - `pickerRows` (the composer's list, Compare, `/model` suggestions, Settings → Model's Text generation and Project instructions rows, and project defaults) leaves the hidden providers' sections and their Favorites out. It doesn't rebuild a hidden provider's star as an unavailable row. The stars stay in `modelFavorites`, so they come back when the provider shows again.
  - `modelFromArg` (`/model <name>` typed whole) searches only the shown providers. When only a hidden one has the name, it refuses, naming the provider and Settings → Providers, and no switch is sent. A name both a shown and a hidden provider list resolves to the shown one.
  - `ProviderOptions` and `ModelSelect` (Settings → Model's main, subagent and helper fields, and the Writing model), the profile form's provider select, and a task's model select list only the shown providers.
  - `offeredCatalog` filters the catalog a new bot's Bot setup brief and a setup card are given, so the bot offers none of the hidden models and a card can't set one.
- **The filter runs where a list is drawn, not where the catalog is read.** The catalog stays as Hermes sent it, so the server's list, a REST fallback and the app's own fallback list are all filtered the same way, and an empty list after hiding is never taken for a failed read that a fallback should replace.
- **What is already set stays.** A chat's model, the sticky pick, a project default, a profile's model, a helper task's pin, the Writing model and a task's model are never changed by hiding. Each field shows its current value with "(hidden in Highwing)" or a note saying the provider's models aren't offered for a new pick. Once the owner picks something else, the hidden provider isn't offered back.
- **Every provider may be hidden.** Settings warns that the lists are empty, and the composer's list says that every provider is hidden and where to show them again. The current model stays.
- **Settings → Providers → Model lists** has one switch per provider Hermes lists for the shown profile, with its slug and model count, reached by Tab and toggled with Space or Enter. A hidden provider Hermes no longer lists keeps its row, so it can always be shown again.
- **The scope reaches the lists through a React context.** `Main` provides its connection's scope as `ModelListScope`, and `useHiddenProviders()` reads the set from the prefs. Outside a connection's screens nothing is hidden. The transport, which builds the Bot setup inventory, reads the same set through `Hermes.hiddenProviders`, which `Main` sets.

## Considered options

- **Filter the catalog as it is read**, in `readModels` and `ModelSettingsApi.providers`. One place, but a model already set on a hidden provider would lose its name and capabilities, and an empty list would look like a failed read. Rejected.
- **Keep the enabled set instead of the hidden one.** A provider added on the server would stay hidden until the owner found it. Rejected.
- **Keep it per connection and profile.** Profiles on one server share provider slugs, so the owner would hide the same provider once per profile. Rejected.
- **Refuse to hide the last shown provider.** It blocks an owner who wants to switch providers by hiding first. An empty list that says why is enough. Rejected.
- **Turn the provider off on Hermes.** Hermes has no such switch, and it would change other clients. Out of scope.

## Consequences

- Another computer, or another Hermes client, still lists the hidden provider. Nothing syncs.
- A chat or setting left on a hidden provider keeps running on it. The owner sees that in the field's note, not as an error.
- When Hermes lists no models and the picker shows the app's fallback list, Settings → Providers lists only what Hermes's REST catalog answers, so a fallback-only provider can't be hidden from there. The fallback list is a guess and short on purpose.
- Settings → Model's helper rows, the Writing model and the profile form still accept a typed model name for a shown provider, as before.
