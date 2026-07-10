import express from "express";
import { GoogleGenAI } from "@google/genai";
import { Firestore } from "@google-cloud/firestore";

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize the official Google Gen AI client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Initialize Firestore. It automatically grabs your Google Cloud project ID.
const db = new Firestore();
const CHAT_HISTORY_COLLECTION = "dnd_sessions";

// Your unchanging, heavy D&D ruleset framework
const SYSTEM_INSTRUCTION = `
You are an expert, immersive D&D 5e Dungeon Master. 
Maintain a rich narrative environment but format responses with bold text, 
bullet points, or brief paragraphs so they are easy to scan in a chat window.
Adhere strictly to 5e rules, track relative distances, and ask for specific dice rolls when necessary.
If players don't have saved player cards, generate one for them.
`;

/**
 * Converts standard Markdown syntax into Google Chat Card compatible HTML tags.
 * @param {string} mdText - The raw markdown text from the AI model.
 * @returns {string} The formatted HTML string.
 */
function convertMarkdownToChatHtml(mdText) {
  if (!mdText) return "";

  return (
    mdText
      // 1. Convert Bold (**text** or __text__) to <b>text</b>
      .replace(/\*\*(.*?)\*\*/g, "<b>$1</b>")
      .replace(/__(.*?)__/g, "<b>$1</b>")

      // 2. Convert Italics (*text* or _text_) to <i>text</i>
      .replace(/\*(.*?)\*/g, "<i>$1</i>")
      .replace(/_(.*?)_/g, "<i>$1</i>")

      // 3. Convert Linebreaks into explicit HTML breaks
      .replace(/\n/g, "<br>")
  );
}

/**
 * Formats a plain text string into a card structure containing an interactive response text input.
 * @param {string} textContent - The message text or DM narration.
 * @param {object} [threadContext] - The thread object from the incoming event payload.
 * @param {boolean} [isCardClick=false] - True if this is responding to a CARD_CLICKED action.
 * @returns {object} The structured JSON payload for Google Chat.
 */
function formatChatResponse(textContent, threadContext, isCardClick = false) {
  const formattedHtml = textContent
    ? convertMarkdownToChatHtml(textContent)
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
                    text: formattedHtml,
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

  // ✅ MANIFEST-APPROVED INTERACTIVE CARD RESPONSE SCHEMA
  if (isCardClick) {
    return {
      actionResponse: {
        type: "UPDATE_MESSAGE",
      },
      message: {
        cardsV2: messageData.cardsV2,
        ...(threadContext ? { thread: threadContext } : {}),
      },
    };
  }

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

/**
 * Parses a dice string (e.g., "2d6") and evaluates the random rolls.
 * @param {string} diceText - The dice notation string.
 * @returns {object} An object containing the individual rolls, the total, and a formatted string.
 */
function rollDice(diceText) {
  const match = diceText.trim().match(/^(\d+)d(\d+)$/i);
  if (!match) return null;

  const count = parseInt(match[1], 10);
  const sides = parseInt(match[2], 10);

  if (count < 1 || count > 100 || sides < 2 || sides > 1000) {
    return { error: "Keep dice count between 1-100 and sides between 2-1000." };
  }

  const rolls = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    const roll = Math.floor(Math.random() * sides) + 1;
    rolls.push(roll);
    total += roll;
  }

  return {
    rolls,
    total,
    text: `Rolled ${count}d${sides}: [${rolls.join(", ")}] = **${total}**`,
  };
}

// ----------------------------------------------------
// 🎲 NEW COMMAND ENDPOINT
// ----------------------------------------------------
app.post("/command", async (req, res) => {
  try {
    const payload = req.body;

    if (payload?.commonEventObject?.hostApp !== "CHAT") {
      return res.status(200).send();
    }

    const incomingChatMessage = payload.chat?.messagePayload?.message;
    const threadContext = incomingChatMessage?.thread;

    // Capture unique space paths safely to write to correct log file
    const threadId =
      payload.chat?.messagePayload?.space?.name ||
      incomingChatMessage?.space?.name ||
      "global-fallback";

    const docId = threadId.replace(/\//g, "-");
    const docRef = db.collection(CHAT_HISTORY_COLLECTION).doc(docId);

    const commandArgs = (incomingChatMessage?.argumentText || "").trim();
    const diceResult = rollDice(commandArgs);

    let rollFeedback = "";

    if (diceResult?.error) {
      rollFeedback = `*The DM sighs:* ${diceResult.error}`;
    } else if (diceResult) {
      rollFeedback = `🎲 ${diceResult.text}`;

      // Fetch history log to push context metadata back in
      const docSnap = await docRef.get();
      let history = [];
      if (docSnap.exists) {
        history = docSnap.data().history || [];
      }

      // Inject the roll context output explicitly into the history log array
      history.push({
        role: "user",
        parts: [
          { text: `[SYSTEM: Player rolled dice. Result: ${diceResult.text}]` },
        ],
      });

      if (history.length > 40) {
        history = history.slice(-40);
      }

      await docRef.set(
        {
          history: history,
          lastUpdated: Firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    } else {
      rollFeedback = `*The DM holds out an empty hand:* Invalid format. Please use \`/roll {n}d{s}\` (e.g., \`/roll 1d20\` or \`/roll 2d6\`).`;
    }

    // Return the response back cleanly using standard host message mapping layout
    return res.json(formatChatResponse(rollFeedback, threadContext, false));
  } catch (error) {
    console.error("Error executing slash command:", error);
    return res.json(
      formatChatResponse(
        "*The DM drops the dice:* Something went wrong processing your mechanical check.",
        null,
        false,
      ),
    );
  }
});

// ----------------------------------------------------
// 🧙‍♂️ STANDARD CHAT FLOWS ENDPOINT
// ----------------------------------------------------
app.post("/chat-bot", async (req, res) => {
  let threadContext = null;
  let isCardResponse = false;

  try {
    const payload = req.body;

    if (payload?.commonEventObject?.hostApp !== "CHAT") {
      console.log(
        "--> Dropped: Request is missing valid Google Chat structure.",
      );
      return res.status(200).send();
    }

    isCardResponse = payload.type === "CARD_CLICKED";
    let userMessage = "";

    const incomingChatMessage = payload.chat?.messagePayload?.message;
    const incomingCardMessage =
      payload.commonEventObject?.messageToInteractiveCard;

    if (isCardResponse) {
      const formInputs = payload.commonEventObject?.formInputs;
      userMessage = formInputs?.playerActionInput?.stringInputs?.value[0] || "";
      threadContext = incomingCardMessage?.thread;
    } else {
      userMessage =
        incomingChatMessage?.argumentText || incomingChatMessage?.text || "";
      threadContext = incomingChatMessage?.thread;
    }

    if (!userMessage || userMessage.trim() === "") {
      return res.json(
        formatChatResponse(
          "*The DM leans forward:* I heard you call my name, but I didn't catch your action. What would you like to do?",
          threadContext,
          isCardResponse,
        ),
      );
    }

    const threadId =
      payload.chat?.messagePayload?.space?.name ||
      incomingChatMessage?.space?.name ||
      incomingCardMessage?.space?.name ||
      "global-fallback";

    const docId = threadId.replace(/\//g, "-");
    const docRef = db.collection(CHAT_HISTORY_COLLECTION).doc(docId);

    const docSnap = await docRef.get();
    let history = [];

    if (docSnap.exists) {
      history = docSnap.data().history || [];
    }

    history.push({
      role: "user",
      parts: [{ text: userMessage }],
    });

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: history,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
      },
    });

    const botReply = response.text;
    console.log(`[Thread: ${docId}] Processed bot response`);

    history.push({
      role: "model",
      parts: [{ text: botReply }],
    });

    if (history.length > 40) {
      history = history.slice(-40);
    }

    await docRef.set(
      {
        history: history,
        lastUpdated: Firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return res.json(
      formatChatResponse(botReply, threadContext, isCardResponse),
    );
  } catch (error) {
    console.error("Error processing chat event:", error);
    return res.json(
      formatChatResponse(
        "*The DM stalls:* An error occurred while calculating your fate. Please try again.",
        threadContext,
        isCardResponse,
      ),
    );
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`D&D Bot backend listening on port ${PORT}`);
});
