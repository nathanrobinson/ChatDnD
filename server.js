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
const GEMINI_MODEL_KEY = "gemini-3.1-flash-lite";

// Compaction thresholds and safety limits
const MAX_HISTORY_LENGTH = 50;
const SHRINK_HISTORY_LENGTH = 10;
const GLOBAL_SUMMARY_TOKEN_LIMIT = 100000;

// Optimized system instructions to enforce tight, low-token outputs
const SYSTEM_INSTRUCTION = `
You are an expert, immersive D&D 5e Dungeon Master. 
Unless explicitly asked for more detail by the user, or the user is investigating, keep narrative descriptions concise and atmospheric—limit narrative text to a maximum of 5 sentences per turn.
Adhere strictly to 5e rules and ask for specific dice rolls when necessary.
Only display character/enemy HP when a change occurs, formatting it compactly on a single line (e.g., [Goblin B: 4/7 HP remaining]). 
Never speak or act on behalf of the players; state the immediate threat or environment and prompt them cleanly for their next action.
`;

// ----------------------------------------------------
// ⚙️ SHARED HELPER UTILITIES
// ----------------------------------------------------

function extractChatMetadata(payload) {
  const isCommand = !!payload.chat?.appCommandPayload;
  const incomingMsg = isCommand
    ? payload.chat?.appCommandPayload?.message
    : payload.chat?.messagePayload?.message;
  const incomingCardMsg = payload.commonEventObject?.messageToInteractiveCard;

  const userMessage = (incomingMsg?.argumentText || incomingMsg?.text || "").trim();
  const threadContext = incomingMsg?.thread || null;
  const userRefId = incomingMsg?.sender?.name || payload.chat?.user?.name || "unknown-user";
  const userDisplayName = incomingMsg?.sender?.displayName || "Adventurer";

  const rawSpaceName = isCommand
    ? payload.chat?.appCommandPayload?.space?.name
    : payload.chat?.messagePayload?.space?.name || incomingMsg?.space?.name || incomingCardMsg?.space?.name || "global-fallback";

  const sessionId = rawSpaceName.replace(/\//g, "-");
  const commandId = payload.chat?.appCommandPayload?.appCommandMetadata?.appCommandId || null;

  return { userMessage, threadContext, userRefId, userDisplayName, sessionId, commandId };
}

function getDocRef(sessionId) {
  return db.collection(CHAT_HISTORY_COLLECTION).doc(sessionId);
}

async function loadSessionData(docRef) {
  const docSnap = await docRef.get();
  if (!docSnap.exists) {
    return { history: [], playerCards: {}, campaign: "", currentTurn: 0, campaignSummary: "" };
  }
  const data = docSnap.data();
  return {
    history: data.history || [],
    playerCards: data.playerCards || {},
    campaign: data.campaign || "",
    currentTurn: data.currentTurn ?? 0,
    campaignSummary: data.campaignSummary || ""
  };
}

function formatChatResponse(textContent, threadContext) {
  let rawText = textContent || "_The DM remains silent..._";
  let chatMarkdown = rawText.replace(/\*\*(.*?)\*\*/g, "*$1*").replace(/__(.*?)__/g, "*$1*");

  const messageData = { text: chatMarkdown };
  if (threadContext) messageData.thread = threadContext;

  return {
    hostAppDataAction: {
      chatDataAction: { createMessageAction: { message: messageData } }
    }
  };
}

/**
 * Summarizes trimmed history logs alongside the existing running summary text
 * and enforces the dynamic token guardrail cap.
 */
async function generateUpdatedSummary(oldSummary, trimmedLines) {
  const serializedTrimmedText = trimmedLines
    .map(msg => `${msg.role === "user" ? "Player Action" : "DM Response"}: ${msg.parts[0].text}`)
    .join("\n");

  const prompt = `
You are the Chronicle Keeper. Review the existing Campaign Summary and the newly elapsed segment of chronological game history below. 
Generate an updated, comprehensive, sequential summary combining both elements. Maintain tracking of key plot developments, active location settings, critical NPC interactions, items found, and the active health/status of major threats.

=== EXISTING CAMPAIGN SUMMARY ===
${oldSummary || "No events have been recorded yet."}

=== ELAPSED NEW HISTORY SEGMENT ===
${serializedTrimmedText}

Provide only the updated summary text. Do not introduce conversational meta-text.
`;

  try {
    // 1. Generate the combined chronological summary update
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL_KEY,
      contents: [{ role: "user", parts: [{ text: prompt }] }]
    });
    let updatedSummaryText = response.text.trim();

    // 2. Measure the token size of the new layout footprint
    const tokenCheck = await ai.models.countTokens({
      model: GEMINI_MODEL_KEY,
      contents: [{ role: "user", parts: [{ text: updatedSummaryText }] }]
    });

    console.log(`[SUMMARY ARCHIVE]: Current log footprint is ${tokenCheck.totalTokens} tokens.`);

    // 3. Deep-compress the lore framework if it breaches the hard global boundary limits
    if (tokenCheck.totalTokens > GLOBAL_SUMMARY_TOKEN_LIMIT) {
      console.warn(`[TOKEN CAPACITY REACHED]: Summary reached ${tokenCheck.totalTokens} tokens. Executing archival deep-compaction...`);
      
      const compressionPrompt = `
You are the High Archivist. The following campaign chronicle is too detailed and long. 
Condense the entire log into a highly dense, space-efficient executive summary. 
Consolidate completed questlines, remove minor flavor descriptions, and group past narrative locations into brief structural milestones. 
Preserve only long-term macro world changes, major faction reputations, vital character items, and open narrative plot arcs.

=== OVERSIZED CAMPAIGN CHRONICLE ===
${updatedSummaryText}

Provide only the newly compressed summary text, keeping it strictly optimized for low token count. Do not introduce conversational meta-text.
`;

      const compressionResponse = await ai.models.generateContent({
        model: GEMINI_MODEL_KEY,
        contents: [{ role: "user", parts: [{ text: compressionPrompt }] }]
      });
      updatedSummaryText = compressionResponse.text.trim();
    }

    return updatedSummaryText;
  } catch (err) {
    console.error("Summary execution or token verification cycle failed, reverting state:", err);
    return oldSummary;
  }
}

/**
 * Core LLM Generation Engine with True Immutable Cache Upsert Edge Logic
 */
async function generateDMResponse({
  sessionId,
  history,
  playerCards,
  campaign,
  campaignSummary,
}) {
  let staticRuleset = SYSTEM_INSTRUCTION;

  if (campaignSummary) {
    staticRuleset += `\n\n=== RUNNING CAMPAIGN CHRONICLE (PAST EVENTS) ===\n${campaignSummary}`;
  }

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

  const uniqueCacheName = `dnd-cache-${sessionId}`;
  let cacheReferenceName = null;

  try {
    const cache = await ai.caches.create({
      model: GEMINI_MODEL_KEY,
      displayName: uniqueCacheName,
      ttl: "1800s",
      contents: [{ role: "user", parts: [{ text: staticRuleset }] }],
    });

    cacheReferenceName = cache.name;
  } catch (cacheError) {
    console.warn("Context caching deferred, switching to inline fallback payload:", cacheError.message);
  }

  const generationConfig = {
    model: GEMINI_MODEL_KEY,
    contents: history,
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
    if (payload?.commonEventObject?.hostApp !== "CHAT") return res.status(200).send();

    const { userMessage, threadContext, userRefId, userDisplayName, sessionId, commandId } = extractChatMetadata(payload);
    const docRef = getDocRef(sessionId);

    // 📜 COMMAND ID 2: REGISTER PLAYER CARD
    if (commandId === 2) {
      const cleanArgs = userMessage.replace(/^(?:\/)?register\s*/i, "").trim();
      if (!cleanArgs) return res.json(formatChatResponse(`*The DM looks up:* The character sheet appears empty.`, threadContext));

      const textLines = cleanArgs.split("\n").map((line) => line.trim()).filter(Boolean);
      const playerName = textLines[0].replace(/[\*\_]/g, "");

      await docRef.set({
        playerCards: {
          [userRefId]: { playerName: playerName || userDisplayName, playerSheet: cleanArgs, inventory: [], learnedSpells: [] },
        },
      }, { merge: true });

      return res.json(formatChatResponse(`📜 *The DM records your character sheet:* **${userDisplayName}** has successfully registered **${playerName || "their character"}**!`, threadContext));
    }

    // ⚔️ COMMAND ID 3: START CAMPAIGN
    else if (commandId === 3) {
      const campaign = userMessage.replace(/^(?:\/)?campaign\s*/i, "").trim();
      if (!campaign) return res.json(formatChatResponse("*The DM looks up:* Please provide campaign details after the command.", threadContext));

      const { playerCards } = await loadSessionData(docRef);
      const initialSystemMessage = {
        role: "user",
        parts: [{ text: `[SYSTEM COMMAND]: The user "${userDisplayName}" has just launched a new campaign session framework. Generate an atmospheric, immersive opening prologue segment.\n\n[TURN CONTEXT]: Current Game Turn: 0` }],
      };

      const initialDMPrologue = await generateDMResponse({
        sessionId,
        history: [initialSystemMessage],
        playerCards,
        campaign,
        campaignSummary: ""
      });

      await docRef.set({
        campaign,
        currentTurn: 1,
        campaignSummary: "",
        history: [initialSystemMessage, { role: "model", parts: [{ text: initialDMPrologue }] }],
      }, { merge: true });

      return res.json(formatChatResponse(initialDMPrologue, threadContext));
    }

    // 🎒 COMMAND ID 4: UPDATE INVENTORY
    else if (commandId === 4) {
      const itemArg = userMessage.replace(/^(?:\/)?inventory\s*/i, "").trim();
      if (!itemArg) return res.json(formatChatResponse(`*The DM checks your pack:* Please specify an item to manage.`, threadContext));

      const { playerCards } = await loadSessionData(docRef);
      if (!playerCards[userRefId]) return res.json(formatChatResponse(`*The DM frowns:* Please register your character sheet using \`/register\` first.`, threadContext));

      let currentInventory = playerCards[userRefId].inventory || [];
      const lowerItem = itemArg.toLowerCase();
      const itemIndex = currentInventory.findIndex((i) => i.toLowerCase() === lowerItem);

      let actionMessage = "";
      if (itemIndex > -1) {
        const removedItem = currentInventory.splice(itemIndex, 1);
        actionMessage = `🎒 **${userDisplayName}** dropped/used: *${removedItem[0]}*`;
      } else {
        currentInventory.push(itemArg);
        actionMessage = `🎒 **${userDisplayName}** added to inventory: *${itemArg}*`;
      }

      await docRef.set({ playerCards: { [userRefId]: { inventory: currentInventory } } }, { merge: true });
      return res.json(formatChatResponse(actionMessage, threadContext));
    }

    // 🔮 COMMAND ID 5: LEARN NEW SPELL
    else if (commandId === 5) {
      const spellArg = userMessage.replace(/^(?:\/)?learn\s*/i, "").trim();
      if (!spellArg) return res.json(formatChatResponse(`*The DM consults the archives:* Please specify the name of the spell you learned.`, threadContext));

      const { playerCards } = await loadSessionData(docRef);
      if (!playerCards[userRefId]) return res.json(formatChatResponse(`*The DM frowns:* Please register your character sheet using \`/register\` first.`, threadContext));

      let currentSpells = playerCards[userRefId].learnedSpells || [];
      if (currentSpells.some((s) => s.toLowerCase() === spellArg.toLowerCase())) {
        return res.json(formatChatResponse(`🔮 You already know the spell *${spellArg}*.`, threadContext));
      }

      currentSpells.push(spellArg);
      await docRef.set({ playerCards: { [userRefId]: { learnedSpells: currentSpells } } }, { merge: true });

      return res.json(formatChatResponse(`🔮 **${userDisplayName}** breaks the seal on a mystical nexus and seals a new incantation into their mind: *${spellArg}*!`, threadContext));
    }

    // 📜 COMMAND ID 6: LIST ALL PLAYER INVENTORIES
    else if (commandId === 6) {
      const { playerCards } = await loadSessionData(docRef);
      const players = Object.keys(playerCards);

      if (players.length === 0) return res.json(formatChatResponse(`*The DM surveys the campsite:* No characters are currently registered in this session.`, threadContext));

      let partyManifest = `📋 **PARTY INVENTORY MANIFEST**\n`;
      for (const key of players) {
        const char = playerCards[key];
        const invList = char.inventory && char.inventory.length > 0 ? char.inventory.map((item) => `  • ${item}`).join("\n") : "  • _Empty_";
        partyManifest += `\n**${char.playerName}** (User: ${key}):\n${invList}\n`;
      }
      return res.json(formatChatResponse(partyManifest, threadContext));
    }

    // 📖 COMMAND ID 7: SHOW SPELLBOOK
    else if (commandId === 7) {
      const { playerCards } = await loadSessionData(docRef);
      const activeChar = playerCards[userRefId];
      if (!activeChar) return res.json(formatChatResponse(`*The DM checks the rosters:* You have not registered a character card in this session yet. Use \`/register\`.`, threadContext));

      const spells = activeChar.learnedSpells || [];
      let spellbookOutput = `📖 **SPELLBOOK: ${activeChar.playerName.toUpperCase()}**\n`;
      spellbookOutput += spells.length === 0 ? `\n_Your memory holds no custom incantations._` : spells.map((spell) => `  ✨ ${spell}`).join("\n");

      return res.json(formatChatResponse(spellbookOutput, threadContext));
    }

    // 📄 COMMAND ID 8: SHOW CHARACTER SHEET
    else if (commandId === 8) {
      const { playerCards } = await loadSessionData(docRef);
      const activeChar = playerCards[userRefId];
      if (!activeChar) return res.json(formatChatResponse(`*The DM unrolls an empty scroll:* You do not have a character card registered. Use \`/register\`.`, threadContext));

      return res.json(formatChatResponse(`📄 **CHARACTER PROFILE: ${activeChar.playerName.toUpperCase()}**\n\n${activeChar.playerSheet}`, threadContext));
    }

    return res.json(formatChatResponse("Unknown command.", threadContext));
  } catch (error) {
    console.error("Error executing slash command:", error);
    return res.json(formatChatResponse("*The DM drops the dice:* Something went wrong processing your check.", null));
  }
});

// ----------------------------------------------------
// 🧙‍♂️ MAIN GAME ACTION TEXT ENDPOINT
// ----------------------------------------------------
app.post("/chat-bot", async (req, res) => {
  try {
    const payload = req.body;
    if (payload?.commonEventObject?.hostApp !== "CHAT") return res.status(200).send();

    const { userMessage, threadContext, userRefId, userDisplayName, sessionId } = extractChatMetadata(payload);
    if (!userMessage) return res.json(formatChatResponse("*The DM leans forward:* I heard you call my name, but I didn't catch your action.", threadContext));

    const docRef = getDocRef(sessionId);
    let { history, playerCards, campaign, currentTurn, campaignSummary } = await loadSessionData(docRef);

    const currentUserTurn = {
      role: "user",
      parts: [{ text: `${userDisplayName}: ${userMessage}` }],
    };

    history.push(currentUsrerTurn);

    cosnt currentTurnContext = {
      role: "user",
      parts: [{ text: `[TURN CONTEXT]: Game Turn Count: ${currentTurn} | Active user ID: "${userRefId}". Evaluate choices matching this profile.` }],
    };

    // 1. Get response based on active array state
    const botReply = await generateDMResponse({
      sessionId,
      history: [...history, currentTurnContext],
      playerCards,
      campaign,
      campaignSummary,
    });

    history.push({
      role: "model",
      parts: [{ text: botReply }],
    });

    // 2. Rolling History Compaction Logic (Optimized for 50 max / 10 shrink slots)
    if (history.length >= MAX_HISTORY_LENGTH) {
      console.log(`[COMPACTION TRIGGERED]: Chat thread reached ${history.length} lines. Condensing back to ${SHRINK_HISTORY_LENGTH} rows...`);
      
      const sliceIndex = history.length - SHRINK_HISTORY_LENGTH;
      const linesToTrim = history.slice(0, sliceIndex);
      
      // Update our running chronicle string with the trimmed message dialogue blocks
      campaignSummary = await generateUpdatedSummary(campaignSummary, linesToTrim);
      
      // Keep only the most recent active turns alive in memory
      history = history.slice(sliceIndex);
    }

    await docRef.set({
      history,
      campaignSummary,
      currentTurn: currentTurn + 1,
      lastUpdated: Firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return res.json(formatChatResponse(botReply, threadContext));
  } catch (error) {
    console.error("Error processing chat event:", error);
    return res.json(formatChatResponse("*The DM stalls:* An error occurred while calculating your fate.", null));
  }
});

// Explicitly bind to 0.0.0.0 for containerized deployment compatibility
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`D&D Bot backend listening on port ${PORT} bound successfully to 0.0.0.0`);
});
