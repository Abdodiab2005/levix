// ESM version of storage utilities.
//
// Same story as storage.cjs: one SQLite file, src/db/store.cjs holds the
// queries, and this module re-exports them so the ESM handlers, middleware and
// helpers keep the synchronous calls they were written against. Both halves
// share one singleton.

import store from "../db/store.esm.js";

// ===== Bot settings =====
export const getBotSetting = store.getBotSetting;
export const saveBotSetting = store.saveBotSetting;
export const deleteBotSetting = store.deleteBotSetting;

// ===== Group settings =====
export const getGroupSettings = store.getGroupSettings;
export const saveGroupSettings = store.saveGroupSettings;
export const getAllGroupSettings = store.getAllGroupSettings;

// ===== Warnings =====
export const getUserWarnings = store.getUserWarnings;
export const saveUserWarnings = store.saveUserWarnings;
export const clearUserWarnings = store.clearUserWarnings;
export const getAllWarnings = store.getAllWarnings;

// ===== Todos =====
export const getUserTodos = store.getUserTodos;
export const saveUserTodos = store.saveUserTodos;

// ===== Notes =====
export const saveNote = store.saveNote;
export const getNote = store.getNote;
export const getAllNotes = store.getAllNotes;
export const deleteNote = store.deleteNote;
export const getAllNotesFlat = store.getAllNotesFlat;

// ===== Pairing QR =====
export const saveQrCode = store.saveQrCode;
export const getQrCode = store.getQrCode;
export const deleteQrCode = store.deleteQrCode;

// ===== LID mapping (Baileys v7) =====
export const storeLidPnMapping = store.storeLidPnMapping;
export const storeLidPnMappings = store.storeLidPnMappings;
export const getLidForPn = store.getLidForPn;
export const getLidsForPns = store.getLidsForPns;
export const getPnForLid = store.getPnForLid;
export const getAllLidMappings = store.getAllLidMappings;

// ===== Forward scores =====
export const incrementForwardScore = store.incrementForwardScore;
export const getForwardScore = store.getForwardScore;
export const getTopForwardedMessages = store.getTopForwardedMessages;

// ===== User metadata & bot roles =====
export const saveUserMetadata = store.saveUserMetadata;
export const getUserMetadata = store.getUserMetadata;
export const isUserOwner = store.isUserOwner;
export const isUserBotAdmin = store.isUserBotAdmin;
export const getAllOwners = store.getAllOwners;
export const getAllBotAdmins = store.getAllBotAdmins;
export const getAllUsers = store.getAllUsers;
export const setUserRole = store.setUserRole;
export const updateUserLastSeen = store.updateUserLastSeen;

// ===== Debts =====
export const addDebt = store.addDebt;
export const getDebt = store.getDebt;
export const deleteDebt = store.deleteDebt;
export const listDebts = store.listDebts;
export const getRecentDebts = store.getRecentDebts;
export const countDebts = store.countDebts;

// ===== Dashboard counters =====
export const countGroups = store.countGroups;
export const countWarnings = store.countWarnings;
export const countTodos = store.countTodos;
export const getAllTodos = store.getAllTodos;
export const countNotes = store.countNotes;
export const countUsers = store.countUsers;

// ===== Scheduled messages =====
export const getSchedules = store.getSchedules;
export const getSchedule = store.getSchedule;
export const saveSchedule = store.saveSchedule;
export const setScheduleStatus = store.setScheduleStatus;
export const deleteSchedule = store.deleteSchedule;
export const countSchedules = store.countSchedules;
