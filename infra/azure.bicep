@maxLength(20)
@minLength(4)
@description('Used to generate names for all resources in this file')
param resourceBaseName string

param webAppSKU string

@maxLength(42)
param botDisplayName string

@maxLength(512)
param botDescription string

@description('OpenAI API Key for the bot to use. This should be kept blank in the template and provided during deployment.')
@secure()
param openAiApiKey string

@description('OpenAI Vector Store ID used for retrieval-augmented generation (RAG). This should be provided during deployment.')
@secure()
param openAiVectorStoreId string

@description('Controls whether OpenAI stores conversation logs (visible to your organization)')
param openAiStoreConversationLogs bool

@description('Microsoft Graph token for RSC chat history check (for local dev or testing only)')
@secure()
param microsoftGraphToken string

@description('User location country for the bot to use (e.g., US, GB)')
param botLocationCountry string

@description('User location region/state for the bot to use (e.g., California, Texas)')
param botLocationRegion string

@description('User location city for the bot to use (e.g., Los Angeles, New York)')
param botLocationCity string

@description('Timezone for the bot to use when displaying dates (e.g., America/New_York, America/Chicago, America/Los_Angeles)')
param botTimezone string

param serverfarmsName string = resourceBaseName
param webAppName string = resourceBaseName
param identityName string = resourceBaseName
param storageAccountName string = toLower(resourceBaseName)
param location string = resourceGroup().location

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2018-11-30' = {
  location: location
  name: identityName
}

// Storage account for conversation history persistence
resource storageAccount 'Microsoft.Storage/storageAccounts@2021-09-01' = {
  name: storageAccountName
  location: location
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    accessTier: 'Hot'
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

// Assign the Storage Blob Data Contributor role to the bot identity
resource roleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(identity.id, storageAccount.id, 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  scope: storageAccount
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe') // Storage Blob Data Contributor role
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Create blob service for storage account
resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2021-09-01' = {
  parent: storageAccount
  name: 'default'
}

// Explicitly create storage container in Bicep to ensure it exists
resource container 'Microsoft.Storage/storageAccounts/blobServices/containers@2021-09-01' = {
  parent: blobService
  name: 'conversation-history'
  properties: {
    publicAccess: 'None'
  }
}

// Compute resources for your Web App
resource serverfarm 'Microsoft.Web/serverfarms@2021-02-01' = {
  kind: 'app'
  location: location
  name: serverfarmsName
  sku: {
    name: webAppSKU
  }
}

// Web App that hosts your bot
resource webApp 'Microsoft.Web/sites@2021-02-01' = {
  kind: 'app'
  location: location
  name: webAppName
  properties: {
    serverFarmId: serverfarm.id
    httpsOnly: true
    siteConfig: {
      alwaysOn: false
      appSettings: [
        {
          name: 'WEBSITE_RUN_FROM_PACKAGE'
          value: '1' // Run Azure App Service from a package file
        }
        {
          name: 'WEBSITE_NODE_DEFAULT_VERSION'
          value: '~22' // Set NodeJS version to 22.x LTS for your site
        }
        {
          name: 'RUNNING_ON_AZURE'
          value: '1'
        }
        {
          name: 'BOT_ID'
          value: identity.properties.clientId
        }
        {
          name: 'BOT_TENANT_ID'
          value: identity.properties.tenantId
        }
        { 
          name: 'BOT_TYPE'
          value: 'UserAssignedMsi' 
        }
        {
          name: 'OPENAI_API_KEY'
          value: openAiApiKey
        }
        {
          name: 'OPENAI_VECTOR_STORE_ID'
          value: openAiVectorStoreId
        }
                {
          name: 'OPENAI_STORE_CONVERSATION_LOGS'
          value: openAiStoreConversationLogs ? 'true' : 'false'
        }
        {
          name: 'MICROSOFT_GRAPH_TOKEN'
          value: microsoftGraphToken
        }
        {
          name: 'BOT_LOCATION_COUNTRY'
          value: botLocationCountry
        }
        {
          name: 'BOT_LOCATION_REGION'
          value: botLocationRegion
        }
        {
          name: 'BOT_LOCATION_CITY'
          value: botLocationCity
        }
        {
          name: 'BOT_TIMEZONE'
          value: botTimezone
        }
        {
          name: 'USE_LOCAL_STORAGE'
          value: 'false' // Use Azure Blob Storage in production
        }
        {
          name: 'AZURE_STORAGE_ACCOUNT_NAME'
          value: storageAccount.name
        }
      ]
      ftpsState: 'FtpsOnly'
    }
  }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
}

// Register your web service as a bot with the Bot Framework
module azureBotRegistration './botRegistration/azurebot.bicep' = {
  name: 'Azure-Bot-registration'
  params: {
    resourceBaseName: resourceBaseName
    identityClientId: identity.properties.clientId
    identityResourceId: identity.id
    identityTenantId: identity.properties.tenantId
    botAppDomain: webApp.properties.defaultHostName
    botDisplayName: botDisplayName
    botDescription: botDescription
  }
}

// The output will be persisted in .env.{envName}. Visit https://aka.ms/teamsfx-actions/arm-deploy for more details.
output BOT_AZURE_APP_SERVICE_RESOURCE_ID string = webApp.id
output BOT_DOMAIN string = webApp.properties.defaultHostName
output BOT_ID string = identity.properties.clientId
output BOT_TENANT_ID string = identity.properties.tenantId
output STORAGE_ACCOUNT_NAME string = storageAccount.name
