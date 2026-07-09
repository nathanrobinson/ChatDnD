import express from "express";
import { GoogleGenAI } from "@google/genai";
import { Firestore } from "@google-cloud/firestore"; // 1. Import the Firestore SDK

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// 2. Initialize Firestore. It automatically grabs your Google Cloud project ID.
const db = new Firestore();
const CHAT_HISTORY_COLLECTION = "dnd_sessions"; // Collection name in Firestore

const SYSTEM_INSTRUCTION = `
You are an expert, immersive D&D 5e Dungeon Master. 
Maintain a rich narrative environment but format responses with bold text, 
bullet points, or brief paragraphs so they are easy to scan in a chat window.
Adhere strictly to 5e rules, track relative distances, and ask for specific dice rolls and offer to roll when necessary.
`;

// (Keep your formatChatResponse function exactly the same here...)

app.post("/chat-bot", async (req, res) => {
  let threadContext = null;

  try {
    const payload = req.body;

    if (
      payload?.commonEventObject?.hostApp !== "CHAT" ||
      !payload?.chat?.messagePayload?.message
    ) {
      return res.status(200).send();
    }

    let userMessage = "";
    const incomingMessage = payload.chat?.messagePayload?.message;

    if (payload.type === "CARD_CLICKED") {
      const formInputs = payload.commonEventObject?.formInputs;
      userMessage = formInputs?.playerActionInput?.stringInputs?.value[0] || "";
      threadContext = incomingMessage?.thread;
    } else {
      userMessage =
        incomingMessage?.argumentText || incomingMessage?.text || "";
      threadContext = incomingMessage?.thread;
    }

    if (!userMessage || userMessage.trim() === "") {
      return res.json(
        formatChatResponse(
          "*The DM leans forward:* I heard you call my name, but I didn't catch your action. What would you like to do?",
          threadContext,
        ),
      );
    }

    // Safely parse the unique ID representing this specific chat room/space
    const threadId =
      payload.chat?.messagePayload?.space?.name ||
      incomingMessage?.space?.name ||
      "global-fallback";

    // Clean up the slash characters in the Google space name ("spaces/XXXXXX" -> "spaces-XXXXXX")
    // to prevent Firestore from treating it as subdirectories
    const docId = threadId.replace(/\//g, "-");
    const docRef = db.collection(CHAT_HISTORY_COLLECTION).doc(docId);

    // 3. Fetch historic conversation log from Firestore
    const docSnap = await docRef.get();
    let history = [];

    if (docSnap.exists) {
      history = docSnap.data().history || [];
    }

    // 4. Append the user's latest turn
    history.push({
      role: "user",
      parts: [{ text: userMessage }],
    });

    // 5. Request generation from Gemini
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: history,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
      },
    });

    const botReply = response.text;
    console.log(`[Thread: ${docId}] Processed bot response`);

    // 6. Append the model's response back to history
    history.push({
      role: "model",
      parts: [{ text: botReply }],
    });

    // 7. Keep memory optimized to manage Firestore document size limit (1MB max per document)
    if (history.length > 40) {
      history = history.slice(-40);
    }

    // 8. Commit the updated conversation history document back to Firestore
    await docRef.set(
      {
        history: history,
        lastUpdated: Firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return res.json(formatChatResponse(botReply, threadContext));
  } catch (error) {
    console.error("Error processing chat event:", error);
    return res.json(
      formatChatResponse(
        "*The DM stalls:* An error occurred while calculating your fate. Please try again.",
        threadContext,
      ),
    );
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`D&D Bot backend listening on port ${PORT}`);
});
