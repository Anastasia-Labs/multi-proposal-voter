param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 8793,
    [switch]$NoBrowser
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

$Root = [System.IO.Path]::GetFullPath($PSScriptRoot)
$StaticRoot = Join-Path $Root "dist"
$KoiosBase = "https://api.koios.rest/api/v1"
$MaxActions = 20
$Routes = @{
    "/"                                           = @{ File = "index.html"; Type = "text/html; charset=utf-8" }
    "/index.html"                                 = @{ File = "index.html"; Type = "text/html; charset=utf-8" }
    "/assets/index.css"                           = @{ File = "assets\index.css"; Type = "text/css; charset=utf-8" }
    "/assets/app.js"                              = @{ File = "assets\app.js"; Type = "application/javascript; charset=utf-8" }
    "/assets/cardano_message_signing_bg.wasm"     = @{ File = "assets\cardano_message_signing_bg.wasm"; Type = "application/wasm" }
    "/assets/cardano_multiplatform_lib_bg.wasm"   = @{ File = "assets\cardano_multiplatform_lib_bg.wasm"; Type = "application/wasm" }
    "/assets/uplc_tx_bg.wasm"                     = @{ File = "assets\uplc_tx_bg.wasm"; Type = "application/wasm" }
}

function Send-Response {
    param(
        [System.Net.Sockets.NetworkStream]$Stream,
        [int]$Status,
        [string]$Reason,
        [string]$ContentType,
        [byte[]]$Body,
        [bool]$HeadOnly
    )

    $Header = "HTTP/1.1 $Status $Reason`r`nContent-Type: $ContentType`r`nContent-Length: $($Body.Length)`r`nCache-Control: no-store`r`nX-Content-Type-Options: nosniff`r`nX-Frame-Options: DENY`r`nReferrer-Policy: no-referrer`r`nConnection: close`r`n`r`n"
    $HeaderBytes = [System.Text.Encoding]::ASCII.GetBytes($Header)
    try {
        $Stream.Write($HeaderBytes, 0, $HeaderBytes.Length)
        if (-not $HeadOnly -and $Body.Length -gt 0) {
            $Stream.Write($Body, 0, $Body.Length)
        }
        $Stream.Flush()
    } catch [System.IO.IOException] {
        # The browser may close a speculative request before the response arrives.
    }
}

function Send-Json {
    param(
        [System.Net.Sockets.NetworkStream]$Stream,
        [int]$Status,
        [string]$Reason,
        [object]$Payload,
        [bool]$HeadOnly = $false
    )

    $Json = ConvertTo-Json -InputObject $Payload -Compress -Depth 8
    $Body = [System.Text.Encoding]::UTF8.GetBytes($Json)
    Send-Response $Stream $Status $Reason "application/json; charset=utf-8" $Body $HeadOnly
}

function Throw-BadRequest {
    param([string]$Message)
    throw [System.ArgumentException]::new($Message)
}

function Invoke-KoiosJson {
    param(
        [string]$Path,
        [object]$Body = $null
    )

    $Request = @{
        Uri = "$KoiosBase/$Path"
        Headers = @{
            Accept = "application/json"
            "User-Agent" = "cardano-local-multi-voter/1.0"
        }
        TimeoutSec = 20
        ErrorAction = "Stop"
    }
    if ($null -eq $Body) {
        $Request.Method = "Get"
    } else {
        $Request.Method = "Post"
        $Request.ContentType = "application/json"
        $Request.Body = ConvertTo-Json -InputObject $Body -Compress -Depth 8
    }
    return Invoke-RestMethod @Request
}

function Get-NetworkPayload {
    $Params = Invoke-KoiosJson "cli_protocol_params"
    $TipRows = @(Invoke-KoiosJson "tip")
    if ($TipRows.Count -lt 1) {
        throw "Koios returned no chain tip."
    }
    $Tip = $TipRows[0]
    return [ordered]@{
        networkId = 1
        epoch = [long]$Tip.epoch_no
        absoluteSlot = [long]$Tip.abs_slot
        blockTime = [long]$Tip.block_time
        txFeePerByte = [long]$Params.txFeePerByte
        txFeeFixed = [long]$Params.txFeeFixed
        utxoCostPerByte = [long]$Params.utxoCostPerByte
        maxTxSize = [long]$Params.maxTxSize
    }
}

function Get-ProposalValidation {
    param([object]$Payload)

    $ActionsProperty = $Payload.PSObject.Properties["actions"]
    if ($null -eq $ActionsProperty) {
        Throw-BadRequest "Provide between 1 and $MaxActions governance actions."
    }
    $Actions = @($ActionsProperty.Value)
    if ($Actions.Count -lt 1 -or $Actions.Count -gt $MaxActions) {
        Throw-BadRequest "Provide between 1 and $MaxActions governance actions."
    }

    $Seen = New-Object "System.Collections.Generic.HashSet[string]"
    $Normalized = @()
    foreach ($Action in $Actions) {
        if ($null -eq $Action) {
            Throw-BadRequest "Each action needs a 64-character transaction hash and index from 0 to 65535."
        }
        $HashProperty = $Action.PSObject.Properties["txHash"]
        $IndexProperty = $Action.PSObject.Properties["index"]
        if ($null -eq $HashProperty -or $null -eq $IndexProperty -or $HashProperty.Value -isnot [string] -or $IndexProperty.Value -is [string]) {
            Throw-BadRequest "Each action needs a 64-character transaction hash and index from 0 to 65535."
        }
        $TxHash = ([string]$HashProperty.Value).ToLowerInvariant()
        [long]$Index = 0
        if ($TxHash -notmatch "^[0-9a-f]{64}$" -or -not [long]::TryParse([string]$IndexProperty.Value, [ref]$Index) -or $Index -lt 0 -or $Index -gt 65535) {
            Throw-BadRequest "Each action needs a 64-character transaction hash and index from 0 to 65535."
        }
        $Key = "$TxHash#$Index"
        if (-not $Seen.Add($Key)) {
            Throw-BadRequest "Duplicate governance action: $Key."
        }
        $Normalized += [pscustomobject]@{ txHash = $TxHash; index = [int]$Index }
    }

    $TipRows = @(Invoke-KoiosJson "tip")
    if ($TipRows.Count -lt 1) {
        throw "Koios returned no chain tip."
    }
    $CurrentEpoch = [long]$TipRows[0].epoch_no
    $Select = "proposal_id,proposal_tx_hash,proposal_index,proposal_type,proposed_epoch,expiration,ratified_epoch,enacted_epoch,dropped_epoch,expired_epoch"
    $Results = @()
    foreach ($Action in $Normalized) {
        $Path = "proposal_list?proposal_tx_hash=eq.$($Action.txHash)&proposal_index=eq.$($Action.index)&select=$Select"
        $Rows = @(Invoke-KoiosJson $Path)
        if ($Rows.Count -lt 1) {
            $Results += [ordered]@{
                txHash = $Action.txHash
                index = $Action.index
                found = $false
                open = $false
            }
            continue
        }

        $Proposal = $Rows[0]
        $Terminal = ($null -ne $Proposal.ratified_epoch) -or ($null -ne $Proposal.enacted_epoch) -or ($null -ne $Proposal.dropped_epoch) -or ($null -ne $Proposal.expired_epoch)
        $Expiration = [long]$Proposal.expiration
        $Results += [ordered]@{
            txHash = $Action.txHash
            index = $Action.index
            found = $true
            open = [bool]((-not $Terminal) -and ($CurrentEpoch -le $Expiration))
            proposalId = $Proposal.proposal_id
            proposalType = $Proposal.proposal_type
            proposedEpoch = $Proposal.proposed_epoch
            expirationEpoch = $Expiration
            currentEpoch = $CurrentEpoch
            ratifiedEpoch = $Proposal.ratified_epoch
            enactedEpoch = $Proposal.enacted_epoch
            droppedEpoch = $Proposal.dropped_epoch
            expiredEpoch = $Proposal.expired_epoch
        }
    }

    return [ordered]@{
        currentEpoch = $CurrentEpoch
        proposals = @($Results)
    }
}

function Get-DrepValidation {
    param([object]$Payload)

    $IdProperty = $Payload.PSObject.Properties["drepId"]
    $HashProperty = $Payload.PSObject.Properties["keyHash"]
    if ($null -eq $IdProperty -or $null -eq $HashProperty -or $IdProperty.Value -isnot [string] -or $HashProperty.Value -isnot [string]) {
        Throw-BadRequest "Provide a valid key-based CIP-129 DRep ID and key hash."
    }
    $DrepId = ([string]$IdProperty.Value).ToLowerInvariant()
    $KeyHash = ([string]$HashProperty.Value).ToLowerInvariant()
    if ($DrepId -notmatch "^drep1[023456789acdefghjklmnpqrstuvwxyz]{20,100}$" -or $KeyHash -notmatch "^[0-9a-f]{56}$") {
        Throw-BadRequest "Provide a valid key-based CIP-129 DRep ID and key hash."
    }

    $Rows = @(Invoke-KoiosJson "drep_info" ([ordered]@{ _drep_ids = @($DrepId) }))
    if ($Rows.Count -lt 1) {
        return [ordered]@{ found = $false; registered = $false; active = $false }
    }
    $Row = $Rows[0]
    if ($Row.hex -ne $KeyHash -or $Row.drep_id -ne $DrepId -or $Row.has_script -ne $false) {
        Throw-BadRequest "Koios returned a DRep credential that does not match the connected key."
    }
    return [ordered]@{
        found = $true
        registered = [bool]($Row.drep_status -eq "registered")
        active = [bool]($Row.active -eq $true)
        status = $Row.drep_status
        expiresEpoch = $Row.expires_epoch_no
    }
}

function Read-RequestBody {
    param(
        [System.IO.StreamReader]$Reader,
        [hashtable]$Headers
    )

    [int]$Length = 0
    if (-not $Headers.ContainsKey("content-length") -or -not [int]::TryParse($Headers["content-length"], [ref]$Length) -or $Length -lt 1 -or $Length -gt 32768) {
        Throw-BadRequest "Request body must be between 1 and 32768 bytes."
    }
    $Buffer = New-Object char[] $Length
    $Read = 0
    while ($Read -lt $Length) {
        $Count = $Reader.Read($Buffer, $Read, $Length - $Read)
        if ($Count -le 0) {
            Throw-BadRequest "Request body ended unexpectedly."
        }
        $Read += $Count
    }
    return -join $Buffer
}

if (-not (Test-Path -LiteralPath (Join-Path $StaticRoot "index.html") -PathType Leaf)) {
    Write-Error "Compiled assets are missing from the dist folder. Download a complete release ZIP or run npm ci and npm run build."
    exit 1
}

$Listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
try {
    $Listener.Start()
} catch {
    Write-Error "Could not start localhost server on port $Port. Another program may already be using it."
    exit 1
}

$Url = "http://127.0.0.1:$Port/"
Write-Host "Multi-proposal voter: $Url" -ForegroundColor Green
Write-Host "Open this URL in the Chrome profile containing the Cardano wallet extensions."
Write-Host "Keep this window open. Press Ctrl+C to stop the server."

if (-not $NoBrowser) {
    try {
        Start-Process "chrome.exe" -ArgumentList $Url -ErrorAction Stop
    } catch {
        try {
            Start-Process $Url
        } catch {
            Write-Warning "The browser could not be opened automatically. Open $Url manually."
        }
    }
}

try {
    while ($true) {
        $Client = $Listener.AcceptTcpClient()
        $Stream = $null
        try {
            $Stream = $Client.GetStream()
            $Reader = [System.IO.StreamReader]::new(
                $Stream,
                [System.Text.Encoding]::ASCII,
                $false,
                4096,
                $true
            )
            $RequestLine = $Reader.ReadLine()
            if ([string]::IsNullOrWhiteSpace($RequestLine)) {
                continue
            }

            $Headers = @{}
            while ($true) {
                $HeaderLine = $Reader.ReadLine()
                if ([string]::IsNullOrEmpty($HeaderLine)) {
                    break
                }
                $Separator = $HeaderLine.IndexOf(":")
                if ($Separator -gt 0) {
                    $Name = $HeaderLine.Substring(0, $Separator).Trim().ToLowerInvariant()
                    $Headers[$Name] = $HeaderLine.Substring($Separator + 1).Trim()
                }
            }

            $Parts = $RequestLine.Split(" ")
            if ($Parts.Length -lt 2) {
                $Body = [System.Text.Encoding]::UTF8.GetBytes("Bad request")
                Send-Response $Stream 400 "Bad Request" "text/plain; charset=utf-8" $Body $false
                continue
            }
            $Method = $Parts[0].ToUpperInvariant()
            $Path = ($Parts[1] -split "\?", 2)[0]

            if ($Method -eq "GET" -and $Path -eq "/api/network") {
                try {
                    Send-Json $Stream 200 "OK" (Get-NetworkPayload)
                } catch {
                    Send-Json $Stream 502 "Bad Gateway" ([ordered]@{ error = "Koios network query failed: $($_.Exception.Message)" })
                }
                continue
            }

            if ($Method -eq "POST" -and ($Path -eq "/api/validate-proposals" -or $Path -eq "/api/validate-drep")) {
                try {
                    $BodyText = Read-RequestBody $Reader $Headers
                    try {
                        $Payload = ConvertFrom-Json -InputObject $BodyText -ErrorAction Stop
                    } catch {
                        Throw-BadRequest "Request body is not valid JSON."
                    }
                    if ($Path -eq "/api/validate-proposals") {
                        $Result = Get-ProposalValidation $Payload
                    } else {
                        $Result = Get-DrepValidation $Payload
                    }
                    Send-Json $Stream 200 "OK" $Result
                } catch [System.ArgumentException] {
                    Send-Json $Stream 400 "Bad Request" ([ordered]@{ error = $_.Exception.Message })
                } catch {
                    Send-Json $Stream 502 "Bad Gateway" ([ordered]@{ error = "Koios query failed: $($_.Exception.Message)" })
                }
                continue
            }

            if ($Method -eq "POST") {
                Send-Json $Stream 404 "Not Found" ([ordered]@{ error = "Unknown API endpoint." })
                continue
            }
            if ($Method -ne "GET" -and $Method -ne "HEAD") {
                $Body = [System.Text.Encoding]::UTF8.GetBytes("Method not allowed")
                Send-Response $Stream 405 "Method Not Allowed" "text/plain; charset=utf-8" $Body ($Method -eq "HEAD")
                continue
            }
            if (-not $Routes.ContainsKey($Path)) {
                $Body = [System.Text.Encoding]::UTF8.GetBytes("Not found")
                Send-Response $Stream 404 "Not Found" "text/plain; charset=utf-8" $Body ($Method -eq "HEAD")
                continue
            }

            $Route = $Routes[$Path]
            $FilePath = Join-Path $StaticRoot $Route.File
            if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
                $Body = [System.Text.Encoding]::UTF8.GetBytes("Required page file is missing")
                Send-Response $Stream 500 "Internal Server Error" "text/plain; charset=utf-8" $Body ($Method -eq "HEAD")
                continue
            }
            $Body = [System.IO.File]::ReadAllBytes($FilePath)
            Send-Response $Stream 200 "OK" $Route.Type $Body ($Method -eq "HEAD")
        } catch {
            if ($null -ne $Stream) {
                $Body = [System.Text.Encoding]::UTF8.GetBytes("Internal server error")
                Send-Response $Stream 500 "Internal Server Error" "text/plain; charset=utf-8" $Body $false
            }
            Write-Warning $_.Exception.Message
        } finally {
            $Client.Close()
        }
    }
} finally {
    $Listener.Stop()
}
