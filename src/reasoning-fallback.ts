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

export function streamOtari(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) {
  const stream = createAssistantMessageEventStream();
  const openAIModel = model as Model<"openai-completions">;

  (async () => {
    try {
      const firstAttempt = openAICompletionsApi().streamSimple(
        openAIModel,
        context,
        options,
      );
      let started = false;
      for await (const event of firstAttempt) {
        if (!started && event.type === "error") {
          const fallbackModel: Model<"openai-completions"> = {
            ...openAIModel,
            compat: { ...openAIModel.compat, supportsReasoningEffort: false },
          };
          const fallbackAttempt = openAICompletionsApi().streamSimple(
            fallbackModel,
            context,
            options,
          );
          for await (const fallbackEvent of fallbackAttempt)
            stream.push(fallbackEvent);
          stream.end();
          return;
        }
        if (event.type === "start") started = true;
        stream.push(event);
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
