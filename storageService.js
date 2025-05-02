/**
 * Azure Blob Storage service for persistent conversation history
 * Uses Azure Identity for secure credential management and follows Azure best practices
 */
const { BlobServiceClient } = require('@azure/storage-blob');
const { DefaultAzureCredential, ManagedIdentityCredential } = require('@azure/identity');
const fs = require('fs');
const path = require('path');

// The name of the container where conversation histories will be stored
const CONTAINER_NAME = 'conversation-history';

class StorageService {
  constructor() {
    this.initialized = false;
    this.blobServiceClient = null;
    this.containerClient = null;
    this.useLocalStorage = process.env.USE_LOCAL_STORAGE === 'true';
    this.fs = fs;
    this.path = path;
    
    // Set up the local storage path based on environment
    // On Azure App Service, a writable directory is required
    const isRunningOnAzure = process.env.RUNNING_ON_AZURE === '1';
    if (isRunningOnAzure) {
      // Use D:\home\LogFiles which is guaranteed to be writable on Azure App Service
      this.localStoragePath = path.join('D:', 'home', 'LogFiles', 'conversation-history');
      console.log(`Running on Azure, using path: ${this.localStoragePath}`);
    } else {
      this.localStoragePath = path.join(__dirname, 'history');
      console.log(`Running locally, using path: ${this.localStoragePath}`);
    }
    
    // If using local storage, ensure storage directory exists
    if (this.useLocalStorage) {
      this.initializeLocalStorage();
    }
  }

  /**
   * Initialize local storage directory
   */
  initializeLocalStorage() {
    console.log(`Ensuring directory exists: ${this.localStoragePath}`);
    if (!this.fs.existsSync(this.localStoragePath)) {
      try {
        this.fs.mkdirSync(this.localStoragePath, { recursive: true });
        console.log(`Created local storage directory at ${this.localStoragePath}`);
      } catch (error) {
        console.error('Error creating local storage directory:', error);
        // Try alternative paths if on Azure
        if (process.env.RUNNING_ON_AZURE === '1') {
          try {
            // Fallback to another location
            this.localStoragePath = path.join('C:', 'home', 'site', 'wwwroot', 'data');
            console.log(`Trying alternative path: ${this.localStoragePath}`);
            this.fs.mkdirSync(this.localStoragePath, { recursive: true });
            console.log(`Created fallback directory at ${this.localStoragePath}`);
          } catch (fallbackError) {
            console.error('Error creating fallback directory:', fallbackError);
            // Last resort: use temp directory
            this.localStoragePath = path.join(require('os').tmpdir(), 'tax-bot-history');
            console.log(`Using temp directory as last resort: ${this.localStoragePath}`);
            this.fs.mkdirSync(this.localStoragePath, { recursive: true });
          }
        }
      }
    } else {
      console.log(`Directory already exists: ${this.localStoragePath}`);
    }
  }

  /**
   * Initialize the storage service
   * Uses Managed Identity in production or connection string in development
   */
  async initialize() {
    if (this.initialized) {
      return;
    }

    // Skip Azure initialization if using local storage
    if (this.useLocalStorage) {
      this.initialized = true;
      console.log('Using local file storage for conversation history');
      return;
    }

    try {
      // Check if on Azure - only use Managed Identity there
      if (process.env.RUNNING_ON_AZURE === '1' && process.env.AZURE_STORAGE_ACCOUNT_NAME) {
        // On Azure, prefer direct Managed Identity credential with explicit client ID
        const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
        const blobServiceUrl = `https://${accountName}.blob.core.windows.net`;
        
        console.log(`Attempting to connect to Azure Storage account: ${accountName} using Managed Identity`);
        
        // If there is a specific client ID for the User-Assigned Managed Identity stored, use it
        if (process.env.BOT_ID) {
          console.log(`Using User-Assigned Managed Identity with client ID: ${process.env.BOT_ID}`);
          const credential = new ManagedIdentityCredential(process.env.BOT_ID);
          this.blobServiceClient = new BlobServiceClient(blobServiceUrl, credential);
        } else {
          // Otherwise fall back to DefaultAzureCredential which tries multiple authentication methods
          console.log('Using DefaultAzureCredential for authentication');
          this.blobServiceClient = new BlobServiceClient(
            blobServiceUrl,
            new DefaultAzureCredential()
          );
        }
        console.log('Connected to Azure Blob Storage using Managed Identity');
      } else if (process.env.AZURE_STORAGE_CONNECTION_STRING) {
        // Use connection string as fallback or for local development
        console.log('Using connection string for authentication');
        this.blobServiceClient = BlobServiceClient.fromConnectionString(
          process.env.AZURE_STORAGE_CONNECTION_STRING
        );
        console.log('Connected to Azure Blob Storage using connection string');
      } else {
        throw new Error('No Azure Storage configuration found. Set AZURE_STORAGE_ACCOUNT_NAME or AZURE_STORAGE_CONNECTION_STRING.');
      }

      // Get or create the container with retry logic
      this.containerClient = this.blobServiceClient.getContainerClient(CONTAINER_NAME);
      
      // Try to access the container with retries
      let retries = 3;
      let containerExists = false;
      
      while (retries > 0) {
        try {
          containerExists = await this.containerClient.exists();
          break; // Success, exit retry loop
        } catch (error) {
          console.log(`Container check attempt failed, retries left: ${retries - 1}`);
          retries--;
          if (retries === 0) throw error;
          await new Promise(resolve => setTimeout(resolve, 1000)); // Wait before retry
        }
      }
      
      if (!containerExists) {
        console.log(`Creating container "${CONTAINER_NAME}"...`);
        await this.containerClient.create();
        console.log(`Container "${CONTAINER_NAME}" created`);
      }
      
      this.initialized = true;
    } catch (error) {
      console.error('Error initializing Azure Blob Storage:', error);
      
      // Log authentication details for troubleshooting
      if (error.name === 'AggregateAuthenticationError' || error.name === 'AuthenticationError') {
        console.log('Authentication error details:', error.message);
        console.log(`Storage account name: ${process.env.AZURE_STORAGE_ACCOUNT_NAME || 'not set'}`);
        console.log(`Connection string available: ${process.env.AZURE_STORAGE_CONNECTION_STRING ? 'Yes' : 'No'}`);
        console.log(`Bot identity type: ${process.env.BOT_TYPE || 'not set'}`);
        console.log(`Bot ID (client ID): ${process.env.BOT_ID || 'not set'}`);
        console.log(`Bot tenant ID: ${process.env.BOT_TENANT_ID || 'not set'}`);
      }
      
      // Fallback to local storage if Azure storage initialization fails
      this.useLocalStorage = true;
      this.initialized = true;
      // Initialize local storage when falling back
      this.initializeLocalStorage();
      console.log('Using local file storage for conversation history');
    }
  }

  /**
   * Save conversation history to blob storage
   * @param {string} conversationId - The conversation ID
   * @param {Array} history - The conversation history array
   */
  async saveConversationHistory(conversationId, history) {
    await this.initialize();
    
    try {
      const content = JSON.stringify(history);
      
      if (this.useLocalStorage) {
        // Local file storage
        const filePath = this.path.join(this.localStoragePath, `${conversationId}.json`);
        this.fs.writeFileSync(filePath, content);
        console.log(`Saved conversation history to ${filePath}`);
      } else {
        // Azure Blob Storage
        const blobName = `${conversationId}.json`;
        const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);
        
        // Upload with content settings
        await blockBlobClient.upload(content, content.length, {
          blobHTTPHeaders: {
            blobContentType: 'application/json',
          }
        });
        console.log(`Saved conversation history to Azure Blob Storage: ${blobName}`);
      }
    } catch (error) {
      console.error('Error saving conversation history:', error);
    }
  }

  /**
   * Load conversation history from blob storage
   * @param {string} conversationId - The conversation ID
   * @returns {Array} The conversation history array or empty array if not found
   */
  async loadConversationHistory(conversationId) {
    await this.initialize();
    
    try {
      let content;
      
      if (this.useLocalStorage) {
        // Local file storage
        const filePath = this.path.join(this.localStoragePath, `${conversationId}.json`);
        if (this.fs.existsSync(filePath)) {
          content = this.fs.readFileSync(filePath, 'utf8');
        }
      } else {
        // Azure Blob Storage
        const blobName = `${conversationId}.json`;
        const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);
        
        const exists = await blockBlobClient.exists();
        if (exists) {
          const downloadResponse = await blockBlobClient.download(0);
          const chunks = [];
          
          for await (const chunk of downloadResponse.readableStreamBody) {
            chunks.push(chunk);
          }
          
          content = Buffer.concat(chunks).toString('utf8');
        }
      }
      
      return content ? JSON.parse(content) : [];
    } catch (error) {
      console.error('Error loading conversation history:', error);
      return [];
    }
  }

  /**
   * Delete conversation history
   * @param {string} conversationId - The conversation ID to delete
   */
  async deleteConversationHistory(conversationId) {
    await this.initialize();
    
    try {
      if (this.useLocalStorage) {
        // Local file storage
        const filePath = this.path.join(this.localStoragePath, `${conversationId}.json`);
        if (this.fs.existsSync(filePath)) {
          console.log(`Deleting local conversation history: ${filePath}`);
          this.fs.unlinkSync(filePath);
          console.log(`Successfully deleted local conversation history for conversation ID: ${conversationId}`);
        } else {
          console.log(`No local history found to delete for conversation ID: ${conversationId}`);
        }
      } else {
        // Azure Blob Storage
        const blobName = `${conversationId}.json`;
        const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);
        console.log(`Attempting to delete blob: ${blobName} from Azure Blob Storage`);
        const deleteResult = await blockBlobClient.deleteIfExists();
        if (deleteResult.succeeded) {
          console.log(`Successfully deleted blob for conversation ID: ${conversationId} from Azure Blob Storage`);
        } else {
          console.log(`No blob found to delete for conversation ID: ${conversationId} in Azure Blob Storage`);
        }
      }
    } catch (error) {
      console.error(`Error deleting conversation history for ID ${conversationId}:`, error);
    }
  }
}

module.exports = new StorageService();