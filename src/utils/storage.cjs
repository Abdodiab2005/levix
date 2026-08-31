// The CommonJS door onto storage.
//
// Everything lives in one SQLite file (src/db/db.cjs); src/db/store.cjs holds
// the queries. This module just re-exports them under the names the commands
// have always used — and yes, the API is synchronous, because SQLite is.
//
// The ESM half is src/utils/storage.esm.js; both point at the same singleton.

const store = require("../db/store.cjs");

module.exports = {
  // Bot Settings
  getBotSetting: store.getBotSetting,
  saveBotSetting: store.saveBotSetting,
  deleteBotSetting: store.deleteBotSetting,
  // Group Settings
  getGroupSettings: store.getGroupSettings,
  saveGroupSettings: store.saveGroupSettings,
  getAllGroupSettings: store.getAllGroupSettings,
  // Warnings
  getUserWarnings: store.getUserWarnings,
  saveUserWarnings: store.saveUserWarnings,
  clearUserWarnings: store.clearUserWarnings,
  getAllWarnings: store.getAllWarnings,
  // Todos
  getUserTodos: store.getUserTodos,
  saveUserTodos: store.saveUserTodos,
  // Notes
  saveNote: store.saveNote,
  getNote: store.getNote,
  getAllNotes: store.getAllNotes,
  deleteNote: store.deleteNote,
  getAllNotesFlat: store.getAllNotesFlat,
  // QR Code
  saveQrCode: store.saveQrCode,
  getQrCode: store.getQrCode,
  deleteQrCode: store.deleteQrCode,
  // Forward Scores
  incrementForwardScore: store.incrementForwardScore,
  getForwardScore: store.getForwardScore,
  getTopForwardedMessages: store.getTopForwardedMessages,
  // User Metadata
  saveUserMetadata: store.saveUserMetadata,
  getUserMetadata: store.getUserMetadata,
  isUserOwner: store.isUserOwner,
  isUserBotAdmin: store.isUserBotAdmin,
  getAllOwners: store.getAllOwners,
  getAllBotAdmins: store.getAllBotAdmins,
  setUserRole: store.setUserRole,
  updateUserLastSeen: store.updateUserLastSeen,
  // LID Mapping (Baileys v7)
  storeLidPnMapping: store.storeLidPnMapping,
  storeLidPnMappings: store.storeLidPnMappings,
  getLidForPn: store.getLidForPn,
  getLidsForPns: store.getLidsForPns,
  getPnForLid: store.getPnForLid,
  getAllLidMappings: store.getAllLidMappings,
  // Debts
  addDebt: store.addDebt,
  getDebt: store.getDebt,
  deleteDebt: store.deleteDebt,
  listDebts: store.listDebts,
  getRecentDebts: store.getRecentDebts,
  countDebts: store.countDebts,
  // Dashboard counters + listings
  countGroups: store.countGroups,
  countWarnings: store.countWarnings,
  countTodos: store.countTodos,
  countNotes: store.countNotes,
  getAllTodos: store.getAllTodos,
  getAllUsers: store.getAllUsers,
  countUsers: store.countUsers,
  // Scheduled messages
  getSchedules: store.getSchedules,
  getSchedule: store.getSchedule,
  saveSchedule: store.saveSchedule,
  setScheduleStatus: store.setScheduleStatus,
  setScheduleDelivery: store.setScheduleDelivery,
  deleteSchedule: store.deleteSchedule,
  countSchedules: store.countSchedules,
};
