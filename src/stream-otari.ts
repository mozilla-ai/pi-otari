import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  openAICompletionsApi,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import {
  type Catalog,
  describeStale,
  isStale,
  replacementsFor,
} from "./staleness.js";
import type { Diagnostic } from "./types.js";
import { type WebSearchState, wrapFetchWithWebSearch } from "./web-search.js";

function errorMessage(
  model: Model<"openai-completions">,
  error: unknown,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}

function describeReasoningRejection(
  model: Model<"openai-completions">,
  level: NonNullable<SimpleStreamOptions["reasoning"]>,
  message: string,
): string {
  return [
    `Otari model "${model.id}" rejected reasoning level "${level}".`,
    "Otari does not currently expose this model's supported reasoning levels. Try another level or disable reasoning.",
    message,
  ].join("\n\n");
}

/**
 * Explain a gateway error for a selector missing from the last discovered
 * list. Otari's own rejections carry their reason in a `detail` field, which
 * the OpenAI client reduces to "<status> status code (no body)", so the
 * discovered list is what tells the user what to do. The gateway's text
 * follows the explanation.
 */
export function explainGatewayError(
  id: string,
  message: string,
  catalog: Catalog,
): string | undefined {
  if (!isStale(catalog, id)) return undefined;
  // This text becomes the assistant error, which Pi checks for transient-
  // looking statuses (429, 5xx) before retrying the turn. Leave the URL out
  // so the check sees only the gateway's own status.
  return [
    describeStale(id, undefined, replacementsFor(id, catalog)),
    message,
  ].join("\n\n");
}

export interface WebSearchWiring {
  /** Only completions sent to this deployment declare the tool. */
  baseUrl: string;
  state: WebSearchState;
  onDiagnostic?: (diagnostic: Diagnostic) => void;
}

export function createStreamOtari(
  catalog: Catalog,
  webSearch?: WebSearchWiring,
) {
  // Every request's wrapper shares webSearch.state, which is what keeps
  // concurrent refusals down to a single warning.
  const wrapFetch = (inner: typeof fetch) =>
    webSearch
      ? wrapFetchWithWebSearch(
          inner,
          webSearch.baseUrl,
          webSearch.state,
          (detail) =>
            webSearch.onDiagnostic?.({
              level: "warning",
              code: "web-search-refused",
              message: `Otari refused its web search tool: ${detail} The request was retried without web search, which stays off until the next model refresh. Set OTARI_WEB_SEARCH=off to stop declaring it.`,
            }),
        )
      : inner;
  return function streamOtari(
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
  ) {
    const stream = createAssistantMessageEventStream();
    const openAIModel = model as Model<"openai-completions">;
    // Declare the gateway-run web search tool on every request while the
    // gateway welcomes it; the wrapper owns refusal detection and the one
    // transparent retry without the declaration.
    const streamOptions: SimpleStreamOptions | undefined = webSearch
      ? { ...options, fetch: wrapFetch(options?.fetch ?? fetch) }
      : options;

    (async () => {
      try {
        const attempt = openAICompletionsApi().streamSimple(
          openAIModel,
          context,
          streamOptions,
        );
        for await (const event of attempt) {
          if (event.type !== "error") {
            stream.push(event);
            continue;
          }
          const message = event.error.errorMessage ?? "Unknown Otari error";
          const explanation = explainGatewayError(
            openAIModel.id,
            message,
            catalog,
          );
          if (explanation) {
            stream.push({
              ...event,
              error: { ...event.error, errorMessage: explanation },
            });
          } else if (
            options?.reasoning &&
            /reasoning[_\s-]?effort|reasoning level|thinking level/i.test(
              message,
            )
          ) {
            stream.push({
              ...event,
              error: {
                ...event.error,
                errorMessage: describeReasoningRejection(
                  openAIModel,
                  options.reasoning,
                  message,
                ),
              },
            });
          } else {
            stream.push(event);
          }
        }
        stream.end();
      } catch (error) {
        stream.push({
          type: "error",
          reason: "error",
          error: errorMessage(openAIModel, error),
        });
        stream.end();
      }
    })();

    return stream;
  };
}
