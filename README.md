# U.S. Tax Assistant for Microsoft Teams

A Teams bot that provides expert guidance on U.S. federal and state tax information using AI-powered responses with built-in tax knowledge.

## Overview

U.S. Tax Assistant is a Microsoft Teams bot that helps users navigate the complex U.S. tax system by providing clear explanations and guidance on tax-related questions. The bot leverages OpenAI's GPT-4.1 model with access to the complete U.S. Tax Code (Title 26—Internal Revenue Code) and the internet to deliver accurate and helpful tax information.

## Features

- **Tax Regulation Explanations**: Clear explanations of specific tax regulations and their practical applications
- **Tax Form Assistance**: Help selecting the appropriate tax forms for different situations
- **Deduction & Credit Guidance**: Personalized advice on available deductions, credits, and filing status options
- **Common Question Answers**: Detailed responses to frequently asked tax questions
- **Resource Recommendations**: Guidance to additional resources for complex tax issues
- **Persistent Conversations**: Conversation history is preserved between sessions
- **Automatic Disclaimers**: AI-powered classification system adds appropriate disclaimers to tax advice
- **Retrieval-Augmented Generation**: Uses OpenAI's file search capability with a custom vector store to provide accurate U.S. Tax Code information
- **Internet Access**: Ability to search the web for the latest tax information, IRS publications, and state-specific tax guidance when needed

## Target Audience

- Individual taxpayers
- Small business owners
- Tax professionals seeking quick reference information

## Technical Architecture

The U.S. Tax Assistant is built using:

- **Microsoft Bot Framework**: Core Teams bot functionality
- **Node.js**: Server-side runtime
- **Azure App Service**: Cloud hosting platform
- **Azure Blob Storage**: Persistent conversation history storage
- **OpenAI API**: GPT-4.1 model for AI-powered responses
- **OpenAI Vector Store**: Retrieval-augmented generation for accessing the U.S. Tax Code
- **Azure Managed Identity**: Secure authentication for Azure resources

## Getting Started

### Prerequisites

- Microsoft 365 for Business account
- Node.js (18.x or 20.x)
- Teams Toolkit for Visual Studio Code
- Azure subscription (with valid resource group)
- OpenAI API key
- OpenAI Vector Store ID for accessing the U.S. Tax Code knowledge base

### Environment Setup

This repository contains sample environment files that show the required configuration structure without exposing sensitive information. When setting up the project, follow these steps:

1. Copy the sample environment files to create your configuration files:
   ```bash
   # Copy environment sample files
   cp env/.env.dev.sample env/.env.dev
   cp env/.env.dev.user.sample env/.env.dev.user
   cp env/.env.local.sample env/.env.local
   cp env/.env.local.user.sample env/.env.local.user
   cp env/.env.testtool.sample env/.env.testtool
   cp infra/azure.parameters.json.sample infra/azure.parameters.json
   ```

2. Update each file with your configuration values (refer to the table below)

3. Keep your configuration files private:
   - The .gitignore is configured to exclude real configuration files while allowing sample files
   - Never commit files containing real credentials or API keys
   - Each developer should maintain their own local configuration

### Required Configuration Values

| File | Key Configuration Values |
|------|--------------------------|
| .env.dev | AZURE_SUBSCRIPTION_ID, AZURE_RESOURCE_GROUP_NAME, RESOURCE_SUFFIX |
| .env.dev.user | OPENAI_API_KEY, OPENAI_VECTOR_STORE_ID, BOT_LOCATION_COUNTRY, BOT_LOCATION_REGION, BOT_LOCATION_CITY, BOT_TIMEZONE |
| azure.parameters.json | openAiApiKey, openAiVectorStoreId, botLocationCountry, botLocationRegion, botLocationCity, botTimezone |

### OpenAI Vector Store Configuration

The U.S. Tax Assistant uses OpenAI's file search capability to retrieve and provide accurate information from the U.S. Tax Code. This requires:

1. **Vector Store ID**: A unique identifier for your OpenAI vector store that contains the indexed U.S. Tax Code.
   - Format: `vs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
   - This ID must be configured in all environment files as described in the table above
   - In production (Azure), this is set via the Azure App Service configuration

2. **Creating a Vector Store**: If you need to create your own vector store:
   - Download the PDF version of Title 26 (Internal Revenue Code) from the official U.S. House of Representatives website: https://uscode.house.gov/download/download.shtml
   - Extract the zip file containing the PDF document
   - Split the PDF into 100-page segments for easier upload using software such as Adobe Acrobat
   - Create a vector store for these documents in the OpenAI developer site: https://platform.openai.com/storage/vector_stores/
   - Upload the U.S. Tax Code documents to the vector store
   - Use the resulting vector store ID in your configuration

3. **Vector Store Best Practices**:
   - Keep your vector store updated with the latest tax code changes
   - For best results, process the tax code into smaller, semantically meaningful chunks before indexing
   - Consider including IRS publications and regulations for comprehensive coverage

### Local Development

1. Clone this repository
2. Set up environment files as described above
3. Start the bot locally by pressing F5

### Deployment

This project uses Teams Toolkit to streamline deployment to Azure:

1. Ensure you have the Teams Toolkit extension installed in VS Code
2. Use the Teams Toolkit deployment commands
3. The deployment will:
   - Create an Azure Bot registration
   - Deploy to Azure App Service
   - Configure necessary authentication
   - Upload the app package to Teams

## Architecture

- **teamsBot.js**: Core bot logic, handles messages and OpenAI API integration
- **taxDisclaimerClassifier.js**: AI-based classifier to determine when tax disclaimers are needed
- **storageService.js**: Manages persistent conversation storage in Azure Blob Storage
- **index.js**: Express server setup and initialization
- **infra/**: Contains Bicep infrastructure-as-code files for Azure deployment

## Security Features

- Uses Azure Managed Identity for secure, passwordless authentication
- Implements Storage Blob Data Contributor role assignment for least privilege
- Securely manages OpenAI API keys in Azure App Service configuration
- Implements fallback storage mechanisms for reliability

## Commands

- **/restart**: Clears conversation history and starts a new session

## Disclaimer

U.S. Tax Assistant provides general tax information and guidance only. The information provided is not legal or tax advice, and should not be relied upon as such. Tax laws are complex and subject to change. While we strive for accuracy, this bot may not account for your specific circumstances, recent tax law changes, or uncommon tax situations. Always verify information with the official IRS resources or consult with a qualified tax professional before making financial decisions or tax filings. Jake Campbell, the creator of this bot, is not responsible for any actions taken based on the information provided.

## Troubleshooting

- Check the bot's logs in the Azure CLI (after authenticating your session) by entering the following command: `az webapp log tail --name YourAppName --resource-group YourResourceGroupName`
- Ensure the OpenAI API key is correctly set in the App Service configuration
- Verify the bot has proper permissions to access Azure Blob Storage

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the LICENSE file for details.