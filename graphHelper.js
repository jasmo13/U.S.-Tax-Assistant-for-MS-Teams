/**
 * Microsoft Graph API helper module for Teams apps using RSC
 * Handles authentication, permission checks, and Graph API calls
 */

const { Client } = require('@microsoft/microsoft-graph-client');
const { TokenCredentialAuthenticationProvider } = require('@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials');
const { DefaultAzureCredential, ManagedIdentityCredential, ClientSecretCredential } = require('@azure/identity');
require('isomorphic-fetch');

/**
 * Creates a Microsoft Graph client with proper authentication and error handling
 * This handles different authentication methods based on the environment
 * 
 * @param {Object} options - Configuration options
 * @param {string} options.tenantId - Optional tenant ID to use (for multi-tenant apps)
 * @param {boolean} options.debugMode - Enable detailed debug logging
 * @returns {Object} Microsoft Graph client instance
 */
function createGraphClient(options = {}) {
    const { tenantId, debugMode = false } = options;

    // Check environment: running in Azure with managed identity vs local dev
    const isRunningInAzure = process.env.RUNNING_ON_AZURE === '1' || process.env.WEBSITE_SITE_NAME;
    const clientId = process.env.BOT_ID || process.env.AZURE_CLIENT_ID;
    
    if (debugMode) {
        console.log(`Graph client initialization:
- Running in Azure: ${isRunningInAzure ? 'Yes' : 'No'}
- Client ID available: ${clientId ? 'Yes' : 'No'}
- Tenant ID specified: ${tenantId || 'No'}`);
    }

    // Create the appropriate credential based on environment
    let credential;
    
    try {
        if (isRunningInAzure) {
            // In Azure, prefer using managed identity
            if (debugMode) console.log('Using Managed Identity for Graph authentication');
            
            const userAssignedClientId = process.env.BOT_ID || process.env.ManagedIdentityClientId;
            
            if (userAssignedClientId) {
                // Use user-assigned managed identity if available
                credential = new ManagedIdentityCredential(userAssignedClientId);
                if (debugMode) console.log(`Using user-assigned managed identity with client ID: ${userAssignedClientId}`);
            } else {
                // Fall back to system-assigned managed identity
                credential = new ManagedIdentityCredential();
                if (debugMode) console.log('Using system-assigned managed identity');
            }
        } else {
            // For local development, use DefaultAzureCredential which tries multiple methods
            if (debugMode) console.log('Using DefaultAzureCredential for local development');
            credential = new DefaultAzureCredential({
                tenantId: tenantId || process.env.AZURE_TENANT_ID,
            });
        }

        // Create auth provider for Microsoft Graph
        const authProvider = new TokenCredentialAuthenticationProvider(credential, {
            scopes: ['https://graph.microsoft.com/.default'],
        });

        // Create Microsoft Graph client
        const graphClient = Client.initWithMiddleware({
            authProvider,
            debugLogging: debugMode
        });

        return graphClient;
    } catch (error) {
        console.error('Error creating Graph client:', error.message);
        throw error;
    }
}

/**
 * Get messages from a Teams chat using RSC permissions
 * 
 * @param {string} chatId - Teams chat ID
 * @param {Object} options - Options for the request
 * @param {number} options.top - Maximum number of messages to return
 * @param {boolean} options.debugMode - Enable detailed debug logging
 * @returns {Promise<Array>} Messages from the chat
 */
async function getChatMessages(chatId, options = {}) {
    const { top = 50, debugMode = false } = options;
    
    if (debugMode) {
        console.log(`Fetching messages from chat ID: ${chatId}`);
    }
    
    try {
        // Create Graph client with diagnostic logging if requested
        const graphClient = createGraphClient({ debugMode });
        
        // Attempt to check permissions before making the actual call
        if (debugMode) {
            try {
                await checkGraphPermissions(graphClient);
            } catch (permErr) {
                console.warn('Permission check warning:', permErr.message);
            }
        }
        
        // Make the actual Graph API call
        const response = await graphClient
            .api(`/chats/${chatId}/messages`)
            .top(top)
            .select('id,createdDateTime,from,body')
            .orderBy('createdDateTime desc')
            .get();
            
        if (debugMode) {
            console.log(`Successfully retrieved ${response.value?.length || 0} messages from chat`);
        }
        
        return response.value || [];
    } catch (error) {
        handleGraphError(error, 'getChatMessages', { chatId, debugMode });
        throw error; // Re-throw after logging
    }
}

/**
 * Check what Graph API permissions the app currently has
 * This is a diagnostic function that attempts to access common Graph endpoints
 * to determine what permissions are actually available
 * 
 * @param {Object} graphClient - Authenticated Graph client
 * @returns {Promise<Object>} Object containing permission check results
 */
async function checkGraphPermissions(graphClient) {
    const results = {
        checkedAt: new Date().toISOString(),
        permissions: {}
    };
    
    // Test various permission combinations
    const permissionTests = [
        { 
            name: 'ChatMessage.Read.Chat', 
            test: async () => await graphClient.api('/me/chats').top(1).get()
        },
        { 
            name: 'Chat.Read.All', 
            test: async () => await graphClient.api('/chats').top(1).get()
        },
        { 
            name: 'User.Read', 
            test: async () => await graphClient.api('/me').get()
        }
    ];
    
    // Run tests and log results
    console.log('Running Graph permission diagnostic checks...');
    
    for (const test of permissionTests) {
        try {
            await test.test();
            results.permissions[test.name] = true;
            console.log(`✅ Permission check passed: ${test.name}`);
        } catch (error) {
            results.permissions[test.name] = false;
            console.log(`❌ Permission check failed: ${test.name} - ${error.message}`);
        }
    }
    
    return results;
}

/**
 * Handle Graph API errors with proper diagnostics
 * 
 * @param {Error} error - The error from Graph API
 * @param {string} operation - The operation being performed
 * @param {Object} context - Additional context information
 */
function handleGraphError(error, operation, context = {}) {
    console.error(`Graph API error during ${operation}:`, error.message);
    
    // Extract and log detailed error information
    if (error.response) {
        const statusCode = error.response.status || 'Unknown';
        console.error(`Status code: ${statusCode}`);
        
        // Check for specific error conditions
        if (statusCode === 401) {
            console.error('Authentication error - verify the identity has proper Graph permissions');
        } else if (statusCode === 403) {
            console.error('Authorization error - missing permissions or RSC not granted');
            
            // Provide more details about missing permissions
            if (error.response.body && error.response.body.error) {
                const errorBody = error.response.body.error;
                console.error(`Error code: ${errorBody.code}`);
                console.error(`Error message: ${errorBody.message}`);
                
                // Check for specific permission mentions in the error
                if (errorBody.message && errorBody.message.includes('permission')) {
                    console.error('Specific permissions mentioned in error:', 
                        extractPermissionsFromError(errorBody.message));
                }
            }
            
            console.error('Verify that RSC permissions are properly configured in the Teams app manifest');
            console.error('Verify that the app has been installed by a team or chat owner');
        }
        
        if (context.debugMode && error.response.body) {
            console.error('Full error response:', JSON.stringify(error.response.body, null, 2));
        }
    }
}

/**
 * Extract permission names from an error message
 * 
 * @param {string} errorMessage - The error message from Graph API
 * @returns {Array<string>} List of permission names mentioned in the error
 */
function extractPermissionsFromError(errorMessage) {
    const permissionRegex = /'([^']+)'/g;
    const matches = errorMessage.match(permissionRegex);
    
    if (!matches) return [];
    
    return matches
        .map(match => match.replace(/'/g, ''))
        .filter(permission => permission.includes('.'));
}

module.exports = {
    createGraphClient,
    getChatMessages,
    checkGraphPermissions
};