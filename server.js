import express from 'express';
import { GoogleGenAI } from '@google/genai';

const app = express();
app.use(express.json());

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

app.post('/chat-bot', async (req, res) => {
  try {
    const event = req.body;

    // Verify this is a user message event from Google Chat
    if (!event || event.type !== 'MESSAGE') {
      return res.status(200).send();
    }

    // Extract conversation context identifiers from Google Chat payload
    const threadId = event.message?.thread?.name || event.space?.name || 'default-session';
    const userMessage = event.message?.argumentText || event.message?.text || '';

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
    return res.json({ text: botReply });

  } catch (error) {
    console.error('Error processing chat event:', error);
    return res.json({ text: "🧙‍♂️ *The DM stalls:* An error occurred while calculating your fate. Please try again." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`D&D Bot backend listening on port ${PORT}`);
});
