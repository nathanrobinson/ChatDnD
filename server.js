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
 * Formats a plain text string into the card structure required by the Google Workspace Add-ons API.
 * @param {string} textContent - The message text or DM narration.
 * @returns {object} The structured JSON payload for Google Chat.
 */
function formatChatResponse(textContent) {
  return {
    cardsV2: [
      {
        cardId: "dmResponseCard",
        card: {
          header: {
            title: "🧙‍♂️ Dungeon Master",
            imageUrl: "https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/casino/default/24px.svg"
          },
          sections: [
            {
              widgets: [
                {
                  textParagraph: {
                    text: textContent
                  }
                }
              ]
            }
          ]
        }
      }
    ]
  };
}

app.post('/chat-bot', async (req, res) => {
  try {

    const payload = req.body;

    // 1. Updated Guard Clause to match the Add-on event structure
    // Verify that it's a Chat app host event and contains a message layout
    if (payload?.commonEventObject?.hostApp !== 'CHAT' || !payload?.chat?.messagePayload?.message) {
      console.log("--> Dropped: Request is missing valid Google Chat structure.");
      return res.status(200).send();
    }

    // 2. Extract the text cleanly using the exact nested path from the logs
    const chatMessage = payload.chat.messagePayload.message;
    const userMessage = chatMessage.argumentText || chatMessage.text || "";

    // 3. Text Validation Guard Clause
    if (!userMessage || userMessage.trim() === '') {
      return res.json(formatChatResponse("*The DM leans forward:* I heard you call my name, but I didn't catch your action. What would you like to do?"));
    }

    const threadId = chatMessage.thread?.name || chatMessage.space?.name || "global-fallback";

    // 1. Retrieve or initialize the historic conversation log for this thread
    if (!sessionHistories.has(threadId)) {
      sessionHistories.set(threadId, []);
    }
    const history = sessionHistories.get(threadId);

    // 2. Append the user's latest turn to the history log
    history.push({
      role: 'user',
      parts: [{ text: userMessage }]
    });

    // 3. Request generation from Gemini.
    // By providing the entire historic array and system instructions,
    // Google's implicit caching will auto-activate once the context surpasses the token threshold.
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash', // Optimal cost/speed model for conversational flows
      contents: history,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION
      }
    });

    const botReply = response.text;
    console.log(`[Thread: ${threadId}] Processed bot response`);

    // 4. Append the model's response to the history log to preserve state for the next turn
    history.push({
      role: 'model',
      parts: [{ text: botReply }]
    });

    // 5. Keep memory optimized (Optional: keep only last 30 turns to fit free-tier memory comfortably)
    if (history.length > 60) { 
      // Removes oldest user/model turn pair
      history.shift();
      history.shift();
    }

    // 6. Return response payload back to Google Chat
    return res.json(formatChatResponse(botReply));

  } catch (error) {
    console.error('Error processing chat event:', error);
    return res.json(formatChatResponse("*The DM stalls:* An error occurred while calculating your fate. Please try again."));
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`D&D Bot backend listening on port ${PORT}`);
});
