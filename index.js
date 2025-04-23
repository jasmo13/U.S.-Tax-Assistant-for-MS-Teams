// index.js is used to setup and configure your bot

// Import required packages
const express = require("express");

// Import required bot services.
// See https://aka.ms/bot-services to learn more about the different parts of a bot.
const {
  CloudAdapter,
  ConfigurationServiceClientCredentialFactory,
  ConfigurationBotFrameworkAuthentication,
  MemoryStorage,
  ConversationState,
} = require("botbuilder");
const { TeamsBot } = require("./teamsBot");
const config = require("./config");

// Create adapter.
// See https://aka.ms/about-bot-adapter to learn more about adapters.
const credentialsFactory = new ConfigurationServiceClientCredentialFactory(config);

const botFrameworkAuthentication = new ConfigurationBotFrameworkAuthentication(
  {},
  credentialsFactory
);

// Create adapter instance (only once)
const adapter = new CloudAdapter(botFrameworkAuthentication);

// Create storage and state
const memoryStorage = new MemoryStorage();
const conversationState = new ConversationState(memoryStorage);

// Set up error handling for the adapter
adapter.onTurnError = async (context, error) => {
  // This check writes out errors to console log .vs. app insights.
  console.error(`\n [onTurnError] unhandled error: ${error}`);
  
  // Add detailed error logging to help diagnose deployed bot issues
  console.error('Error details:', error.stack);
  console.error('Bot configuration:', {
    nodeEnv: process.env.NODE_ENV,
    botId: process.env.BOT_ID,
    botType: process.env.BOT_TYPE,
    hasOpenAiKey: !!process.env.OPENAI_API_KEY,
    hasVectorStoreKey: !!process.env.OPENAI_VECTOR_STORE_ID,
    runningOnAzure: !!process.env.RUNNING_ON_AZURE,
    country: process.env.BOT_LOCATION_COUNTRY,
    region: process.env.BOT_LOCATION_REGION,
    city: process.env.BOT_LOCATION_CITY,
    timezone: process.env.BOT_TIMEZONE
  });

  // Only send error message for user messages
  if (context.activity.type === "message") {
    await context.sendActivity(`The bot encountered an unhandled error:\n ${error.message}`);
    await context.sendActivity("To continue to run this bot, please fix the bot source code.");
  }
  
  // Delete the conversation state
  await conversationState.delete(context);
};

// Create the bot with the conversation state
const bot = new TeamsBot(conversationState);

// Create express application.
const expressApp = express();
expressApp.use(express.json());

const server = expressApp.listen(process.env.port || process.env.PORT || 3978, () => {
  console.log(`\nBot Started, ${expressApp.name} listening to`, server.address());
  // Log configuration at startup to diagnose issues
  console.log('Bot configuration:', {
    nodeEnv: process.env.NODE_ENV,
    botId: process.env.BOT_ID,
    botType: process.env.BOT_TYPE,
    hasOpenAiKey: !!process.env.OPENAI_API_KEY,
    hasVectorStoreKey: !!process.env.OPENAI_VECTOR_STORE_ID,
    runningOnAzure: !!process.env.RUNNING_ON_AZURE,
    country: process.env.BOT_LOCATION_COUNTRY,
    region: process.env.BOT_LOCATION_REGION,
    city: process.env.BOT_LOCATION_CITY,
    timezone: process.env.BOT_TIMEZONE
  });
});

// Listen for incoming requests.
expressApp.post("/api/messages", async (req, res) => {
  console.log('Received message activity');
  try {
    await adapter.process(req, res, async (context) => {
      await bot.run(context);
    });
    console.log('Message activity processed successfully');
  } catch (error) {
    console.error('Error processing message activity:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Add a simple health check endpoint
expressApp.get("/health", (req, res) => {
  res.status(200).send("Bot is running");
});

// Gracefully shutdown HTTP server
["exit", "uncaughtException", "SIGINT", "SIGTERM", "SIGUSR1", "SIGUSR2"].forEach((event) => {
  process.on(event, () => {
    server.close();
  });
});

// Global unhandled promise rejection handler
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
