const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const DATA_FILE = path.join(__dirname, 'data.json');

function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`[DB] Failed to read ${filePath}: ${err.message}`);
    throw err;
  }
}

function writeJSON(filePath, data) {
  const tmp = filePath + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    console.error(`[DB] Failed to write ${filePath}: ${err.message}`);
    throw err;
  }
}

// --- Settings (prompt) ---

function getPromptTemplate() {
  return readJSON(SETTINGS_FILE).promptTemplate;
}

function savePromptTemplate(template) {
  const settings = readJSON(SETTINGS_FILE);
  settings.promptTemplate = template;
  writeJSON(SETTINGS_FILE, settings);
}

// --- Data (users + stats) ---

function getData() {
  return readJSON(DATA_FILE);
}

function saveData(data) {
  writeJSON(DATA_FILE, data);
}

function upsertUser(userId, username) {
  const data = getData();
  const existing = data.users.find((u) => u.id === userId);
  if (!existing) {
    data.users.push({
      id: userId,
      username: username || null,
      firstSeen: new Date().toISOString(),
    });
    saveData(data);
  } else if (username && existing.username !== username) {
    existing.username = username;
    saveData(data);
  }
}

function incrementAnalyses() {
  const data = getData();
  data.analysesCount = (data.analysesCount || 0) + 1;
  saveData(data);
}

function getStats() {
  const data = getData();
  return {
    usersCount: data.users.length,
    analysesCount: data.analysesCount || 0,
    users: data.users,
  };
}

// --- Admins ---

function getAdmins() {
  const data = getData();
  return data.admins || [];
}

function addAdmin(userId, username) {
  const data = getData();
  if (!data.admins) data.admins = [];
  if (!data.admins.find((a) => a.id === userId)) {
    data.admins.push({ id: userId, username: username || null });
    saveData(data);
  }
}

function removeAdmin(userId) {
  const data = getData();
  data.admins = (data.admins || []).filter((a) => a.id !== userId);
  saveData(data);
}

module.exports = {
  getPromptTemplate,
  savePromptTemplate,
  upsertUser,
  incrementAnalyses,
  getStats,
  getAdmins,
  addAdmin,
  removeAdmin,
};
