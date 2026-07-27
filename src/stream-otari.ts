import {
  type Api,
  type AssistantMessage,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  openAICompletionsApi,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";

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

export function streamOtari(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) {
  const stream = createAssistantMessageEventStream();
  const openAIModel = model as Model<"openai-completions">;

  (async () => {
    try {
      const attempt = openAICompletionsApi().streamSimple(
        openAIModel,
        context,
        options,
      );
      for await (const event of attempt) {
        if (
          event.type === "error" &&
          options?.reasoning &&
          /reasoning[_\s-]?effort|reasoning level|thinking level/i.test(
            event.error.errorMessage ?? "",
          )
        ) {
          stream.push({
            ...event,
            error: {
              ...event.error,
              errorMessage: describeReasoningRejection(
                openAIModel,
                options.reasoning,
                event.error.errorMessage ?? "Unknown Otari error",
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
}
