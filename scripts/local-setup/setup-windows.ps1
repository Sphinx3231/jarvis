<#
  Jarvis - fully local setup for Windows (a GEEKOM A6, or any PC).

  Installs and wires up, all on this PC (no API keys, no cloud, no usage limits):
    - Ollama            the local model engine (one model kept loaded 24/7)
    - your model        whichever you choose (-Model), with the largest context window that fits your RAM
    - OpenJarvis        the brain server, plus the Python that runs local listening (Whisper) and the
                        voice (Kokoro) in on-demand workers that free their RAM when idle
    - Jarvis            built and started
    - logon tasks       "Jarvis Brain" (OpenJarvis) and "Jarvis" (the app), restarted if they stop

  Run from the Jarvis folder in PowerShell:
    powershell -ExecutionPolicy Bypass -File scripts\local-setup\setup-windows.ps1 -Model <ollama-model>
  Options:
    -Model <tag>   the model to run (any Ollama tag, e.g. a DeepSeek); omit to choose later with
                   node scripts\jarvis-local.ts use <tag>
    -Engine        talk to the engine directly (no OpenJarvis server: ~0.6 GB more RAM for the model)
    -Vulkan        let Ollama try the iGPU (experimental; CPU is the default)
    -KeepAwake     stop the PC sleeping on mains power (for 24/7 use)
    -NoServices    install only; don't register the logon tasks
#>
param(
  [string]$Model = '',
  [switch]$Engine,
  [switch]$Vulkan,
  [switch]$KeepAwake,
  [switch]$NoServices
)
$ErrorActionPreference = 'Stop'
# The OpenJarvis version Jarvis is tested against (has /v1/speech/synthesize - newer than PyPI 1.0.4).
$OpenJarvisCommit = '427c2dd11d180ac254a03e92c5fb01189fb4b23b'
$OpenJarvisSpec = if ($env:JARVIS_OPENJARVIS_SPEC) { $env:JARVIS_OPENJARVIS_SPEC } else { "openjarvis[server,voice,speech] @ https://github.com/open-jarvis/OpenJarvis/archive/$OpenJarvisCommit.zip" }
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Home_ = Join-Path $env:LOCALAPPDATA 'Jarvis'
$Venv = Join-Path $Home_ 'openjarvis'
$Logs = Join-Path $Home_ 'logs'
New-Item -ItemType Directory -Force -Path $Home_, $Logs | Out-Null

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ";$env:LOCALAPPDATA\Programs\Ollama;$env:USERPROFILE\.local\bin" }
function Winget-Install($id) {
  if (-not (Have 'winget')) { throw "winget is missing - install '$id' manually, then re-run." }
  winget install --id $id -e --silent --accept-package-agreements --accept-source-agreements | Out-Host
  Refresh-Path
}
$Local = Join-Path $Root 'scripts\jarvis-local.ts'
$EngineArgs = if ($Engine) { @('--engine') } else { @() }
function JarvisLocal { & node --disable-warning=ExperimentalWarning $Local @args @EngineArgs }
function Restart-Ollama {
  Get-Process -Name 'ollama*' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Process -FilePath 'ollama' -ArgumentList 'serve' -WindowStyle Hidden -RedirectStandardOutput (Join-Path $Logs 'ollama.log') -RedirectStandardError (Join-Path $Logs 'ollama.err.log')
  for ($i = 0; $i -lt 30; $i++) { try { Invoke-RestMethod 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2 | Out-Null; return } catch { Start-Sleep 1 } }
}
function Apply-OllamaEnv($lines) {
  foreach ($line in $lines) { Invoke-Expression $line }
  if ($Vulkan) { [Environment]::SetEnvironmentVariable('OLLAMA_VULKAN', '1', 'User') }
  foreach ($k in 'OLLAMA_MAX_LOADED_MODELS', 'OLLAMA_NUM_PARALLEL', 'OLLAMA_KEEP_ALIVE', 'OLLAMA_CONTEXT_LENGTH', 'OLLAMA_FLASH_ATTENTION', 'OLLAMA_KV_CACHE_TYPE', 'OLLAMA_HOST', 'OLLAMA_VULKAN') {
    $v = [Environment]::GetEnvironmentVariable($k, 'User'); if ($v) { Set-Item -Path "env:$k" -Value $v }
  }
}

Step 'Checking Node.js 22+'
if (-not (Have 'node') -or ([int]((node -v).TrimStart('v').Split('.')[0]) -lt 22)) { Winget-Install 'OpenJS.NodeJS.LTS' }
node -v
JarvisLocal budget

Step 'Ollama (the local model engine)'
if (-not (Have 'ollama')) {
  if (Have 'winget') { Winget-Install 'Ollama.Ollama' }
  else {
    # No winget: Ollama's own installer, silent.
    $setup = Join-Path $env:TEMP 'OllamaSetup.exe'
    Invoke-WebRequest 'https://ollama.com/download/OllamaSetup.exe' -OutFile $setup
    Start-Process -FilePath $setup -ArgumentList '/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES' -Wait
    Refresh-Path
  }
}
Apply-OllamaEnv (JarvisLocal env --context 16384 --format powershell)
Restart-Ollama

if ($Model) {
  Step "Downloading your model: $Model (once)"
  ollama pull $Model
  # Size the context window to what fits beside the model on this PC, then restart Ollama with it.
  Apply-OllamaEnv (JarvisLocal env $Model --format powershell)
  Restart-Ollama
}

Step 'OpenJarvis + local voice runtime (Whisper, Kokoro)'
if (-not (Have 'uv')) { Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression; Refresh-Path }
if (-not (Test-Path (Join-Path $Venv 'Scripts\python.exe'))) { uv venv --python 3.12 $Venv }
$Py = Join-Path $Venv 'Scripts\python.exe'
uv pip install --python $Py --index-strategy unsafe-best-match --extra-index-url https://download.pytorch.org/whl/cpu $OpenJarvisSpec
# Kokoro's English pronunciation needs this spaCy model. Installed now, because if Kokoro has to fetch it
# at the first spoken reply and that fails, spaCy exits and takes its process down with it.
# (Windows PowerShell 5.1 turns redirected stderr from a native command into an error under 'Stop'.)
$haveSpacyModel = $false
try { $ErrorActionPreference = 'Continue'; & $Py -c "import en_core_web_sm" 2>$null; $haveSpacyModel = ($LASTEXITCODE -eq 0) } finally { $ErrorActionPreference = 'Stop' }
if (-not $haveSpacyModel) {
  uv pip install --python $Py pip | Out-Null
  try { $ErrorActionPreference = 'Continue'; & $Py -m spacy download en_core_web_sm } finally { $ErrorActionPreference = 'Stop' }
  if ($LASTEXITCODE -ne 0) {
    $whl = Join-Path $env:TEMP 'en_core_web_sm-3.7.1-py3-none-any.whl'
    Invoke-WebRequest 'https://huggingface.co/spacy/en_core_web_sm/resolve/main/en_core_web_sm-any-py3-none-any.whl' -OutFile $whl
    uv pip install --python $Py $whl
  }
}
if ($Model) { JarvisLocal use $Model } else { JarvisLocal configure }

Step 'Building Jarvis'
Push-Location $Root
npm ci --no-audit --no-fund
npm run build
Pop-Location

$JarvisExe = Join-Path $Venv 'Scripts\jarvis.exe'
$BrainCmd = "`"$JarvisExe`" serve >> `"$Logs\openjarvis.log`" 2>&1"
# The harness stays small: a capped V8 heap; JARVIS_VOICE_PYTHON points the voice workers at the venv.
$Via = if ($Engine) { 'set JARVIS_BRAIN_VIA=engine&& ' } else { '' }
$AppCmd = "cd /d `"$Root`" && set JARVIS_VOICE_PYTHON=$Py&& $Via" + "node --max-old-space-size=384 --disable-warning=ExperimentalWarning server\main.ts >> `"$Logs\jarvis.log`" 2>&1"
$Tasks = @(@{ Name = 'Jarvis'; Cmd = $AppCmd })
if (-not $Engine) { $Tasks = @(@{ Name = 'Jarvis Brain'; Cmd = $BrainCmd }) + $Tasks }

if (-not $NoServices) {
  Step 'Registering logon tasks (restarted if they stop)'
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
  # At logon (in your session) - Jarvis needs your desktop for the microphone, voice and Computer Access.
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  foreach ($t in $Tasks) {
    # Extra outer quotes: cmd /c strips the first and last quote when the command starts with one.
    $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$($t.Cmd)`""
    Register-ScheduledTask -TaskName $t.Name -Action $action -Trigger $trigger -Settings $settings -Description 'Jarvis - fully local assistant' -Force | Out-Null
    Start-ScheduledTask -TaskName $t.Name
  }
}
elseif (-not $Engine) {
  Start-Process -FilePath 'cmd.exe' -ArgumentList "/c `"$BrainCmd`"" -WindowStyle Hidden
}

if ($KeepAwake) {
  Step 'Keeping the PC awake on mains power (24/7)'
  powercfg /change standby-timeout-ac 0
  powercfg /change hibernate-timeout-ac 0
}

if (-not $Engine) {
  Step 'Waiting for the brain'
  for ($i = 0; $i -lt 90; $i++) { try { Invoke-RestMethod 'http://127.0.0.1:8000/health' -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep 2 } }
}
JarvisLocal check
if (-not $Model) { Write-Host "`nNo model yet: pull one (ollama pull <model>), then run: node scripts\jarvis-local.ts use <model>" -ForegroundColor Yellow }
Write-Host "`nJarvis: http://127.0.0.1:7777   (logs: $Logs)" -ForegroundColor Green
exit 0
