const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const DATA_FILE = path.join(__dirname, 'data.json');

function readJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
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
