const { TeamsActivityHandler, TurnContext, MemoryStorage, ConversationState } = require("botbuilder");
const OpenAI = require("openai");
const { classifyTextForDisclaimer, CLASSIFICATION_LABELS } = require("./taxDisclaimerClassifier");
const { encoding_for_model } = require("tiktoken");
const storageService = require("./storageService");
const fs = require('fs');
const path = require('path');

// Load environment variables with fallbacks for Azure
try {
  // Check if we're on Azure (where env vars are set directly)
  if (process.env.RUNNING_ON_AZURE !== '1') {
    // Try to load from .env.dev.user file (for local development)
    const envPath = path.join(__dirname, 'env', '.env.dev.user');
    if (fs.existsSync(envPath)) {
      require('dotenv').config({ path: envPath });
      console.log('Loaded environment variables from .env.dev.user');
    } else {
      // Try alternative .env locations
      require('dotenv').config();
      console.log('Tried to load from default .env location');
    }
  } else {
    console.log('Running on Azure, using pre-configured environment variables');
  }
} catch (error) {
  console.error('Error loading environment variables:', error);
  // Continue execution - Azure should have env vars set in App Service Configuration
}

// Constants for conversation management
const MAX_TOKENS = 900000; // Max tokens to keep in history (90% of the 1M limit)

class TeamsBot extends TeamsActivityHandler {
  constructor(conversationState) {
    super();
    
    // Initialize conversation state
    this.conversationState = conversationState;
    this.conversationHistoryAccessor = this.conversationState.createProperty('conversationHistory');
    
    // Initialize tiktoken encoder for GPT-4o
    this.encoder = encoding_for_model("gpt-4o");
    
    // Initialize OpenAI client
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    // Define the standard disclaimer text
    this.standardDisclaimer = "**DISCLAIMER:** U.S. Tax Assistant provides general tax information and guidance only. The information provided is not legal or tax advice, and should not be relied upon as such. Tax laws are complex and subject to change. While we strive for accuracy, this bot may not account for your specific circumstances, recent tax law changes, or uncommon tax situations. Always verify information with the official IRS resources or consult with a qualified tax professional before making financial decisions or tax filings. Jake Campbell, the creator of this bot, is not responsible for any actions taken based on the information provided.";
    
    // Define a shorter disclaimer for appending to messages
    this.shortDisclaimer = "\n\n---\n*Note: This is not professional tax advice. Please verify all information provided.*";
    
    // Store system message as class property
    this.systemMessage = "";

    this.onMessage(async (context, next) => {
      console.log("Running with Message Activity.");
      const removedMentionText = TurnContext.removeRecipientMention(context.activity);
      const txt = removedMentionText.trim();
      
      // Get conversation ID for storage
      const conversationId = context.activity.conversation.id;
      
      // Check for reset command
      if (txt.toLowerCase() === '/restart') {
        // Clear conversation history
        await this.conversationHistoryAccessor.set(context, []);
        await this.conversationState.saveChanges(context);
        
        // Clear persistent history in Azure Storage
        await storageService.deleteConversationHistory(conversationId);
        
        await context.sendActivity(
          "Conversation history has been reset! Let's start over!"
        );
        await context.sendActivity(this.standardDisclaimer);
        await context.sendActivity(
          "You can type '/restart' anytime to start fresh!"
        );
        return await next();
      }
      
      // Get conversation history from state
      let conversationHistory = await this.conversationHistoryAccessor.get(context, []);
      
      // If history is empty, try to load from Azure Storage
      if (conversationHistory.length === 0) {
        try {
          const savedHistory = await storageService.loadConversationHistory(conversationId);
          if (savedHistory && savedHistory.length > 0) {
            conversationHistory = savedHistory;
            await this.conversationHistoryAccessor.set(context, conversationHistory);
            console.log(`Restored conversation history for ${conversationId} with ${conversationHistory.length} messages`);
            
            // Log token count of restored history
            const historyTokens = this.countTokensInHistory(conversationHistory);
            console.log(`Restored history contains ${historyTokens} tokens`);
          }
        } catch (error) {
          console.error("Error loading conversation history:", error);
        }
      }
      
      // Send typing indicator
      await context.sendActivity({ type: 'typing' });
      
      try {
        // Get current date for system instructions
        const currentDate = new Date();
        const timezone = process.env.BOT_TIMEZONE
        const formattedDate = currentDate.toLocaleString('en-US', { 
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: 'numeric',
          minute: 'numeric',
          timeZoneName: 'short',
          timeZone: timezone
        });
        
        // System message for the bot
        this.systemMessage = `Today's date is ${formattedDate}.\n\nYou are U.S. Tax Assistant. Your mission is to assist users with their tax-related questions using expert guidance on U.S. federal and state tax information. You'll handle different tax-related tasks and user queries as follows:\n\n- Explain specific tax regulations and their application.\n- Assist in selecting the correct tax forms.\n- Provide advice on deductions, credits, and filing status.\n- Answer common tax questions.\n- Direct users to additional resources for complex issues.\n- Serve individual taxpayers, small business owners, and tax professionals.\n- Offer a quick reference to tax codes and regulations.\n\nYou have been provided with the entire U.S. Tax Code (Title 26—Internal Revenue Code) to use with your retrieval tool. As a result, you're knowledgeable about the complete U.S. Tax Code, and can clarify misunderstandings by referencing it and offering examples. For intricate issues, suggest seeking professional advice.\n\n**Note:** Users cannot upload documents, and any document access is based on databases or sources available to you, not user-uploaded content.\n\nIf you cannot find information in the Title 26—Internal Revenue Code, or if the user mentions any material outside the U.S. Tax Code, you can search the internet. Start by referencing primary sources such as the IRS website and official documents from the IRS for federal tax information. For state laws, court decisions, and other tax document information, use the internet. Refer to reputable secondary sources and avoid blog sites and forums like Reddit. If the internet is not available to you, or you are confused by the user's request, inform the user that you cannot find the information in the U.S. Tax Code.\nIMPORTANT: Always be sure to cite where you found all information if you accessed any files via the retrieval tool or used the internet. Do not mention any files the user uploaded. When introducing yourself, make sure to omit any comments about files that the user uploaded or that you cannot access them.`
        
        // Calculate tokens in the system message
        const systemTokens = this.encoder.encode(this.systemMessage).length;
        
        // Calculate tokens in the current user message
        const userMessageTokens = this.encoder.encode(txt).length;
        
        // Prepare messages array with system prompt and history
        const messages = [
          {
            "role": "system",
            "content": [
              {
                "type": "input_text",
                "text": this.systemMessage
              }
            ]
          }
        ];
        
        // Add conversation history to messages
        conversationHistory.forEach(message => {
          messages.push(message);
        });
        
        // Add current user message
        messages.push({
          "role": "user",
          "content": [
            {
              "type": "input_text",
              "text": txt
            }
          ]
        });
        
        // Log token counts
        const totalTokens = this.countTokensInMessages(messages);
        console.log(`Request using ${totalTokens} tokens (system: ${systemTokens}, history: ${this.countTokensInHistory(conversationHistory)}, user: ${userMessageTokens})`);
        
        // Call OpenAI API with history and current message
        const response = await this.openai.responses.create({
          model: "gpt-4.1",
          input: messages,
          text: {
            "format": {
              "type": "text"
            }
          },
          reasoning: {},
          tools: [
            {
              "type": "file_search",
              "vector_store_ids": [
                process.env.OPENAI_VECTOR_STORE_ID
              ]
            },
            {
              "type": "web_search_preview",
              "user_location": {
                "type": "approximate",
                "country": process.env.BOT_LOCATION_COUNTRY,
                "region": process.env.BOT_LOCATION_REGION,
                "city": process.env.BOT_LOCATION_CITY
              },
              "search_context_size": "high"
            }
          ],
          temperature: 1,
          max_output_tokens: 16384,
          top_p: 1,
          store: true
        });
        
        let botResponseText = "";
        
        // Process response
        if (response.output_text) {
          botResponseText = response.output_text;
        } else if (response.output && response.output.length > 0) {
          const messageOutput = response.output.find(item => item.type === "message");
          if (messageOutput && messageOutput.content && messageOutput.content.length > 0) {
            const textContent = messageOutput.content.find(item => item.type === "output_text");
            if (textContent && textContent.text) {
              botResponseText = textContent.text;
            } else {
              botResponseText = "I processed your request but couldn't format the response properly.";
            }
          } else {
            botResponseText = "I processed your request but couldn't find a message in the response.";
          }
        } else {
          botResponseText = "I processed your request, but had trouble formatting the response.";
        }
        
        // Calculate tokens in the bot response
        const botResponseTokens = this.encoder.encode(botResponseText).length;
        console.log(`Response contains ${botResponseTokens} tokens`);
        
        // Use instructor-js to classify if the response needs a disclaimer
        const classification = await classifyTextForDisclaimer(this.openai, botResponseText);
        console.log("Disclaimer classification: ", classification);
        
        // Add disclaimer if needed
        if (classification.class_label === CLASSIFICATION_LABELS.NEEDS_DISCLAIMER) {
          await context.sendActivity({ text: botResponseText + this.shortDisclaimer });
        } else {
          await context.sendActivity({ text: botResponseText });
        }
        
        // Update conversation history
        conversationHistory.push({
          "role": "user",
          "content": [{ "type": "input_text", "text": txt }]
        });

        // Change input_text to output_text for assistant messages
        conversationHistory.push({
          "role": "assistant",
          "content": [{ "type": "output_text", "text": botResponseText }]
        });

        // NOW trim the history if needed (after adding both messages)
        if (conversationHistory.length > 0) {
          // Make sure you're passing the actual systemTokens (407) not MAX_TOKENS here
          conversationHistory = this.trimConversationToTokenLimit(
            conversationHistory, 
            systemTokens, // This should be ~407, not 900000
            0 // userTokens is 0 since the current message is already in history
          );
        }

        // Save updated history to state after trimming
        await this.conversationHistoryAccessor.set(context, conversationHistory);
        await this.conversationState.saveChanges(context);

        // Log the total token count after adding the new exchange and trimming
        const finalTokenCount = this.countTokensInHistory(conversationHistory);
        console.log(`Conversation history now contains ${conversationHistory.length} messages with ${finalTokenCount} tokens`);

        // Save to persistent storage in Azure
        await storageService.saveConversationHistory(conversationId, conversationHistory);
        
      } catch (error) {
        console.error("Error calling OpenAI API: ", error);
        await context.sendActivity("I'm sorry, I'm having trouble processing your request. Please try again later.");
      }
      
      await next();
    });

    // Listen to MembersAdded event
    this.onMembersAdded(async (context, next) => {
      const membersAdded = context.activity.membersAdded;
      for (let cnt = 0; cnt < membersAdded.length; cnt++) {
        if (membersAdded[cnt].id) {
          await context.sendActivity(this.standardDisclaimer);
          await context.sendActivity(
            "You can type '/restart' anytime to start fresh!"
          );
          break;
        }
      }
      await next();
    });
  }
  
  /**
   * Count tokens in a single message
   * @param {Object} message - Message object with role and content
   * @returns {number} - Token count
   */
  countTokensInMessage(message) {
    let tokenCount = 0;
    
    // Count tokens in content
    if (message.content && Array.isArray(message.content)) {
      for (const content of message.content) {
        if (content.type === 'input_text' || content.type === 'output_text') {
          const tokens = this.encoder.encode(content.text);
          tokenCount += tokens.length;
        }
      }
    }
    
    return tokenCount;
  }
  
  /**
   * Count tokens in all messages including system message
   * @param {Array} messages - Array of message objects
   * @returns {number} - Total token count
   */
  countTokensInMessages(messages) {
    let totalTokens = 0;
    
    for (const message of messages) {
      totalTokens += this.countTokensInMessage(message);
    }
    
    return totalTokens;
  }
  
  /**
   * Count tokens in conversation history (excluding system message)
   * @param {Array} history - Conversation history array
   * @returns {number} - Token count
   */
  countTokensInHistory(history) {
    return this.countTokensInMessages(history);
  }
  
  /**
   * Trim conversation history to fit within token limit
   * @param {Array} history - Conversation history array
   * @param {number} systemTokens - Tokens used by system message
   * @param {number} userTokens - Tokens used by current user message
   * @returns {Array} - Trimmed history array
   */
  trimConversationToTokenLimit(history, systemTokens, userTokens) {
    // If history is empty, return it
    if (history.length === 0) {
      return history;
    }
    
    // Calculate current token count - only count history tokens here
    const currentHistoryTokens = this.countTokensInHistory(history);
    
    // Total includes system + user + history tokens
    const totalTokens = systemTokens + userTokens + currentHistoryTokens;
    const percentageUsed = (totalTokens / MAX_TOKENS) * 100;
    
    // Always log token counts showing both history tokens and total including system
    console.log(`HISTORY STATUS: Conversation has ${history.length} messages with ${currentHistoryTokens} history tokens`);
    console.log(`TOTAL TOKENS: ${totalTokens} / ${MAX_TOKENS} (${percentageUsed.toFixed(2)}%) (system: ${systemTokens}, user: ${userTokens}, history: ${currentHistoryTokens})`);
    
    // If already under limit, return as is
    if (totalTokens <= MAX_TOKENS) {
      return history;
    }
    
    // Calculate how much we need to trim
    const excessTokens = totalTokens - MAX_TOKENS;
    
    console.log(`CONVERSATION SHORTENING: Total tokens (${totalTokens}) exceeds the ${MAX_TOKENS} token limit by ${excessTokens} tokens. Will trim history to fit.`);
    
    // Need to trim history to fit within token limit
    // Clone the history array to avoid modifying the original
    const trimmedHistory = [...history];
    let originalLength = trimmedHistory.length;
    let removedCount = 0;
    
    // Keep removing oldest message pairs until under token limit
    while (systemTokens + userTokens + this.countTokensInHistory(trimmedHistory) > MAX_TOKENS && trimmedHistory.length >= 2) {
      // Remove the oldest user-assistant pair (preserving pairs to maintain context)
      const removedMessages = trimmedHistory.splice(0, 2);
      removedCount += 2;
      
      // Recalculate tokens after removal
      const removedTokens = this.countTokensInMessage(removedMessages[0]) + this.countTokensInMessage(removedMessages[1]);
      
      // Get updated history token count
      const updatedHistoryTokens = this.countTokensInHistory(trimmedHistory);
      const updatedTotal = systemTokens + userTokens + updatedHistoryTokens;
      
      console.log(`Removed ${removedTokens} tokens by removing oldest message pair (${removedCount} messages removed so far). ${updatedHistoryTokens} history tokens remaining. Total: ${updatedTotal}`);
    }
    
    // Log final status after trimming
    const finalHistoryTokens = this.countTokensInHistory(trimmedHistory);
    const finalTotalTokens = systemTokens + userTokens + finalHistoryTokens;

    console.log(`After removal: ${trimmedHistory.length} messages remaining with ${finalHistoryTokens} history tokens. Total: ${finalTotalTokens} / ${MAX_TOKENS} (removed ${originalLength - trimmedHistory.length} messages total)`);
    
    // Log if we still couldn't get under the limit
    if (finalTotalTokens > MAX_TOKENS) {
      console.warn(`WARNING: Conversation still exceeds token limit after trimming. Current total: ${finalTotalTokens}, Limit: ${MAX_TOKENS}`);
    }
    
    return trimmedHistory;
  }
}

module.exports.TeamsBot = TeamsBot;
