import express from "express";
import { GoogleGenAI } from "@google/genai";
import { Firestore } from "@google-cloud/firestore";

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize official Google Cloud & Gen AI clients
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const db = new Firestore();
const CHAT_HISTORY_COLLECTION = "dnd_sessions";

// Optimized system instructions to enforce tight, low-token outputs
const SYSTEM_INSTRUCTION = `
You are an expert, immersive D&D 5e Dungeon Master. 
Unless explicity asked for more detail by the user, or the user is investigating, keep narrative descriptions concise and atmospheric—limit narrative text to a maximum of 5 sentences per turn.
Adhere strictly to 5e rules and ask for specific dice rolls when necessary.
Only display character/enemy HP when a change occurs, formatting it compactly on a single line (e.g., [Goblin B: 4/7 HP remaining]). 
Never speak or act on behalf of the players; state the immediate threat or environment and prompt them cleanly for their next action.
`;

// ----------------------------------------------------
// ⚙️ SHARED HELPER UTILITIES
// ----------------------------------------------------

/**
 * Normalizes Google Chat's payload variations and forces room alignment via sessionId.
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
      incomingCardMsg?.space?.name ||
      "global-fallback";

  const sessionId = rawSpaceName.replace(/\//g, "-");
  
  const commandId =
    payload.chat?.appCommandPayload?.appCommandMetadata?.appCommandId || null;

  return {
    userMessage,
    threadContext,
    userRefId,
    userDisplayName,
    sessionId,
    commandId,
  };
}

/**
 * Returns a dedicated Firestore Document Reference using the unified sessionId.
 */
function getDocRef(sessionId) {
  return db.collection(CHAT_HISTORY_COLLECTION).doc(sessionId);
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
 * Core LLM Generation Engine with True Immutable Cache Upsert Edge Logic
 */
async function generateDMResponse({
  sessionId,
  history,
  playerCards,
  campaign,
}) {
  // 1. Compile your heavy text framework ruleset — REMOVED currentTurn to keep this 100% static!
  let staticRuleset = SYSTEM_INSTRUCTION;

  const registeredPlayers = Object.keys(playerCards || {});
  if (registeredPlayers.length > 0) {
    staticRuleset += "\n\n=== ACTIVE ADVENTURING PARTY ===";
    for (const playerKey of registeredPlayers) {
      const player = playerCards[playerKey];
      staticRuleset += `\nCharacter Profile [User ID: ${playerKey}]:\n${player.playerSheet}`;
      
      if (player.inventory && player.inventory.length > 0) {
        staticRuleset += `\nCarried Inventory Items:\n* ${player.inventory.join("\n* ")}`;
      }
      
      if (player.learnedSpells && player.learnedSpells.length > 0) {
        staticRuleset += `\nAdditional Known Spells:\n* ${player.learnedSpells.join("\n* ")}`;
      }
      staticRuleset += "\n---";
    }
  }

  if (campaign) {
    staticRuleset += `\n\n=== CAMPAIGN FRAMEWORK ===\nContext: "${campaign}"\nTarget Timeline: Complete segment by turn 40.`;
  }

  // 2. Attempt Cache Upsert — This will now hit perfectly on every single turn!
  const uniqueCacheName = `dnd-cache-${sessionId}`;
  let cacheReferenceName = null;

  try {
    const cache = await ai.caches.create({
      model: "gemini-2.5-flash-light",
      displayName: uniqueCacheName,
      ttl: "1800s",
      contents: [{ role: "user", parts: [{ text: staticRuleset }] }]
    });
    
    cacheReferenceName = cache.name;
    
  } catch (cacheError) {
    console.warn("Context caching deferred, switching to inline fallback payload:", cacheError.message);
  }

  // 3. Build execution configuration uniformly
  const generationConfig = { 
    model: "gemini-2.5-flash-light",
    contents: history
  };

  if (cacheReferenceName) {
    generationConfig.cachedContent = cacheReferenceName;
  } else {
    generationConfig.config = { systemInstruction: staticRuleset };
  }

  const response = await ai.models.generateContent(generationConfig);
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

    const {
      userMessage,
      threadContext,
      userRefId,
      userDisplayName,
      sessionId,
      commandId,
    } = extractChatMetadata(payload);
    const docRef = getDocRef(sessionId);

    // 📜 COMMAND ID 2: REGISTER PLAYER CARD
    if (commandId === 2) {
      const cleanArgs = userMessage.replace(/^(?:\/)?register\s*/i, "").trim();
      if (!cleanArgs) {
        return res.json(formatChatResponse(`*The DM looks up:* The character sheet appears empty.`, threadContext));
      }

      const textLines = cleanArgs.split("\n").map((line) => line.trim()).filter(Boolean);
      const playerName = textLines[0].replace(/[\*\_]/g, "");

      await docRef.set({
        playerCards: {
          [userRefId]: {
            playerName: playerName || userDisplayName,
            playerSheet: cleanArgs,
            inventory: [],
            learnedSpells: []
          },
        },
      }, { merge: true });

      return res.json(formatChatResponse(`📜 *The DM records your character sheet:* **${userDisplayName}** has successfully registered **${playerName || "their character"}**!`, threadContext));
    }

    // ⚔️ COMMAND ID 3: START CAMPAIGN
    else if (commandId === 3) {
      const campaign = userMessage.replace(/^(?:\/)?campaign\s*/i, "").trim();
      if (!campaign) {
        return res.json(formatChatResponse("*The DM looks up:* Please provide campaign details after the command.", threadContext));
      }

      const { playerCards } = await loadSessionData(docRef);

      const initialSystemMessage = {
        role: "user",
        parts: [{ text: `[SYSTEM COMMAND]: The user "${userDisplayName}" has just launched a new campaign session framework. Generate an atmospheric, immersive opening prologue segment.\n\n[TURN CONTEXT]: Current Game Turn: 0` }],
      };

      // Notice we dropped currentTurn parameter entirely from the function call
      const initialDMPrologue = await generateDMResponse({
        sessionId,
        history: [initialSystemMessage],
        playerCards,
        campaign,
      });

      await docRef.set({
        campaign,
        currentTurn: 1,
        history: [
          initialSystemMessage,
          { role: "model", parts: [{ text: initialDMPrologue }] },
        ],
      }, { merge: true });

      return res.json(formatChatResponse(initialDMPrologue, threadContext));
    }

    // 🎒 COMMAND ID 4: UPDATE INVENTORY
    else if (commandId === 4) {
      const itemArg = userMessage.replace(/^(?:\/)?inventory\s*/i, "").trim();
      if (!itemArg) {
        return res.json(formatChatResponse(`*The DM checks your pack:* Please specify an item to manage.`, threadContext));
      }

      const { playerCards } = await loadSessionData(docRef);
      if (!playerCards[userRefId]) {
        return res.json(formatChatResponse(`*The DM frowns:* Please register your character sheet using \`/register\` first.`, threadContext));
      }

      let currentInventory = playerCards[userRefId].inventory || [];
      const lowerItem = itemArg.toLowerCase();
      const itemIndex = currentInventory.findIndex(i => i.toLowerCase() === lowerItem);

      let actionMessage = "";
      if (itemIndex > -1) {
        const removedItem = currentInventory.splice(itemIndex, 1);
        actionMessage = `🎒 **${userDisplayName}** dropped/used: *${removedItem[0]}*`;
      } else {
        currentInventory.push(itemArg);
        actionMessage = `🎒 **${userDisplayName}** added to inventory: *${itemArg}*`;
      }

      await docRef.set({
        playerCards: {
          [userRefId]: { inventory: currentInventory }
        }
      }, { merge: true });

      return res.json(formatChatResponse(actionMessage, threadContext));
    }

    // 🔮 COMMAND ID 5: LEARN NEW SPELL
    else if (commandId === 5) {
      const spellArg = userMessage.replace(/^(?:\/)?learn\s*/i, "").trim();
      if (!spellArg) {
        return res.json(formatChatResponse(`*The DM consults the archives:* Please specify the name of the spell you learned.`, threadContext));
      }

      const { playerCards } = await loadSessionData(docRef);
      if (!playerCards[userRefId]) {
        return res.json(formatChatResponse(`*The DM frowns:* Please register your character sheet using \`/register\` first.`, threadContext));
      }

      let currentSpells = playerCards[userRefId].learnedSpells || [];
      if (currentSpells.some(s => s.toLowerCase() === spellArg.toLowerCase())) {
        return res.json(formatChatResponse(`🔮 You already know the spell *${spellArg}*.`, threadContext));
      }

      currentSpells.push(spellArg);

      await docRef.set({
        playerCards: {
          [userRefId]: { learnedSpells: currentSpells }
        }
      }, { merge: true });

      return res.json(formatChatResponse(`🔮 **${userDisplayName}** breaks the seal on a mystical nexus and seals a new incantation into their mind: *${spellArg}*!`, threadContext));
    }

    return res.json(formatChatResponse("Unknown command.", threadContext));
  } catch (error) {
    console.error("Error executing slash command:", error);
    return res.json(formatChatResponse("*The DM drops the dice:* Something went wrong processing your mechanical check.", null));
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

    const { userMessage, threadContext, userRefId, userDisplayName, sessionId } =
      extractChatMetadata(payload);
    if (!userMessage) {
      return res.json(formatChatResponse("*The DM leans forward:* I heard you call my name, but I didn't catch your action.", threadContext));
    }

    const docRef = getDocRef(sessionId);
    let { history, playerCards, campaign, currentTurn } = await loadSessionData(docRef);

    // Injected currentTurn here so it tracks natively within the volatile message block
    const currentUserTurn = {
      role: "user",
      parts: [{ 
        text: `${userDisplayName}: ${userMessage}\n\n[TURN CONTEXT]: Game Turn Count: ${currentTurn} | Active user ID: "${userRefId}". Evaluate choices matching this profile.` 
      }],
    };

    const botReply = await generateDMResponse({
      sessionId,
      history: [...history, currentUserTurn],
      playerCards,
      campaign,
    });

    history.push(currentUserTurn, {
      role: "model",
      parts: [{ text: botReply }],
    });
    
    if (history.length > 20) history = history.slice(-20);

    await docRef.set({
      history,
      currentTurn: currentTurn + 1,
      lastUpdated: Firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return res.json(formatChatResponse(botReply, threadContext));
  } catch (error) {
    console.error("Error processing chat event:", error);
    return res.json(formatChatResponse("*The DM stalls:* An error occurred while calculating your fate.", null));
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`D&D Bot backend listening on port ${PORT}`));
