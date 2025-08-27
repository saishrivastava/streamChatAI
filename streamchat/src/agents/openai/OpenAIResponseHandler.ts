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
    private readonly onDispose: () => void
  ) {
    this.chatClient.on("ai_indicator.stop", this.handleStopGenerating);
  }

  run = async () => {
    const {cid, id: message_id} = this.message;
    let isCompleted = false;
    let toolOutputs = [];
    let currentStream: AssistantStream = this.assistantStream;

    try {
      while(!isCompleted){
        for await (const event of currentStream){
          this.handleStreamEvent(event);

          if(event.event === "thread.run.requires_action" && event.data.required_action?.type === "submit_tool_outputs"){
            this.run_id = event.data.id;

            await this.channel.sendEvent({
              type: "ai_indicator.update",
              ai_state: "AI_STATE_EXTERNAL_SOURCES",
              cid,
              message_id,
            });

            const toolCalls = event.data.required_action.submit_tool_outputs.tool_calls;
            toolOutputs = [];

            for (const toolCall of toolCalls) {
              if(toolCall.function.name === "web_search") {
                try {
                  const args = JSON.parse(toolCall.function.arguments);
                  const searchResult = await this.performWebSearch(args.query);
                  toolOutputs.push({
                    tool_call_id: toolCall.id,
                    output: searchResult,
                  });
                  
                } catch (error) {
                  console.error(`Error parsing the tool arguments or performing the web search. Error: ${error}`);
                  toolOutputs.push({
                    tool_call_id: toolCall.id,
                    output: JSON.stringify({"error": "Failed to call tool"})
                  });
                }
              }
            }
            // Exiting the inner loop to submit the outputs of the tool
            break;
          }

          if(event.event === "thread.run.completed") {
            isCompleted = true;
            break; // Exit the inner loop
          }

          if(event.event === "thread.run.failed") {
            isCompleted = true;
            await this.handleError(
              new Error(event.data.last_error?.message ?? "Run Failed")
            );
            break; // Exit the inner loop
          }

          if(isCompleted) break;

          if (toolOutputs.length > 0) {
            currentStream = this.openAi.beta.threads.runs.submitToolOutputsStream(
              this.run_id,
              {
                thread_id: this.openAiThread.id,
                tool_outputs: toolOutputs,
              }
            );
            toolOutputs = []; // Resting the tool outputs
          }
        }
      }
    } catch (error) {
        console.error("An error occurred during the run:", error);
        await this.handleError(error as Error);
    } finally {
      await this.dispose();
    }
  };

  dispose = async () => {
    if (this.is_done) return;
    this.is_done = true;
    this.chatClient.off("ai_indicator.stop", this.handleStopGenerating);
    this.onDispose();
  };

  private handleStopGenerating = async (event: Event) => {
    if (this.is_done || event.message_id !== this.message.id) return;

    try {
        // TODO: Migrate to the new Responses API as this method is deprecated.
        await this.openAi.beta.threads.runs.cancel(
            this.run_id,
            { thread_id: this.openAiThread.id }
        );
    } catch (error) {
        console.error(`Error cancelling the run, ${error}`)
    }

    await this.channel.sendEvent({
        type: "ai_indicator.clear",
        cid: this.message.cid,
        message_id: this.message.id,
    });

    await this.dispose();

  };

  private handleStreamEvent = async (event: OpenAI.Beta.Assistants.AssistantStreamEvent) => {
    const {cid, id} = this.message
    if(event.event === "thread.run.created"){
        this.run_id = event.data.id
    } else if (event.event === "thread.message.delta"){
        const textDelta = event.data.delta.content?.[0]
        if(textDelta?.type === "text" && textDelta.text){
            this.message.text += textDelta.text.value || ""
            const now = Date.now()

            if(now - this.last_update_time > 1000) {
                this.chatClient.partialUpdateMessage(id, {
                    set: {
                        text: this.message.text
                    }
                })
                this.last_update_time = now;
            }
            this.chunk_counter += 1

        }
    } else if (event.event === "thread.message.completed"){
        this.chatClient.partialUpdateMessage(id, {
            set: {
                text: event.data.content[0].type === "text" ? event.data.content[0].text.value : this.message.text,
            },
        });

        this.channel.sendEvent({
            type: "ai_indicator.clear",
            cid,
            message_id: id,
        })
    } else if (event.event === "thread.run.step.created"){
        if(event.data.step_details.type === "message_creation"){
            this.channel.sendEvent({
                type: "ai_indicator.update",
                ai_state: "AI_STATE_CHECKING_SOURCES",
                cid,
                message_id: id,
            })
        }
    }
  };

  private handleError = async (error: Error) => {
    if (this.is_done) return;
    await this.channel.sendEvent({
      type: "ai_indicator.update",
      ai_state: "AI_STATE_ERROR",
      cid: this.message.cid,
      message_id: this.message.id,
    });

    await this.chatClient.partialUpdateMessage(this.message.id, {
      set: {
        text:
          error.message ?? `An error occurred while generating the message.`,
        messaage: error.toString(),
      },
    });

    await this.dispose();
  };

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
