import express from 'express';
import { GoogleGenAI } from '@google/genai';

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize the official Google Gen AI client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Using a lightweight in-memory Map to act as your session database.
// Maps Google Chat Space/Thread ID -> Array of conversation messages.
const sessionHistories = new Map();

// Your unchanging, heavy D&D ruleset framework
const SYSTEM_INSTRUCTION = `
You are an expert, immersive D&D 5e Dungeon Master. 
Maintain a rich narrative environment but format responses with bold text, 
bullet points, or brief paragraphs so they are easy to scan in a chat window.
Adhere strictly to 5e rules, track relative distances, and ask for specific dice rolls and offer to roll when necessary.
`;

/**
 * Formats a plain text string into a card structure containing an interactive response text input.
 * @param {string} textContent - The message text or DM narration.
 * @param {object} [threadContext] - The thread object from the incoming event payload.
 * @returns {object} The structured JSON payload for Google Chat.
 */
function formatChatResponse(textContent, threadContext) {
  const safeText = textContent ? String(textContent) : "The DM remains silent...";

  const messageData = {
    cardsV2: [
      {
        cardId: "dmResponseCard",
        card: { 
          header: {
            title: "🧙‍♂️ Dungeon Master",
            imageUrl: "https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/casino/default/24px.svg"
          },
          sections: [
            // Section 1: The DM's Narration Text
            {
              widgets: [
                {
                  textParagraph: {
                    text: safeText
                  }
                }
              ]
            },
            // Section 2: The Action Input Form
            {
              widgets: [
                {
                  textInput: {
                    name: "playerActionInput", // The key name your server will look for
                    label: "What do you do?",
                    type: "MULTIPLE_LINE",     // Allows multi-line typing
                    placeholderText: "Type your action here (e.g., I draw my sword and attack)..."
                  }
                },
                {
                  buttonList: {
                    buttons: [
                      {
                        text: "Send Action to DM",
                        onClick: {
                          action: {
                            function: "SUBMIT_ACTION" // Custom tracking tag for your endpoint
                          }
                        }
                      }
                    ]
                  }
                }
              ]
            }
          ]
        }
      }
    ]
  };

  if (threadContext) {
    messageData.thread = threadContext;
  }

  return { hostAppDataAction: { chatDataAction: { createMessageAction: { message: messageData } } } };
}

app.post('/chat-bot', async (req, res) => {
  let threadContext = null;

  try {
    const payload = req.body;

    // 1. Verify that it's a Chat app host event and contains a message layout
    if (payload?.commonEventObject?.hostApp !== 'CHAT' || !payload?.chat?.messagePayload?.message) {
      console.log("--> Dropped: Request is missing valid Google Chat structure.");
      return res.status(200).send();
    }

    // 2. Extract the text cleanly using the nested path from the Workspace Add-on logs
    let userMessage = "";
    
    // 2-a. Check if the event came from your text box button click
    if (payload.type === 'CARD_CLICKED') {
      // Pull the exact value by the 'name' attribute we assigned ("playerActionInput")
      const formInputs = payload.commonEventObject?.formInputs;
      userMessage = formInputs?.playerActionInput?.stringInputs?.value[0] || "";
      
      // Grab the thread info from the event object roots
      threadContext = payload.chat?.messagePayload?.message?.thread;
    } else {
      // 2-b. Fall back to standard text entry / @mentions
      const chatMessage = payload.chat?.messagePayload?.message;
      userMessage = chatMessage?.argumentText || chatMessage?.text || "";
      threadContext = chatMessage?.thread;
    }

    // 3. Text Validation Guard Clause
    if (!userMessage || userMessage.trim() === '') {
      return res.json(formatChatResponse(
        "*The DM leans forward:* I heard you call my name, but I didn't catch your action. What would you like to do?",
        threadContext
      ));
    }

    const threadId = chatMessage.space?.name || "global-fallback";

    // 4. Retrieve or initialize the historic conversation log for this thread
    if (!sessionHistories.has(threadId)) {
      sessionHistories.set(threadId, []);
    }
    const history = sessionHistories.get(threadId);

    // 5. Append the user's latest turn to the history log
    history.push({
      role: 'user',
      parts: [{ text: userMessage }]
    });

    // 6. Request generation from Gemini
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash', // Optimal cost/speed model for conversational flows
      contents: history,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION
      }
    });

    const botReply = response.text;
    console.log(`[Thread: ${threadId}] Processed bot response`);

    // 7. Append the model's response to the history log to preserve state for the next turn
    history.push({
      role: 'model',
      parts: [{ text: botReply }]
    });

    // 8. Keep memory optimized (keep only last 30 turns to fit instance memory comfortably)
    if (history.length > 60) { 
      history.shift();
      history.shift();
    }

    // 9. Return response payload back to Google Chat wrapped in the Add-on action envelope
    return res.json(formatChatResponse(botReply, threadContext));

  } catch (error) {
    console.error('Error processing chat event:', error);
    // Safe fall-back reply so the webhook doesn't time out or throw a Console Code 3
    return res.json(formatChatResponse(
      "*The DM stalls:* An error occurred while calculating your fate. Please try again.",
      threadContext
    ));
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`D&D Bot backend listening on port ${PORT}`);
});
