const { setGlobalOptions } = require("firebase-functions/v2");
const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");

// Initialize Firebase Admin SDK to access Firestore
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

// Import the official Google Gen AI client
const { GoogleGenAI } = require("@google/genai");

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || "PLACEHOLDER_KEY_FOR_COMPILATION",
});

// Set maximum concurrent instances for cost management
setGlobalOptions({ maxInstances: 5 });

const SYSTEM_INSTRUCTION = `
You are an expert, immersive D&D 5e Dungeon Master. 
Maintain a rich narrative environment but format responses with bold text, 
bullet points, or brief paragraphs so they are easy to scan in a chat window.
Adhere strictly to 5e rules, track relative distances, and ask for specific dice rolls and offer to roll when necessary.
`;

/**
 * Formats a plain text string into a card structure containing an interactive response text input.
 */
function formatChatResponse(textContent, threadContext) {
  const safeText = textContent
    ? String(textContent)
    : "The DM remains silent...";

  const messageData = {
    cardsV2: [
      {
        cardId: "dmResponseCard",
        card: {
          header: {
            title: "🧙‍♂️ Dungeon Master",
            imageUrl:
              "https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/casino/default/24px.svg",
          },
          sections: [
            {
              widgets: [
                {
                  textParagraph: {
                    text: safeText,
                  },
                },
              ],
            },
            {
              widgets: [
                {
                  textInput: {
                    name: "playerActionInput",
                    label: "What do you do?",
                    type: "MULTIPLE_LINE",
                    placeholderText:
                      "Type your action here (e.g., I draw my sword and attack)...",
                  },
                },
                {
                  buttonList: {
                    buttons: [
                      {
                        text: "Send Action to DM",
                        onClick: {
                          action: {
                            function: "SUBMIT_ACTION",
                          },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  };

  if (threadContext) {
    messageData.thread = threadContext;
  }

  return {
    hostAppDataAction: {
      chatDataAction: {
        createMessageAction: {
          message: messageData,
        },
      },
    },
  };
}

// Export your webhook function endpoint
exports.chatBot = onRequest(async (req, res) => {
  let threadContext = null;

  try {
    const payload = req.body;

    // 1. Verify valid Workspace Chat App Host structure
    if (payload?.commonEventObject?.hostApp !== "CHAT") {
      logger.info(
        "--> Dropped: Request is missing valid Google Chat structure.",
      );
      return res.status(200).send();
    }

    let userMessage = "";

    // 2. Extract inputs depending on interaction type (Button click vs Text message)
    if (payload.type === "CARD_CLICKED") {
      const formInputs = payload.commonEventObject?.formInputs;
      userMessage = formInputs?.playerActionInput?.stringInputs?.value[0] || "";
      threadContext = payload.chat?.messagePayload?.message?.thread;
    } else {
      const chatMessage = payload.chat?.messagePayload?.message;
      userMessage = chatMessage?.argumentText || chatMessage?.text || "";
      threadContext = chatMessage?.thread;
    }

    // 3. Fallback for empty messages
    if (!userMessage || userMessage.trim() === "") {
      return res.json(
        formatChatResponse(
          "*The DM leans forward:* I heard you call my name, but I didn't catch your action. What would you like to do?",
          threadContext,
        ),
      );
    }

    // 4. Safely pull the Space Name to keep session history continuous across the room
    const spaceId =
      payload.chat?.messagePayload?.message?.space?.name || "global-fallback";

    // 5. Query Firestore for existing conversation context history
    const docRef = db.collection("campaign_histories").doc(spaceId);
    const docSnap = await docRef.get();

    let history = [];
    if (docSnap.exists) {
      history = docSnap.data().messages || [];
    }

    // 6. Push the user's latest turn to the transaction timeline
    history.push({
      role: "user",
      parts: [{ text: userMessage }],
    });

    // 7. Core generation invoke with Google Gen AI SDK
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: history,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
      },
    });

    const botReply = response.text;
    logger.info(`[Space: ${spaceId}] Processed DM response`);

    // 8. Log the reply back into the historical sequence array
    history.push({
      role: "model",
      parts: [{ text: botReply }],
    });

    // 9. Optimization: Cap context depth at 40 messages to save space/tokens
    if (history.length > 40) {
      history = history.slice(-40);
    }

    // 10. Persist history log update to Firestore
    await docRef.set({ messages: history }, { merge: true });

    // 11. Complete webhook lifecycle handshake back to Google Chat
    return res.json(formatChatResponse(botReply, threadContext));
  } catch (error) {
    logger.error("Error processing chat event:", error);
    return res.json(
      formatChatResponse(
        "*The DM stalls:* An error occurred while calculating your fate. Please try again.",
        threadContext,
      ),
    );
  }
});
