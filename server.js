import express from "express";
import { GoogleGenAI } from "@google/genai";
import { Firestore } from "@google-cloud/firestore";

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize official clients
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const db = new Firestore();
const CHAT_HISTORY_COLLECTION = "dnd_sessions";

const SYSTEM_INSTRUCTION = `
You are an expert, immersive D&D 5e Dungeon Master. 
Maintain a rich narrative environment but format responses with bold text, 
bullet points, or brief paragraphs so they are easy to scan in a chat window.
Adhere strictly to 5e rules, track relative distances, and ask for specific dice rolls when necessary.
If players don't have saved player cards, generate one for them.
Always display HP for all parties involved in a battle after every move.
`;

// ----------------------------------------------------
// ⚙️ SHARED HELPER UTILITIES
// ----------------------------------------------------

/**
 * Normalizes Google Chat's payload structure variation across message and command events.
 */
function extractChatMetadata(payload) {
  const isCommand = !!payload.chat?.appCommandPayload;

  const incomingMsg = isCommand
    ? payload.chat?.appCommandPayload?.message
    : payload.chat?.messagePayload?.message;

  const incomingCardMsg = payload.commonEventObject?.messageToInteractiveCard;

  const userMessage = (
    incomingMsg?.argumentText ||
    incomingMsg?.text ||
    ""
  ).trim();
  const threadContext = incomingMsg?.thread || null;

  const userRefId =
    incomingMsg?.sender?.name || payload.chat?.user?.name || "unknown-user";
  const userDisplayName = incomingMsg?.sender?.displayName || "Adventurer";

  const rawSpaceName = isCommand
    ? payload.chat?.appCommandPayload?.space?.name
    : payload.chat?.messagePayload?.space?.name ||
      incomingMsg?.space?.name ||
      incomingCardMsg?.space?.name;

  const threadId = rawSpaceName || "global-fallback";
  const commandId =
    payload.chat?.appCommandPayload?.appCommandMetadata?.appCommandId || null;

  return {
    userMessage,
    threadContext,
    userRefId,
    userDisplayName,
    threadId,
    commandId,
  };
}

/**
 * Sanitizes thread spaces and returns a dedicated Firestore Document Reference.
 */
function getDocRef(threadId) {
  const docId = threadId.replace(/\//g, "-");
  return db.collection(CHAT_HISTORY_COLLECTION).doc(docId);
}

/**
 * Fetches document snapshot data with uniform operational fallbacks.
 */
async function loadSessionData(docRef) {
  const docSnap = await docRef.get();
  if (!docSnap.exists) {
    return { history: [], playerCards: {}, campaign: "", currentTurn: 0 };
  }
  const data = docSnap.data();
  return {
    history: data.history || [],
    playerCards: data.playerCards || {},
    campaign: data.campaign || "",
    currentTurn: data.currentTurn ?? 0,
  };
}

/**
 * Formats a plain text string into a native Google Chat Markdown text response.
 */
function formatChatResponse(textContent, threadContext) {
  let rawText = textContent || "_The DM remains silent..._";
  let chatMarkdown = rawText
    .replace(/\*\*(.*?)\*\*/g, "*$1*")
    .replace(/__(.*?)__/g, "*$1*");

  const messageData = { text: chatMarkdown };
  if (threadContext) messageData.thread = threadContext;

  return {
    hostAppDataAction: {
      chatDataAction: {
        createMessageAction: { message: messageData },
      },
    },
  };
}

/**
 * Core LLM Generation Engine
 */
async function generateDMResponse({
  history,
  playerCards,
  campaign,
  currentTurn,
  activeMessageContext,
}) {
  let systemInstruction = SYSTEM_INSTRUCTION;

  const registeredPlayers = Object.keys(playerCards || {});
  if (registeredPlayers.length > 0) {
    systemInstruction += "\n\n=== ACTIVE ADVENTURING PARTY ===";
    for (const playerKey of registeredPlayers) {
      systemInstruction += `\nCharacter Profile [Registered to user ID: ${playerKey}]:\n${playerCards[playerKey].playerSheet}\n---`;
    }
  }

  if (activeMessageContext) {
    systemInstruction += `\n\n[CURRENT ACTION CONTEXT]: ${activeMessageContext}`;
  }

  if (campaign) {
    systemInstruction += `\n\n=== CAMPAIGN FRAMEWORK ===\nContext: "${campaign}"\nCurrent Turn: ${currentTurn}\nTarget Timeline: Complete this segment by turn 40.`;
  }

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: history,
    config: { systemInstruction: systemInstruction },
  });

  return response.text;
}

// ----------------------------------------------------
// 🎲 SLASH COMMAND HANDLER ENDPOINT
// ----------------------------------------------------
app.post("/command", async (req, res) => {
  try {
    const payload = req.body;
    if (payload?.commonEventObject?.hostApp !== "CHAT")
      return res.status(200).send();

    // Clean abstractions applied
    const {
      userMessage,
      threadContext,
      userRefId,
      userDisplayName,
      threadId,
      commandId,
    } = extractChatMetadata(payload);
    const docRef = getDocRef(threadId);

    // 📜 COMMAND ID 2: REGISTER PLAYER CARD
    if (commandId === 2) {
      const cleanArgs = userMessage.replace(/^(?:\/)?register\s*/i, "").trim();
      if (!cleanArgs) {
        return res.json(
          formatChatResponse(
            `*The DM looks up:* The character sheet appears empty.`,
            threadContext,
          ),
        );
      }

      const textLines = cleanArgs
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const playerName = textLines[0].replace(/[\*\_]/g, "");

      await docRef.set(
        {
          playerCards: {
            [userRefId]: {
              playerName: playerName || userDisplayName,
              playerSheet: cleanArgs,
            },
          },
        },
        { merge: true },
      );

      return res.json(
        formatChatResponse(
          `📜 *The DM records your character sheet:* **${userDisplayName}** has successfully registered **${playerName || "their character"}**!`,
          threadContext,
        ),
      );
    }

    // ⚔️ COMMAND ID 3: START CAMPAIGN
    else if (commandId === 3) {
      const campaign = userMessage.replace(/^(?:\/)?campaign\s*/i, "").trim();
      if (!campaign) {
        return res.json(
          formatChatResponse(
            "*The DM looks up:* Please provide campaign details after the command.",
            threadContext,
          ),
        );
      }

      const { playerCards } = await loadSessionData(docRef);

      const initialSystemMessage = {
        role: "user",
        parts: [
          {
            text: `[SYSTEM COMMAND]: The user "${userDisplayName}" has just launched a new campaign session framework. Generate an atmospheric, immersive opening prologue segment.`,
          },
        ],
      };

      const initialDMPrologue = await generateDMResponse({
        history: [initialSystemMessage],
        playerCards,
        campaign,
        currentTurn: 0,
        activeMessageContext: `The campaign session is starting. Address the party and establish the narrative hook.`,
      });

      await docRef.set(
        {
          campaign,
          currentTurn: 1,
          history: [
            initialSystemMessage,
            { role: "model", parts: [{ text: initialDMPrologue }] },
          ],
        },
        { merge: true },
      );

      return res.json(formatChatResponse(initialDMPrologue, threadContext));
    }

    return res.json(formatChatResponse("Unknown command.", threadContext));
  } catch (error) {
    console.error("Error executing slash command:", error);
    return res.json(
      formatChatResponse(
        "*The DM drops the dice:* Something went wrong processing your mechanical check.",
        null,
      ),
    );
  }
});

// ----------------------------------------------------
// 🧙‍♂️ MAIN GAME ACTION TEXT ENDPOINT
// ----------------------------------------------------
app.post("/chat-bot", async (req, res) => {
  try {
    const payload = req.body;
    if (payload?.commonEventObject?.hostApp !== "CHAT")
      return res.status(200).send();

    const { userMessage, threadContext, userRefId, userDisplayName, threadId } =
      extractChatMetadata(payload);
    if (!userMessage) {
      return res.json(
        formatChatResponse(
          "*The DM leans forward:* I heard you call my name, but I didn't catch your action.",
          threadContext,
        ),
      );
    }

    const docRef = getDocRef(threadId);
    let { history, playerCards, campaign, currentTurn } =
      await loadSessionData(docRef);

    const currentUserTurn = {
      role: "user",
      parts: [{ text: `${userDisplayName}: ${userMessage}` }],
    };

    const contextNotation = `The user currently acting is "${userDisplayName}" (ID: ${userRefId}). Match their action against their specific profile listed above.`;

    const botReply = await generateDMResponse({
      history: [...history, currentUserTurn],
      playerCards,
      campaign,
      currentTurn,
      activeMessageContext: contextNotation,
    });

    history.push(currentUserTurn, {
      role: "model",
      parts: [{ text: botReply }],
    });
    if (history.length > 30) history = history.slice(-30);

    await docRef.set(
      {
        history,
        currentTurn: currentTurn + 1,
        lastUpdated: Firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return res.json(formatChatResponse(botReply, threadContext));
  } catch (error) {
    console.error("Error processing chat event:", error);
    return res.json(
      formatChatResponse(
        "*The DM stalls:* An error occurred while calculating your fate.",
        null,
      ),
    );
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`D&D Bot backend listening on port ${PORT}`),
);
