param([Parameter(Mandatory=$true)][string]$SourcePath,[Parameter(Mandatory=$true)][string]$PdfPath,[Parameter(Mandatory=$true)][string]$ResultPath)
$ErrorActionPreference = 'Stop'
$publisher = $null
$document = $null
try {
    $publisher = New-Object -ComObject Publisher.Application
    # msoAutomationSecurityForceDisable. Never enable document macros.
    $publisher.AutomationSecurity = 3
    $document = $publisher.Open($SourcePath, $true, $false)
    $pages = [int]$document.Pages.Count
    # pbFixedFormatTypePDF = 2. This produces a PDF, not validated PDF/A.
    $document.ExportAsFixedFormat(2, $PdfPath)
    @{ ok = $true; pages = $pages } | ConvertTo-Json | Set-Content -LiteralPath $ResultPath -Encoding UTF8
} catch {
    @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json | Set-Content -LiteralPath $ResultPath -Encoding UTF8
    exit 1
} finally {
    if ($document) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($document) }
    if ($publisher) {
        try { $publisher.Quit() } catch { }
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($publisher)
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
