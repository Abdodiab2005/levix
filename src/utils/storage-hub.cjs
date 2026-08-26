// CommonJS face of storage-hub.esm.js — the AI conversation history.
//
// Both halves are the same SQLite store, so this one can require it directly
// instead of lazy-importing the ESM module the way it had to when the history
// lived in a separate async database. The signatures stay async for callers.

const logger = require("./logger.cjs");
const store = require("../db/store.cjs");

async function getChatHistoryAsync(chatId) {
  try {
    return store.getChatHistory(chatId);
  } catch (err) {
    logger.error({ err }, "[storage-hub] getChatHistoryAsync failed");
    return [];
  }
}

async function saveChatHistoryAsync(chatId, historyArray) {
  try {
    store.saveChatHistory(chatId, historyArray);
  } catch (err) {
    logger.error({ err }, "[storage-hub] saveChatHistoryAsync failed");
  }
}

async function deleteChatHistoryAsync(chatId) {
  try {
    return store.deleteChatHistory(chatId);
  } catch (err) {
    logger.error({ err }, "[storage-hub] deleteChatHistoryAsync failed");
    return false;
  }
}

async function deleteAllChatHistoriesAsync() {
  try {
    store.deleteAllChatHistories();
  } catch (err) {
    logger.error({ err }, "[storage-hub] deleteAllChatHistoriesAsync failed");
  }
}

module.exports = {
  getChatHistoryAsync,
  saveChatHistoryAsync,
  deleteChatHistoryAsync,
  deleteAllChatHistoriesAsync,
};
