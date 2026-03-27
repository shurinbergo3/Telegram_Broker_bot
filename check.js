const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

async function listModels() {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  try {
    // В некоторых версиях SDK 2026 года доступ к списку идет через этот метод
    const response = await genAI.getGenerativeModel({ model: "gemini-3-flash" }); 
    console.log("Модель gemini-3-flash доступна и готова к работе!");
    
    // Если хочешь именно список всех моделей, попробуй так:
    const models = await genAI.listModels(); 
    console.log("Доступные модели:");
    models.models.forEach(m => console.log("- " + m.name));
  } catch (e) {
    console.error("Ошибка:", e.message);
    console.log("Попробуй выполнить: npm install @google/generative-ai@latest");
  }
}
listModels();