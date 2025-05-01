const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/**
 * Runs a PowerShell device authentication flow to get a Microsoft Graph token for local dev.
 * Sets process.env.MICROSOFT_GRAPH_TOKEN for the current session.
 * Returns a Promise that resolves to the token string.
 */
async function ensureDevGraphToken() {
  // Create a temporary PowerShell script for device authentication
  const tempScriptPath = path.join(__dirname, 'temp-dev-auth.ps1');
  let psScriptContent = `
Write-Host "===================================================="
Write-Host "      AZURE DEVICE AUTH FOR MICROSOFT GRAPH" -ForegroundColor Cyan
Write-Host "===================================================="
Write-Host ""
try {
    $result = Connect-AzAccount -UseDeviceAuthentication
    Write-Host ""
    Write-Host "Authentication successful!" -ForegroundColor Green
    Write-Host "User: $($result.Context.Account.Id)" -ForegroundColor Green
    Write-Host "Tenant: $($result.Context.Tenant.Id)" -ForegroundColor Green
    $token = Get-AzAccessToken -ResourceUrl "https://graph.microsoft.com/" -ErrorAction Stop
    $token | ConvertTo-Json
} catch {
    Write-Host "Authentication error: $_" -ForegroundColor Red
}`;
  fs.writeFileSync(tempScriptPath, psScriptContent);
  console.log(`[DEV AUTH] Created temporary authentication script at ${tempScriptPath}`);

  return new Promise((resolve, reject) => {
    const ps = spawn('powershell', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', tempScriptPath
    ], {
      stdio: ['inherit', 'pipe', 'pipe']
    });
    let stdoutData = '';
    let stderrData = '';
    ps.stdout.on('data', (data) => {
      const output = data.toString();
      stdoutData += output;
      process.stdout.write(output);
    });
    ps.stderr.on('data', (data) => {
      const output = data.toString();
      stderrData += output;
      process.stderr.write(output);
    });
    ps.on('close', (code) => {
      try { fs.unlinkSync(tempScriptPath); } catch {}
      if (code !== 0) {
        return reject(new Error(`[DEV AUTH] PowerShell exited with code ${code}: ${stderrData}`));
      }
      // Extract token from JSON output
      const jsonStart = stdoutData.indexOf('{');
      const jsonEnd = stdoutData.lastIndexOf('}') + 1;
      if (jsonStart >= 0 && jsonEnd > 0) {
        try {
          const jsonStr = stdoutData.substring(jsonStart, jsonEnd);
          const tokenData = JSON.parse(jsonStr);
          if (tokenData.Token) {
            process.env.MICROSOFT_GRAPH_TOKEN = tokenData.Token;
            console.log('[DEV AUTH] Acquired Microsoft Graph token for dev session.');
            resolve(tokenData.Token);
            return;
          }
        } catch (error) {
          return reject(new Error(`[DEV AUTH] Failed to parse token JSON: ${error.message}`));
        }
      }
      reject(new Error('[DEV AUTH] Could not find valid JSON/token in PowerShell output'));
    });
    ps.on('error', (err) => {
      try { fs.unlinkSync(tempScriptPath); } catch {}
      reject(new Error(`[DEV AUTH] Failed to start PowerShell process: ${err.message}`));
    });
  });
}

module.exports = { ensureDevGraphToken };
