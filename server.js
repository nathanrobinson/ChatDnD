import express from "express";
import { GoogleGenAI } from "@google/genai";
import { Firestore } from "@google-cloud/firestore";

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize the official Google Gen AI client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Initialize Firestore
const db = new Firestore();
const CHAT_HISTORY_COLLECTION = "dnd_sessions";

// Heavy D&D ruleset framework
const SYSTEM_INSTRUCTION = `
You are an expert, immersive D&D 5e Dungeon Master. 
Maintain a rich narrative environment but format responses with bold text, 
bullet points, or brief paragraphs so they are easy to scan in a chat window.
Adhere strictly to 5e rules, track relative distances, and ask for specific dice rolls when necessary.
If players don't have saved player cards, generate one for them.
Always display HP for all parties involved in a battle after every move.
`;

/**
 * Formats a plain text string into a native Google Chat Markdown text response.
 */
function formatChatResponse(textContent, threadContext) {
  let rawText = textContent || "_The DM remains silent..._";

  let chatMarkdown = rawText
    .replace(/\*\*(.*?)\*\*/g, "*$1*")
    .replace(/__(.*?)__/g, "*$1*");

  const messageData = {
    text: chatMarkdown,
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

/**
 * Parses a dice string (e.g., "2d6") and evaluates the random rolls.
 */
function rollDice(diceText) {
  const match = diceText.trim().match(/(?:^|\s|[^\d])(\d+)d(\d+)\b/i);
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
// 🎲 SLASH COMMAND HANDLER ENDPOINT
// ----------------------------------------------------
app.post("/command", async (req, res) => {
  try {
    const payload = req.body;
    console.log(
      `[RAW COMMAND PAYLOAD] ${JSON.stringify(payload || {}).replace(/[\r\n]+/g, " ")}`,
    );

    if (payload?.commonEventObject?.hostApp !== "CHAT") {
      return res.status(200).send();
    }

    const incomingChatMessage = payload.chat?.appCommandPayload?.message;
    const threadContext = incomingChatMessage?.thread;

    const userRefId =
      incomingChatMessage?.sender?.name ||
      payload.chat?.user?.name ||
      "unknown-user";
    const userDisplayName =
      incomingChatMessage?.sender?.displayName || "Adventurer";

    const threadId =
      payload.chat?.appCommandPayload?.space?.name ||
      incomingChatMessage?.space?.name ||
      "global-fallback";
    const docId = threadId.replace(/\//g, "-");
    const docRef = db.collection(CHAT_HISTORY_COLLECTION).doc(docId);

    const commandArgs = (
      incomingChatMessage?.argumentText ||
      incomingChatMessage?.text ||
      ""
    ).trim();
    const commandId =
      payload.chat?.appCommandPayload?.appCommandMetadata?.appCommandId;

    // 📜 COMMAND ID 2: REGISTER PLAYER CARD
    if (commandId === 2) {
      let feedback = "";
      const cleanArgs = commandArgs.replace(/^(?:\/)?register\s*/i, "").trim();

      if (!cleanArgs) {
        feedback = `*The DM looks up:* The character sheet appears empty. Format:\n\`/register Dustin\`\n\`* Race: Human...\``;
        return res.json(formatChatResponse(feedback, threadContext));
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

      feedback = `📜 *The DM records your character sheet:* **${userDisplayName}** has successfully registered **${playerName || "their character"}**! I will consult this sheet when you make your actions.`;
      return res.json(formatChatResponse(feedback, threadContext));
    }

    // ⚔️ COMMAND ID 3: START CAMPAIGN
    else if (commandId === 3) {
      let feedback = "";
      // Clean up the input string if the command keyword leaked in
      const campaign = commandArgs.replace(/^(?:\/)?campaign\s*/i, "").trim();

      if (!campaign) {
        feedback =
          "*The DM looks up:* Please provide campaign details after the command.";
        return res.json(formatChatResponse(feedback, threadContext));
      }

      await docRef.set(
        {
          campaign: campaign,
          currentTurn: 0,
        },
        { merge: true },
      );

      feedback = `📜 *The DM begins a new campaign:* **${userDisplayName}** has successfully initiated a new campaign landscape: "${campaign}"`;
      return res.json(formatChatResponse(feedback, threadContext));
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
  let threadContext = null;

  try {
    const payload = req.body;

    if (payload?.commonEventObject?.hostApp !== "CHAT") {
      return res.status(200).send();
    }

    const incomingChatMessage = payload.chat?.messagePayload?.message;
    const incomingCardMessage =
      payload.commonEventObject?.messageToInteractiveCard;

    const userMessage =
      incomingChatMessage?.argumentText || incomingChatMessage?.text || "";
    threadContext = incomingChatMessage?.thread;

    const userRefId =
      incomingChatMessage?.sender?.name ||
      payload.chat?.user?.name ||
      "unknown-user";
    const userDisplayName =
      incomingChatMessage?.sender?.displayName || "Adventurer";

    if (!userMessage || userMessage.trim() === "") {
      return res.json(
        formatChatResponse(
          "*The DM leans forward:* I heard you call my name, but I didn't catch your action. What would you like to do?",
          threadContext,
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
    let playerCards = {};
    let campaign = "";
    let currentTurn = 0;

    if (docSnap.exists) {
      const docData = docSnap.data();
      history = docData.history || [];
      playerCards = docData.playerCards || {};
      campaign = docData.campaign || "";
      currentTurn = docData.currentTurn ?? 0;
    }

    history.push({
      role: "user",
      parts: [{ text: `${userDisplayName}: ${userMessage}` }],
    });

    let systemInstruction = SYSTEM_INSTRUCTION;

    // ✅ FIX: Inject the ENTIRE party's character sheets so the DM remembers everyone in the room
    const registeredPlayers = Object.keys(playerCards);
    if (registeredPlayers.length > 0) {
      systemInstruction += "\n\n=== ACTIVE ADVENTURING PARTY ===";
      for (const playerKey of registeredPlayers) {
        const card = playerCards[playerKey];
        systemInstruction += `\nCharacter Profile [Registered to user ID: ${playerKey}]:\n${card.playerSheet}\n---`;
      }

      // Explicitly tell the model who just made the current move
      systemInstruction += `\n\n[CURRENT ACTION CONTEXT]: The user currently acting is "${userDisplayName}" (ID: ${userRefId}). Match their action against their specific profile listed above.`;
    }

    if (campaign) {
      systemInstruction += `\n\n=== CAMPAIGN FRAMEWORK ===\nContext: "${campaign}"\nCurrent Turn: ${currentTurn}\nTarget Timeline: Complete this segment by turn 40.`;
    }

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: history,
      config: {
        systemInstruction: systemInstruction,
      },
    });

    const botReply = response.text;
    console.log(`[Thread: ${docId}] Processed bot response`);

    history.push({
      role: "model",
      parts: [{ text: botReply }],
    });

    if (history.length > 30) {
      history = history.slice(-30);
    }

    const nextTurn = currentTurn + 1;

    await docRef.set(
      {
        history: history,
        lastUpdated: Firestore.FieldValue.serverTimestamp(),
        currentTurn: nextTurn,
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
