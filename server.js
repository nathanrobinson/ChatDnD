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
const MAX_HISTORY_LENGTH = 40;
const SHRINK_HISTORY_LENGTH = 5;
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
