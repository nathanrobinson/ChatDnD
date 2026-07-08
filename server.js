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

app.post('/chat-bot', async (req, res) => {
  try {
    const event = req.body;

    // Verify this is a user message event from Google Chat
    if (!event || event.type !== 'MESSAGE') {
      return res.json({ text: "🧙‍♂️ *The DM leans forward:* did you say something?" });
    }

    // Extract conversation context identifiers from Google Chat payload
    const threadId = event.message?.thread?.name || event.space?.name || 'default-session';

    // FIX: Extract clean text. Direct messages use text, mentions have formatting properties.
    let userMessage = event.message?.text || '';

    // If it's a mention in a space, strip out the bot's name so Gemini doesn't get confused
    if (event.message?.annotations) {
      event.message.annotations.forEach(annotation => {
        if (annotation.type === 'USER_MENTION' && annotation.userMention?.type === 'BOT') {
          // Strips the "@ChatDnD " mention tag cleanly from the start
          userMessage = userMessage.replace(annotation.userMention.user.name, '').trim();
        }
      });
    }

    // Add a quick guard to see if we parsed nothing
    if (!userMessage || userMessage.trim() === '') {
      return res.json({ text: "🧙‍♂️ *The DM leans forward:* I heard you call my name, but I didn't catch your action. What would you like to do?" });
    }

    console.log(`[Thread: ${threadId}] Processed Player Input: "${userMessage}"`);

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
    console.log(`[Thread: ${threadId}] Processed bot response ${botReply}`);

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
