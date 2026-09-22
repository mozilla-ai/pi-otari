/**
 * Ids from the last successful discovery against the configured deployment,
 * filled by the provider and read wherever a selector needs checking. Empty
 * means unknown: nothing discovered yet, or a workspace with no models. Neither
 * is evidence against any selector, so nothing is stale until Otari has
 * answered with a list.
 */
export type Catalog = Set<string>;

/** A selector is stale once Otari has answered with a list that omits it. */
export function isStale(catalog: Catalog, id: string): boolean {
  return catalog.size > 0 && !catalog.has(id);
}

/**
 * The model half of a `provider:model` selector. Split at the first colon
 * only: model names can carry their own, such as OpenRouter's `:exacto`.
 */
export function modelPart(selector: string): string {
  const separator = selector.indexOf(":");
  return separator === -1 ? selector : selector.slice(separator + 1);
}

/**
 * Listed selectors that serve the same model under another provider prefix.
 * Derived from the catalog alone, so a retired prefix maps to whichever
 * providers Otari routes that model through today, and to nothing when none
 * does.
 */
export function replacementsFor(selector: string, catalog: Catalog): string[] {
  const model = modelPart(selector);
  return [...catalog].filter(
    (id) => id !== selector && modelPart(id) === model,
  );
}

/** Explain a stale selector and point at the current one where there is one. */
export function describeStale(
  id: string,
  baseUrl: string,
  replacements: string[],
): string {
  const listed =
    replacements.length === 0
      ? "no listed model has the same name"
      : `the same model is listed as ${replacements
          .map((replacement) => `"${replacement}"`)
          .join(" and ")}`;
  return `Otari at ${baseUrl} does not list "${id}"; ${listed}. Open /model to refresh and select a current model.`;
}
