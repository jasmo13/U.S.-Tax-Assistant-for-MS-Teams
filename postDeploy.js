// This script handles post-deployment tasks, including uploading a custom icon
// It reads environment variables set by Teams Toolkit during deployment
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const dotenv = require('dotenv');
const util = require('util');
const execPromise = util.promisify(exec);
const readline = require('readline');
const axios = require('axios');

// Create a readline interface for user interaction
function createReadlineInterface() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
}

// Ask a question and get the answer
async function askQuestion(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer);
    });
  });
}

// Ask a yes/no question and validate the answer
async function askYesNoQuestion(rl, question) {
  while (true) {
    const answer = await askQuestion(rl, question);
    const normalizedAnswer = answer.trim().toLowerCase();
    
    if (normalizedAnswer === 'y' || normalizedAnswer === 'yes') {
      return true;
    } else if (normalizedAnswer === 'n' || normalizedAnswer === 'no') {
      return false;
    } else {
      console.log("Please enter 'y' or 'n'.");
    }
  }
}

// Get bearer token using the reliable PowerShell device authentication approach
async function getPowerShellTokenWithDeviceAuth(tenantId = null) {
  try {
    console.log('\nAttempting to get token from PowerShell...');
    
    // Create a temporary PowerShell script for device authentication
    const tempScriptPath = path.join(__dirname, 'temp-auth.ps1');
    
    // PowerShell script content that ensures device code is clearly displayed
    // and handles the breaking change in Get-AzAccessToken
    let psScriptContent = `
Write-Host "===================================================="
Write-Host "             AZURE DEVICE AUTHENTICATION" -ForegroundColor Cyan
Write-Host "===================================================="
Write-Host ""

# Capture the Connect-AzAccount output to ensure it is formatted properly
try {
    # This launches the interactive authentication and shows the device code
`;

    // Add tenant ID parameter if provided
    if (tenantId) {
      psScriptContent += `    $result = Connect-AzAccount -UseDeviceAuthentication -TenantId '${tenantId}'`;
    } else {
      psScriptContent += `    $result = Connect-AzAccount -UseDeviceAuthentication`;
    }

    psScriptContent += `
    
    Write-Host ""
    Write-Host "Authentication successful!" -ForegroundColor Green
    Write-Host "User: $($result.Context.Account.Id)" -ForegroundColor Green
    Write-Host "Tenant: $($result.Context.Tenant.Id)" -ForegroundColor Green
    
    # Handle the upcoming breaking change in Get-AzAccessToken
    # Check if a version of Az that supports -AsSecureString is being used
    try {
        # First try with -AsSecureString parameter (future version)
        Write-Host "Trying to get token with -AsSecureString parameter..." -ForegroundColor Gray
        $secureToken = Get-AzAccessToken -ResourceUrl "https://management.azure.com/" -AsSecureString -ErrorAction Stop
        
        # Convert SecureString to plain text for use in script
        # Note: This is necessary for now because the plain token for API calls is needed
        $BSTR = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken.Token)
        $plainToken = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($BSTR)
        
        # Create an object with the plain token to return as JSON
        $tokenObj = @{
            Token = $plainToken
            ExpiresOn = $secureToken.ExpiresOn
            TenantId = $secureToken.TenantId
            UserId = $secureToken.UserId
            Type = $secureToken.Type
            IsSecureString = $true
        }
        $tokenObj | ConvertTo-Json
    }
    catch {
        # If -AsSecureString fails, fallback to the current version behavior
        Write-Host "Falling back to standard Get-AzAccessToken..." -ForegroundColor Gray
        $token = Get-AzAccessToken -ResourceUrl "https://management.azure.com/" -ErrorAction Stop
        Write-Host ""
        Write-Host "Successfully retrieved token!" -ForegroundColor Green
        $token | ConvertTo-Json
    }
}
catch {
    Write-Host "Authentication error: $_" -ForegroundColor Red
}`;
    
    // Write the script to a temporary file
    fs.writeFileSync(tempScriptPath, psScriptContent);
    console.log(`Created temporary authentication script at ${tempScriptPath}\n`);
    
    // Use spawn to run PowerShell with better interactive output handling
    return new Promise((resolve, reject) => {
      const ps = spawn('powershell', [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', tempScriptPath
      ], {
        stdio: ['inherit', 'pipe', 'pipe'] // Allow input inheritance but capture output
      });
      
      let stdoutData = '';
      let stderrData = '';
      
      ps.stdout.on('data', (data) => {
        const output = data.toString();
        stdoutData += output;
        process.stdout.write(output); // Display in real-time
      });
      
      ps.stderr.on('data', (data) => {
        const output = data.toString();
        stderrData += output;
        process.stderr.write(output); // Display in real-time
      });
      
      ps.on('close', (code) => {
        // Remove the temporary file
        try {
          fs.unlinkSync(tempScriptPath);
        } catch (err) {
          console.warn(`Warning: Could not remove temporary script file: ${err.message}`);
        }
        
        if (code !== 0) {
          return reject(new Error(`PowerShell authentication exited with code ${code}: ${stderrData}`));
        }
        
        // Extract token from JSON output
        const jsonStart = stdoutData.indexOf('{');
        const jsonEnd = stdoutData.lastIndexOf('}') + 1;
        
        if (jsonStart >= 0 && jsonEnd > 0) {
          try {
            const jsonStr = stdoutData.substring(jsonStart, jsonEnd);
            const tokenData = JSON.parse(jsonStr);
            console.log('Successfully retrieved token from PowerShell');
            resolve(tokenData.Token);
          } catch (error) {
            reject(new Error(`Failed to parse token JSON: ${error.message}`));
          }
        } else {
          reject(new Error('Could not find valid JSON in PowerShell output'));
        }
      });
      
      ps.on('error', (err) => {
        // Remove the temporary file
        try {
          fs.unlinkSync(tempScriptPath);
        } catch (unlinkErr) {
          console.warn(`Warning: Could not remove temporary script file: ${unlinkErr.message}`);
        }
        
        reject(new Error(`Failed to start PowerShell process: ${err.message}`));
      });
    });
  } catch (error) {
    console.error(`Authentication error: ${error.message}`);
    throw error;
  }
}

// Extract tenant ID from error response
function extractTenantIdFromError(error) {
  if (error.response && error.response.data && error.response.data.error) {
    const errorMessage = error.response.data.error.message;
    console.log(`Analyzing error message for tenant information: ${errorMessage}`);
    
    // Look for different patterns of tenant information in error messages
    const patterns = [
      /tenant\s+'https:\/\/sts\.windows\.net\/([^\/]+)/, // Standard format
      /directory\s+'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'/, // GUID format
      /AADSTS50020.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/ // AADSTS error
    ];
    
    for (const pattern of patterns) {
      const match = errorMessage.match(pattern);
      if (match && match[1]) {
        console.log(`Found tenant ID in error message: ${match[1]}`);
        return match[1];
      }
    }
  }
  
  console.log('No tenant ID found in error message');
  return null;
}

// Update bot icon with Azure REST API
async function updateBotIcon(botId, iconPath, token) {
  try {
    console.log("\n========== UPDATING BOT ICON ==========");
    
    // Parse bot ID to extract resource info
    const resourcePattern = /\/subscriptions\/([^\/]+)\/resourceGroups\/([^\/]+)\/providers\/Microsoft\.BotService\/botServices\/([^\/]+)/;
    const match = botId.match(resourcePattern);
    
    if (!match) {
      throw new Error(`Invalid Bot ID format: ${botId}`);
    }
    
    const [, subscriptionId, resourceGroupName, botName] = match;
    console.log(`Bot details:`);
    console.log(`- Name: ${botName}`);
    console.log(`- Resource Group: ${resourceGroupName}`);
    console.log(`- Subscription: ${subscriptionId}`);
    
    // Read the icon file as base64
    console.log(`\nReading icon from: ${iconPath}`);
    const iconContent = fs.readFileSync(iconPath);
    const base64Icon = iconContent.toString('base64');
    console.log(`Icon loaded successfully (${iconContent.length} bytes)`);
    
    // For Teams bots, you need to update the bot properties instead of using the updateIcon endpoint
    // First, get the current bot properties
    const apiVersion = '2022-09-15';
    const getBotUrl = `https://management.azure.com${botId}?api-version=${apiVersion}`;
    
    console.log(`\nGetting current bot properties for: ${botName}`);
    let getBotResponse;
    try {
      getBotResponse = await axios.get(getBotUrl, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
      console.log(`Successfully retrieved bot properties`);
    } catch (error) {
      if (error.response && error.response.status === 401) {
        console.log("Authentication error (401 Unauthorized)");
        console.log("This could be because you're trying to access a resource in a different tenant.");
        
        // Check for tenant information in the error
        let differentTenantId = null;
        if (error.response.data && error.response.data.error) {
          const errorMessage = error.response.data.error.message;
          console.log(`\nError message: ${errorMessage}`);
          
          const tenantMatch = errorMessage.match(/tenant\s+'https:\/\/sts\.windows\.net\/([^\/]+)/);
          if (tenantMatch && tenantMatch[1]) {
            differentTenantId = tenantMatch[1];
            console.log(`\nDetected different tenant ID: ${differentTenantId}`);
            
            const rl = createReadlineInterface();
            const shouldRetry = await askYesNoQuestion(rl, "\nWould you like to retry the authentication process? (y/n): ");
            rl.close();
            
            if (shouldRetry) {
              console.log("\nRetrying with the different tenant...");
              // Get a new token with the correct tenant
              const newToken = await getPowerShellTokenWithDeviceAuth(differentTenantId);
              // Retry the entire operation with new token
              return await updateBotIcon(botId, iconPath, newToken);
            }
          }
        }
        
        throw new Error("Authentication failed. Please check your tenant ID and permissions.");
      }
      throw error;
    }
    
    const botProperties = getBotResponse.data;
    
    // Second, update the bot properties with the new icon
    const updateUrl = `https://management.azure.com${botId}?api-version=${apiVersion}`;
    
    // Add icon to properties
    botProperties.properties.iconUrl = `data:image/png;base64,${base64Icon}`;
    
    console.log(`\nUpdating bot properties with new icon...`);
    const updateResponse = await axios.put(updateUrl, botProperties, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log(`\nIcon uploaded successfully for bot: ${botName}`);
    return updateResponse.data;
  } catch (error) {
    console.error(`\nError updating bot icon: ${error.message}`);
    if (error.response) {
      console.error(`Status: ${error.response.status}`);
      console.error(`Response: ${JSON.stringify(error.response.data, null, 2)}`);
    }
    throw error;
  }
}

async function main() {
  try {
    console.log('Running post-deployment tasks...');

    // Load environment variables from .env file
    const envFiles = [
      path.join(__dirname, 'env', '.env.dev')
    ];

    for (const envPath of envFiles) {
      if (fs.existsSync(envPath)) {
        console.log(`Loading environment from: ${envPath}`);
        dotenv.config({ path: envPath });
      }
    }

    // Check if the bot service resource ID has been retrieved
    const botServiceResourceId = process.env.BOT_AZURE_APP_SERVICE_RESOURCE_ID;
    if (!botServiceResourceId) {
      console.log('Bot service resource ID not found in environment variables.');
      return;
    }

    // Extract resource group and subscription ID from the resource ID
    // Format: /subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Web/sites/{siteName}
    const match = botServiceResourceId.match(/\/subscriptions\/([^\/]+)\/resourceGroups\/([^\/]+)\/providers\/Microsoft\.Web\/sites\/([^\/]+)/);
    if (!match) {
      console.log(`Invalid resource ID format: ${botServiceResourceId}`);
      return;
    }

    const [, subscriptionId, resourceGroupName, siteName] = match;

    // Construct the Bot Service resource ID
    // Format: /subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.BotService/botServices/{botName}
    const botName = siteName; // In most Teams Bot deployments, the site name and bot name are the same
    const botServiceId = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.BotService/botServices/${botName}`;

    // Path to the icon file
    const iconPath = path.join(__dirname, 'appPackage', 'color.png');
    if (!fs.existsSync(iconPath)) {
      console.log(`Icon file not found: ${iconPath}`);
      return;
    }

    console.log(`Uploading icon for bot: ${botName}`);
    console.log(`Using icon from: ${iconPath}`);

    // Ask user if they want to upload the icon
    const rl = createReadlineInterface();
    const shouldUploadIcon = await askYesNoQuestion(rl, "Do you want to upload the bot icon? This requires Azure authentication (y/n): ");
    
    if (shouldUploadIcon) {
      try {
        // Get authentication token using PowerShell device authentication
        console.log("\nStarting Azure authentication for bot icon upload...");
        
        // First check if PowerShell is available
        try {
          await execPromise('powershell -Command "Write-Host \'PowerShell is available\'"');
          console.log("PowerShell is available on this system.");
        } catch (psError) {
          console.error("PowerShell is not available on this system.");
          console.error("Please ensure PowerShell is installed and accessible from the command line.");
          throw new Error("PowerShell is required for authentication but is not available");
        }
        
        // Check if Az PowerShell module is installed
        try {
          await execPromise('powershell -Command "Get-Command Connect-AzAccount -ErrorAction Stop | Out-Null; Write-Host \'Az module is installed\'"');
          console.log("Az PowerShell module is installed.");
        } catch (azError) {
          console.log("Azure PowerShell module (Az) is not installed or not loaded.");
          console.log("In your PowerShell terminal, enter 'Install-Module -Name Az -Scope CurrentUser -Force -AllowClobber' and then enter 'npm run post-deploy' to redo this process.");
          rl.close();
          return;
        }

        // Use the reliable device authentication method
        const token = await getPowerShellTokenWithDeviceAuth();
        
        // Upload the icon
        await updateBotIcon(botServiceId, iconPath, token);
        console.log("\nBot icon updated successfully!");
      } catch (error) {
        console.error(`\nFailed to update bot icon: ${error.message}`);
        console.log("You can upload the icon manually later using: npm run post-deploy");
      }
    } else {
      console.log("\nSkipping bot icon upload.");
      console.log("You can upload the icon manually later using: npm run post-deploy");
    }
    
    rl.close();
  } catch (error) {
    console.error(`Error in post-deployment script: ${error.message}`);
  }
}

main();