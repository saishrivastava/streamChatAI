import axios from "axios";
import OpenAI from "openai";
import type { AssistantStream } from "openai/lib/AssistantStream";
import type { Channel, Event, MessageResponse, StreamChat } from "stream-chat";

export class OpenAIResponseHandler {
  private message_text = "";
  private chunk_counter = 0;
  private run_id = "";
  private is_done = false;
  private last_update_time = 0;

  constructor(
    private readonly openAi: OpenAI,
    private readonly openAiThread: OpenAI.Beta.Threads.Thread,
    private readonly assistantStream: AssistantStream,
    private readonly chatClient: StreamChat,
    private readonly channel: Channel,
    private readonly message: MessageResponse,
    private readonly onDisposal: () => void
  ) {
    this.chatClient.on("ai_indicator.stop", this.handleStopGenerating);
  }

  run = async () => {};

  dispose = async () => {};

  private handleStopGenerating = async (event: Event) => {};

  private handleStreamEvent = async (event: Event) => {};

  private handleError = async (event: Event) => {};

  private performWebSearch = async (query: String): Promise<string> => {
    const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

    if (!TAVILY_API_KEY) {
      return JSON.stringify({
        error: "Web Search is not available. The API Key is not configured.",
      });
    }

    console.log(`Performing a web search for ${query}`);

    try {
      const response = await axios.post(
        "https://api.tavily.com/search",
        {
          query,
          search_depth: "advanced",
          max_results: 5,
          include_answer: true,
          include_raw_content: false,
        },
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TAVILY_API_KEY}`,
          },
        }
      );

      const data = response.data;
      console.log(`Tavily Search Successful for query: ${query}`);
      return JSON.stringify(data);
    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        console.log(`Tavily Search Failed for query: ${query}`);
        console.error(`Axios error: ${error.response?.data || error.message}`);
        return JSON.stringify({
          error: `Failed to perform web search with status ${error.response?.status}`,
          details: error.response?.data || error.message,
        });
      } else {
        console.error(
          `An unexpected error occurred during web search for query: ${query} \n error: ${error}`
        );
        return JSON.stringify({
          error: `An unexpected error occurred during web search.`,
        });
      }
    }
  };
}
